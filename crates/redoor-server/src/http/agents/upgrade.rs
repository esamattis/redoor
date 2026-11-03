//! REST endpoints that install a selected binary on an agent and restart it, in the background.
//!
//! Installing streams a whole executable to the agent, which takes minutes on a slow link. A
//! request that did all of it would be cancelled by a page reload, a phone suspending the tab
//! or a proxy timeout, and would leave the UI without progress. So `POST` only validates and
//! starts the upgrade, which then runs in its own task, and `GET` reports where it is.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use axum::{Json, extract::State as AxumState, http::StatusCode};
use redoor_core::{log, log_error};
use redoor_protocol::wire::request;
use redoor_protocol::{
    api::agents::{
        AgentConnectionStatus, AgentDetailsResponse, AgentUpgradeJob, AgentUpgradePhase,
        AgentUpgradeSource, AgentUpgradeStatusResponse, UpgradeAgentRequest, UpgradeAgentResponse,
    },
    identity::BinaryIdentity,
    ids::{AgentId, SocketId, UnixTimestampMillis},
    wire::{command::Command, log::Level},
};

use crate::actors::router::AgentListEntry;
use crate::http::access::ResolvedDevice;
use crate::http::{
    agent_client::SelfExec,
    error::ApiError,
    services::upload::{AgentUpload, UploadStart},
    state::ServerState,
};

/// Agent upgrades by agent: the running one, or the last one until it is dismissed.
///
/// Kept in memory only: a server restart ends every upgrade task anyway.
#[derive(Clone, Default)]
pub(crate) struct AgentUpgrades {
    jobs: Arc<Mutex<HashMap<AgentId, TrackedUpgrade>>>,
}

/// One upgrade plus what the server needs to tell when the agent is back.
struct TrackedUpgrade {
    job: AgentUpgradeJob,
    /// Connection that ran the old binary; the replacement arrives on another one.
    previous_connection: Option<SocketId>,
    /// Binary the replacement connection must report.
    expected: ExpectedBinary,
}

/// What the upgraded agent must report to count as upgraded.
enum ExpectedBinary {
    /// A published release is identified by its version.
    Version(String),
    /// The server's own executable may be an unreleased build, so all of its identity counts.
    Exact(BinaryIdentity),
}

impl ExpectedBinary {
    /// Whether a reconnected agent runs the binary this upgrade installed.
    fn matches(&self, binary: &BinaryIdentity) -> bool {
        match self {
            Self::Version(version) => &binary.version == version,
            Self::Exact(identity) => binary == identity,
        }
    }
}

impl TrackedUpgrade {
    /// Ends a restarting upgrade once the agent is back on a new connection.
    ///
    /// Done when the status is read rather than by watching connections, because only a
    /// reader needs the outcome. An agent whose new binary could not start falls back to its
    /// old image, so a replacement on the wrong build is reported as a failure.
    fn resolve(&mut self, entry: Option<&AgentListEntry>) {
        if self.job.phase != AgentUpgradePhase::Restarting {
            return;
        }
        let Some(entry) = entry else {
            return;
        };
        if entry.status != AgentConnectionStatus::Connected
            || entry.connection_id == self.previous_connection
        {
            return;
        }
        let Some(identity) = &entry.identity else {
            return;
        };
        self.job.phase = if self.expected.matches(&identity.binary) {
            AgentUpgradePhase::Completed
        } else {
            AgentUpgradePhase::Failed {
                error: format!(
                    "The agent reconnected running Redoor {} instead of {}; check the agent's log",
                    identity.binary.version, self.job.target_version
                ),
            }
        };
    }
}

