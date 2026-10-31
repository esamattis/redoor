//! Selects, verifies, and streams compatible agent binaries to remote hosts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use redoor_core::log;
use redoor_protocol::wire::log::Level;
use tokio::io::AsyncReadExt;
use tokio::time::{Duration, timeout};

use super::ProvisionError;
use super::shell::{path_word, quote};
use super::transport::{SshHost, SshRunOptions};
use crate::watchdog::ProvisioningStatusSink;

/// Bounds cancellation-triggered SSH cleanup so a second unreachable host cannot leak a task.
const REMOTE_TEMP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(30);

/// First line of a probe report, so output from anything else (a login banner printed
/// by a shell startup file, for example) is not mistaken for probe fields.
const PROBE_MARKER: &str = "redoor-probe";

/// Lines of a probe report: the marker, os, arch, path and version.
pub(super) const PROBE_REPORT_LINES: usize = 5;

/// Last line of a launch report when the binary matched and is being started.
pub(super) const LAUNCH_READY: &str = "ready";

/// Last line of a launch report when the binary did not match and nothing was started.
pub(super) const LAUNCH_NEEDS_INSTALL: &str = "install";

/// Owns a remote upload sibling until it is atomically renamed into place.
struct RemoteTempGuard {
    host: SshHost,
    path: Option<String>,
}

impl RemoteTempGuard {
    /// Starts guarding immediately after the path can first be created remotely.
    fn new(host: &SshHost, path: String) -> Self {
        Self {
            host: host.clone(),
            path: Some(path),
        }
    }

    /// Removes the sibling on ordinary errors while retaining drop cleanup if this await is canceled.
    async fn cleanup(&mut self) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        if remove_remote_temp(&self.host, path).await {
            self.path = None;
        }
    }

    /// Transfers ownership to the final binary after a successful remote rename.
    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for RemoteTempGuard {
    /// Schedules bounded cleanup because provisioning futures are intentionally cancellable.
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        let host = self.host.clone();
        tokio::spawn(async move {
            remove_remote_temp(&host, &path).await;
        });
    }
}

/// Best-effort removal is bounded and its SSH child is kill-on-drop through [`SshHost::run`].
async fn remove_remote_temp(host: &SshHost, path: &str) -> bool {
    let options = SshRunOptions::default().compressed();
    let command = format!("rm -f {}", path_word(path));
    match timeout(
        REMOTE_TEMP_CLEANUP_TIMEOUT,
        host.run(&command, &[], &options),
    )
    .await
    {
        Ok(Ok(status)) if status.success() => true,
        Ok(Ok(status)) => {
            redoor_core::log_failure!(
                Level::Error,
                "Remote provisioning temp cleanup failed: target={}, path={}, status={}",
                host.target(),
                path,
                status.code().unwrap_or(-1)
            );
            false
        }
        Ok(Err(error)) => {
            redoor_core::log_failure!(
                Level::Error,
                "Remote provisioning temp cleanup failed: target={}, path={}, error={:#}",
                host.target(),
                path,
                error
            );
            false
        }
        Err(_) => {
            redoor_core::log_failure!(
                Level::Error,
                "Remote provisioning temp cleanup timed out: target={}, path={}",
                host.target(),
                path
            );
            false
        }
    }
}

/// Default remote redoor binary path when the user does not override it
/// via `--remote-bin` or `REDOOR_REMOTE_BIN`.
pub(super) fn default_remote_bin(app_name: &str) -> String {
    format!(
        "${{XDG_DATA_HOME:-$HOME/.local/share}}/{app_name}/binaries/{}/redoor",
        env!("CARGO_PKG_VERSION")
    )
}

/// Directory holding every install of `app_name` on a device: the versioned releases and
/// the content-addressed debug builds. Stale debug builds are only ever removed below it.
fn remote_binaries_dir(app_name: &str) -> String {
    format!("${{XDG_DATA_HOME:-$HOME/.local/share}}/{app_name}/binaries")
}

/// Content-addressed remote path for an upload of the local debug build with `hash`.
///
/// Debug rebuilds keep the same `--version`, so the version cannot tell them apart. Naming
/// the directory after the build's content hash makes the path itself the identity: a
/// binary there that runs and reports the expected version is the build, and the device
/// never has to hash hundreds of megabytes (slow with Perl `shasum` on macOS or on phones
/// and boards without hashing instructions). It also keeps debug deploys from overwriting
/// a versioned release install on the same host.
fn debug_remote_bin(app_name: &str, hash: &str) -> String {
    format!("{}/debug-{hash}/redoor", remote_binaries_dir(app_name))
}

/// Result of probing a remote host: which OS/arch it runs and what its existing redoor
/// binary reports for `--version` (empty when there is no runnable binary at the path).
#[derive(Debug)]
pub(super) struct RemoteSniff {
    pub(super) os: String,
    pub(super) arch: String,
    /// First line of `<remote_bin> --version` with surrounding whitespace stripped.
    /// Empty when the binary is missing, not executable, or otherwise fails to run,
    /// in which case it needs to be (re)installed.
    pub(super) version_output: String,
    /// Shell-expanded remote path so status lines can show the real file.
    pub(super) remote_bin: String,
}

/// Builds the probe statements shared by the standalone probe and the launch script.
///
/// The script stays a single line so it can also be passed through `sh -c`. Each field is
/// printed on its own line, and only the first line of `--version` is kept, so a version
/// string or path containing commas, or a broken binary printing garbage, cannot shift
/// the other fields. The binary is deliberately not hashed: its path already identifies
/// the build (see [`debug_remote_bin`]), and hashing it remotely was the slowest part of
/// every start on small devices.
fn probe_statements(remote_bin: &str) -> String {
    format!(
        "bin={bin}; os=$(uname); arch=$(uname -m); \
         version=$(\"$bin\" --version 2>/dev/null | head -n 1); \
         printf '%s\\n' {PROBE_MARKER} \"$os\" \"$arch\" \"$bin\" \"$version\"",
        bin = path_word(remote_bin)
    )
}

/// Builds the shell script used to inspect a remote binary in one SSH
/// round-trip. The outer brace group must be parsed in full before execution,
/// so a truncated SSH stdin stream cannot run a partially received probe.
fn remote_sniff_script(remote_bin: &str) -> String {
    format!("{{ {}; }}\n", probe_statements(remote_bin))
}

impl RemoteSniff {
    /// Parses the probe report lines printed by [`probe_statements`].
    pub(super) fn parse(target: &str, report: &[String]) -> Result<Self, ProvisionError> {
        let [marker, os, arch, remote_bin, version_output] = report else {
            return Err(Self::unexpected(target, report));
        };
        if marker != PROBE_MARKER {
            return Err(Self::unexpected(target, report));
        }
        // Map `uname` values to the os component used in the release artifact
        // filenames (e.g. `redoor-aarch64-linux.tar.gz`).
        let os = match os.trim() {
            "Linux" => "linux",
            "Darwin" => "macos",
            other => {
                return Err(ProvisionError::Remote(format!(
                    "unsupported remote os '{other}' on {target}"
                )));
            }
        };
        // macOS reports `arm64` for Apple Silicon but the release artifacts use
        // `aarch64`, so normalize before looking up the download URL.
        let arch = match arch.trim() {
            "x86_64" => "x86_64",
            "aarch64" | "arm64" => "aarch64",
            other => {
                return Err(ProvisionError::Remote(format!(
                    "unsupported remote arch '{other}' on {target}"
                )));
            }
        };
        Ok(Self {
            os: os.to_string(),
            arch: arch.to_string(),
            version_output: version_output.trim().to_string(),
            remote_bin: remote_bin.to_string(),
        })
    }

