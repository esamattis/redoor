//! Selects, verifies, and streams compatible agent binaries to remote hosts.

use std::path::{Path, PathBuf};

use redoor::{Level, log};
use tokio::io::AsyncReadExt;

use super::transport::{SshHost, SshRunOptions};

/// Default remote redoor binary path when the user does not override it
/// via `--remote-bin` or `REDOOR_REMOTE_BIN`.
pub(super) fn default_remote_bin() -> anyhow::Result<String> {
    Ok(format!(
        "${{XDG_DATA_HOME:-$HOME/.local/share}}/{}/binaries/{}/redoor",
        crate::app_name::app_name()?,
        env!("CARGO_PKG_VERSION")
    ))
}

/// Dedicated remote path for local debug binary uploads so iterative debug
/// deploys never overwrite a versioned release install on the same host.
fn debug_remote_bin() -> anyhow::Result<String> {
    Ok(format!(
        "${{XDG_DATA_HOME:-$HOME/.local/share}}/{}/binaries/debug/redoor",
        crate::app_name::app_name()?
    ))
}

/// Result of probing a remote host: which OS/arch it runs, what its existing
/// redoor binary reports for `--version`, and the SHA-1 of that binary file
/// (empty version/sha1 when there is no readable binary at the path).
pub(super) struct RemoteSniff {
    os: String,
    arch: String,
    /// Stdout of `<remote_bin> --version` with leading/trailing whitespace
    /// stripped. Empty when the binary is missing, not executable, or
    /// otherwise fails to run, in which case it needs to be (re)installed.
    version_output: String,
    /// Lowercase hex SHA-1 of the remote binary file contents. Empty when the
    /// file is missing or unreadable. Used to skip re-upload when the remote
    /// bytes already match the local binary (critical for debug builds where
    /// `--version` stays constant across rebuilds).
    sha1sum: String,
}

