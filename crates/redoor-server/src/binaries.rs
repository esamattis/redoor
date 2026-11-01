//! Selects and provisions Redoor binaries without coupling local release caching to SSH.

use redoor_core::log;
use redoor_core::upgrade::install::{ReleaseInstall, ReleaseTarget};
use redoor_protocol::wire::log::Level;
use std::path::{Path, PathBuf};

/// Local cache of released binaries shared by SSH provisioning and agent upgrades.
///
/// One instance is built per process and cloned into every user, so its lock (rather
/// than a static) is what makes concurrent cache misses download each artifact once.
#[derive(Clone)]
pub(crate) struct BinaryCache {
    /// Supplies the per-application cache directory.
    paths: redoor_core::paths::AppPaths,
    /// Serializes cache misses so one process downloads each missing artifact only once.
    provision_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

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
        match redoor_core::safe_fs::safe_rm_all(path).await {
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
            if let Err(error) = redoor_core::safe_fs::safe_rm_all(&path).await
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
pub(crate) fn validate_release_version(version: &str) -> Result<(), UpgradeBinaryError> {
    semver::Version::parse(version)
        .map(|_| ())
        .map_err(|_| UpgradeBinaryError::InvalidVersion {
            version: version.to_string(),
        })
}

/// Validates a platform before any artifact URL can be constructed.
pub(crate) fn validate_release_platform(os: &str, arch: &str) -> Result<(), UpgradeBinaryError> {
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

impl BinaryCache {
    /// Creates the process-wide cache for the selected application namespace.
    pub(crate) fn new(paths: redoor_core::paths::AppPaths) -> Self {
        Self {
            paths,
            provision_lock: std::sync::Arc::default(),
        }
    }

    /// Returns the version/platform cache directory under the selected application namespace.
    fn directory(&self, version: &str, os: &str, arch: &str) -> anyhow::Result<PathBuf> {
        Ok(self
            .paths
            .cache_dir()?
            .join("binaries")
            .join(version)
            .join(os)
            .join(arch))
    }

    /// Ensures a released binary is cached, reporting the source before slow download work.
    pub(crate) async fn ensure(
        &self,
        version: &str,
        os: &str,
        arch: &str,
        report: impl Fn(&str) + Send + Sync,
    ) -> Result<PathBuf, UpgradeBinaryError> {
        validate_release_version(version)?;
        validate_release_platform(os, arch)?;
        let binaries_dir = self
            .directory(version, os, arch)
            .map_err(|error| UpgradeBinaryError::Provision(format!("{error:#}")))?;
        self.ensure_in(version, os, arch, &binaries_dir, None, report)
            .await
    }

    /// Provisions into an explicit directory, from an optional release mirror, so cache
    /// behavior can be tested locally.
    async fn ensure_in(
        &self,
        version: &str,
        os: &str,
        arch: &str,
        binaries_dir: &Path,
        base_url: Option<&str>,
        report: impl Fn(&str) + Send + Sync,
    ) -> Result<PathBuf, UpgradeBinaryError> {
        validate_release_version(version)?;
        validate_release_platform(os, arch)?;
        tokio::fs::create_dir_all(binaries_dir)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        let _provision_guard = self.provision_lock.lock().await;
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
        report(&format!(
            "Downloading the matching binary from release v{version} for {os}/{arch}"
        ));
        install_release(version, os, arch, binaries_dir, base_url).await?;
        Ok(final_path)
    }
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

/// Installs a release into the cache directory with `install.sh`, the shared downloader.
///
/// The script's temporary download lives in a unique work directory inside the cache, so
/// failed and cancelled runs leave nothing behind; the script itself publishes the binary
/// with an atomic rename, so concurrent readers never see a partial file.
async fn install_release(
    version: &str,
    os: &str,
    arch: &str,
    binaries_dir: &Path,
    base_url: Option<&str>,
) -> Result<(), UpgradeBinaryError> {
    let work_dir = binaries_dir.join(format!(
        ".redoor-provision-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let mut work_dir_guard = ProvisionWorkDir::new(work_dir.clone());
    log!(
        Level::Info,
        "Redoor binary cache miss; downloading release: version={version}, os={os}, arch={arch}, cache_dir={}",
        binaries_dir.display()
    );
    let result = async {
        tokio::fs::create_dir_all(&work_dir)
            .await
            .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))?;
        ReleaseInstall {
            tag: Some(format!("v{version}")),
            install_dir: binaries_dir.to_path_buf(),
            target: Some(ReleaseTarget {
                os: os.to_string(),
                arch: arch.to_string(),
            }),
            temp_dir: Some(work_dir.clone()),
            base_url: base_url.map(str::to_string),
        }
        .run()
        .await
        .map(|_| ())
        .map_err(|error| UpgradeBinaryError::Provision(error.to_string()))
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, extract::State, routing::get};
    use redoor_core::test_support::TempDir;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;
    use tokio::sync::Notify;

    /// Gives newly cached release files the executable mode expected by SSH and upgrades.
    async fn make_executable(path: &Path) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        let metadata = tokio::fs::metadata(path).await?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(path, permissions).await
    }

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
            .route("/{*path}", get(test_archive_handler))
            .with_state(TestArchiveServer {
                path,
                requests: requests.clone(),
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), requests, task)
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
            .route("/{*path}", get(hanging_archive_handler))
            .with_state(started.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), started, task)
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
    }

    /// Builds a cache rooted in a throwaway home so tests never share real cache state.
    fn test_cache(home: &Path) -> BinaryCache {
        BinaryCache::new(redoor_core::paths::AppPaths::for_home("redoor", home))
    }

    /// Release cache paths expose version, operating system, and architecture.
    #[test]
    fn cached_binary_uses_versioned_platform_hierarchy() {
        let cache = test_cache(Path::new("/home/test"));
        // Versioned per-platform directories keep upgrades from overwriting other targets.
        assert_eq!(
            cache.directory("1.2.3", "linux", "x86_64").unwrap(),
            Path::new("/home/test/.cache/redoor/binaries/1.2.3/linux/x86_64")
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
        let selected = test_cache(temp_dir.path())
            .ensure_in(
                "1.2.3",
                "linux",
                "x86_64",
                &dir,
                Some("http://127.0.0.1:9/unreachable"),
                |_| {},
            )
            .await
            .unwrap();
        assert_eq!(selected, expected);
    }

    /// Concurrent misses share one provision and only observe the atomically published file.
    #[tokio::test]
    async fn concurrent_cache_misses_download_once() {
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-concurrent");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let archive = create_test_archive(&root).await;
        let (url, requests, server) = start_test_archive_server(archive).await;
        let cache = root.join("cache");

        let binaries = test_cache(temp_dir.path());
        let (first, second) = tokio::join!(
            binaries.ensure_in("1.2.3", "linux", "x86_64", &cache, Some(&url), |_| {}),
            binaries.ensure_in("1.2.3", "linux", "x86_64", &cache, Some(&url), |_| {})
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
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-failure");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let invalid_archive = root.join("invalid.tar.gz");
        tokio::fs::write(&invalid_archive, b"not an archive")
            .await
            .unwrap();
        let (url, _requests, server) = start_test_archive_server(invalid_archive).await;
        let cache = root.join("cache");

        let result = test_cache(temp_dir.path())
            .ensure_in("1.2.3", "linux", "x86_64", &cache, Some(&url), |_| {})
            .await;
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
        let temp_dir = TempDir::create();
        let root = temp_dir.path().join("binary-cache-canceled");
        let cache = root.join("cache");
        tokio::fs::create_dir_all(&cache).await.unwrap();
        let (url, started, server) = start_hanging_archive_server().await;
        let provision_cache = cache.clone();
        let binaries = test_cache(temp_dir.path());
        let provision = tokio::spawn(async move {
            binaries
                .ensure_in(
                    "1.2.3",
                    "linux",
                    "x86_64",
                    &provision_cache,
                    Some(&url),
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