    /// Logs and describes a report that does not have the probe's shape.
    fn unexpected(target: &str, report: &[String]) -> ProvisionError {
        redoor_core::log_failure!(
            Level::Error,
            "Remote probe report has an unexpected shape: target={}, report={:?}",
            target,
            report
        );
        ProvisionError::Remote(format!(
            "unexpected probe output from {target}: {report:?}; expected '{PROBE_MARKER}' followed by os, arch, path and version lines"
        ))
    }

    /// Formats probe fields for the sticky starting UI without sending raw script output.
    pub(super) fn status_message(&self) -> String {
        format!(
            "Sniff results: arch={}, platform={}, path={}, version={}",
            self.arch,
            self.os,
            self.remote_bin,
            if self.version_output.is_empty() {
                "(none)"
            } else {
                self.version_output.as_str()
            }
        )
    }
}

/// Probes the remote host with a single ssh command that reports its OS,
/// CPU architecture and the `--version` output of the configured redoor binary.
/// Batching into one round-trip avoids paying ssh setup latency multiple times
/// for what is conceptually one "is the host ready" check.
pub(super) async fn sniff_remote(
    host: &SshHost,
    remote_bin: &str,
) -> Result<RemoteSniff, ProvisionError> {
    let sniff_start = std::time::Instant::now();
    let script = remote_sniff_script(remote_bin);
    log!(
        Level::Debug,
        "Remote sniff started: target={}, ssh_server_port={}, remote_bin={}, script='{}'",
        host.target(),
        host.server_port_label(),
        remote_bin,
        script.trim_end()
    );
    let options = SshRunOptions::default().compressed();
    let output = host
        .run_script_captured("remote host probe", &script, &options)
        .await
        .map_err(|error| {
            redoor_core::log_failure!(
                Level::Error,
                "Remote sniff script execution failed: target={}, remote_bin={}, elapsed={:?}, error={:#}",
                host.target(),
                remote_bin,
                sniff_start.elapsed(),
                error
            );
            error
        })?;
    let report: Vec<String> = output.lines().map(str::to_string).collect();
    let sniff = RemoteSniff::parse(host.target(), &report)?;
    log!(
        Level::Info,
        "Remote sniff complete: target={}, remote_bin={}, os={}, arch={}, version_output='{}', elapsed={:?}",
        host.target(),
        sniff.remote_bin,
        sniff.os,
        sniff.arch,
        sniff.version_output,
        sniff_start.elapsed()
    );
    Ok(sniff)
}

/// Bytes read per step while hashing the local debug build: large enough to keep the
/// hasher fast, small enough that a build of hundreds of megabytes never sits in memory.
const HASH_CHUNK_SIZE: usize = 1024 * 1024;

/// Hex characters of the BLAKE3 hash kept in a debug install directory name. The hash only
/// tells builds apart and does not need to resist forgery, so 64 bits are plenty, and a
/// short name keeps remote paths and status lines readable.
const DEBUG_HASH_LEN: usize = 16;

/// What provisioning needs to know about the local debug build: enough to name its remote
/// install, verify an upload of it and recognize it on the device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LocalBuild {
    /// File size in bytes, which the upload script checks so a cut-off stream is never
    /// installed at a content-addressed path that would then be trusted.
    size: u64,
    /// Leading hex characters of the BLAKE3 hash of the file, naming its remote directory.
    hash: String,
    /// First `--version` line of the build. It is read from the build itself rather than
    /// taken from this server: the build on disk can be newer than the running server, for
    /// example after a version bump without a restart, and expecting the server's version
    /// would reject every upload of it and re-upload the same bytes forever.
    version: String,
}

impl LocalBuild {
    /// Hashes and runs the build described by `stamp`. Fails when the file changes while it
    /// is read, because a hash of a half-rewritten file would name the wrong bytes.
    async fn read(stamp: &BuildStamp) -> Result<Self, std::io::Error> {
        let started = std::time::Instant::now();
        let version = Self::version(&stamp.path).await?;
        let hash = Self::content_hash(&stamp.path, stamp.size).await?;
        if BuildStamp::read(&stamp.path).await? != *stamp {
            return Err(std::io::Error::other(format!(
                "local debug build '{}' changed while it was being hashed",
                stamp.path.display()
            )));
        }
        log!(
            Level::Info,
            "Identified local debug build: path={}, size={}, hash={}, version='{}', elapsed={:?}",
            stamp.path.display(),
            stamp.size,
            hash,
            version,
            started.elapsed()
        );
        Ok(Self {
            size: stamp.size,
            hash,
            version,
        })
    }

