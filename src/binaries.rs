//! Selects and provisions Redoor binaries without coupling local release caching to SSH.

use futures_util::StreamExt;
use redoor::{Level, commands::BinaryIdentity, log};
use std::path::{Path, PathBuf};
use tokio::{io::AsyncWriteExt, process::Command};

/// Serializes cache misses so one process downloads each missing artifact only once.
static BINARY_PROVISION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    if matches!(
        (os, arch),
        ("linux", "x86_64") | ("linux", "aarch64") | ("macos", "aarch64")
    ) {
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
    let url = release_url(version, os, arch);
    ensure_local_binary_in_from_url(version, os, arch, binaries_dir, &url).await
}

/// Provisions from an explicit URL so publication behavior can be tested locally.
async fn ensure_local_binary_in_from_url(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    url: &str,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_platform(os, arch)?;
    tokio::fs::create_dir_all(binaries_dir)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let _provision_guard = BINARY_PROVISION_LOCK.lock().await;
    let final_path = binaries_dir.join("redoor");
    if cached_binary_is_ready(&final_path).await? {
        return Ok(final_path);
    }
    if tokio::fs::try_exists(&final_path)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?
    {
        tokio::fs::remove_file(&final_path)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    }
    download_binary(version, os, arch, binaries_dir, &final_path, url).await?;
    Ok(final_path)
}

