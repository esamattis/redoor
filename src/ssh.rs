//! `redoor ssh` subcommand: starts a redoor agent on a remote host through
//! ssh and tunnels the local redoor server port to the remote host so the
//! agent can connect back to the server running on the machine that issued
//! the ssh command.

use clap::Args;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use redoor::{Level, log};

/// Arguments for `redoor ssh`.
///
/// Mirrors the familiar `ssh` invocation (`-l user -p port user@host`) while
/// adding a redoor port option that controls both the local server port that
/// is forwarded and the remote tunnel port the agent connects to, so callers
/// can override the default 3000 without repeating themselves on both sides
/// of the tunnel.
#[derive(Args)]
#[command(author, version, about)]
pub(crate) struct SshArgs {
    /// SSH login username. Forwarded to ssh via `-l`. Optional so that
    /// ssh config (`~/.ssh/config`) or the `user@host` target syntax can
    /// supply the username instead.
    #[arg(short = 'l')]
    pub(crate) username: Option<String>,
    /// SSH server port. Forwarded to ssh via `-p`.
    #[arg(short = 'p', default_value_t = 22)]
    pub(crate) ssh_port: u16,
    /// Redoor server port running on the local machine that is forwarded to
    /// the remote host. The agent on the remote host connects to
    /// `ws://localhost:<port>/ws` which tunnels back to the local server.
    #[arg(long, env = "REDOOR_PORT", default_value_t = 3000)]
    pub(crate) redoor_port: u16,
    /// Name the remote agent registers with on the server. Defaults to the
    /// host portion of the ssh target so multiple ssh agents are naturally
    /// distinguishable without requiring an explicit name.
    #[arg(long)]
    pub(crate) name: Option<String>,
    /// Path to the redoor binary on the remote host. Defaults to the
    /// versioned install layout (`~/.local/redoor/<version>/redoor`).
    #[arg(long, env = "REDOOR_REMOTE_BIN", default_value_t = default_remote_bin())]
    pub(crate) remote_bin: String,
    /// Working directory the remote redoor agent switches into via its
    /// `-d/--dir` flag, mirroring the operator's `redoor agent -d`. Useful
    /// for keeping relative paths and local uploads confined to a project
    /// tree on the remote host without changing ssh's own cwd.
    #[arg(short = 'd', long)]
    pub(crate) dir: Option<String>,
    /// Remote ssh target in `user@host` form. Kept positional to mirror the
    /// standard ssh CLI usage so existing muscle memory transfers.
    pub(crate) target: String,
}

/// Default remote redoor binary path when the user does not override it
/// via `--remote-bin` or `REDOOR_REMOTE_BIN`.
fn default_remote_bin() -> String {
    format!("~/.local/redoor/{}/redoor", env!("CARGO_PKG_VERSION"))
}

/// Derives a default agent name from the ssh target by stripping any
/// `user@` prefix so the name reflects the host being connected to.
fn default_agent_name(target: &str) -> String {
    target.rsplit('@').next().unwrap_or(target).to_string()
}

/// Configuration for one ssh-backed agent, independent of any specific CLI
/// surface so both `redoor ssh` and `redoor server --agents` can construct it
/// without depending on clap.
///
/// `remote_bin` is optional so callers that want the versioned default
/// (`~/.local/redoor/<version>/redoor`) don't have to compute it themselves;
/// `start_ssh_agent` fills it in when `None`.
#[derive(Debug, Clone)]
pub(crate) struct SshAgentConfig {
    /// SSH login username. Forwarded to ssh via `-l`. When `None`, ssh config
    /// or the `user@host` target syntax supplies the username.
    pub(crate) username: Option<String>,
    /// SSH server port. Forwarded to ssh via `-p`.
    pub(crate) ssh_port: u16,
    /// Name the remote agent registers with on the server. When `None`,
    /// defaults to the host portion of `target`.
    pub(crate) name: Option<String>,
    /// Path to the redoor binary on the remote host. When `None`, defaults to
    /// the versioned install layout.
    pub(crate) remote_bin: Option<String>,
    /// Working directory the remote redoor agent switches into via its
    /// `-d/--dir` flag, mirroring the operator's `redoor agent -d`. When
    /// `None`, the agent uses the remote shell's current directory.
    pub(crate) dir: Option<String>,
    /// Remote ssh target in `user@host` form.
    pub(crate) target: String,
    /// Optional local log file path. When set, the ssh process's
    /// stdout/stderr is redirected to this file so the remote agent's
    /// logs (forwarded through ssh) are captured locally. The file is
    /// opened in append mode so agent restarts accumulate logs.
    pub(crate) log: Option<String>,
}