    /// Reads the first `--version` line, which is all the remote probe compares.
    async fn version(path: &Path) -> Result<String, std::io::Error> {
        let output = tokio::process::Command::new(path)
            .arg("--version")
            .output()
            .await
            .map_err(|error| {
                std::io::Error::other(format!(
                    "failed to run '{} --version': {error}",
                    path.display()
                ))
            })?;
        if !output.status.success() {
            return Err(std::io::Error::other(format!(
                "'{} --version' exited with {}",
                path.display(),
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string())
    }

    /// Streams the file through BLAKE3 in fixed chunks so the whole build never sits in
    /// memory, and checks that exactly `size` bytes were read so a concurrent rebuild
    /// cannot slip a different file length past the stamp.
    async fn content_hash(path: &Path, size: u64) -> Result<String, std::io::Error> {
        let mut file = tokio::fs::File::open(path).await.map_err(|error| {
            std::io::Error::other(format!(
                "failed to open '{}' to hash it: {error}",
                path.display()
            ))
        })?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; HASH_CHUNK_SIZE];
        let mut total: u64 = 0;
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            total += n as u64;
        }
        if total != size {
            return Err(std::io::Error::other(format!(
                "local debug build '{}' changed while it was being hashed: read {total} bytes, expected {size}",
                path.display()
            )));
        }
        let mut hash = hasher.finalize().to_hex().to_string();
        hash.truncate(DEBUG_HASH_LEN);
        Ok(hash)
    }
}

/// What a cached [`LocalBuild`] was computed from. Cargo rewrites the file on every
/// rebuild, which changes its modification time and usually its size, so an unchanged
/// stamp means the cached hash still describes the file without reading it again.
#[derive(Clone, Debug, PartialEq, Eq)]
struct BuildStamp {
    /// Path of the build, so a different build file never reuses another's identity.
    path: PathBuf,
    /// File size in bytes.
    size: u64,
    /// Last modification time, `None` on a filesystem that does not record one.
    modified: Option<SystemTime>,
}

impl BuildStamp {
    /// Stats the build; this is the only file access a cached provision makes.
    async fn read(path: &Path) -> Result<Self, std::io::Error> {
        let metadata = tokio::fs::metadata(path).await.map_err(|error| {
            std::io::Error::other(format!(
                "failed to access local debug build '{}': {error}",
                path.display()
            ))
        })?;
        Ok(Self {
            path: path.to_path_buf(),
            size: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

/// A computed [`LocalBuild`] together with the stamp it is valid for.
#[derive(Debug)]
struct CachedBuild {
    /// File state the build identity was computed from.
    stamp: BuildStamp,
    /// The identity, reused while the stamp is unchanged.
    build: LocalBuild,
}

/// Lazily computed identity of the local debug build, shared by every provision of this
/// process.
///
/// Hashing and running a debug build of hundreds of megabytes on every agent start would
/// slow down each start, so the identity is computed on the first use after the server
/// starts or the build changes, and later uses only stat the file. It is deliberately not
/// computed at startup: most servers (including every integration test server) never
/// provision an SSH device. The mutex makes concurrent provisions wait for one hash
/// instead of reading the same file in parallel.
#[derive(Clone, Default)]
pub(crate) struct LocalBuildCache {
    /// Last computed identity; `Arc` so clones of the provisioning context share it.
    cached: Arc<tokio::sync::Mutex<Option<CachedBuild>>>,
}

impl LocalBuildCache {
    /// Returns the identity of the build at `path`, computing it only when the file is new
    /// to this cache or changed since it was last computed.
    async fn get(&self, path: &Path) -> Result<LocalBuild, std::io::Error> {
        let mut cached = self.cached.lock().await;
        let stamp = BuildStamp::read(path).await?;
        if let Some(entry) = cached.as_ref()
            && entry.stamp == stamp
        {
            return Ok(entry.build.clone());
        }
        let build = LocalBuild::read(&stamp).await?;
        *cached = Some(CachedBuild {
            stamp,
            build: build.clone(),
        });
        Ok(build)
    }
}

/// What a remote binary must report before it is used, in the probe script and in Rust.
///
/// Only the version is compared: the install path already says which bytes are there,
/// because release installs are versioned and debug installs are content-addressed, and
/// every upload is size-checked before it is moved into place.
#[derive(Clone, Debug)]
pub(super) struct BinaryExpectation {
    /// Exact first line of `--version`.
    version: String,
}

impl BinaryExpectation {
    /// Any binary reporting this server's version, as for a versioned release install.
    fn this_version() -> Self {
        Self {
            version: redoor_core::identity::version_line(),
        }
    }

    /// The version the local debug build reports, which may differ from this server's.
    fn of_build(build: &LocalBuild) -> Self {
        Self {
            version: build.version.clone(),
        }
    }

    /// Decides whether a probed binary can be used; mirrors the check in [`Self::launch_script`].
    pub(super) fn matches(&self, sniff: &RemoteSniff) -> bool {
        sniff.version_output == self.version
    }

    /// Builds the single-line launch script: it prints the probe report, then either
    /// prints [`LAUNCH_READY`] and `exec`s the binary with the script's positional
    /// arguments, or prints [`LAUNCH_NEEDS_INSTALL`] and exits without starting anything.
    /// Probing and starting in one session saves an SSH round-trip on every start.
    pub(super) fn launch_script(&self, remote_bin: &str) -> String {
        format!(
            "{{ {probe}; \
             if [ \"$version\" = {version} ]; then \
             echo {LAUNCH_READY}; exec \"$bin\" \"$@\"; fi; \
             echo {LAUNCH_NEEDS_INSTALL}; }}",
            probe = probe_statements(remote_bin),
            version = quote(&self.version),
        )
    }

    /// Explains why a just-uploaded binary was rejected.
    fn mismatch_message(&self, sniff: &RemoteSniff) -> String {
        format!(
            "remote binary at {} did not verify after upload: version '{}' (want '{}')",
            sniff.remote_bin, sniff.version_output, self.version
        )
    }
}

/// Result of checking the binary at one path against an expectation.
pub(super) struct BinaryCheckResult<T> {
    /// What the probe found at the path.
    pub(super) sniff: RemoteSniff,
    /// The started process or usable path when the binary matched, `None` when it must be
    /// installed first.
    pub(super) ready: Option<T>,
}

/// One way of checking a device's binary: probing only (relays, which start the agent
/// later and repeatedly) or probing while starting the agent (managed agents).
pub(super) trait BinaryCheck {
    /// What a successful check produces.
    type Ready;

    /// Checks the binary at `remote_bin` against `expect`.
    async fn check(
        &mut self,
        remote_bin: &str,
        expect: &BinaryExpectation,
    ) -> Result<BinaryCheckResult<Self::Ready>, ProvisionError>;
}

/// Checks by probing only; the ready value is the shell-expanded remote path.
pub(super) struct ProbeCheck<'a> {
    /// Host to probe.
    pub(super) host: &'a SshHost,
}

impl BinaryCheck for ProbeCheck<'_> {
    type Ready = String;

    async fn check(
        &mut self,
        remote_bin: &str,
        expect: &BinaryExpectation,
    ) -> Result<BinaryCheckResult<String>, ProvisionError> {
        let sniff = sniff_remote(self.host, remote_bin).await?;
        let ready = expect.matches(&sniff).then(|| sniff.remote_bin.clone());
        Ok(BinaryCheckResult { sniff, ready })
    }
}

/// Local binary a missing or stale remote install is uploaded from.
enum InstallSource {
    /// The local debug build at `path`, installed at its content-addressed path.
    Debug {
        /// Local file to upload.
        path: PathBuf,
        /// Identity the remote path and expectation were derived from.
        build: LocalBuild,
    },
    /// The release artifact of the probed platform, fetched into the local cache on demand
    /// so a device that already has it never triggers a download.
    Release,
}

/// Where a missing or stale binary is installed from and to.
struct InstallTarget {
    /// Remote path the binary is checked at and uploaded to.
    remote_bin: String,
    /// What gets uploaded when the remote binary does not match.
    source: InstallSource,
}

impl InstallTarget {
    /// What the binary at [`Self::remote_bin`] must report to be used.
    fn expectation(&self) -> BinaryExpectation {
        match &self.source {
            InstallSource::Debug { build, .. } => BinaryExpectation::of_build(build),
            InstallSource::Release => BinaryExpectation::this_version(),
        }
    }
}

/// Makes sure a device runs a binary matching this server, installing one when needed.
///
/// Only the default install locations are managed here; an operator-provided path is
/// used as-is by the caller. A debug server prefers its local debug build at a path named
/// after the build's content hash, because the version does not change between rebuilds,
/// and falls back to the versioned release install when the device's platform differs.
pub(super) struct Installer<'a> {
    /// Host to install on.
    pub(super) host: &'a SshHost,
    /// Local namespace and release cache.
    pub(super) provision: &'a super::ProvisionContext,
    /// Progress lines for the lifecycle UI.
    pub(super) status: &'a ProvisioningStatusSink,
}

impl Installer<'_> {
    /// Checks the expected path with `check` and installs the binary when it does not
    /// match, then checks again to verify the upload. Returns what the successful check
    /// produced.
    pub(super) async fn ensure<C: BinaryCheck>(
        &self,
        check: &mut C,
    ) -> Result<C::Ready, ProvisionError> {
        self.status.report("Sniffing the SSH target");
        let mut target = self.first_candidate().await?;
        let mut uploaded = false;
        let mut first_check = true;
        // At most: the debug path, the release path after a platform mismatch, and the
        // verification after the upload.
        for _ in 0..3 {
            let expect = target.expectation();
            log!(
                Level::Debug,
                "Checking remote binary: target={}, remote_bin={}, expect={:?}, uploaded={}",
                self.host.target(),
                target.remote_bin,
                expect,
                uploaded
            );
            let result = check.check(&target.remote_bin, &expect).await?;
            let sniff = result.sniff;
            if first_check {
                // Later checks follow an upload or a platform switch and have their own lines.
                self.status.report(sniff.status_message());
                first_check = false;
            }
            if let Some(ready) = result.ready {
                if uploaded {
                    self.status.report(format!(
                        "Verified the uploaded binary at {}",
                        sniff.remote_bin
                    ));
                    if let InstallSource::Debug { build, .. } = &target.source {
                        self.spawn_stale_debug_cleanup(&build.hash);
                    }
                } else {
                    self.status.report(format!(
                        "Using existing remote binary at {}",
                        sniff.remote_bin
                    ));
                }
                log!(
                    Level::Info,
                    "Remote binary matches: target={}, remote_bin={}, version='{}', uploaded={}",
                    self.host.target(),
                    sniff.remote_bin,
                    sniff.version_output,
                    uploaded
                );
                return Ok(ready);
            }
            if uploaded {
                let message = expect.mismatch_message(&sniff);
                redoor_core::log_failure!(
                    Level::Error,
                    "Uploaded binary did not verify: target={}, {}",
                    self.host.target(),
                    message
                );
                return Err(ProvisionError::Remote(message));
            }
            let install = self.install_target(&sniff).await?;
            if install.remote_bin != target.remote_bin {
                // The probe looked at another path than this platform installs to: the
                // debug path on a device that needs the release install, or the previous
                // debug path after a rebuild. The binary may already be in place there.
                log!(
                    Level::Info,
                    "Switching the remote install path: target={}, os={}, arch={}, from={}, to={}",
                    self.host.target(),
                    sniff.os,
                    sniff.arch,
                    target.remote_bin,
                    install.remote_bin
                );
                self.status.report(match install.source {
                    InstallSource::Release => format!(
                        "Checking the release install at {} for this platform",
                        install.remote_bin
                    ),
                    InstallSource::Debug { .. } => format!(
                        "Checking the debug install at {} for the rebuilt local binary",
                        install.remote_bin
                    ),
                });
                target = install;
                continue;
            }
            target = install;
            self.upload(&target, &sniff).await?;
            uploaded = true;
        }
        let message = format!(
            "could not settle on a remote binary for {} after several attempts",
            self.host.target()
        );
        redoor_core::log_failure!(Level::Error, "{}", message);
        Err(ProvisionError::Remote(message))
    }

