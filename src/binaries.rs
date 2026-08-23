//! Selects and provisions Redoor binaries without coupling local release caching to SSH.

use futures_util::StreamExt;
use redoor::{Level, log};
use std::path::{Path, PathBuf};
use tokio::{io::AsyncWriteExt, process::Command};

/// Serializes cache misses so one process downloads each missing artifact only once.
static BINARY_PROVISION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Owns one unique provisioning directory across errors and future cancellation.
struct ProvisionWorkDir {
    path: Option<PathBuf>,
}

impl ProvisionWorkDir {
    /// Begins ownership before the directory can be created.
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// Reports normal-path cleanup errors while leaving drop cleanup armed during this await.
    async fn cleanup(&mut self) -> std::io::Result<()> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };
        match redoor::safe_fs::safe_rm_all(path).await {
            Ok(()) => {
                self.path = None;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.path = None;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl Drop for ProvisionWorkDir {
    /// Retries removal asynchronously because REST and watchdog callers may drop provisioning.
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        tokio::spawn(async move {
            if let Err(error) = redoor::safe_fs::safe_rm_all(&path).await
                && error.kind() != std::io::ErrorKind::NotFound
            {
                log!(
                    Level::Warning,
                    "Canceled binary provisioning cleanup failed: path={}, error={}",
                    path.display(),
                    error
                );
            }
        });
    }
}

/// Stable failure categories used by the REST endpoint to choose an operator-facing status.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UpgradeBinaryError {
    /// Keeps release identifiers safe as URL and cache path components.
    #[error("Invalid Redoor release version: {version}")]
    InvalidVersion { version: String },
    /// Rejects target pairs that have no published release artifact.
    #[error("Unsupported Redoor release platform: {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },
    /// Covers local executable lookup and release download/extraction failures.
    #[error("{0}")]
    Provision(String),
}

/// Accepts semantic versions because release tags and cache directories use this value verbatim.
fn validate_release_version(version: &str) -> Result<(), UpgradeBinaryError> {
    semver::Version::parse(version)
        .map(|_| ())
        .map_err(|_| UpgradeBinaryError::InvalidVersion {
            version: version.to_string(),
        })
}

