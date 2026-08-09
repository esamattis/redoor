//! Selects and provisions Redoor binaries without coupling local release caching to SSH.

use futures_util::StreamExt;
use redoor::{Level, commands::BinaryIdentity, log};
use std::path::{Path, PathBuf};
use tokio::{io::AsyncWriteExt, process::Command};

/// Identifies whether an upgrade uses this exact process image or a cached release.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UpgradeBinary {
    /// Dirty builds have no release artifact, so matching agents receive the running server image.
    ExactServer { path: PathBuf },
    /// Clean builds use the release artifact for the agent's platform.
    CachedRelease { path: PathBuf },
}

/// Stable failure categories used by the REST endpoint to choose an operator-facing status.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UpgradeBinaryError {
    /// Rejects target pairs that have no published release artifact.
    #[error("Unsupported Redoor release platform: {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },
    /// Prevents a local dirty executable from being sent to an incompatible target.
    #[error(
        "This dirty server binary is {server_os}/{server_arch}, but the agent is {agent_os}/{agent_arch}. Dirty builds can only upgrade agents on the server's platform."
    )]
    DirtyPlatformMismatch {
        server_os: String,
        server_arch: String,
        agent_os: String,
        agent_arch: String,
    },
    /// Covers local executable lookup and release download/extraction failures.
    #[error("{0}")]
    Provision(String),
}

/// Validates a platform before any artifact URL can be constructed.
fn validate_release_platform(os: &str, arch: &str) -> Result<(), UpgradeBinaryError> {
    if matches!(os, "linux" | "macos") && matches!(arch, "x86_64" | "aarch64") {
        Ok(())
    } else {
        Err(UpgradeBinaryError::UnsupportedPlatform {
            os: os.to_string(),
            arch: arch.to_string(),
        })
    }
}

/// Returns the version/platform cache directory under the selected application namespace.
fn local_binaries_dir(version: &str, os: &str, arch: &str) -> anyhow::Result<PathBuf> {
    Ok(crate::app_name::user_cache_directory()?
        .join("binaries")
        .join(version)
        .join(os)
        .join(arch))
}

/// Returns the final cached executable path for one released target.
#[cfg(test)]
fn cached_binary_path(version: &str, os: &str, arch: &str) -> anyhow::Result<PathBuf> {
    Ok(local_binaries_dir(version, os, arch)?.join("redoor"))
}

/// Constructs a release URL only after callers validate the platform pair.
fn release_url(version: &str, os: &str, arch: &str) -> String {
    format!(
        "https://github.com/esamattis/redoor/releases/download/v{version}/redoor-{arch}-{os}.tar.gz"
    )
}

/// Ensures a released binary is cached, returning immediately for an existing file.
pub(crate) async fn ensure_local_binary(
    version: &str,
    os: &str,
    arch: &str,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_platform(os, arch)?;
    let binaries_dir = local_binaries_dir(version, os, arch)
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    ensure_local_binary_in(version, os, arch, &binaries_dir).await
}

/// Uses an explicit cache directory so cache-hit behavior can be tested without network access.
async fn ensure_local_binary_in(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_platform(os, arch)?;
    tokio::fs::create_dir_all(binaries_dir)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let final_path = binaries_dir.join("redoor");
    if tokio::fs::try_exists(&final_path)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?
    {
        return Ok(final_path);
    }
    download_binary(version, os, arch, binaries_dir, &final_path).await?;
    Ok(final_path)
}

/// Selects a clean build from an explicit platform cache, downloading only on a miss.
async fn clean_binary_for_connected_agent_in(
    server: &BinaryIdentity,
    agent_os: &str,
    agent_arch: &str,
    binaries_dir: &Path,
) -> Result<UpgradeBinary, UpgradeBinaryError> {
    let path = ensure_local_binary_in(&server.version, agent_os, agent_arch, binaries_dir).await?;
    Ok(UpgradeBinary::CachedRelease { path })
}

/// Streams a release archive to disk and extracts its executable without whole-file buffering.
async fn download_binary(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    final_path: &Path,
) -> Result<(), UpgradeBinaryError> {
    let url = release_url(version, os, arch);
    let tar_path = binaries_dir.join(format!("redoor-{arch}-{os}.tar.gz"));
    let extract_dir = binaries_dir.join(format!("extract-v{version}-{arch}-{os}"));
    log!(
        Level::Info,
        "Downloading redoor binary: version={version}, os={os}, arch={arch}"
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    if !response.status().is_success() {
        return Err(UpgradeBinaryError::Provision(format!(
            "download from {url} failed: HTTP {}",
            response.status()
        )));
    }
    let mut file = tokio::fs::File::create(&tar_path)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    }
    file.flush()
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    drop(file);

    tokio::fs::create_dir_all(&extract_dir)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&tar_path)
        .arg("-C")
        .arg(&extract_dir)
        .status()
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    if !status.success() {
        return Err(UpgradeBinaryError::Provision(format!(
            "tar extraction failed with status {}",
            status.code().unwrap_or(-1)
        )));
    }

    let extracted = extract_dir.join("redoor");
    if !tokio::fs::try_exists(&extracted)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?
    {
        return Err(UpgradeBinaryError::Provision(format!(
            "extracted tarball did not contain a 'redoor' binary at {}",
            extracted.display()
        )));
    }
    tokio::fs::copy(&extracted, final_path)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    make_executable(final_path)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let _ = tokio::fs::remove_file(&tar_path).await;
    let _ = tokio::fs::remove_dir_all(&extract_dir).await;
    Ok(())
}