/// Probes the remote host with a single ssh command that reports its OS,
/// CPU architecture, the `--version` output of the configured redoor binary,
/// and that binary's SHA-1. Batching into one round-trip avoids paying ssh
/// setup latency multiple times for what is conceptually one "is the host
/// ready" check.
pub(super) async fn sniff_remote(
    host: &SshHost,
    remote_bin: &str,
) -> Result<RemoteSniff, Box<dyn std::error::Error>> {
    // The whole probe is one shell command so we only authenticate once.
    // We probe with `--version` instead of `test -x` so a binary that
    // exists at the path but is broken, the wrong program, or a stale
    // version still gets reinstalled -- we trust the remote report only
    // when it matches the version this client was built against.
    // SHA-1 is collected in the same pass so debug deploys can skip upload
    // when the remote file already matches the local bytes. Prefer
    // `sha1sum` (Linux) and fall back to `shasum` (macOS).
    let shell_command = format!(
        "echo \"$(uname),$(uname -m),$({bin} --version 2>/dev/null),$((sha1sum {bin} 2>/dev/null || shasum -a 1 {bin} 2>/dev/null) | awk '{{print $1}}')\"",
        bin = remote_bin
    );
    let options = SshRunOptions::default().compressed();
    let output = host.run_captured(&shell_command, &options).await?;
    let trimmed = output.trim();
    let parts: Vec<&str> = trimmed.split(',').collect();
    if parts.len() != 4 {
        return Err(format!(
            "unexpected ssh sniff output '{}': expected '<os>,<arch>,<version>,<sha1sum>'",
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
    let version_output = parts[2].trim().to_string();
    let sha1sum = parts[3].trim().to_string();
    log!(
        Level::Info,
        "Remote sniff: os={}, arch={}, version_output='{}', sha1sum='{}'",
        os,
        arch,
        version_output,
        sha1sum
    );
    Ok(RemoteSniff {
        os: os.to_string(),
        arch: arch.to_string(),
        version_output,
        sha1sum,
    })
}

/// Streams `path` through SHA-1 so large binaries never need to sit fully in
/// memory, matching the same digest the remote `sha1sum`/`shasum` probe uses.
async fn file_sha1sum(path: &Path) -> Result<String, std::io::Error> {
    use sha1::{Digest, Sha1};

    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Ensures the remote host has the appropriate redoor binary and returns the
/// remote path the agent should run. A debug server uploads its local debug
/// binary to the dedicated `debug` install path when it exists and matches
/// the remote platform, so debug deploys never clobber a versioned release
/// install. Upload is skipped when the remote file's SHA-1 already matches
/// the local binary, which is how debug rebuilds avoid a full copy on every
/// agent restart. Otherwise, a matching remote version is retained at the
/// versioned path and stale binaries are replaced with the matching GitHub
/// release artifact. The post-upload probe catches wrong-architecture or
/// corrupted uploads before agent startup.
pub(super) async fn ensure_remote_binary(
    host: &SshHost,
    versioned_remote_bin: &str,
    sniff: &RemoteSniff,
) -> Result<String, Box<dyn std::error::Error>> {
    let expected = format!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
    let debug_binary = available_debug_binary(&sniff.os, &sniff.arch).await?;

    let (local_path, remote_bin) = if let Some(debug_binary) = debug_binary {
        // Use a dedicated path so a debug binary never overwrites the versioned one.
        // Content equality is decided by SHA-1 below because `--version` cannot
        // tell whether the remote executable contains the current local debug code.
        let remote_bin = debug_remote_bin()?;
        log!(
            Level::Info,
            "Using local debug binary for matching remote platform: path={}, remote_bin={}, os={}, arch={}",
            debug_binary.display(),
            remote_bin,
            sniff.os,
            sniff.arch
        );
        (debug_binary, remote_bin)
    } else {
        if sniff.version_output == expected {
            return Ok(versioned_remote_bin.to_string());
        }
        log!(
            Level::Info,
            "Remote binary missing or version mismatch (got '{}', want '{}'), reinstalling",
            sniff.version_output,
            expected
        );
        let local_path =
            crate::binaries::ensure_local_binary(env!("CARGO_PKG_VERSION"), &sniff.os, &sniff.arch)
                .await?;
        (local_path, versioned_remote_bin.to_string())
    };

    let local_sha1 = file_sha1sum(&local_path).await?;
    // Initial sniff targets the versioned path; debug installs live elsewhere
    // and need their own SHA-1 before we can decide whether to upload.
    let remote_sha1 = if remote_bin == versioned_remote_bin {
        sniff.sha1sum.clone()
    } else {
        sniff_remote(host, &remote_bin).await?.sha1sum
    };

    if !remote_sha1.is_empty() && remote_sha1 == local_sha1 {
        log!(
            Level::Info,
            "Remote binary already matches local sha1sum, skipping upload: remote_bin={}, sha1sum={}",
            remote_bin,
            local_sha1
        );
        return Ok(remote_bin);
    }

    log!(
        Level::Info,
        "Remote binary sha1sum differs or missing (remote='{}', local='{}'), uploading: remote_bin={}",
        remote_sha1,
        local_sha1,
        remote_bin
    );

    upload_binary(host, &local_path, &remote_bin).await?;
    let post_upload = sniff_remote(host, &remote_bin).await?;
    // Prefer SHA-1 over `--version` for integrity: debug builds keep the same
    // version string across rebuilds, so only the digest proves the bytes landed.
    if post_upload.sha1sum != local_sha1 {
        return Err(format!(
            "remote binary at {} sha1sum mismatch after upload: got '{}', want '{}'",
            remote_bin, post_upload.sha1sum, local_sha1
        )
        .into());
    }
    if post_upload.version_output != expected {
        return Err(format!(
            "remote binary at {} did not report expected version after upload: got '{}', want '{}'",
            remote_bin, post_upload.version_output, expected
        )
        .into());
    }
    log!(
        Level::Info,
        "Remote binary verified after upload: version='{}', sha1sum='{}'",
        post_upload.version_output,
        post_upload.sha1sum
    );
    Ok(remote_bin)
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
        Path::new(env!("CARGO_MANIFEST_DIR")),
    );

    match candidate {
        Some(path) if tokio::fs::try_exists(&path).await? => Ok(Some(path)),
        _ => Ok(None),
    }
}

/// Returns the parent directory of a posix-style path that may start with
/// `~`. We split on the last `/` so a versioned data path becomes its
/// containing directory while leaving the leading `~` for the remote shell.
fn parent_dir_of(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => ".".to_string(),
    }
}

/// Sibling temp path for atomic remote binary replace. Keeping the temp file
/// in the same directory as `remote_bin` ensures `mv` stays on one filesystem
/// and can rename over a still-running executable without ETXTBSY.
fn remote_upload_tmp_path(remote_bin: &str, unique: &str) -> String {
    format!("{remote_bin}.tmp.{unique}")
}

/// Uploads the locally cached binary to the remote host by streaming into a
/// sibling temp path, then atomically `mv` over the final path. In-place
/// `cat > remote_bin` fails with ETXTBSY ("text file busy") when a previous
/// agent is still executing that binary; rename replaces the directory entry
/// while the old inode stays mapped until that process exits. Creates the
/// remote parent directory and marks the temp binary executable so the moved
/// file is ready to run even when `cat` did not preserve local mode bits.
async fn upload_binary(
    host: &SshHost,
    local_path: &Path,
    remote_bin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let parent = parent_dir_of(remote_bin);
    let options = SshRunOptions::default().compressed();
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let remote_tmp = remote_upload_tmp_path(remote_bin, &unique);

    log!(
        Level::Info,
        "Uploading binary to remote host: local_path={}, remote_bin={}, remote_tmp={}",
        local_path.display(),
        remote_bin,
        remote_tmp
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

    if let Err(error) = host.upload_via_cat(local_path, &remote_tmp).await {
        // Drop a partial temp so failed prepares do not litter the install dir.
        let _ = host
            .run(&format!("rm -f {}", remote_tmp), &[], &options)
            .await;
        return Err(format!(
            "failed to upload binary to temporary remote path '{}': {}",
            remote_tmp, error
        )
        .into());
    }

    // `cat` does not always copy the source mode bits across ssh, so be
    // explicit on the temp path before rename: a non-executable file would
    // otherwise produce a remote binary that fails with "permission denied".
    let chmod_cmd = format!("chmod +x {}", remote_tmp);
    let chmod_status = host.run(&chmod_cmd, &[], &options).await?;
    if !chmod_status.success() {
        let _ = host
            .run(&format!("rm -f {}", remote_tmp), &[], &options)
            .await;
        return Err(format!(
            "remote chmod +x '{}' failed with status {}",
            remote_tmp,
            chmod_status.code().unwrap_or(-1)
        )
        .into());
    }

    // rename replaces the path even if remote_bin is currently executing.
    let mv_cmd = format!("mv -f {} {}", remote_tmp, remote_bin);
    let mv_status = host.run(&mv_cmd, &[], &options).await?;
    if !mv_status.success() {
        let _ = host
            .run(&format!("rm -f {}", remote_tmp), &[], &options)
            .await;
        return Err(format!(
            "remote mv -f '{}' -> '{}' failed with status {}",
            remote_tmp,
            remote_bin,
            mv_status.code().unwrap_or(-1)
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

#[cfg(test)]
mod tests {
    use super::{
        debug_binary_candidate, debug_remote_bin, default_remote_bin, file_sha1sum,
        remote_upload_tmp_path,
    };
    use std::path::{Path, PathBuf};

    /// Verifies local SHA-1 matches the well-known digest for a fixed payload so
    /// remote `sha1sum` comparisons cannot drift from a buggy hasher.
    #[tokio::test]
    async fn file_sha1sum_matches_known_digest() {
        let dir = std::env::temp_dir().join(format!("redoor-sha1-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("payload.bin");
        tokio::fs::write(&path, b"redoor").await.unwrap();

        // echo -n redoor | sha1sum
        let digest = file_sha1sum(&path).await.unwrap();
        assert_eq!(digest, "5cd57297d6ccaa26976cb250ba018adbc98d5907");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Ensures the upload temp path stays beside the final binary so remote
    /// `mv` is atomic and does not cross filesystems.
    #[test]
    fn remote_upload_tmp_path_stays_in_same_directory() {
        assert_eq!(
            remote_upload_tmp_path(
                "${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/debug/redoor",
                "1-2"
            ),
            "${XDG_DATA_HOME:-$HOME/.local/share}/redoor/binaries/debug/redoor.tmp.1-2"
        );
    }

    /// Verifies remote releases mirror the local versioned binary hierarchy
    /// while using the persistent XDG data location on the target host.
    #[test]
    fn default_remote_bin_uses_versioned_data_hierarchy() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            default_remote_bin().unwrap(),
            format!(
                "${{XDG_DATA_HOME:-$HOME/.local/share}}/{app_name}/binaries/{}/redoor",
                env!("CARGO_PKG_VERSION")
            ),
            "the remote install should live under the application data hierarchy"
        );
    }

    /// Verifies debug uploads target a dedicated install path rather than the
    /// versioned release layout, so both can coexist on one remote host.
    #[test]
    fn debug_remote_bin_uses_dedicated_debug_version() {
        let app_name = crate::app_name::app_name().unwrap();
        assert_eq!(
            debug_remote_bin().unwrap(),
            format!("${{XDG_DATA_HOME:-$HOME/.local/share}}/{app_name}/binaries/debug/redoor"),
            "the debug install path should use the effective application namespace"
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