/// Result of probing a remote host: which OS/arch it runs and whether the
/// configured redoor binary is already executable at the target path.
struct RemoteSniff {
    os: String,
    arch: String,
    binary_exists: bool,
}

/// Probes the remote host with a single ssh command that reports its OS,
/// CPU architecture, and whether the configured redoor binary is already
/// executable at `remote_bin`. Batching all three into one round-trip
/// avoids paying ssh setup latency three times for what is conceptually
/// one "is the host ready" check.
async fn sniff_remote(
    host: &SshHost,
    remote_bin: &str,
) -> Result<RemoteSniff, Box<dyn std::error::Error>> {
    // The whole probe is one shell command so we only authenticate once.
    // `test -x` is used instead of `test -f` so a broken symlink or a
    // non-executable file is treated as "needs reinstall" rather than
    // "already installed".
    let shell_command = format!(
        "echo \"$(uname),$(uname -m),$(test -x {} && echo yes || echo no)\"",
        remote_bin
    );
    let options = SshRunOptions::default().compressed();
    let output = host.run_captured(&shell_command, &options).await?;
    let trimmed = output.trim();
    let parts: Vec<&str> = trimmed.split(',').collect();
    if parts.len() != 3 {
        return Err(format!(
            "unexpected ssh sniff output '{}': expected '<os>,<arch>,<yes|no>'",
            trimmed
        )
        .into());
    }
    // Map `uname` values to the os component used in the release artifact
    // filenames (e.g. `redoor-aarch64-linux.tar.gz`).
    let os = match parts[0] {
        "Linux" => "linux",
        "Darwin" => "macos",
        other => return Err(format!("unsupported remote os '{}'", other).into()),
    };
    // macOS reports `arm64` for Apple Silicon but the release artifacts use
    // `aarch64`, so normalize before looking up the download URL.
    let arch = match parts[1] {
        "x86_64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        other => return Err(format!("unsupported remote arch '{}'", other).into()),
    };
    let binary_exists = parts[2] == "yes";
    log!(
        Level::Info,
        "Remote sniff: os={}, arch={}, binary_exists={}",
        os,
        arch,
        binary_exists
    );
    Ok(RemoteSniff {
        os: os.to_string(),
        arch: arch.to_string(),
        binary_exists,
    })
}

/// Local cache directory for redoor release binaries downloaded from GitHub.
/// Caching avoids re-downloading the same tarball on every `redoor ssh` call
/// against the same remote target.
fn local_binaries_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME must be set");
    PathBuf::from(home).join(".local/share/redoor/binaries")
}

/// Final on-disk name of the cached binary for a given (version, os, arch).
/// Embedding all three in the filename lets multiple targets coexist in the
/// same cache directory and makes it obvious which file matches which host.
fn cached_binary_path(version: &str, os: &str, arch: &str) -> PathBuf {
    local_binaries_dir().join(format!("redoor-v{}-{}-{}", version, os, arch))
}

/// Builds the GitHub release download URL for a given (version, os, arch).
/// The artifact naming follows the release workflow in
/// `.github/workflows/release.yml` (`redoor-<arch>-<os>.tar.gz`).
fn release_url(version: &str, os: &str, arch: &str) -> String {
    format!(
        "https://github.com/esamattis/redoor/releases/download/v{}/redoor-{}-{}.tar.gz",
        version, arch, os
    )
}

/// Ensures the matching redoor binary is present in the local cache,
/// downloading and extracting it from GitHub releases on a cache miss.
/// Returns the absolute path to the cached binary.
async fn ensure_local_binary(
    version: &str,
    os: &str,
    arch: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let binaries_dir = local_binaries_dir();
    tokio::fs::create_dir_all(&binaries_dir).await?;
    let final_path = cached_binary_path(version, os, arch);
    if tokio::fs::try_exists(&final_path).await? {
        log!(
            Level::Info,
            "Local binary already cached: path={}",
            final_path.display()
        );
        return Ok(final_path);
    }
    download_binary(version, os, arch, &binaries_dir, &final_path).await?;
    Ok(final_path)
}

