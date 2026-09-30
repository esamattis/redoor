//! One transfer command resolves copy-style destinations before choosing the existing REST transport.

use super::client::{RemoteApiError, RemoteClient};
use crate::agent::transfers::destination::{
    check_existing_destination, place_temp_at_destination, remove_existing_path,
};
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, ValueEnum};
use futures_util::{StreamExt, TryStreamExt};
use redoor::{
    commands::{
        CopyEndpoint, CopyExistingMode, CopyFileRequest, CopyFileResponse, MetadataResponse,
        TransferProgressListResponse, TransferProgressState,
    },
    types::TransferId,
};
use reqwest::{Method, StatusCode};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::io::AsyncWriteExt;

/// Keeps supported conflict policies explicit in command help and consistent across all transports.
#[derive(Clone, Copy, ValueEnum)]
pub enum ExistingMode {
    /// Reject existing resulting paths (the default).
    Error,
    /// Replace the resulting path entirely.
    Override,
    /// Merge directories, replacing conflicting files.
    Merge,
}

impl From<ExistingMode> for CopyExistingMode {
    /// Adapts CLI spelling to the existing API policy without changing its meaning.
    fn from(value: ExistingMode) -> Self {
        match value {
            ExistingMode::Error => Self::Error,
            ExistingMode::Override => Self::Override,
            ExistingMode::Merge => Self::Merge,
        }
    }
}

/// Transfer status uses stderr; JSON stdout is one terminal result, never a stream of progress messages.
#[derive(Args)]
pub struct CopyArgs {
    /// Copy directory trees using streaming archives.
    #[arg(short = 'r', long)]
    recursive: bool,
    /// Policy for the resulting path after destination-directory resolution.
    #[arg(long, value_enum, default_value = "error")]
    on_existing: ExistingMode,
    /// Suppress progress and successful completion messages.
    #[arg(long)]
    quiet: bool,
    /// Print one terminal JSON result and suppress human progress.
    #[arg(long)]
    json: bool,
    source: String,
    destination: String,
}

/// Separates remote syntax from local colon filenames without guessing agent names from the server.
#[derive(Debug)]
enum Location {
    Local(PathBuf),
    Remote(CopyEndpoint),
}

impl Location {
    /// Explicit ./ and / paths are local; unprefixed AGENT:path must contain an absolute remote path.
    async fn parse(input: &str) -> Result<Self> {
        ensure!(!input.is_empty(), "Copy paths must not be empty");
        if !input.starts_with('/')
            && !input.starts_with("./")
            && !input.starts_with("../")
            && let Some((agent, path)) = input.split_once(':')
        {
            ensure!(
                !agent.is_empty() && path.starts_with('/'),
                "Remote paths must use AGENT:/absolute/path; prefix local colon paths with ./"
            );
            ensure!(
                agent != "." && agent != ".." && !agent.contains('/'),
                "Invalid agent ID"
            );
            ensure!(
                !path.split('/').any(|part| part == "." || part == ".."),
                "Remote paths must not contain . or .. components; use the resolved absolute path"
            );
            return Ok(Self::Remote(CopyEndpoint {
                agent: agent.into(),
                path: path.into(),
            }));
        }
        let path = PathBuf::from(input);
        Ok(Self::Local(if path.is_absolute() {
            path
        } else {
            std::env::current_dir()?.join(path)
        }))
    }

    /// A source basename is required to reproduce directory-destination semantics predictably.
    fn basename(&self) -> Result<&str> {
        let path = match self {
            Self::Local(path) => path.as_path(),
            Self::Remote(remote) => Path::new(&remote.path),
        };
        path.file_name()
            .and_then(|name| name.to_str())
            .context("Source must have a UTF-8 basename (filesystem root cannot be copied)")
    }
}

/// Tracks only owned outputs/transfer IDs, so cleanup never targets another client's transfer.
#[derive(Default)]
struct Transfer {
    staging: Option<PathBuf>,
    /// Async filesystem creation must finish before cleanup, even if interruption wins its await.
    staging_creation: Option<tokio::task::JoinHandle<Result<PathBuf>>>,
    remote_id: Option<TransferId>,
    /// Identifies this HTTP upload through the server's post-body publication phase.
    upload_token: Option<uuid::Uuid>,
    bytes: Arc<AtomicU64>,
    /// Admission must finish to recover the server-owned id even if interrupted during POST.
    admission: Option<tokio::task::JoinHandle<Result<TransferId>>>,
    /// Completed local staging is published outside the interruptible streaming region.
    publication: Option<(PathBuf, CopyExistingMode, bool)>,
}