impl AgentUpgrades {
    /// Locks the table; a poisoned lock still holds consistent plain data.
    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<AgentId, TrackedUpgrade>> {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a new upgrade, refusing while another one of the same agent is running,
    /// since both would write the same executable.
    fn begin(&self, agent_id: &AgentId, upgrade: TrackedUpgrade) -> Result<(), ApiError> {
        let mut jobs = self.jobs();
        if jobs
            .get(agent_id)
            .is_some_and(|tracked| tracked.job.phase.is_running())
        {
            return Err(ApiError::conflict(
                "An upgrade of this agent is already running",
            ));
        }
        jobs.insert(agent_id.clone(), upgrade);
        Ok(())
    }

    /// Moves an upgrade to `phase`, unless a newer upgrade replaced it meanwhile.
    fn set_phase(&self, agent_id: &AgentId, job_id: &str, phase: AgentUpgradePhase) {
        if let Some(tracked) = self.jobs().get_mut(agent_id)
            && tracked.job.id == job_id
        {
            tracked.job.phase = phase;
        }
    }

    /// The agent's current or last upgrade, ended first if the agent is back.
    fn status(
        &self,
        agent_id: &AgentId,
        entry: Option<&AgentListEntry>,
    ) -> Option<AgentUpgradeJob> {
        let mut jobs = self.jobs();
        let tracked = jobs.get_mut(agent_id)?;
        tracked.resolve(entry);
        Some(tracked.job.clone())
    }

    /// Forgets a finished upgrade; a running one cannot be dismissed.
    fn dismiss(&self, agent_id: &AgentId) -> Result<(), ApiError> {
        let mut jobs = self.jobs();
        if jobs
            .get(agent_id)
            .is_some_and(|tracked| tracked.job.phase.is_running())
        {
            return Err(ApiError::conflict(
                "The upgrade of this agent is still running",
            ));
        }
        jobs.remove(agent_id);
        Ok(())
    }
}

/// Maps binary selection failures to stable operator-facing upgrade errors.
fn upgrade_binary_error(error: crate::binaries::UpgradeBinaryError) -> ApiError {
    let status = match error {
        crate::binaries::UpgradeBinaryError::InvalidVersion { .. }
        | crate::binaries::UpgradeBinaryError::UnsupportedPlatform { .. } => {
            StatusCode::BAD_REQUEST
        }
        crate::binaries::UpgradeBinaryError::Provision(_) => StatusCode::BAD_GATEWAY,
    };
    ApiError::status(status, error.to_string())
}

/// Rejects a running server executable that cannot target the agent CPU.
fn running_server_architecture_error(agent_arch: &str) -> Option<ApiError> {
    if agent_arch == std::env::consts::ARCH {
        return None;
    }
    Some(ApiError::conflict(format!(
        "Cannot install the running server binary: server architecture is {}, but agent architecture is {agent_arch}",
        std::env::consts::ARCH
    )))
}

/// Where the binary of an accepted upgrade comes from.
enum UpgradeBinary {
    /// Fetched into the release cache by the task, since a download can take long.
    Release { version: String },
    /// The server's own executable, already on disk.
    RunningServer { path: PathBuf },
}

/// An accepted upgrade, run to its end by its own task.
struct UpgradeTask {
    state: ServerState,
    agent_id: AgentId,
    job_id: String,
    target_version: String,
    binary: UpgradeBinary,
    details: AgentDetailsResponse,
}

impl UpgradeTask {
    /// Runs the upgrade and records how it ended.
    async fn run(self) {
        let phase = match self.install().await {
            Ok(()) => AgentUpgradePhase::Restarting,
            Err(error) => {
                log_error!(
                    anyhow::Error::msg(error.to_string()),
                    "Agent upgrade failed: agent_id={}, target_version={}, error={}",
                    self.agent_id,
                    self.target_version,
                    error
                );
                AgentUpgradePhase::Failed {
                    error: error.to_string(),
                }
            }
        };
        self.state
            .agent_upgrades
            .set_phase(&self.agent_id, &self.job_id, phase);
    }

    /// Prepares the binary, streams it over the agent's executable and asks it to exec it.
    async fn install(&self) -> Result<(), ApiError> {
        let source_path = match &self.binary {
            UpgradeBinary::Release { version } => self
                .state
                .binaries
                .ensure(version, &self.details.os, &self.details.arch, |_| {})
                .await
                .map_err(upgrade_binary_error)?,
            UpgradeBinary::RunningServer { path } => path.clone(),
        };
        log!(
            Level::Info,
            "Agent upgrade binary ready: agent_id={}, target_version={}, os={}, arch={}, path={}",
            self.agent_id,
            self.target_version,
            self.details.os,
            self.details.arch,
            source_path.display()
        );
        self.upload(&source_path).await?;
        log!(
            Level::Info,
            "Requesting upgraded agent self-exec: agent_id={}, target_version={}, executable={}",
            self.agent_id,
            self.target_version,
            self.details.exe_path
        );
        let call = SelfExec {
            path: self.details.exe_path.clone(),
        };
        self.state.agents.call(&self.agent_id, call).await?;
        log!(
            Level::Info,
            "Agent acknowledged upgrade self-exec: agent_id={}, target_version={}",
            self.agent_id,
            self.target_version
        );
        Ok(())
    }