    /// Uploads the binary `target` installs from, fetching the release artifact for the
    /// probed platform first when that is the source.
    async fn upload(
        &self,
        target: &InstallTarget,
        sniff: &RemoteSniff,
    ) -> Result<(), ProvisionError> {
        let (local_path, size) = match &target.source {
            // The size is the one the hash was computed for, so a rebuild that changes the
            // file length during the upload is rejected by the size check.
            InstallSource::Debug { path, build } => (path.clone(), build.size),
            InstallSource::Release => {
                let path = self
                    .provision
                    .binaries
                    .ensure(env!("CARGO_PKG_VERSION"), &sniff.os, &sniff.arch, |line| {
                        self.status.report(line)
                    })
                    .await?;
                let size = local_file_size(&path).await?;
                (path, size)
            }
        };
        log!(
            Level::Info,
            "Remote binary missing or stale, uploading: target={}, remote_bin={}, remote_version='{}', local_path={}, size={}",
            self.host.target(),
            sniff.remote_bin,
            sniff.version_output,
            local_path.display(),
            size
        );
        upload_binary(
            self.host,
            &local_path,
            &target.remote_bin,
            size,
            self.status,
        )
        .await
    }

    /// The install checked first, before the remote platform is known: the local debug
    /// build when this is a debug server that has one, otherwise the versioned release
    /// install.
    async fn first_candidate(&self) -> Result<InstallTarget, ProvisionError> {
        match available_debug_binary(std::env::consts::OS, std::env::consts::ARCH).await? {
            Some(path) => {
                self.status
                    .report("Comparing the remote debug install to this local build");
                self.debug_target(path).await
            }
            None => Ok(self.release_target()),
        }
    }

    /// Where the binary for the probed platform is installed from and to.
    async fn install_target(&self, sniff: &RemoteSniff) -> Result<InstallTarget, ProvisionError> {
        match available_debug_binary(&sniff.os, &sniff.arch).await? {
            Some(path) => self.debug_target(path).await,
            None => Ok(self.release_target()),
        }
    }

    /// The content-addressed install of the local debug build at `path`. The identity is
    /// cached, so only the first provision after a rebuild pays for hashing it.
    async fn debug_target(&self, path: PathBuf) -> Result<InstallTarget, ProvisionError> {
        let build = self.provision.local_build.get(&path).await?;
        Ok(InstallTarget {
            remote_bin: debug_remote_bin(&self.provision.app_name, &build.hash),
            source: InstallSource::Debug { path, build },
        })
    }

    /// The versioned release install of this server's version.
    fn release_target(&self) -> InstallTarget {
        InstallTarget {
            remote_bin: default_remote_bin(&self.provision.app_name),
            source: InstallSource::Release,
        }
    }