/// Validates a platform before any artifact URL can be constructed.
fn validate_release_platform(os: &str, arch: &str) -> Result<(), UpgradeBinaryError> {
    if matches!(
        (os, arch),
        ("linux", "x86_64") | ("linux", "aarch64") | ("macos", "aarch64") | ("android", "aarch64")
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

/// Ensures a released binary is cached, reporting the source before slow download work.
pub(crate) async fn ensure_local_binary_reported(
    version: &str,
    os: &str,
    arch: &str,
    report: impl Fn(&str) + Send + Sync,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_version(version)?;
    validate_release_platform(os, arch)?;
    let binaries_dir = local_binaries_dir(version, os, arch)
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    ensure_local_binary_in(version, os, arch, &binaries_dir, report).await
}

/// Uses an explicit cache directory so cache-hit behavior can be tested without network access.
async fn ensure_local_binary_in(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    report: impl Fn(&str) + Send + Sync,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_version(version)?;
    validate_release_platform(os, arch)?;
    let url = release_url(version, os, arch);
    ensure_local_binary_in_from_url(version, os, arch, binaries_dir, &url, report).await
}

/// Provisions from an explicit URL so publication behavior can be tested locally.
async fn ensure_local_binary_in_from_url(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    url: &str,
    report: impl Fn(&str) + Send + Sync,
) -> Result<PathBuf, UpgradeBinaryError> {
    validate_release_version(version)?;
    validate_release_platform(os, arch)?;
    tokio::fs::create_dir_all(binaries_dir)
        .await
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
    let _provision_guard = BINARY_PROVISION_LOCK.lock().await;
    let final_path = binaries_dir.join("redoor");
    if cached_binary_is_ready(&final_path).await? {
        report(&format!(
            "Using cached binary from {}",
            final_path.display()
        ));
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
    report(&format!("Downloading the matching binary from {url}"));
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
    let mut work_dir_guard = ProvisionWorkDir::new(work_dir.clone());
    log!(
        Level::Info,
        "Redoor binary cache miss; downloading release: version={version}, os={os}, arch={arch}, url={url}, cache_path={}",
        final_path.display()
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

        let mut tar = Command::new("tar");
        tar.arg("-xzf")
            .arg(&tar_path)
            .arg("-C")
            .arg(&extract_dir)
            .kill_on_drop(true);
        let status = tar
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
    let cleanup = work_dir_guard.cleanup().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use axum::{Router, body::Body, extract::State, routing::get};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::AsyncReadExt;
    use tokio::sync::Notify;

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

    /// Holds an artifact response open after signaling that provisioning reached the download.
    async fn hanging_archive_handler(State(started): State<Arc<Notify>>) -> Body {
        started.notify_one();
        Body::from_stream(async_stream::stream! {
            // One chunk ensures the response body is actively being streamed when canceled.
            yield Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"partial archive"));
            std::future::pending::<()>().await;
        })
    }

    /// Starts an artifact host that deterministically holds provisioning in its streaming phase.
    async fn start_hanging_archive_server() -> (String, Arc<Notify>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let started = Arc::new(Notify::new());
        let app = Router::new()
            .route("/artifact", get(hanging_archive_handler))
            .with_state(started.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/artifact"), started, task)
    }

    /// Waits cooperatively for a cache directory to contain no provisioning artifacts.
    async fn wait_for_empty_directory(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let mut entries = tokio::fs::read_dir(path).await.unwrap();
                if entries.next_entry().await.unwrap().is_none() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provisioning artifacts should be removed");
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

    /// Release versions must be safe semantic-version path and URL components.
    #[test]
    fn validates_release_versions() {
        for valid in ["1.2.3", "1.2.3-beta.1", "1.2.3+build.4"] {
            // Published semver tags, including prerelease metadata, must remain selectable.
            assert!(validate_release_version(valid).is_ok());
        }
        for invalid in ["", "v1.2.3", "../1.2.3", "1.2"] {
            // Invalid values cannot escape the versioned cache directory or alter the URL.
            assert!(validate_release_version(invalid).is_err());
        }
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

    /// Android agents must resolve to the archive emitted by the release workflow.
    #[test]
    fn aarch64_android_release_is_supported() {
        // Accepting the platform lets servers provision upgrades for Termux agents.
        assert!(validate_release_platform("android", "aarch64").is_ok());
        // The URL must remain aligned with the workflow's Android archive name.
        assert_eq!(
            release_url("1.2.3", "android", "aarch64"),
            "https://github.com/esamattis/redoor/releases/download/v1.2.3/redoor-aarch64-android.tar.gz"
        );
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

    /// Provisioning uses a versioned platform cache and avoids the downloader on a hit.
    #[tokio::test]
    async fn ensure_binary_selects_existing_versioned_cache_file() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache");
        let dir = root.join("1.2.3/linux/x86_64");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let expected = dir.join("redoor");
        tokio::fs::write(&expected, b"cached").await.unwrap();
        make_executable(&expected).await.unwrap();
        let selected = ensure_local_binary_in("1.2.3", "linux", "x86_64", &dir, |_| {})
            .await
            .unwrap();
        assert_eq!(selected, expected);
    }

    /// Concurrent misses share one provision and only observe the atomically published file.
    #[tokio::test]
    async fn concurrent_cache_misses_download_once() {
        crate::logging::init(None).await.unwrap();
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-concurrent");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let archive = create_test_archive(&root).await;
        let (url, requests, server) = start_test_archive_server(archive).await;
        let cache = root.join("cache");

        let (first, second) = tokio::join!(
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url, |_| {}),
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url, |_| {})
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
    }

    /// Failed extraction leaves neither a final executable nor temporary provisioning state.
    #[tokio::test]
    async fn failed_provisioning_cleans_temporary_state() {
        crate::logging::init(None).await.unwrap();
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-failure");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let invalid_archive = root.join("invalid.tar.gz");
        tokio::fs::write(&invalid_archive, b"not an archive")
            .await
            .unwrap();
        let (url, _requests, server) = start_test_archive_server(invalid_archive).await;
        let cache = root.join("cache");

        let result =
            ensure_local_binary_in_from_url("1.2.3", "linux", "x86_64", &cache, &url, |_| {}).await;
        // Extraction failure must be visible rather than publishing corrupt bytes.
        assert!(result.is_err());
        // No final path can be exposed after an unsuccessful provision.
        assert!(!tokio::fs::try_exists(cache.join("redoor")).await.unwrap());
        let mut entries = tokio::fs::read_dir(&cache).await.unwrap();
        // Attempt directories are always removed, including after tar failures.
        assert!(entries.next_entry().await.unwrap().is_none());

        server.abort();
    }

    /// Canceling a streaming download must not strand its unique provisioning directory.
    #[tokio::test]
    async fn canceled_provisioning_cleans_temporary_state() {
        crate::logging::init(None).await.unwrap();
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-canceled");
        let cache = root.join("cache");
        tokio::fs::create_dir_all(&cache).await.unwrap();
        let (url, started, server) = start_hanging_archive_server().await;
        let provision_cache = cache.clone();
        let provision = tokio::spawn(async move {
            ensure_local_binary_in_from_url(
                "1.2.3",
                "linux",
                "x86_64",
                &provision_cache,
                &url,
                |_| {},
            )
            .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
            .await
            .expect("artifact request should start");
        provision.abort();
        // Awaiting the abort proves the provisioning future and its ownership guard were dropped.
        assert!(provision.await.unwrap_err().is_cancelled());
        wait_for_empty_directory(&cache).await;
        // An empty cache proves cancellation removed the hidden work directory before retry.
        assert!(
            tokio::fs::read_dir(&cache)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
        );

        server.abort();
    }
}