/// Accepts only complete-looking executable files as published cache entries.
async fn cached_binary_is_ready(path: &Path) -> Result<bool, UpgradeBinaryError> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(UpgradeBinaryError::Provision(error.to_string())),
    };
    Ok(metadata.is_file() && metadata.len() > 0 && metadata.permissions().mode() & 0o111 != 0)
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
    url: &str,
) -> Result<(), UpgradeBinaryError> {
    let work_dir = binaries_dir.join(format!(
        ".redoor-provision-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let tar_path = work_dir.join("archive.tar.gz");
    let extract_dir = work_dir.join("extract");
    log!(
        Level::Info,
        "Downloading redoor binary: version={version}, os={os}, arch={arch}"
    );
    let result = async {
        tokio::fs::create_dir_all(&extract_dir)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        let response = reqwest::get(url)
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
        file.sync_all()
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        drop(file);

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
        make_executable(&extracted)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        tokio::fs::rename(&extracted, final_path)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        Ok(())
    }
    .await;
    let cleanup = match tokio::fs::remove_dir_all(&work_dir).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    };
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(error)) => Err(UpgradeBinaryError::Provision(format!(
            "Failed to clean binary provisioning state at {}: {error}",
            work_dir.display()
        ))),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(UpgradeBinaryError::Provision(format!(
            "{error}; failed to clean binary provisioning state at {}: {cleanup_error}",
            work_dir.display()
        ))),
    }
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
    validate_release_platform(agent_os, agent_arch)?;
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
    use axum::{Router, body::Body, extract::State, routing::get};
    use redoor::commands::{BinaryIdentity, ServerBuildMode};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::AsyncReadExt;

    /// State for a local server that streams one archive and records cache misses.
    #[derive(Clone)]
    struct TestArchiveServer {
        /// Archive streamed without buffering it into test process memory.
        path: PathBuf,
        /// Number of artifact requests accepted by the server.
        requests: Arc<AtomicUsize>,
    }

    /// Streams a test artifact using the same chunked response behavior as a release host.
    async fn test_archive_handler(State(state): State<TestArchiveServer>) -> Body {
        state.requests.fetch_add(1, Ordering::SeqCst);
        let mut file = tokio::fs::File::open(state.path).await.unwrap();
        Body::from_stream(async_stream::stream! {
            let mut buffer = vec![0; 1024];
            loop {
                match file.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(bytes_read) => {
                        yield Ok::<_, std::io::Error>(bytes::Bytes::copy_from_slice(
                            &buffer[..bytes_read],
                        ));
                    }
                    Err(error) => {
                        yield Err(error);
                        break;
                    }
                }
            }
        })
    }

    /// Starts an ephemeral local artifact host and returns its URL and request counter.
    async fn start_test_archive_server(
        path: PathBuf,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/artifact", get(test_archive_handler))
            .with_state(TestArchiveServer {
                path,
                requests: requests.clone(),
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/artifact"), requests, task)
    }

    /// Creates a small executable archive through Tokio's process API.
    async fn create_test_archive(root: &Path) -> PathBuf {
        let source = root.join("source");
        tokio::fs::create_dir_all(&source).await.unwrap();
        let executable = source.join("redoor");
        tokio::fs::write(&executable, b"complete executable")
            .await
            .unwrap();
        make_executable(&executable).await.unwrap();
        let archive = root.join("artifact.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg("redoor")
            .status()
            .await
            .unwrap();
        assert!(status.success(), "the test archive must be created");
        archive
    }

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

    /// A dirty executable cannot run on another supported target platform.
    #[tokio::test]
    async fn dirty_mismatching_platform_is_rejected() {
        let (other_os, other_arch) = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => ("linux", "aarch64"),
            _ => ("linux", "x86_64"),
        };
        let error = binary_for_connected_agent(&identity(true), other_os, other_arch)
            .await
            .unwrap_err();
        // A published target that differs from the running executable must reach the dirty-build guard.
        assert_eq!(
            error.to_string(),
            format!(
                "This dirty server binary is {}/{}, but the agent is {}/{}. Dirty builds can only upgrade agents on the server's platform.",
                std::env::consts::OS,
                std::env::consts::ARCH,
                other_os,
                other_arch
            )
        );
    }

    /// Matching architectures are still incompatible across operating systems.
    #[tokio::test]
    async fn dirty_mismatching_os_is_rejected() {
        let (other_os, other_arch) = if std::env::consts::OS == "linux" {
            ("macos", "aarch64")
        } else {
            ("linux", "x86_64")
        };
        assert!(matches!(
            binary_for_connected_agent(&identity(true), other_os, other_arch).await,
            Err(UpgradeBinaryError::DirtyPlatformMismatch { .. })
        ));
    }

    /// A release target must match an artifact actually emitted by the workflow.
    #[test]
    fn x86_64_macos_release_is_rejected() {
        let error = validate_release_platform("macos", "x86_64").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported Redoor release platform: macos/x86_64"
        );
    }

    /// Dirty builds cannot bypass the exact published-platform allowlist.
    #[tokio::test]
    async fn dirty_x86_64_macos_target_is_rejected() {
        assert!(matches!(
            binary_for_connected_agent(&identity(true), "macos", "x86_64").await,
            Err(UpgradeBinaryError::UnsupportedPlatform { .. })
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
        make_executable(&expected).await.unwrap();
        let selected =
            clean_binary_for_connected_agent_in(&identity(false), "linux", "x86_64", &dir)
                .await
                .unwrap();
        assert_eq!(selected, UpgradeBinary::CachedRelease { path: expected });
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    /// Concurrent misses share one provision and only observe the atomically published file.
    #[tokio::test]
    async fn concurrent_cache_misses_download_once() {
        crate::logging::init(None).await.unwrap();
        let root = std::env::temp_dir().join(format!(
            "redoor-binary-cache-concurrent-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let archive = create_test_archive(&root).await;
        let (url, requests, server) = start_test_archive_server(archive).await;
        let cache = root.join("cache");

        let (first, second) = tokio::join!(
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url),
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url)
        );
        let first = first.unwrap();
        let second = second.unwrap();
        // Matching paths prove both callers were released only after publication.
        assert_eq!(first, second);
        // One request proves the second miss rechecked under the provision lock.
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        // The published bytes prove no caller observed an intermediate output file.
        assert_eq!(
            tokio::fs::read(first).await.unwrap(),
            b"complete executable"
        );

        server.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    /// Failed extraction leaves neither a final executable nor temporary provisioning state.
    #[tokio::test]
    async fn failed_provisioning_cleans_temporary_state() {
        crate::logging::init(None).await.unwrap();
        let root = std::env::temp_dir().join(format!(
            "redoor-binary-cache-failure-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let invalid_archive = root.join("invalid.tar.gz");
        tokio::fs::write(&invalid_archive, b"not an archive")
            .await
            .unwrap();
        let (url, _requests, server) = start_test_archive_server(invalid_archive).await;
        let cache = root.join("cache");

        let result =
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url).await;
        // Extraction failure must be visible rather than publishing corrupt bytes.
        assert!(result.is_err());
        // No final path can be exposed after an unsuccessful provision.
        assert!(!tokio::fs::try_exists(cache.join("redoor")).await.unwrap());
        let mut entries = tokio::fs::read_dir(&cache).await.unwrap();
        // Attempt directories are always removed, including after tar failures.
        assert!(entries.next_entry().await.unwrap().is_none());

        server.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