/// Gives newly cached release files the executable mode expected by SSH and upgrades.
async fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = tokio::fs::metadata(path).await?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o755);
    tokio::fs::set_permissions(path, permissions).await
}

/// Selects the exact server image for dirty builds or a same-version release for clean builds.
pub(crate) async fn binary_for_connected_agent(
    server: &BinaryIdentity,
    agent_os: &str,
    agent_arch: &str,
) -> Result<UpgradeBinary, UpgradeBinaryError> {
    if server.git_dirty || server.version_dirty {
        if agent_os != std::env::consts::OS || agent_arch != std::env::consts::ARCH {
            return Err(UpgradeBinaryError::DirtyPlatformMismatch {
                server_os: std::env::consts::OS.to_string(),
                server_arch: std::env::consts::ARCH.to_string(),
                agent_os: agent_os.to_string(),
                agent_arch: agent_arch.to_string(),
            });
        }
        let path = std::env::current_exe()
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        return Ok(UpgradeBinary::ExactServer { path });
    }

    let binaries_dir = local_binaries_dir(&server.version, agent_os, agent_arch)
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    clean_binary_for_connected_agent_in(server, agent_os, agent_arch, &binaries_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor::commands::{BinaryIdentity, ServerBuildMode};

    /// Builds a selectable identity while keeping tests independent of compile-time metadata.
    fn identity(dirty: bool) -> BinaryIdentity {
        BinaryIdentity {
            version: "1.2.3".to_string(),
            git_rev: "abc".to_string(),
            git_dirty: dirty,
            version_dirty: false,
            build_mode: ServerBuildMode::Debug,
            build_date: "today".to_string(),
        }
    }

    /// Matching dirty targets must receive the actual running executable.
    #[tokio::test]
    async fn dirty_matching_platform_selects_running_server() {
        let selected = binary_for_connected_agent(
            &identity(true),
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
        .await
        .unwrap();
        assert_eq!(
            selected,
            UpgradeBinary::ExactServer {
                path: std::env::current_exe().unwrap()
            }
        );
    }

    /// A dirty executable cannot run on another CPU architecture.
    #[tokio::test]
    async fn dirty_mismatching_arch_is_rejected() {
        let other_arch = if std::env::consts::ARCH == "x86_64" {
            "aarch64"
        } else {
            "x86_64"
        };
        let error = binary_for_connected_agent(&identity(true), std::env::consts::OS, other_arch)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "This dirty server binary is {}/{}, but the agent is {}/{}. Dirty builds can only upgrade agents on the server's platform.",
                std::env::consts::OS,
                std::env::consts::ARCH,
                std::env::consts::OS,
                other_arch
            )
        );
    }

    /// Matching architectures are still incompatible across operating systems.
    #[tokio::test]
    async fn dirty_mismatching_os_is_rejected() {
        let other_os = if std::env::consts::OS == "linux" {
            "macos"
        } else {
            "linux"
        };
        assert!(matches!(
            binary_for_connected_agent(&identity(true), other_os, std::env::consts::ARCH).await,
            Err(UpgradeBinaryError::DirtyPlatformMismatch { .. })
        ));
    }

    /// Release cache paths expose version, operating system, and architecture.
    #[test]
    fn cached_binary_uses_versioned_platform_hierarchy() {
        let cache_dir = crate::app_name::user_cache_directory().unwrap();
        assert_eq!(
            cached_binary_path("1.2.3", "linux", "x86_64").unwrap(),
            cache_dir.join("binaries/1.2.3/linux/x86_64/redoor")
        );
    }

    /// Clean selection uses a versioned platform cache and avoids the downloader on a hit.
    #[tokio::test]
    async fn clean_build_selects_existing_versioned_cache_file() {
        let root = std::env::temp_dir().join(format!(
            "redoor-binary-cache-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        let dir = root.join("1.2.3/linux/x86_64");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let expected = dir.join("redoor");
        tokio::fs::write(&expected, b"cached").await.unwrap();
        let selected =
            clean_binary_for_connected_agent_in(&identity(false), "linux", "x86_64", &dir)
                .await
                .unwrap();
        assert_eq!(selected, UpgradeBinary::CachedRelease { path: expected });
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