/// Downloads the release tarball from GitHub and extracts the `redoor`
/// binary into `final_path`. The tarball is streamed to disk and extracted
/// with the system `tar` command so we never hold the whole archive (or
/// the binary) in memory at once.
async fn download_binary(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    final_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use futures_util::StreamExt;

    let url = release_url(version, os, arch);
    let tar_path = binaries_dir.join(format!("redoor-{}-{}.tar.gz", arch, os));
    let extract_dir = binaries_dir.join(format!("extract-v{}-{}-{}", version, arch, os));

    log!(
        Level::Info,
        "Downloading redoor binary: version={}, os={}, arch={}",
        version,
        os,
        arch
    );

    // Stream the response body to disk chunk by chunk so large tarballs
    // don't have to fit in RAM, which matters on memory-constrained hosts.
    let response = reqwest::get(&url).await?;
    if !response.status().is_success() {
        return Err(format!("download from {} failed: HTTP {}", url, response.status()).into());
    }
    let mut file = tokio::fs::File::create(&tar_path).await?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    // Use the system `tar` rather than the `tar` crate so extraction
    // matches exactly what the release workflow used to create the archive,
    // including any platform-specific flags.
    tokio::fs::create_dir_all(&extract_dir).await?;
    let tar_status = Command::new("tar")
        .arg("-xzf")
        .arg(&tar_path)
        .arg("-C")
        .arg(&extract_dir)
        .status()
        .await?;
    if !tar_status.success() {
        return Err(format!(
            "tar extraction failed with status {}",
            tar_status.code().unwrap_or(-1)
        )
        .into());
    }

    // The release archive contains a single `redoor` binary; move it to the
    // versioned cache path so future `redoor ssh` calls hit the cache.
    let extracted_bin = extract_dir.join("redoor");
    if !tokio::fs::try_exists(&extracted_bin).await? {
        return Err(format!(
            "extracted tarball did not contain a 'redoor' binary at {}",
            extracted_bin.display()
        )
        .into());
    }
    // Copy + remove rather than rename so it works even if `extract_dir`
    // ends up on a different filesystem than `final_path` (e.g. tmpfs).
    tokio::fs::copy(&extracted_bin, final_path).await?;
    let _ = make_executable(final_path).await;

    // Best-effort cleanup of the intermediate extraction artifacts; failures
    // here are harmless and shouldn't abort the upload.
    let _ = tokio::fs::remove_file(&tar_path).await;
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;

    log!(
        Level::Info,
        "Binary download complete: path={}",
        final_path.display()
    );

    Ok(())
}

/// Sets the executable bit on `path` so the cached binary can be uploaded
/// and run on the remote host without an extra `chmod` round-trip.
async fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = tokio::fs::metadata(path).await?;
    let mut perms = metadata.permissions();
    perms.set_mode(0o755);
    tokio::fs::set_permissions(path, perms).await
}

/// Returns the parent directory of a posix-style path that may start with
/// `~`. We split on the last `/` so `~/.local/redoor/0.0.3/redoor` becomes
/// `~/.local/redoor/0.0.3`, which the remote shell can still expand.
fn parent_dir_of(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => ".".to_string(),
    }
}

/// Uploads the locally cached binary to the remote host by piping it
/// through `ssh ... 'cat > remote_path'`. Creates the remote parent
/// directory and marks the binary executable so it is ready to run
/// immediately, even when `cat` did not preserve the local mode bits.
async fn upload_binary(
    host: &SshHost,
    local_path: &Path,
    remote_bin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let parent = parent_dir_of(remote_bin);
    let options = SshRunOptions::default().compressed();

    log!(
        Level::Info,
        "Uploading binary to remote host: local_path={}, remote_bin={}",
        local_path.display(),
        remote_bin
    );

    // The remote parent directory may not exist yet (e.g. first run against
    // a fresh host), so create it before `cat` tries to write into it.
    let mkdir_cmd = format!("mkdir -p {}", parent);
    let mkdir_status = host.run(&mkdir_cmd, &[], &options).await?;
    if !mkdir_status.success() {
        return Err(format!(
            "remote mkdir '{}' failed with status {}",
            parent,
            mkdir_status.code().unwrap_or(-1)
        )
        .into());
    }

    host.upload_via_cat(local_path, remote_bin).await?;

    // `cat` does not always copy the source mode bits across ssh, so be
    // explicit: a non-executable cached file would otherwise produce a
    // remote binary that fails with "permission denied" on the next step.
    let chmod_cmd = format!("chmod +x {}", remote_bin);
    let chmod_status = host.run(&chmod_cmd, &[], &options).await?;
    if !chmod_status.success() {
        return Err(format!(
            "remote chmod +x '{}' failed with status {}",
            remote_bin,
            chmod_status.code().unwrap_or(-1)
        )
        .into());
    }

    log!(
        Level::Info,
        "Binary upload complete: remote_bin={}",
        remote_bin
    );

    Ok(())
}