    /// Removes the installs of other debug builds once the build with `keep_hash` verified.
    ///
    /// Every rebuild gets a new content-addressed directory, so without this a device would
    /// keep hundreds of megabytes per rebuild. An agent still running an older build keeps
    /// its deleted file open, so removing it is safe. It runs as its own bounded task: the
    /// agent may already be connected when the upload verifies, and neither its start nor
    /// a stop requested right after it should wait for, or cancel, the cleanup.
    fn spawn_stale_debug_cleanup(&self, keep_hash: &str) {
        let host = self.host.clone();
        let script = stale_debug_cleanup_script(&self.provision.app_name, keep_hash);
        let keep_hash = keep_hash.to_string();
        tokio::spawn(async move {
            remove_stale_debug_installs(&host, &script, &keep_hash).await;
        });
    }
}

/// Runs the cleanup built by [`stale_debug_cleanup_script`]. Failures are only logged: the
/// agent is already usable and the next verified upload tries again.
async fn remove_stale_debug_installs(host: &SshHost, script: &str, keep_hash: &str) {
    let options = SshRunOptions::default().compressed();
    match timeout(REMOTE_TEMP_CLEANUP_TIMEOUT, host.run(script, &[], &options)).await {
        Ok(Ok(status)) if status.success() => log!(
            Level::Info,
            "Removed stale remote debug installs: target={}, kept=debug-{}",
            host.target(),
            keep_hash
        ),
        Ok(Ok(status)) => redoor_core::log_failure!(
            Level::Error,
            "Stale remote debug install cleanup failed: target={}, status={}",
            host.target(),
            status.code().unwrap_or(-1)
        ),
        Ok(Err(error)) => redoor_core::log_failure!(
            Level::Error,
            "Stale remote debug install cleanup failed: target={}, error={:#}",
            host.target(),
            error
        ),
        Err(_) => redoor_core::log_failure!(
            Level::Error,
            "Stale remote debug install cleanup timed out: target={}",
            host.target()
        ),
    }
}

/// Builds the single-line script that deletes every debug install of `app_name` except the
/// one named after `keep_hash`, including the `debug/` directory older servers used.
///
/// It only touches `debug-*` and `debug` entries directly inside the binaries directory,
/// so versioned release installs and anything else stay untouched; the pattern is
/// expanded by the remote shell, and an unmatched pattern is skipped by the `-d` test.
fn stale_debug_cleanup_script(app_name: &str, keep_hash: &str) -> String {
    format!(
        "base={base}; keep={keep}; \
         for dir in \"$base\"/debug-* \"$base\"/debug; do \
         if [ \"$dir\" != \"$base/$keep\" ] && [ -d \"$dir\" ]; then rm -rf \"$dir\"; fi; \
         done",
        base = path_word(&remote_binaries_dir(app_name)),
        keep = quote(&format!("debug-{keep_hash}")),
    )
}

/// Size of a local binary, which the upload script compares with the bytes it received.
async fn local_file_size(path: &Path) -> Result<u64, std::io::Error> {
    let metadata = tokio::fs::metadata(path).await.map_err(|error| {
        std::io::Error::other(format!(
            "failed to access binary source '{}': {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(std::io::Error::other(format!(
            "binary source '{}' is not a regular file",
            path.display()
        )));
    }
    Ok(metadata.len())
}

/// Unconditionally streams an operator-selected binary to the remote install
/// path and verifies that the upload arrived complete and runs.
/// This intentionally bypasses version/cache selection so local development or
/// cross-compiled artifacts can replace an otherwise matching remote release.
/// The upload script rejects a stream of the wrong length before anything is moved into
/// place, and the probe afterwards proves the installed file executes.
pub(super) async fn force_upload_binary(
    host: &SshHost,
    local_path: &Path,
    remote_bin: &str,
    status: &ProvisioningStatusSink,
) -> Result<String, ProvisionError> {
    let size = local_file_size(local_path).await?;
    upload_binary(host, local_path, remote_bin, size, status).await?;
    let uploaded = sniff_remote(host, remote_bin).await?;
    if uploaded.version_output.is_empty() {
        redoor_core::log_failure!(
            Level::Error,
            "Forced binary upload does not run: target={}, remote_bin={}",
            host.target(),
            uploaded.remote_bin
        );
        return Err(ProvisionError::Remote(format!(
            "uploaded binary at {} did not execute successfully with --version",
            uploaded.remote_bin
        )));
    }

    log!(
        Level::Info,
        "Forced binary upload verified: binary_source={}, remote_bin={}, version='{}', size={}",
        local_path.display(),
        uploaded.remote_bin,
        uploaded.version_output,
        size
    );
    Ok(uploaded.remote_bin)
}

/// Returns the workspace debug binary path when the running server was built
/// in debug mode and its platform matches the remote host. Keeping platform
/// checks here prevents accidentally uploading a locally runnable binary that
/// the remote kernel or CPU cannot execute.
fn debug_binary_candidate(
    debug_build: bool,
    local_os: &str,
    local_arch: &str,
    remote_os: &str,
    remote_arch: &str,
    manifest_dir: &Path,
) -> Option<PathBuf> {
    if !debug_build || local_os != remote_os || local_arch != remote_arch {
        return None;
    }

    Some(manifest_dir.join("target/debug/redoor"))
}

/// Root of the cargo workspace this server was built from. `CARGO_MANIFEST_DIR` names
/// `crates/redoor-server`, but `cargo build` writes `target/debug/redoor` at the workspace
/// root, so the debug binary lookup must climb out of the crate directory (the same
/// `../..` that `redoor-core/build.rs` uses to find `.git`).
fn workspace_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or(manifest_dir)
        .to_path_buf()
}

/// Replaces the workspace debug build that a debug server uploads. Integration tests use
/// it to give the server a "rebuilt" binary without touching the shared `target/debug`
/// output; release servers never upload a debug build, so they ignore it.
const TEST_DEBUG_BINARY_ENV: &str = "REDOOR_TEST_DEBUG_BINARY";

/// Resolves the matching local debug binary only when it exists. Missing debug
/// output is not an error because GitHub release provisioning remains the
/// intended fallback for fresh checkouts and cross-compiled server binaries.
async fn available_debug_binary(
    remote_os: &str,
    remote_arch: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    let candidate = debug_binary_candidate(
        cfg!(debug_assertions),
        std::env::consts::OS,
        std::env::consts::ARCH,
        remote_os,
        remote_arch,
        &workspace_root(),
    )
    .map(|workspace_build| {
        std::env::var_os(TEST_DEBUG_BINARY_ENV)
            .filter(|path| !path.is_empty())
            .map_or(workspace_build, PathBuf::from)
    });

    match candidate {
        Some(path) if tokio::fs::try_exists(&path).await? => Ok(Some(path)),
        _ => Ok(None),
    }
}

/// Sibling temp path for atomic remote binary replace. Keeping the temp file
/// in the same directory as `remote_bin` ensures `mv` stays on one filesystem
/// and can rename over a still-running executable without ETXTBSY.
fn remote_upload_tmp_path(remote_bin: &str, unique: &str) -> String {
    format!("{remote_bin}.tmp.{unique}")
}

/// Builds the single-line script that installs the binary streamed on stdin.
///
/// In-place `cat > remote_bin` fails with ETXTBSY ("text file busy") when a previous
/// agent is still executing that binary, so the script writes a sibling temp file and
/// renames it over the final path; the old inode stays mapped until that process exits.
/// It creates the parent directory for a fresh host and marks the file executable
/// because `cat` does not carry mode bits. `set -e` stops at the first failing step and
/// the EXIT trap removes the temp file on that failure.
///
/// The received length must equal `size` before the file is moved into place. A stream
/// that ended early would otherwise be installed, and at a content-addressed debug path a
/// truncated binary that still answered `--version` would be trusted from then on. A size
/// check is enough to catch that without hashing on the device. `wc -c` pads its output
/// with spaces on macOS and BSD, so the count is compared unquoted as a number; the
/// negation also fails the check when `wc` printed nothing.
fn upload_script(remote_bin: &str, remote_tmp: &str, size: u64) -> String {
    format!(
        "{{ set -e; bin={bin}; tmp={tmp}; mkdir -p \"$(dirname \"$bin\")\"; \
         trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; received=$(wc -c < \"$tmp\"); \
         if ! [ $received -eq {size} ]; then \
         echo \"received $received bytes of the binary, expected {size}\" >&2; exit 1; fi; \
         chmod +x \"$tmp\"; mv -f \"$tmp\" \"$bin\"; \
         trap - EXIT; }}",
        bin = path_word(remote_bin),
        tmp = path_word(remote_tmp)
    )
}