impl Transfer {
    /// Handles both stream-driven server cancellation and explicit asynchronous copy cancellation.
    async fn cleanup(&mut self, client: &RemoteClient, failed: bool) -> Result<()> {
        if let Some(creation) = self.staging_creation.take() {
            self.staging = Some(creation.await??);
        }
        if let Some(admission) = self.admission.take() {
            self.remote_id = Some(admission.await??);
        }
        let mut cancellation = Ok(());
        if failed && let Some(token) = self.upload_token {
            cancellation = match client
                .send(
                    client
                        .request(Method::DELETE, &format!("api/v1/upload-requests/{token}"))?
                        .timeout(std::time::Duration::from_secs(10)),
                )
                .await
            {
                Ok(_) => Ok(()),
                Err(error)
                    if error
                        .downcast_ref::<RemoteApiError>()
                        .is_some_and(|error| error.status == StatusCode::NOT_FOUND) =>
                {
                    Ok(())
                }
                Err(error) => Err(error),
            };
        }
        if failed && let Some(id) = self.remote_id {
            cancellation = client
                .send(
                    client
                        .request(Method::DELETE, &format!("api/v1/transfers/{id}"))?
                        .timeout(std::time::Duration::from_secs(10)),
                )
                .await
                .map(|_| ());
        }
        if let Some(path) = self.staging.take() {
            match tokio::fs::symlink_metadata(&path).await {
                Ok(_) => remove_existing_path(&path).await?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        cancellation
    }

    /// Resolves directory destinations once, then sends their exact resulting path to REST APIs.
    async fn execute(&mut self, client: &RemoteClient, args: &CopyArgs) -> Result<String> {
        let source = Location::parse(&args.source).await?;
        let mut destination = Location::parse(&args.destination).await?;
        ensure!(
            !matches!(
                (&source, &destination),
                (Location::Local(_), Location::Local(_))
            ),
            "remote cp requires at least one remote endpoint"
        );
        let basename = source.basename()?;
        if let Location::Remote(remote) = &source {
            client.ensure_agent_running(&remote.agent.0).await?;
        }
        if let Location::Remote(remote) = &destination
            && !matches!(&source, Location::Remote(source) if source.agent == remote.agent)
        {
            client.ensure_agent_running(&remote.agent.0).await?;
        }
        let (directory, size) = match &source {
            Location::Local(path) => {
                let metadata = tokio::fs::symlink_metadata(path).await?;
                ensure!(
                    metadata.is_file() || metadata.is_dir(),
                    "Only regular files and directories are supported"
                );
                (metadata.is_dir(), metadata.len())
            }
            Location::Remote(remote) => {
                let metadata = metadata(client, remote)
                    .await?
                    .context("Source does not exist")?;
                ensure!(
                    metadata.is_file || metadata.is_dir,
                    "Only regular files and directories are supported"
                );
                (metadata.is_dir, metadata.file_size)
            }
        };
        ensure!(
            !directory || args.recursive,
            "Source is a directory; use -r or --recursive"
        );
        match &mut destination {
            Location::Local(path) => match tokio::fs::metadata(&path).await {
                Ok(metadata) if metadata.is_dir() => *path = path.join(basename),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure!(
                        !args.destination.ends_with('/'),
                        "Destination directory does not exist"
                    );
                }
                Err(error) => return Err(error.into()),
            },
            Location::Remote(remote) => {
                if metadata(client, remote)
                    .await?
                    .is_some_and(|metadata| metadata.is_dir)
                {
                    remote.path = Path::new(&remote.path)
                        .join(basename)
                        .to_string_lossy()
                        .into_owned();
                } else if remote.path.ends_with('/') {
                    bail!("Destination directory does not exist");
                }
            }
        }
        let policy = args.on_existing.into();
        match (&source, &destination) {
            (Location::Local(path), Location::Remote(remote)) => {
                self.upload(client, path, remote, directory, size, policy)
                    .await?
            }
            (Location::Remote(remote), Location::Local(path)) => {
                self.download(client, remote, path, directory, policy)
                    .await?
            }
            (Location::Remote(source), Location::Remote(dest)) => {
                self.copy(client, source, dest, policy).await?
            }
            _ => unreachable!("local-local rejected above"),
        }
        Ok(match destination {
            Location::Local(path) => path.display().to_string(),
            Location::Remote(remote) => format!("{}:{}", remote.agent, remote.path),
        })
    }

    /// Streams raw bytes or a generated archive without a producer task that could outlive cancellation.
    async fn upload(
        &mut self,
        client: &RemoteClient,
        source: &Path,
        destination: &CopyEndpoint,
        directory: bool,
        size: u64,
        policy: CopyExistingMode,
    ) -> Result<()> {
        let operation = if directory { "archive" } else { "raw" };
        let mode = match policy {
            CopyExistingMode::Error => "error",
            CopyExistingMode::Override => "override",
            CopyExistingMode::Merge => "merge",
        };
        let builder = client.request(
            Method::PUT,
            &format!("{}?on_existing={mode}", api_path(destination, operation)?),
        )?;
        let token = uuid::Uuid::new_v4();
        self.upload_token = Some(token);
        let builder = builder.header("X-Redoor-Upload-Request", token.to_string());
        let counter = self.bytes.clone();
        let builder = if directory {
            let stream = super::archive::stream(source.to_owned()).inspect_ok(move |bytes| {
                counter.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            });
            builder
                .header("Content-Type", "application/x-tar")
                .body(reqwest::Body::wrap_stream(stream))
        } else {
            let file = tokio::fs::File::open(source).await?;
            let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024).inspect_ok(
                move |bytes| {
                    counter.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                },
            );
            builder
                .header("Content-Length", size)
                .body(reqwest::Body::wrap_stream(stream))
        };
        let response = client.send(builder).await?;
        // Reading the small response confirms the destination worker's terminal publication.
        if directory {
            let _: redoor::commands::ArchiveUploadResponse =
                serde_json::from_slice(&response.bytes().await?)?;
        } else {
            let _: redoor::commands::RawUploadResponse =
                serde_json::from_slice(&response.bytes().await?)?;
        }
        self.upload_token = None;
        Ok(())
    }