/// One end of a reverse port forward: ssh listens on `remote_port` at the
/// remote host and tunnels connections to `local_port` on the machine that
/// started ssh. Both ports are usually the same redoor port, but they are
/// kept separate so callers can map onto a different local port if needed.
#[derive(Clone, Copy)]
pub(crate) struct ReverseForward {
    pub(crate) remote_port: u16,
    pub(crate) local_port: u16,
}

/// Options for [`SshHost::run`] that are orthogonal to the remote command,
/// such as reverse port forwards and whether ssh should compress its traffic.
#[derive(Default)]
pub(crate) struct SshRunOptions {
    /// Reverse port forwards (`ssh -R`) to request on this connection.
    pub(crate) reverse_forwards: Vec<ReverseForward>,
    /// When true, adds `-C` so ssh compresses its traffic. Useful for bulk
    /// transfers like binary uploads and the one-shot sniff command; left off
    /// for the long-running agent session which is mostly idle and would just
    /// burn CPU on compression.
    pub(crate) compressed: bool,
    /// When set, the ssh process's stdout/stderr is redirected (append
    /// mode) to this local file path. Used only for the long-running
    /// agent run so sniff/upload diagnostics still go to the terminal.
    pub(crate) log_file: Option<String>,
}

impl SshRunOptions {
    /// Adds a reverse forward mapping `remote_port` on the ssh host to
    /// `local_port` on this machine.
    pub(crate) fn with_reverse_forward(mut self, remote_port: u16, local_port: u16) -> Self {
        self.reverse_forwards.push(ReverseForward {
            remote_port,
            local_port,
        });
        self
    }

    /// Enables ssh compression (`-C`) for this connection.
    pub(crate) fn compressed(mut self) -> Self {
        self.compressed = true;
        self
    }

    /// Sets a local log file to redirect the ssh process's stdout/stderr into.
    pub(crate) fn with_log_file(mut self, path: impl Into<String>) -> Self {
        self.log_file = Some(path.into());
        self
    }
}

/// Represents an ssh reachable host and builds `ssh` invocations against it.
///
/// Encapsulates the ssh connection parameters (user, port, target) so the
/// `run` method can stay focused on the remote command and its options. The
/// builder methods return `Self` by value so callers can chain configuration
/// fluently before awaiting [`SshHost::run`].
pub(crate) struct SshHost {
    username: Option<String>,
    ssh_port: u16,
    target: String,
}

impl SshHost {
    /// Starts building an ssh connection to `target` (e.g. `user@host`).
    pub(crate) fn new(target: String) -> Self {
        Self {
            username: None,
            ssh_port: 22,
            target,
        }
    }

    /// Sets the ssh login username (`ssh -l`).
    pub(crate) fn username(mut self, username: Option<String>) -> Self {
        self.username = username;
        self
    }

    /// Sets the ssh server port (`ssh -p`). Defaults to 22 if not called.
    pub(crate) fn ssh_port(mut self, port: u16) -> Self {
        self.ssh_port = port;
        self
    }