    /// Streams the executable through the same bounded transfer producer as HTTP PUT,
    /// recording the bytes sent so the UI can show progress.
    async fn upload(&self, source_path: &Path) -> Result<(), ApiError> {
        use tokio::io::AsyncReadExt;

        let destination_path = &self.details.exe_path;
        let mut file = tokio::fs::File::open(source_path).await.map_err(|error| {
            ApiError::status(
                StatusCode::BAD_GATEWAY,
                format!("Failed to open upgrade binary: {error}"),
            )
        })?;
        let total_bytes = file
            .metadata()
            .await
            .map_err(|error| {
                ApiError::status(
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to inspect upgrade binary: {error}"),
                )
            })?
            .len();
        log!(
            Level::Info,
            "Uploading agent upgrade binary: agent_id={}, source={}, destination={}, bytes={}",
            self.agent_id,
            source_path.display(),
            destination_path,
            total_bytes
        );
        self.report_upload(0, total_bytes);
        let command = Command::RawUpload(request::RawUpload {
            partial: None,
            path: destination_path.clone(),
            // Merge publishes a file with a single rename over the old one, so the executable
            // path never goes missing; override would move the old binary aside first.
            on_existing: redoor_protocol::api::transfers::CopyExistingMode::Merge,
            ownership: redoor_protocol::api::files::CreationOwnershipOptions::default(),
            executable: false,
            precondition: None,
        });
        let upload = AgentUpload::start(
            &self.state.router_ref,
            self.agent_id.clone(),
            command,
            destination_path.clone(),
            total_bytes,
        )
        .await?;
        // An upgrade binary is never empty, so an agent that finished before reading a byte did
        // not install it; self-exec would then run whatever (if anything) is at the destination.
        let UploadStart::Ready(mut upload) = upload else {
            return Err(ApiError::internal(
                "Unexpected early upgrade upload completion",
            ));
        };
        let mut buffer = vec![0; redoor_protocol::wire::stream::CHUNK_SIZE];
        let mut sent_bytes = 0;
        loop {
            let bytes_read = file.read(&mut buffer).await.map_err(|error| {
                ApiError::status(
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to read upgrade binary: {error}"),
                )
            })?;
            if bytes_read == 0 {
                break;
            }
            upload.send(&buffer[..bytes_read]).await?;
            sent_bytes += bytes_read as u64;
            self.report_upload(sent_bytes, total_bytes);
        }
        upload.finish().await?;
        log!(
            Level::Info,
            "Agent upgrade binary upload completed: agent_id={}, destination={}, bytes={}",
            self.agent_id,
            destination_path,
            total_bytes
        );
        Ok(())
    }