    /// Writes into a private sibling and only publishes after the entire HTTP/archive stream succeeds.
    async fn download(
        &mut self,
        client: &RemoteClient,
        source: &CopyEndpoint,
        destination: &Path,
        directory: bool,
        policy: CopyExistingMode,
    ) -> Result<()> {
        check_existing_destination(destination, policy, directory).await?;
        let parent = destination.parent().context("Destination needs a parent")?;
        let staging = parent.join(format!(".redoor-remote-{}", uuid::Uuid::new_v4()));
        self.staging_creation = Some(tokio::spawn(async move {
            if directory {
                tokio::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&staging)
                    .await?;
            } else {
                tokio::fs::OpenOptions::new()
                    .mode(0o600)
                    .write(true)
                    .create_new(true)
                    .open(&staging)
                    .await?;
            }
            Ok(staging)
        }));
        let created = self
            .staging_creation
            .as_mut()
            .context("Staging initialization missing")?
            .await;
        self.staging_creation = None;
        let staging = created??;
        self.staging = Some(staging.clone());
        let response = client
            .send(client.request(Method::GET, &api_path(source, "raw")?)?)
            .await?;
        let counter = self.bytes.clone();
        let stream = response.bytes_stream().map(move |chunk| {
            chunk
                .inspect(|bytes| {
                    counter.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                })
                .map_err(std::io::Error::other)
        });
        let mut reader = tokio_util::io::StreamReader::new(stream);
        if directory {
            let mut gzip = async_compression::tokio::bufread::GzipDecoder::new(reader);
            let root = Path::new(&source.path)
                .file_name()
                .and_then(|name| name.to_str())
                .context("Archive source needs a basename")?;
            super::archive::extract(&mut gzip, &staging, root).await?;
        } else {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&staging)
                .await?;
            tokio::io::copy(&mut reader, &mut file).await?;
            file.flush().await?;
        }
        self.publication = Some((destination.to_owned(), policy, directory));
        Ok(())
    }

    /// Payloads remain on the server; retained transfer state is the completion/error authority.
    async fn copy(
        &mut self,
        client: &RemoteClient,
        source: &CopyEndpoint,
        dest: &CopyEndpoint,
        on_existing: CopyExistingMode,
    ) -> Result<()> {
        let payload = CopyFileRequest {
            source: source.clone(),
            dest: dest.clone(),
            on_existing,
        };
        let admission_client = client.clone();
        self.admission = Some(tokio::spawn(async move {
            let response = admission_client
                .send(
                    admission_client
                        .json_request(Method::POST, "api/v1/copy", &payload)?
                        .timeout(std::time::Duration::from_secs(30)),
                )
                .await?;
            let copy: CopyFileResponse = serde_json::from_slice(&response.bytes().await?)?;
            Ok(copy.copy_request_id)
        }));
        let admitted = self
            .admission
            .as_mut()
            .context("Copy admission missing")?
            .await;
        self.admission = None;
        let id = admitted??;
        self.remote_id = Some(id);
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
        loop {
            interval.tick().await;
            let progress: TransferProgressListResponse =
                client.get_json("api/v1/transfers/progress").await?;
            let entry = progress
                .transfers
                .into_iter()
                .find(|entry| entry.request_id == id)
                .context("Copy progress disappeared before completion")?;
            self.bytes.store(entry.transferred_bytes, Ordering::Relaxed);
            match entry.state {
                TransferProgressState::Completed => {
                    self.remote_id = None;
                    return Ok(());
                }
                TransferProgressState::Errored | TransferProgressState::Canceled => {
                    self.remote_id = None;
                    bail!(
                        "{}",
                        entry.error.unwrap_or_else(|| "Transfer canceled".into())
                    );
                }
                _ => {}
            }
        }
    }
}