    /// Spawns `ssh` to execute `command` with `args` on the remote host,
    /// applying the forwards and forwarding-failure behavior described by
    /// `options`. Stdio is inherited so the user can observe remote output
    /// and interact with the process when needed.
    ///
    /// Returns the ssh exit status. Callers are responsible for translating
    /// a non-zero status into their own error handling.
    pub(crate) async fn run(
        &self,
        command: &str,
        args: &[&str],
        options: &SshRunOptions,
    ) -> Result<std::process::ExitStatus, std::io::Error> {
        let mut ssh = Command::new("ssh");

        if let Some(ref username) = self.username {
            ssh.arg("-l").arg(username);
        }
        ssh.arg("-p").arg(self.ssh_port.to_string());

        if options.compressed {
            ssh.arg("-C");
        }

        // Always fail fast if a requested reverse forward cannot be bound.
        // Without this, ssh keeps running and the remote command executes
        // against a tunnel that will never come up.
        ssh.arg("-o").arg("ExitOnForwardFailure=yes");

        for forward in &options.reverse_forwards {
            let spec = format!("{}:localhost:{}", forward.remote_port, forward.local_port);
            ssh.arg("-R").arg(spec);
        }

        ssh.arg(&self.target);
        ssh.arg(command);
        for arg in args {
            ssh.arg(arg);
        }

        ssh.stdin(Stdio::inherit());

        if let Some(log_path) = &options.log_file {
            // Open in append mode via the async tokio API, then convert to a
            // std::fs::File so it can be turned into a Stdio for the child.
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .await?;
            // Clone the handle so stdout and stderr can both write to the same file.
            let file_for_stderr = file.try_clone().await?;
            let stdout_file = file.into_std().await;
            let stderr_file = file_for_stderr.into_std().await;
            ssh.stdout(Stdio::from(stdout_file));
            ssh.stderr(Stdio::from(stderr_file));
        } else {
            ssh.stdout(Stdio::inherit());
            ssh.stderr(Stdio::inherit());
        }

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        ssh.status().await
    }