    /// Records upload progress for `GET /api/v1/agents/{agent}/upgrade`.
    fn report_upload(&self, sent_bytes: u64, total_bytes: u64) {
        self.state.agent_upgrades.set_phase(
            &self.agent_id,
            &self.job_id,
            AgentUpgradePhase::Uploading {
                sent_bytes,
                total_bytes,
            },
        );
    }
}

/// Finds the inventory row of one agent.
async fn inventory_entry(
    state: &ServerState,
    agent_id: &AgentId,
) -> Result<Option<AgentListEntry>, ApiError> {
    Ok(state
        .agents
        .inventory()
        .await?
        .into_iter()
        .find(|entry| &entry.id == agent_id))
}

/// Route: `POST /api/v1/agents/{agent}/upgrade` validates the request, then installs and
/// execs the selected binary in the background.
///
/// Everything that can be checked up front is answered here, so a bad version or an
/// unusable agent is reported by the request itself; later failures end up in the status.
pub(crate) async fn upgrade_agent_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
    Json(request): Json<UpgradeAgentRequest>,
) -> Result<Json<UpgradeAgentResponse>, ApiError> {
    let entry = inventory_entry(&state, &agent_id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("Agent not found: {agent_id}")))?;
    // The next ensure step would replace a managed daemon running another binary than the
    // server's, and the upgrade's re-exec releases the daemon's lock, which its session
    // would read as a dead daemon.
    if entry.managed {
        return Err(ApiError::conflict(format!(
            "Managed agents are upgraded by the server, which runs its own binary on them at every start: {agent_id}"
        )));
    }
    if entry.status != AgentConnectionStatus::Connected {
        return Err(ApiError::conflict(format!(
            "Agent is not connected: {agent_id}"
        )));
    }
    let details = state.agents.agent_details(&agent_id).await?;
    if details.exe_path == "unknown" || !Path::new(&details.exe_path).is_absolute() {
        return Err(ApiError::bad_request(format!(
            "Agent executable path is unusable: {}",
            details.exe_path
        )));
    }
    let (binary, target_version, source, expected) = match request {
        UpgradeAgentRequest::PublishedRelease { target_version } => {
            crate::binaries::validate_release_version(&target_version)
                .and_then(|()| {
                    crate::binaries::validate_release_platform(&details.os, &details.arch)
                })
                .map_err(upgrade_binary_error)?;
            (
                UpgradeBinary::Release {
                    version: target_version.clone(),
                },
                target_version.clone(),
                AgentUpgradeSource::PublishedRelease,
                ExpectedBinary::Version(target_version),
            )
        }
        UpgradeAgentRequest::RunningServer => {
            if let Some(error) = running_server_architecture_error(&details.arch) {
                return Err(error);
            }
            let path = redoor_core::identity::current_exe_path().await;
            if path == "unknown" {
                return Err(ApiError::internal(
                    "Cannot locate the running server binary",
                ));
            }
            let server_binary = redoor_core::identity::current_binary_identity();
            (
                UpgradeBinary::RunningServer {
                    path: PathBuf::from(path),
                },
                server_binary.version.clone(),
                AgentUpgradeSource::RunningServer,
                ExpectedBinary::Exact(server_binary),
            )
        }
    };
    let job_id = uuid::Uuid::new_v4().to_string();
    state.agent_upgrades.begin(
        &agent_id,
        TrackedUpgrade {
            job: AgentUpgradeJob {
                id: job_id.clone(),
                target_version: target_version.clone(),
                source,
                phase: AgentUpgradePhase::Preparing,
                started_at: UnixTimestampMillis::now(),
            },
            previous_connection: entry.connection_id,
            expected,
        },
    )?;
    log!(
        Level::Info,
        "Starting agent upgrade: agent_id={}, current_version={}, target_version={}, source={:?}, os={}, arch={}, executable={}",
        agent_id,
        details.binary.version,
        target_version,
        source,
        details.os,
        details.arch,
        details.exe_path
    );
    let task = UpgradeTask {
        state,
        agent_id,
        job_id,
        target_version: target_version.clone(),
        binary,
        details,
    };
    redoor_core::logging::spawn_in_user_scope(task.run());
    Ok(Json(UpgradeAgentResponse {
        upgrading: true,
        target_version,
    }))
}

/// Route: `GET /api/v1/agents/{agent}/upgrade` reports the agent's running or last upgrade.
pub(crate) async fn agent_upgrade_status_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<Json<AgentUpgradeStatusResponse>, ApiError> {
    let entry = inventory_entry(&state, &agent_id).await?;
    Ok(Json(AgentUpgradeStatusResponse {
        job: state.agent_upgrades.status(&agent_id, entry.as_ref()),
    }))
}