/// Uploads the binary in one SSH session with [`upload_script`], which only installs it
/// when exactly `size` bytes arrived.
async fn upload_binary(
    host: &SshHost,
    local_path: &Path,
    remote_bin: &str,
    size: u64,
    status: &ProvisioningStatusSink,
) -> Result<(), ProvisionError> {
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let remote_tmp = remote_upload_tmp_path(remote_bin, &unique);
    // The script removes the temp file itself on failure; the guard covers a cancelled
    // provisioning future or a dropped connection, where the script may not finish.
    let mut remote_tmp_guard = RemoteTempGuard::new(host, remote_tmp.clone());

    status.report(format!("Uploading the binary to {remote_bin}"));
    log!(
        Level::Info,
        "Uploading binary to remote host: target={}, local_path={}, remote_bin={}, remote_tmp={}",
        host.target(),
        local_path.display(),
        remote_bin,
        remote_tmp
    );

    if let Err(error) = host
        .upload(
            local_path,
            &upload_script(remote_bin, &remote_tmp, size),
            "binary upload",
        )
        .await
    {
        remote_tmp_guard.cleanup().await;
        return Err(ProvisionError::Remote(format!(
            "failed to upload the binary to {remote_bin}: {error}"
        )));
    }
    remote_tmp_guard.disarm();

    log!(
        Level::Info,
        "Binary upload complete: target={}, remote_bin={}",
        host.target(),
        remote_bin
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        BinaryExpectation, DEBUG_HASH_LEN, LAUNCH_NEEDS_INSTALL, LAUNCH_READY, LocalBuild,
        LocalBuildCache, PROBE_REPORT_LINES, RemoteSniff, debug_binary_candidate, debug_remote_bin,
        default_remote_bin, remote_sniff_script, remote_upload_tmp_path,
        stale_debug_cleanup_script, upload_script,
    };
    use crate::ssh::shell::{quote, sh_command};
    use std::path::{Path, PathBuf};
    use tokio::io::AsyncWriteExt;

    /// Runs a remote command line through a local `/bin/sh` the way sshd runs it through
    /// the login shell, with `stdin` as its input and a fake home directory.
    async fn run_remote(command: &str, stdin: &[u8], home: &Path) -> std::process::Output {
        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .env_remove("XDG_DATA_HOME")
            .env("HOME", home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        input.write_all(stdin).await.unwrap();
        drop(input);
        child.wait_with_output().await.unwrap()
    }

    /// Writes an executable fake redoor that prints `version` and its arguments.
    /// A separate writer process prevents concurrent forks in this test process from
    /// inheriting a writable descriptor, which can cause ETXTBSY even after our write ends.
    async fn fake_binary(path: &Path, version: &str) {
        let parent = path.parent().unwrap();
        tokio::fs::create_dir_all(parent).await.unwrap();
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = --version ]; then echo '{version}'; echo 'second line, with comma'; exit 0; fi
printf 'agent:%s|' "$@"
"#
        );
        let quoted_path = quote(path.to_str().unwrap());
        let command = format!("cat > {quoted_path} && chmod 755 {quoted_path}");
        let output = run_remote(&command, script.as_bytes(), parent).await;
        // Reaping the writer also guarantees every writable fixture descriptor is closed.
        assert!(
            output.status.success(),
            "fixture creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Splits stdout into lines the way the report reader does.
    fn lines(output: &std::process::Output) -> Vec<String> {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Sets the modification time of `path`, so a test can rewrite a file without the
    /// cache noticing, or make it notice a rebuild that kept the same size. A read-only
    /// descriptor can update timestamps without racing execution of the fixture.
    async fn set_modified(path: &Path, modified: std::time::SystemTime) {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            std::fs::File::open(path).and_then(|file| file.set_modified(modified))
        })
        .await
        .unwrap()
        .unwrap();
    }

    /// Reads the modification time of `path`.
    async fn modified(path: &Path) -> std::time::SystemTime {
        tokio::fs::metadata(path).await.unwrap().modified().unwrap()
    }

    /// The streamed hash is the leading part of the one-shot BLAKE3 hash, and a file whose
    /// length differs from the stamped size is rejected rather than hashed.
    #[tokio::test]
    async fn content_hash_streams_blake3_and_checks_the_size() {
        let directory = redoor_core::test_support::TempDir::create();
        let path = directory.path().join("payload.bin");
        // Larger than one chunk, so the streaming loop runs more than once.
        let payload: Vec<u8> = (0..super::HASH_CHUNK_SIZE * 2 + 7)
            .map(|index| (index % 251) as u8)
            .collect();
        tokio::fs::write(&path, &payload).await.unwrap();

        let hash = LocalBuild::content_hash(&path, payload.len() as u64)
            .await
            .unwrap();
        // Chunked hashing must name the same bytes as hashing the whole file at once.
        assert_eq!(hash, blake3::hash(&payload).to_hex()[..DEBUG_HASH_LEN]);
        // A length change means the file was rewritten while it was read.
        assert!(
            LocalBuild::content_hash(&path, payload.len() as u64 + 1)
                .await
                .is_err()
        );
    }

    /// The build identity is reused while the file's size and modification time are
    /// unchanged, and recomputed as soon as either changes.
    #[tokio::test]
    async fn local_build_cache_recomputes_only_after_a_change() {
        let home = redoor_core::test_support::TempDir::create();
        let path = home.path().join("target/debug/redoor");
        let cache = LocalBuildCache::default();
        fake_binary(&path, "redoor 1.0.0").await;
        let first = cache.get(&path).await.unwrap();
        // The identity comes from the build itself.
        assert_eq!(first.version, "redoor 1.0.0");
        assert_eq!(first.hash.len(), DEBUG_HASH_LEN);

        // Same size, and the original modification time restored.
        let original = modified(&path).await;
        fake_binary(&path, "redoor 2.0.0").await;
        set_modified(&path, original).await;
        // An unchanged stamp reuses the cached identity without reading the file again,
        // which is what keeps every later start cheap.
        assert_eq!(cache.get(&path).await.unwrap(), first);

        // Same size, but a newer modification time, as after a rebuild.
        set_modified(&path, original + std::time::Duration::from_secs(5)).await;
        let rebuilt = cache.get(&path).await.unwrap();
        // A new modification time alone triggers a recompute.
        assert_eq!(rebuilt.version, "redoor 2.0.0");
        assert_ne!(rebuilt.hash, first.hash);

        // A different size with the previous modification time restored.
        let previous = modified(&path).await;
        fake_binary(&path, "redoor 10.0.0").await;
        set_modified(&path, previous).await;
        let resized = cache.get(&path).await.unwrap();
        // A new size alone triggers a recompute.
        assert_eq!(resized.version, "redoor 10.0.0");
        assert_ne!(resized.size, rebuilt.size);
        assert_ne!(resized.hash, rebuilt.hash);
    }

    /// Streams the generated probe to a POSIX shell just as SSH does, proving
    /// the script remains executable without login-shell features.
    #[tokio::test]
    async fn remote_sniff_script_executes_successfully() {
        let home = redoor_core::test_support::TempDir::create();
        let script =
            remote_sniff_script("${XDG_DATA_HOME:-$HOME/.local/share}/redoor-test-missing-binary");
        // The outer group prevents any probe command from running before the full script arrives.
        assert!(
            script.starts_with("{ ") && script.ends_with("}\n"),
            "the complete probe should be protected by one brace group"
        );

        let output = run_remote("exec sh -s", script.as_bytes(), home.path()).await;
        // Success proves the streamed script uses syntax supported by the local POSIX shell.
        assert!(
            output.status.success(),
            "probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report = lines(&output);
        // The parser needs every field even when the binary is missing.
        assert_eq!(report.len(), PROBE_REPORT_LINES, "report: {report:?}");
        let sniff = RemoteSniff::parse("test", &report).unwrap();
        // Returning the shell-expanded path lets logs identify the actual remote file.
        assert_eq!(
            sniff.remote_bin,
            format!(
                "{}/.local/share/redoor-test-missing-binary",
                home.path().display()
            )
        );
        // A missing binary has no version, so it gets installed.
        assert_eq!(sniff.version_output, "");
    }

    /// A path with spaces and shell syntax is probed literally, and only the first version
    /// line is kept so commas or extra output cannot shift the other fields.
    #[tokio::test]
    async fn probe_reports_odd_paths_and_versions_literally() {
        let home = redoor_core::test_support::TempDir::create();
        let remote_bin = "~/my bin/$(touch pwned)/redoor";
        let path = home.path().join("my bin/$(touch pwned)/redoor");
        fake_binary(&path, "redoor 1.2.3").await;

        let output = run_remote(
            "exec sh -s",
            remote_sniff_script(remote_bin).as_bytes(),
            home.path(),
        )
        .await;
        let sniff = RemoteSniff::parse("test", &lines(&output)).unwrap();
        // The path is used literally after the expanded home prefix.
        assert_eq!(sniff.remote_bin, path.display().to_string());
        // Only the first `--version` line is reported.
        assert_eq!(sniff.version_output, "redoor 1.2.3");
        // The path's command substitution never ran.
        assert!(!home.path().join("pwned").exists());
    }

    /// The launch script starts a matching binary with its arguments after the report, and
    /// starts nothing when the binary does not match.
    #[tokio::test]
    async fn launch_script_starts_only_a_matching_binary() {
        let home = redoor_core::test_support::TempDir::create();
        let path = home.path().join("bin/redoor");
        let expected = redoor_core::identity::version_line();
        fake_binary(&path, &expected).await;
        let cases = [
            (BinaryExpectation::this_version(), true),
            (
                BinaryExpectation {
                    version: "redoor 0.0.0".to_string(),
                },
                false,
            ),
        ];
        for (expect, starts) in cases {
            let command = sh_command(&expect.launch_script("~/bin/redoor"), &["agent", "a b'c"]);
            let output = run_remote(&command, b"", home.path()).await;
            let report = lines(&output);
            // The report comes first in both outcomes, so the server can show the sniff results.
            let sniff = RemoteSniff::parse("test", &report[..PROBE_REPORT_LINES]).unwrap();
            // The Rust-side check must agree with the script.
            assert_eq!(expect.matches(&sniff), starts, "expect {expect:?}");
            if starts {
                // The decision line is followed by the binary's own output with every argument intact.
                assert_eq!(report[PROBE_REPORT_LINES], LAUNCH_READY);
                assert_eq!(report[PROBE_REPORT_LINES + 1], "agent:agent|agent:a b'c|");
            } else {
                // Nothing runs after the decision line when the binary has to be installed.
                assert_eq!(
                    report[PROBE_REPORT_LINES..],
                    [LAUNCH_NEEDS_INSTALL.to_string()]
                );
            }
        }
    }

    /// The upload script installs the streamed bytes as an executable in one session, and
    /// leaves no temp file behind when a step fails.
    #[tokio::test]
    async fn upload_script_installs_streamed_binary() {
        let home = redoor_core::test_support::TempDir::create();
        let remote_bin = "~/data dir/redoor";
        let remote_tmp = remote_upload_tmp_path(remote_bin, "1-2");
        let binary = b"#!/bin/sh
echo uploaded
";
        let command = sh_command(
            &upload_script(remote_bin, &remote_tmp, binary.len() as u64),
            &[],
        );
        let output = run_remote(&command, binary, home.path()).await;
        // The directory is created and the binary moved into place.
        assert!(
            output.status.success(),
            "upload failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let installed = home.path().join("data dir/redoor");
        let ran = tokio::process::Command::new(&installed)
            .output()
            .await
            .unwrap();
        // The installed file has the streamed bytes and is executable.
        assert_eq!(String::from_utf8_lossy(&ran.stdout).trim_end(), "uploaded");
        // The temp file was renamed, not copied.
        assert!(!home.path().join("data dir/redoor.tmp.1-2").exists());

        // A read-only directory makes `cat` fail after the trap is set up.
        let blocked = home.path().join("blocked");
        tokio::fs::create_dir(&blocked).await.unwrap();
        let mut permissions = tokio::fs::metadata(&blocked).await.unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o555);
        tokio::fs::set_permissions(&blocked, permissions)
            .await
            .unwrap();
        let blocked_bin = "~/blocked/redoor";
        let command = sh_command(
            &upload_script(blocked_bin, &remote_upload_tmp_path(blocked_bin, "3-4"), 4),
            &[],
        );
        let output = run_remote(&command, b"data", home.path()).await;
        // The failure is reported through the exit status.
        assert!(!output.status.success());
        // Nothing is left in the directory.
        let mut entries = tokio::fs::read_dir(&blocked).await.unwrap();
        assert!(entries.next_entry().await.unwrap().is_none());
    }

    /// A stream shorter or longer than the local file is rejected before anything reaches
    /// the final path, so a cut-off upload can never be installed at a trusted debug path.
    #[tokio::test]
    async fn upload_script_rejects_a_stream_of_the_wrong_size() {
        let home = redoor_core::test_support::TempDir::create();
        let remote_bin = "~/debug-0123456789abcdef/redoor";
        let directory = home.path().join("debug-0123456789abcdef");
        let binary = b"#!/bin/sh
echo uploaded
";
        // The stream ended early, then a stream with unexpected extra bytes.
        for (index, received) in [&binary[..10], &[binary.as_slice(), b"extra"].concat()]
            .into_iter()
            .enumerate()
        {
            let command = sh_command(
                &upload_script(
                    remote_bin,
                    &remote_upload_tmp_path(remote_bin, &index.to_string()),
                    binary.len() as u64,
                ),
                &[],
            );
            let output = run_remote(&command, received, home.path()).await;
            // The size mismatch fails the upload, which makes provisioning report it.
            assert!(!output.status.success());
            // The reason names both sizes so the operator can tell a cut-off stream apart.
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains(&format!(
                    "received {} bytes of the binary, expected {}",
                    received.len(),
                    binary.len()
                )),
                "stderr: {stderr}"
            );
            // Neither the final binary nor the temp file is left behind.
            let mut entries = tokio::fs::read_dir(&directory).await.unwrap();
            assert!(entries.next_entry().await.unwrap().is_none());
        }
    }

    /// The cleanup removes other debug builds and the legacy `debug/` install, and keeps
    /// the current build, release installs and other files.
    #[tokio::test]
    async fn stale_debug_cleanup_keeps_only_the_current_build() {
        let home = redoor_core::test_support::TempDir::create();
        let binaries = home.path().join(".local/share/redoor-dev/binaries");
        for directory in [
            "debug-1111111111111111",
            "debug-2222222222222222",
            "debug",
            "1.2.3",
            "debugger",
        ] {
            fake_binary(&binaries.join(directory).join("redoor"), "redoor 1.2.3").await;
        }
        tokio::fs::write(binaries.join("debug-notes"), b"a file, not an install")
            .await
            .unwrap();
        // Another namespace's debug build must survive a cleanup of this one.
        let other_app = home
            .path()
            .join(".local/share/other/binaries/debug-3333333333333333");
        fake_binary(&other_app.join("redoor"), "redoor 1.2.3").await;

        let command = sh_command(
            &stale_debug_cleanup_script("redoor-dev", "2222222222222222"),
            &[],
        );
        let output = run_remote(&command, b"", home.path()).await;
        // Success lets the installer log a completed cleanup.
        assert!(
            output.status.success(),
            "cleanup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut remaining = Vec::new();
        let mut entries = tokio::fs::read_dir(&binaries).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            remaining.push(entry.file_name().to_string_lossy().into_owned());
        }
        remaining.sort();
        // Only the stale debug installs are removed; the kept build, the release install
        // and names that merely start with `debug` are untouched.
        assert_eq!(
            remaining,
            ["1.2.3", "debug-2222222222222222", "debug-notes", "debugger"]
        );
        // The cleanup is scoped to this namespace's binaries directory.
        assert!(other_app.join("redoor").exists());
    }

    /// A binary is matched by its version alone, because its install path already
    /// identifies the bytes.
    #[test]
    fn expectation_matches_by_version() {
        let sniff = |version: &str| RemoteSniff {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            version_output: version.to_string(),
            remote_bin: "/bin/redoor".to_string(),
        };
        let expect = BinaryExpectation::this_version();
        // The release install of this server's version is used as is.
        assert!(expect.matches(&sniff(&redoor_core::identity::version_line())));
        // Another version, or a binary that does not run, has to be installed.
        assert!(!expect.matches(&sniff("redoor 0.0.0")));
        assert!(!expect.matches(&sniff("")));
    }

    /// A local debug build is expected to report its own version, not this server's, so a
    /// build that is newer than the running server still verifies after its upload.
    #[tokio::test]
    async fn local_build_expects_the_build_version() {
        let home = redoor_core::test_support::TempDir::create();
        let path = home.path().join("target/debug/redoor");
        fake_binary(&path, "redoor 999.0.0").await;
        let build = LocalBuildCache::default().get(&path).await.unwrap();
        let expect = BinaryExpectation::of_build(&build);
        // The version comes from the build's first `--version` line.
        assert_eq!(expect.version, "redoor 999.0.0");
        let sniff = RemoteSniff {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            version_output: "redoor 999.0.0".to_string(),
            remote_bin: "/bin/redoor".to_string(),
        };
        // An upload of the build verifies even though this server reports another version.
        assert!(expect.matches(&sniff));
    }

    /// Ensures the upload temp path stays beside the final binary so remote
    /// `mv` is atomic and does not cross filesystems.
    #[test]
    fn remote_upload_tmp_path_stays_in_same_directory() {
        assert_eq!(
            remote_upload_tmp_path(
                "${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/debug-0123456789abcdef/redoor",
                "1-2"
            ),
            "${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/debug-0123456789abcdef/redoor.tmp.1-2"
        );
    }

    /// Verifies remote releases mirror the local versioned binary hierarchy
    /// while using the persistent XDG data location on the target host.
    #[test]
    fn default_remote_bin_uses_versioned_data_hierarchy() {
        assert_eq!(
            default_remote_bin("redoor-dev"),
            format!(
                "${{XDG_DATA_HOME:-$HOME/.local/share}}/redoor-dev/binaries/{}/redoor",
                env!("CARGO_PKG_VERSION")
            ),
            "the remote install should live under the application data hierarchy"
        );
    }

    /// Verifies debug uploads target a content-addressed install path beside, not over,
    /// the versioned release layout, so each build has its own path that identifies it.
    #[test]
    fn debug_remote_bin_is_named_after_the_build_hash() {
        assert_eq!(
            debug_remote_bin("redoor-dev", "0123456789abcdef"),
            "${XDG_DATA_HOME:-$HOME/.local/share}/redoor-dev/binaries/debug-0123456789abcdef/redoor",
            "the debug install path should use the namespace and the build's hash"
        );
    }

    /// Verifies a debug server can provision its exact local build to a host
    /// that can execute the same operating-system and CPU artifact.
    #[test]
    fn selects_debug_binary_for_matching_platform() {
        let path = debug_binary_candidate(
            true,
            "linux",
            "x86_64",
            "linux",
            "x86_64",
            Path::new("/workspace/redoor"),
        );

        // A matching debug build should bypass GitHub and use workspace output.
        assert_eq!(
            path,
            Some(PathBuf::from("/workspace/redoor/target/debug/redoor"))
        );
    }

    /// Verifies the debug binary lookup points at the workspace build output that
    /// `cargo build` produces, not at a per-crate target directory that never exists.
    #[test]
    fn debug_binary_resolves_from_workspace_root() {
        let root = super::workspace_root();
        let manifest = std::fs::read_to_string(root.join("Cargo.toml"))
            .expect("workspace root should contain Cargo.toml");
        // Only the virtual workspace manifest declares `[workspace]`.
        assert!(
            manifest.contains("[workspace]"),
            "{} is not the workspace root",
            root.display()
        );
        let path = debug_binary_candidate(
            true,
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::consts::OS,
            std::env::consts::ARCH,
            &root,
        );
        // The candidate must be `<workspace>/target/debug/redoor`, where the binary is built.
        assert_eq!(path, Some(root.join("target/debug/redoor")));
    }

    /// Verifies release servers keep using release provisioning even when a
    /// stale debug binary happens to remain in the workspace target directory.
    #[test]
    fn ignores_debug_binary_for_release_build() {
        let path = debug_binary_candidate(
            false,
            "linux",
            "x86_64",
            "linux",
            "x86_64",
            Path::new("/workspace/redoor"),
        );

        // Build mode must gate local debug deployment independently of the path.
        assert_eq!(path, None);
    }

    /// Verifies a debug binary is never uploaded to a remote CPU that cannot
    /// execute it, leaving release download selection to choose the right arch.
    #[test]
    fn ignores_debug_binary_for_different_architecture() {
        let path = debug_binary_candidate(
            true,
            "linux",
            "x86_64",
            "linux",
            "aarch64",
            Path::new("/workspace/redoor"),
        );

        // Architecture mismatches must fall back rather than fail after upload.
        assert_eq!(path, None);
    }

    /// Verifies matching CPU names alone are insufficient when the remote host
    /// uses another executable format and system ABI.
    #[test]
    fn ignores_debug_binary_for_different_operating_system() {
        let path = debug_binary_candidate(
            true,
            "linux",
            "aarch64",
            "macos",
            "aarch64",
            Path::new("/workspace/redoor"),
        );

        // OS mismatches must use the platform-specific GitHub artifact instead.
        assert_eq!(path, None);
    }
}