    /// Runs a single shell command on the remote host and captures its
    /// stdout. Used for one-shot "sniff" commands whose output we need to
    /// parse locally rather than stream to the user. Stderr is still
    /// inherited so authentication errors and similar diagnostics stay
    /// visible.
    pub(crate) async fn run_captured(
        &self,
        shell_command: &str,
        options: &SshRunOptions,
    ) -> Result<String, std::io::Error> {
        let mut ssh = Command::new("ssh");

        if let Some(ref username) = self.username {
            ssh.arg("-l").arg(username);
        }
        ssh.arg("-p").arg(self.ssh_port.to_string());

        if options.compressed {
            ssh.arg("-C");
        }

        // Always fail fast if a requested reverse forward cannot be bound.
        // Without this, ssh keeps running and the remote command executes
        // against a tunnel that will never come up.
        ssh.arg("-o").arg("ExitOnForwardFailure=yes");

        for forward in &options.reverse_forwards {
            let spec = format!("{}:localhost:{}", forward.remote_port, forward.local_port);
            ssh.arg("-R").arg(spec);
        }

        ssh.arg(&self.target);
        ssh.arg(shell_command);

        ssh.stdin(Stdio::null());
        ssh.stdout(Stdio::piped());
        ssh.stderr(Stdio::inherit());

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        let output = ssh.output().await?;
        if !output.status.success() {
            return Err(std::io::Error::other(format!(
                "ssh exited with status {} while running: {}",
                output.status.code().unwrap_or(-1),
                shell_command
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Streams `local_path` to the remote host by piping it into
    /// `cat > remote_path` over ssh with compression enabled. Streaming
    /// (rather than scp/sftp) keeps the implementation simple and avoids
    /// reading the entire binary into memory, which matters when the binary
    /// is large or memory is constrained. The remote path is interpreted by
    /// the remote shell so `~` and other shell expansions work as expected.
    pub(crate) async fn upload_via_cat(
        &self,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<(), std::io::Error> {
        let mut ssh = Command::new("ssh");

        if let Some(ref username) = self.username {
            ssh.arg("-l").arg(username);
        }
        ssh.arg("-p").arg(self.ssh_port.to_string());
        // Compress the upload stream so large binaries transfer faster over
        // slow uplinks. ssh compression is cheap and transparent here.
        ssh.arg("-C");
        ssh.arg(&self.target);
        ssh.arg(format!("cat > {}", remote_path));

        ssh.stdin(Stdio::piped());
        ssh.stdout(Stdio::inherit());
        ssh.stderr(Stdio::inherit());

        log!(Level::Debug, "Running ssh command: {:?}", ssh);

        let mut child = ssh.spawn()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut file = tokio::fs::File::open(local_path).await?;

        // Run the copy on a separate task so we can concurrently wait for
        // the child. If the remote `cat` exits early (e.g. disk full), the
        // stdin pipe closes and the copy errors out; without the spawn we
        // would deadlock waiting on a write that never completes.
        let copy_handle = tokio::spawn(async move {
            tokio::io::copy(&mut file, &mut stdin).await?;
            // Drop stdin to send EOF so the remote `cat` flushes and exits.
            drop(stdin);
            Ok::<_, std::io::Error>(())
        });

        let status = child.wait().await?;
        copy_handle
            .await
            .map_err(|e| std::io::Error::other(format!("copy task panicked: {e}")))??;

        if !status.success() {
            return Err(std::io::Error::other(format!(
                "ssh upload exited with status {}",
                status.code().unwrap_or(-1)
            )));
        }
        Ok(())
    }
}

/// Spawns `ssh` with reverse port forwarding and starts a redoor agent on
/// the remote host.
///
/// Reverse port forwarding (`-R`) is used because the redoor server is
/// running on the local machine and the agent is on the remote host. `-R`
/// makes the remote host listen on `<redoor_port>` and tunnel connections
/// back to `localhost:<redoor_port>` on the local machine where the server
/// is listening. The agent then connects to `ws://localhost:<redoor_port>/ws`
/// on the remote host, which reaches the local server through the tunnel.
/// Stdio is inherited so the user can observe agent logs and interact with
/// the remote shell when needed.
pub(crate) async fn run(args: SshArgs) -> Result<(), Box<dyn std::error::Error>> {
    let config = SshAgentConfig {
        username: args.username,
        ssh_port: args.ssh_port,
        name: args.name,
        // `SshArgs` already resolved the default via clap's `default_value_t`,
        // so forward it as-is rather than re-deriving it in `start_ssh_agent`.
        remote_bin: Some(args.remote_bin),
        dir: args.dir,
        target: args.target,
        log: None,
    };
    start_ssh_agent(config, args.redoor_port).await
}

/// Core implementation shared by `redoor ssh` and `redoor server --agents`:
/// probes the remote host, installs the redoor binary if missing, then starts
/// a redoor agent on the remote host with a reverse port forward back to
/// `redoor_port` on the local machine.
///
/// Returns an error (rather than calling `process::exit`) so the server can
/// log per-agent failures without taking down the whole process when one
/// host is unreachable.
pub(crate) async fn start_ssh_agent(
    config: SshAgentConfig,
    redoor_port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let remote_bin = config.remote_bin.unwrap_or_else(default_remote_bin);
    let agent_name = config
        .name
        .clone()
        .unwrap_or_else(|| default_agent_name(&config.target));
    let ws_url = format!("ws://localhost:{}/ws", redoor_port);

    let host = SshHost::new(config.target)
        .username(config.username)
        .ssh_port(config.ssh_port);

    // Sniff the remote host before starting the agent so we can install the
    // redoor binary on first contact. Without this, a fresh remote host
    // would just fail with "command not found" and the user would have to
    // install the binary manually, which defeats the purpose of `redoor ssh`.
    let sniff = sniff_remote(&host, &remote_bin).await?;
    if !sniff.binary_exists {
        log!(
            Level::Info,
            "Remote binary not found, downloading and uploading"
        );
        let local_path =
            ensure_local_binary(env!("CARGO_PKG_VERSION"), &sniff.os, &sniff.arch).await?;
        upload_binary(&host, &local_path, &remote_bin).await?;
    }

    // The reverse forward is a run-time option because it describes the
    // tunnel, not the remote command itself. ExitOnForwardFailure is always
    // enabled so the agent fails fast if its tunnel cannot be established.
    let mut options = SshRunOptions::default().with_reverse_forward(redoor_port, redoor_port);
    if let Some(log) = &config.log {
        options = options.with_log_file(log);
    }

    // ssh joins all trailing args after the command into one remote argv, so
    // the agent name must be appended after the fixed flags. The optional
    // `-d/--dir` is appended last so its absence matches the local agent's
    // default of inheriting the current working directory.
    let mut remote_argv: Vec<&str> = vec!["agent", &ws_url, "--name", &agent_name];
    if let Some(dir) = &config.dir {
        remote_argv.push("-d");
        remote_argv.push(dir);
    }

    log!(
        Level::Info,
        "Starting redoor agent on remote host: name={}, ws_url={}, remote_bin={}, dir={:?}, log={:?}",
        agent_name,
        ws_url,
        remote_bin,
        config.dir,
        config.log,
    );

    let status = host.run(&remote_bin, &remote_argv, &options).await?;
    if !status.success() {
        return Err(format!(
            "ssh agent exited with status {}",
            status.code().unwrap_or(-1)
        )
        .into());
    }
    Ok(())
}