/// Percent-encodes each route component so spaces, colons, #, and ? remain filesystem data.
fn api_path(endpoint: &CopyEndpoint, operation: &str) -> Result<String> {
    let mut url = reqwest::Url::parse("http://localhost/")?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid API URL"))?;
        let agent = endpoint.agent.to_string();
        segments.extend(["api", "v1", "agents", &agent, operation]);
        for part in endpoint.path.trim_start_matches('/').split('/') {
            segments.push(part);
        }
    }
    Ok(url.path().trim_start_matches('/').to_owned())
}

/// Treats only HTTP 404 as absence; authentication and permissions still fail clearly.
async fn metadata(
    client: &RemoteClient,
    endpoint: &CopyEndpoint,
) -> Result<Option<MetadataResponse>> {
    match client.get_json(&api_path(endpoint, "metadata")?).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error)
            if error
                .downcast_ref::<RemoteApiError>()
                .is_some_and(|error| error.status == StatusCode::NOT_FOUND) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// Receives terminal and service-manager interruptions before starting payload IO.
async fn interrupted() -> Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = terminate.recv() => {} }
    Ok(())
}

/// Waits by default and guarantees one final JSON object, including failures and interruption.
pub async fn run(store: super::session::SessionStore, args: CopyArgs) -> Result<()> {
    let client = match RemoteClient::load(store).await {
        Ok(client) => client,
        Err(error) => {
            let result = Err(error);
            print_result(&args, &result, 0)?;
            return result.map(|_| ());
        }
    };
    let mut transfer = Transfer::default();
    let bytes = transfer.bytes.clone();
    let mut progress = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut result = {
        let operation = transfer.execute(&client, &args);
        tokio::pin!(operation);
        let interrupt = interrupted();
        tokio::pin!(interrupt);
        loop {
            tokio::select! {
                biased;
                signal = &mut interrupt => break signal.and_then(|_| Err(anyhow::anyhow!("Transfer interrupted"))),
                result = &mut operation => break result,
                _ = progress.tick() => report_progress(&args, &bytes),
            }
        }
    };
    if result.is_ok()
        && let Some((destination, policy, directory)) = transfer.publication.take()
        && let Some(staging) = transfer.staging.as_ref()
        && let Err(error) =
            place_temp_at_destination(staging, &destination, policy, directory).await
    {
        result = Err(error.into());
    }
    let cleanup = transfer.cleanup(&client, result.is_err()).await;
    let result = match (result, cleanup) {
        (Ok(path), Ok(())) => Ok(path),
        (Err(error), Ok(())) => Err(error),
        (result, Err(cleanup)) => Err(anyhow::anyhow!(
            "{}; cleanup failed: {cleanup:#}",
            result
                .err()
                .map(|error| format!("{error:#}"))
                .unwrap_or_else(|| "Transfer completed".into())
        )),
    };
    print_result(&args, &result, bytes.load(Ordering::Relaxed))?;
    result.map(|_| ())
}

/// Includes authentication and preflight failures in the same terminal JSON contract as payload failures.
fn print_result(args: &CopyArgs, result: &Result<String>, bytes: u64) -> Result<()> {
    if args.json {
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({"status": if result.is_ok() { "completed" } else { "failed" }, "source": args.source, "destination": args.destination, "resolved_destination": result.as_ref().ok(), "bytes_transferred": bytes, "error": result.as_ref().err().map(|error| format!("{error:#}"))})
            )?
        );
    } else if result.is_ok() && !args.quiet {
        eprintln!("Copy completed ({bytes} bytes)");
    }
    Ok(())
}

/// Progress remains human-readable stderr and never contaminates scripted stdout.
fn report_progress(args: &CopyArgs, bytes: &AtomicU64) {
    if !args.quiet && !args.json {
        eprintln!(
            "Copying: {} bytes transferred",
            bytes.load(Ordering::Relaxed)
        );
    }
}