/// Route: `DELETE /api/v1/agents/{agent}/upgrade` forgets a finished upgrade once its
/// outcome was seen, so the UI stops showing it.
pub(crate) async fn dismiss_agent_upgrade_handler(
    ResolvedDevice(agent_id): ResolvedDevice,
    AxumState(state): AxumState<ServerState>,
) -> Result<StatusCode, ApiError> {
    state.agent_upgrades.dismiss(&agent_id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::{
        lanes::ControlLanes,
        router::{ConnectionStreams, RegisterAgentRequest},
    };

    /// An inventory row of agent `a` connected on `connection` and running `version`.
    fn connected_entry(connection: SocketId, version: &str) -> AgentListEntry {
        let agent_id = redoor_core::test_support::test_agent_id("a");
        let mut registration = RegisterAgentRequest::for_test(
            &agent_id,
            ControlLanes::bounded(1, 1).0,
            ConnectionStreams::new(agent_id.clone()),
        );
        registration.identity.binary.version = version.to_string();
        AgentListEntry {
            id: agent_id,
            name: "a".to_string(),
            default_directory: Some("/tmp".to_string()),
            managed: false,
            configuration_editable: false,
            ssh_target: None,
            status: AgentConnectionStatus::Connected,
            connected_at: None,
            connection_id: Some(connection),
            last_seen_at: None,
            connection_issue: None,
            provisioning_status: Vec::new(),
            identity: Some(registration.identity),
            capabilities: registration.capabilities,
            duplicate_id: None,
        }
    }

    /// A release upgrade to `2.0.0` that already asked the agent on `previous` to exec.
    fn restarting_upgrade(previous: SocketId) -> TrackedUpgrade {
        TrackedUpgrade {
            job: AgentUpgradeJob {
                id: "job".to_string(),
                target_version: "2.0.0".to_string(),
                source: AgentUpgradeSource::PublishedRelease,
                phase: AgentUpgradePhase::Restarting,
                started_at: UnixTimestampMillis::now(),
            },
            previous_connection: Some(previous),
            expected: ExpectedBinary::Version("2.0.0".to_string()),
        }
    }

    /// A restarting upgrade ends only when the agent is back on another connection.
    #[test]
    fn restarting_upgrade_completes_on_the_replacement_connection() {
        let previous = SocketId::new();
        let mut upgrade = restarting_upgrade(previous.clone());
        upgrade.resolve(Some(&connected_entry(previous, "1.0.0")));
        // The old connection may still be listed before it drops, which is not the upgrade.
        assert_eq!(upgrade.job.phase, AgentUpgradePhase::Restarting);
        upgrade.resolve(Some(&connected_entry(SocketId::new(), "2.0.0")));
        // A new connection on the target version is the upgraded agent.
        assert_eq!(upgrade.job.phase, AgentUpgradePhase::Completed);
    }

    /// An agent whose new binary could not start comes back on its old one, which must be
    /// reported instead of leaving the UI waiting.
    #[test]
    fn replacement_on_another_build_fails_the_upgrade() {
        let previous = SocketId::new();
        let mut upgrade = restarting_upgrade(previous);
        upgrade.resolve(Some(&connected_entry(SocketId::new(), "1.0.0")));
        // The failure names both versions so the operator knows what is running.
        assert_eq!(
            upgrade.job.phase,
            AgentUpgradePhase::Failed {
                error: "The agent reconnected running Redoor 1.0.0 instead of 2.0.0; check the agent's log"
                    .to_string()
            }
        );
    }

    /// A second upgrade of the same agent would write the same executable concurrently.
    #[test]
    fn refuses_a_second_running_upgrade_and_its_dismissal() {
        let upgrades = AgentUpgrades::default();
        let agent_id = redoor_core::test_support::test_agent_id("a");
        let mut running = restarting_upgrade(SocketId::new());
        running.job.phase = AgentUpgradePhase::Preparing;
        upgrades.begin(&agent_id, running).unwrap();
        let second = upgrades.begin(&agent_id, restarting_upgrade(SocketId::new()));
        // Starting another one while the first still writes the binary is a conflict.
        assert_eq!(
            second.map_err(|error| error.status_code()),
            Err(StatusCode::CONFLICT)
        );
        // A running upgrade cannot be dismissed either, or its outcome would be lost.
        assert_eq!(
            upgrades
                .dismiss(&agent_id)
                .map_err(|error| error.status_code()),
            Err(StatusCode::CONFLICT)
        );
        upgrades.set_phase(&agent_id, "job", AgentUpgradePhase::Restarting);
        // Once the agent was told to exec, a new upgrade may start, e.g. after a failed exec.
        assert!(
            upgrades
                .begin(&agent_id, restarting_upgrade(SocketId::new()))
                .is_ok()
        );
    }

    /// Unsupported release pairs return a client error with the exact rejected target.
    #[test]
    fn unsupported_upgrade_platform_error_is_actionable() {
        let error =
            upgrade_binary_error(crate::binaries::UpgradeBinaryError::UnsupportedPlatform {
                os: "macos".to_string(),
                arch: "x86_64".to_string(),
            });
        // A nonexistent release artifact is a target validation error, not an upstream outage.
        assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);
        // Naming the exact pair lets operators select one emitted by release.yml.
        assert_eq!(
            error.to_string(),
            "Unsupported Redoor release platform: macos/x86_64"
        );
    }

    /// Running binaries are rejected before upload when their CPU target differs.
    #[test]
    fn running_server_binary_requires_matching_architecture() {
        let mismatching_arch = if std::env::consts::ARCH == "x86_64" {
            "aarch64"
        } else {
            "x86_64"
        };
        let error = running_server_architecture_error(mismatching_arch).unwrap();
        // A conflict identifies a valid force operation that is unsafe for this agent.
        assert_eq!(error.status_code(), StatusCode::CONFLICT);
        // Both architectures let operators understand why the force action was blocked.
        assert_eq!(
            error.to_string(),
            format!(
                "Cannot install the running server binary: server architecture is {}, but agent architecture is {mismatching_arch}",
                std::env::consts::ARCH
            )
        );
        // A matching architecture is allowed to proceed to binary selection.
        assert!(running_server_architecture_error(std::env::consts::ARCH).is_none());
    }
}
