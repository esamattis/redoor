//! Router handlers for agent registration, managed lifecycle, one-shot command routing and the
//! terminal and log streams of a connection.

use super::RouterError;
use super::flows::{CommandFlow, Flow};
use super::messages::{
    AgentListEntry, ApplyManagedLifecycleRequest, ExecuteCommandRequest, LogStream,
    OpenAgentLogStreamRequest, OpenTerminalRequest, RegisterAgentRequest,
    RegisterManagedAgentRequest, RegistrationRejection, RouteResponse, TerminalStream,
    UnregisterManagedAgentRequest,
};
use super::state::{AgentConnection, KnownAgent, RouterState};
use super::streams::{AgentLink, OutboundStart, OutboundStream, StreamLease};
use redoor_core::log;
use redoor_protocol::wire::command::Command;
use redoor_protocol::wire::handshake::RejectReason;
use redoor_protocol::wire::log::Level;
use redoor_protocol::wire::policy::CancelScope;
use redoor_protocol::wire::policy::CommandLane;
use redoor_protocol::wire::stream::{STREAM_CREDIT_WINDOW_FRAMES, TERMINAL_CREDIT_WINDOW_FRAMES};
use redoor_protocol::{api::agents::AgentConnectionStatus, wire::request::CommandOutcome};
use redoor_protocol::{
    ids::{AgentId, RequestId, SocketId, UnixTimestampSeconds},
    wire::ServerToAgent,
};

/// Terminals one connection may run at once, matching the agent's own limit so the server
/// refuses excess terminals before the agent has to.
const MAX_TERMINALS_PER_CONNECTION: usize = 8;
/// Live log streams one connection may run at once, matching the agent's own limit.
const MAX_LOG_STREAMS_PER_CONNECTION: usize = 8;

impl AgentConnection {
    /// Builds one live router connection entry from the agent registration payload.
    pub(crate) fn from_register_request(request: RegisterAgentRequest) -> Self {
        Self {
            agent_id: request.agent_id,
            agent_name: request.agent_name,
            socket_id: request.socket_id,
            lanes: request.lanes,
            connected_at: UnixTimestampSeconds::new(jiff::Timestamp::now().as_second()),
            identity: request.identity,
            capabilities: request.capabilities,
            streams: request.streams,
            activity: request.activity,
            terminals: Default::default(),
            log_streams: Default::default(),
            tickets: Default::default(),
        }
    }

    /// Lanes a stream of this connection uses without going through the router.
    pub(crate) fn link(&self) -> AgentLink {
        AgentLink::new(self.lanes.clone())
    }

    /// Admits a command onto the bounded command lane.
    ///
    /// Output streams get their initial credit in the command frame so output starts without
    /// a round trip; uploads start with none and wait for the agent's first grant, which
    /// tells the router the agent's worker is ready.
    pub(crate) fn send_command(&mut self, id: RequestId, command: Command) -> bool {
        let credit = if command.policy().lane == CommandLane::Output {
            STREAM_CREDIT_WINDOW_FRAMES
        } else {
            0
        };
        self.send_request(
            id,
            ServerToAgent::Command {
                id,
                credit,
                command,
            },
        )
    }

    /// Admits a frame that starts work under `id` (a command or a stream open) and keeps its
    /// ticket, so a cancel can still withdraw it while it waits in the queue.
    pub(crate) fn send_request(&mut self, id: RequestId, frame: ServerToAgent) -> bool {
        let ticket = self.lanes.try_tracked_command(frame);
        let admitted = ticket.is_some();
        if let Some(ticket) = ticket {
            self.tickets.insert(id, ticket);
        }
        self.report_admission(admitted)
    }

    /// Stops work `id` on the agent.
    ///
    /// A cancel may never overtake its command, because the agent would not know the id and
    /// the command would then run uncanceled. So a command still in the queue is withdrawn
    /// and never written, and only a written one gets a `cancel` frame (on the priority lane,
    /// retained in a task when the lane is momentarily full so an admitted cancel is never
    /// lost). A closed lane is an error the caller can report and retry.
    pub(crate) fn cancel_request(
        &mut self,
        id: RequestId,
        reason: redoor_protocol::wire::partials::CancelReason,
    ) -> Result<CancelDelivery, RouterError> {
        if let Some(ticket) = self.tickets.remove(&id)
            && ticket.withdraw()
        {
            return Ok(CancelDelivery::Withdrawn);
        }
        self.lanes
            .queue_priority(ServerToAgent::Cancel { id, reason })
            .map(CancelDelivery::Sent)
            .map_err(|_| RouterError::ControlQueueFull {
                agent_id: self.agent_id.to_string(),
            })
    }

    /// Forgets the ticket of work the agent answered or that ended otherwise.
    pub(crate) fn settle_request(&mut self, id: RequestId) {
        self.tickets.remove(&id);
    }

    /// Queues lifecycle or cancellation traffic independently of command admission.
    pub(crate) fn send_priority_message(&self, message: ServerToAgent) -> bool {
        self.report_admission(self.lanes.try_priority(message))
    }

    /// Logs a frame a saturated or closed lane refused, so dropped work is visible.
    fn report_admission(&self, admitted: bool) -> bool {
        if !admitted {
            log!(
                Level::Warning,
                "Failed to queue control frame for agent: socket_id={}",
                self.socket_id
            );
        }
        admitted
    }
}

/// How a cancel reached (or did not need to reach) the agent.
#[derive(Debug)]
pub(crate) enum CancelDelivery {
    /// The command was still queued and will never be written, so the agent never sees it
    /// and the router answers it locally.
    Withdrawn,
    /// A `cancel` frame was queued, possibly through a task waiting for lane capacity (to be
    /// aborted once the cancel became pointless); the agent's result acknowledges it.
    Sent(Option<tokio::task::JoinHandle<()>>),
}

/// Why a `hello`'s identity is unacceptable, if it is; ids must be in the device id format
/// and names must follow the name rules, or stored references and lookups would break.
fn invalid_identity(request: &RegisterAgentRequest) -> Option<String> {
    if !request.agent_id.is_valid() {
        return Some(
            redoor_protocol::ids::InvalidAgentId(request.agent_id.to_string()).to_string(),
        );
    }
    redoor_protocol::ids::validate_device_name(&request.agent_name)
        .err()
        .map(|error| error.to_string())
}

/// Current wall-clock second, used for inventory timestamps.
fn now() -> UnixTimestampSeconds {
    UnixTimestampSeconds::new(jiff::Timestamp::now().as_second())
}

impl RouterState {
    /// Commits live routing and retained inventory together after lifecycle admission.
    ///
    /// `welcome` is queued before anything else on the priority lane, so it is always the
    /// first frame the agent reads. The connection carries every stream, so the agent is
    /// fully usable from this point on.
    fn commit_registration(&mut self, mut request: RegisterAgentRequest) {
        let reply = request.reply.take();
        log!(
            Level::Info,
            "Agent registered: agent_id={}, agent_name={}, socket_id={}",
            request.agent_id,
            request.agent_name,
            request.socket_id
        );
        let agent_id = request.agent_id.clone();
        let connection = AgentConnection::from_register_request(request);
        let welcome = ServerToAgent::Welcome {
            connection_id: connection.socket_id.clone(),
        };
        let lanes = connection.lanes.clone();
        let known = self
            .agents
            .known_by_id
            .entry(agent_id.clone())
            .or_insert_with(|| {
                KnownAgent::unregistered(
                    agent_id.clone(),
                    None,
                    AgentConnectionStatus::Disconnected,
                )
            });
        known.name = connection.agent_name.clone();
        known.default_directory = Some(connection.identity.default_directory.clone());
        known.status = AgentConnectionStatus::Connected;
        known.connected_at = Some(connection.connected_at);
        known.connection_issue = None;
        known.socket_id = Some(connection.socket_id.clone());
        known.identity = Some(connection.identity.clone());
        known.capabilities = connection.capabilities;
        self.agents.by_id.insert(agent_id, connection);
        self.notify_agents_changed();

        let _ = lanes.try_priority(welcome);
        if let Some(reply) = reply {
            let _ = reply.send(Ok(()));
        }
    }

    /// Refuses a `hello`: queues `rejected` for the agent and tells its session to close.
    fn reject_registration(request: RegisterAgentRequest, reason: RejectReason, message: String) {
        let _ = request.lanes.try_priority(ServerToAgent::Rejected {
            reason,
            message: message.clone(),
        });
        if let Some(reply) = request.reply {
            let _ = reply.send(Err(RegistrationRejection { reason, message }));
        }
    }

    /// Ends an evicted control session and fails everything that depended on it.
    ///
    /// `notice` is sent on the old session's priority lane so a replaced agent process exits
    /// promptly instead of lingering as a zombie.
    fn release_connection(&mut self, connection: AgentConnection, notice: Option<&str>) {
        if let Some(message) = notice {
            let _ = connection.send_priority_message(ServerToAgent::Evicted {
                message: message.to_string(),
            });
        }
        let agent_id = connection.agent_id.clone();
        self.fail_agent_flows(&agent_id);
        // Ends terminal and log bridges too: their output queues close with the tables.
        connection.streams.clear();
    }

    /// Records in the inventory that an agent's authoritative connection ended.
    fn forget_connection(&mut self, agent_id: &AgentId) {
        if let Some(known) = self.agents.known_by_id.get_mut(agent_id) {
            known.last_seen_at = Some(now());
            known.connected_at = None;
            known.socket_id = None;
        }
    }

    /// Registers a connected agent, replacing an existing connection of the same agent.
    ///
    /// When the SSH tunnel drops without a clean TCP close, the server may not detect the old
    /// session's disconnect for a long time. Rejecting the reconnect in that window would make
    /// the agent permanently unreachable until the TCP timeout fires. Instead, the new
    /// connection takes over and the old session is evicted. The stale session's later
    /// `UnregisterAgent` is ignored because its `socket_id` will not match.
    ///
    /// A `hello` whose id is not in the device id format or whose name breaks the name rules
    /// is refused, because ids are stored in token scopes and names are used to address
    /// devices. A *different* id claiming a name that a live or configured device uses is
    /// refused too, so a name in a request always points to exactly one device. A `hello`
    /// that keeps taking over healthy connections of its id is refused with `duplicate_id`,
    /// because that is several machines sharing one id rather than a reconnect (see
    /// `duplicate_ids`).
    pub(crate) fn register_agent(&mut self, request: RegisterAgentRequest) {
        // The token was validated during the websocket upgrade, so takeover here is only
        // reachable with a valid agent_token.
        if let Some(message) = invalid_identity(&request) {
            log!(
                Level::Warning,
                "Rejecting agent with an invalid identity: agent_name={}, agent_id={}, reason={}",
                request.agent_name,
                request.agent_id,
                message
            );
            Self::reject_registration(request, RejectReason::InvalidIdentity, message);
            return;
        }
        if let Some(owner) = self.name_owner(&request.agent_name, &request.agent_id) {
            log!(
                Level::Warning,
                "Rejecting agent whose name is used by another device: agent_name={}, agent_id={}, owner_agent_id={}",
                request.agent_name,
                request.agent_id,
                owner
            );
            let message = format!(
                "Device name '{}' is already used by device '{}'",
                request.agent_name, owner
            );
            Self::reject_registration(request, RejectReason::DuplicateName, message);
            return;
        }
        if let Err(message) = self.admit_takeover(&request) {
            log!(
                Level::Warning,
                "Rejecting agent whose id is held by a healthy connection of another machine: agent_name={}, agent_id={}, hostname={}",
                request.agent_name,
                request.agent_id,
                request.identity.hostname
            );
            Self::reject_registration(request, RejectReason::DuplicateId, message);
            return;
        }
        self.forget_stale_name_holders(&request.agent_name, &request.agent_id);
        if let Some(old_connection) = self.agents.by_id.remove(&request.agent_id) {
            log!(
                Level::Warning,
                "Replacing stale agent connection: agent_name={}, agent_id={}, old_socket_id={}, socket_id={}",
                request.agent_name,
                request.agent_id,
                old_connection.socket_id,
                request.socket_id
            );
            self.forget_connection(&request.agent_id);
            self.release_connection(
                old_connection,
                Some("Connection replaced by a new connection of the same agent"),
            );
        }

        let Some(watchdog) = request.watchdog.clone() else {
            self.commit_registration(request);
            return;
        };
        let Some(attempt_generation) = request.watchdog_attempt_generation else {
            Self::reject_registration(
                request,
                RejectReason::Stopped,
                "Managed agent is intentionally stopped".to_string(),
            );
            return;
        };
        // The closure consumes the request only when the attempt is still current, so the
        // rejection path below gets it back otherwise.
        let mut pending = Some(request);
        let committed = watchdog
            .while_current_attempt(attempt_generation, || {
                if let Some(request) = pending.take() {
                    self.commit_registration(request);
                }
            })
            .is_some();
        if let Some(request) = pending.filter(|_| !committed) {
            log!(
                Level::Warning,
                "Rejecting managed registration that lost a shutdown race: agent_id={}",
                request.agent_id
            );
            Self::reject_registration(
                request,
                RejectReason::Stopped,
                "Managed agent is intentionally stopped".to_string(),
            );
        }
    }

    /// Removes an agent whose control session ended, unless a newer session replaced it.
    pub(crate) fn unregister_agent(&mut self, agent_id: AgentId, socket_id: SocketId) {
        // A replacement shares the agent id, so only the matching session may evict the entry.
        let is_current = self
            .agents
            .by_id
            .get(&agent_id)
            .is_some_and(|connection| connection.socket_id == socket_id);
        if !is_current {
            log!(
                Level::Debug,
                "Ignoring stale unregister: agent_id={}, socket_id={}",
                agent_id,
                socket_id
            );
            return;
        }
        log!(Level::Info, "Agent unregistered: agent_id={}", agent_id);
        let Some(connection) = self.agents.by_id.remove(&agent_id) else {
            return;
        };
        if let Some(known) = self.agents.known_by_id.get_mut(&agent_id) {
            known.connected_at = None;
            known.last_seen_at = Some(now());
            known.socket_id = None;
            known.status = if known.managed {
                AgentConnectionStatus::Starting
            } else {
                AgentConnectionStatus::Disconnected
            };
        }
        self.notify_agents_changed();
        self.release_connection(connection, None);
    }

    /// Adds a configured stopped record before its dormant supervisor can be controlled.
    pub(crate) fn register_managed(&mut self, request: RegisterManagedAgentRequest) {
        let id = request.agent_id;
        // Configuration checks already refused names of other configured or live devices, so
        // only a previously seen standalone agent can still hold this name.
        self.forget_stale_name_holders(&request.name, &id);
        let mut known = KnownAgent::unregistered(
            id.clone(),
            request.default_directory,
            AgentConnectionStatus::Stopped,
        );
        known.name = request.name;
        known.managed = true;
        known.configuration_editable = request.configuration_editable;
        known.ssh_target = request.ssh_target;
        self.agents.known_by_id.insert(id, known);
        self.notify_agents_changed();
        let _ = request.reply.send(());
    }

    /// Removes all retained state for a managed agent whose supervisor is already dormant.
    pub(crate) fn unregister_managed(&mut self, request: UnregisterManagedAgentRequest) {
        self.agents.known_by_id.remove(&request.agent_id);
        self.agents.takeovers.remove(&request.agent_id);
        if let Some(connection) = self.agents.by_id.remove(&request.agent_id) {
            self.release_connection(connection, None);
        }
        self.notify_agents_changed();
        let _ = request.reply.send(());
    }

    /// Projects supervisor changes into retained inventory without touching streaming lanes.
    pub(crate) fn apply_managed_lifecycle(&mut self, request: ApplyManagedLifecycleRequest) {
        let ApplyManagedLifecycleRequest {
            agent_id,
            snapshot,
            evict_existing,
            reply,
        } = request;
        let managed = self
            .agents
            .known_by_id
            .get(&agent_id)
            .is_some_and(|known| known.managed);
        if !managed {
            if let Some(reply) = reply {
                let _ = reply.send(());
            }
            return;
        }

        if evict_existing && let Some(connection) = self.agents.by_id.remove(&agent_id) {
            self.forget_connection(&agent_id);
            self.release_connection(connection, Some("Managed agent startup was retried"));
        }

        let live_socket = self
            .agents
            .by_id
            .get(&agent_id)
            .map(|connection| connection.socket_id.clone());
        let known = self
            .agents
            .known_by_id
            .get_mut(&agent_id)
            .expect("managed agent disappeared during lifecycle projection");
        if live_socket.is_some() && snapshot.status != AgentConnectionStatus::Stopped {
            // A live connection is fully usable, whatever the supervisor learned last.
            known.status = AgentConnectionStatus::Connected;
            known.connection_issue = snapshot.connection_issue;
            known.provisioning_status = snapshot.provisioning_status.clone();
        } else {
            known.status = snapshot.status.clone();
            known.connection_issue = snapshot.connection_issue;
            known.provisioning_status = snapshot.provisioning_status;
            known.socket_id = snapshot.socket_id;
            if known.status != AgentConnectionStatus::Connected {
                known.connected_at = None;
            }
        }

        if known.status == AgentConnectionStatus::Stopped
            && let Some(connection) = self.agents.by_id.remove(&agent_id)
        {
            known.last_seen_at = Some(now());
            known.socket_id = None;
            self.release_connection(connection, Some("Managed agent was shut down"));
        }
        self.notify_agents_changed();
        if let Some(reply) = reply {
            let _ = reply.send(());
        }
    }

    /// Resolves a device value from a request: an exact id wins, otherwise the name.
    ///
    /// Names cannot be in the id format, so the two never compete. Resolution happens once,
    /// before access control, so scope checks always compare ids.
    pub(crate) fn resolve_device(&self, value: &str) -> Option<AgentId> {
        if let Some((id, _)) = self
            .agents
            .known_by_id
            .get_key_value(&AgentId::unchecked(value))
        {
            return Some(id.clone());
        }
        self.agents
            .known_by_id
            .values()
            .find(|known| known.name == value)
            .map(|known| known.id.clone())
    }

    /// Another device that holds `name` and must keep it: one that is connected or configured.
    fn name_owner(&self, name: &str, agent_id: &AgentId) -> Option<AgentId> {
        self.agents
            .known_by_id
            .values()
            .filter(|known| &known.id != agent_id && known.name == name)
            .find(|known| known.managed || self.agents.by_id.contains_key(&known.id))
            .map(|known| known.id.clone())
            .or_else(|| self.name_reserved_by_other(name, agent_id))
    }

    /// Another device's pending reservation of `name`, which a config edit is about to give
    /// to that device.
    fn name_reserved_by_other(&self, name: &str, agent_id: &AgentId) -> Option<AgentId> {
        self.agents
            .reserved_names
            .iter()
            .find(|(id, reserved)| *id != agent_id && reserved.as_str() == name)
            .map(|(id, _)| id.clone())
    }

    /// Claims `name` for a managed device before its config edit, atomically with every
    /// `hello`, so no other device can take the name while the edit runs.
    ///
    /// Any device in the inventory holding the name refuses it, even a disconnected one,
    /// because it is still listed under that name; a pending reservation of another device
    /// refuses it too. The holder is returned so the caller can name it.
    pub(crate) fn reserve_name(&mut self, agent_id: AgentId, name: String) -> Result<(), AgentId> {
        let holder = self
            .agents
            .known_by_id
            .values()
            .find(|known| known.id != agent_id && known.name == name)
            .map(|known| known.id.clone())
            .or_else(|| self.name_reserved_by_other(&name, &agent_id));
        if let Some(holder) = holder {
            return Err(holder);
        }
        self.agents.reserved_names.insert(agent_id, name);
        Ok(())
    }

    /// Drops inventory rows of disconnected standalone agents that held `name`, so a new
    /// device can take over the name of one that is gone without making names ambiguous.
    fn forget_stale_name_holders(&mut self, name: &str, agent_id: &AgentId) {
        let live = &self.agents.by_id;
        self.agents.known_by_id.retain(|id, known| {
            id == agent_id || known.name != name || known.managed || live.contains_key(id)
        });
    }

    /// Projects every retained inventory entry for deterministic REST sorting.
    pub(crate) fn list_agents(&self) -> Vec<AgentListEntry> {
        self.agents
            .known_by_id
            .values()
            .map(|info| AgentListEntry {
                id: info.id.clone(),
                name: info.name.clone(),
                default_directory: info.default_directory.clone(),
                managed: info.managed,
                configuration_editable: info.configuration_editable,
                ssh_target: info.ssh_target.clone(),
                status: info.status.clone(),
                connected_at: info.connected_at,
                connection_id: info.socket_id.clone(),
                last_seen_at: info.last_seen_at,
                connection_issue: info.connection_issue.clone(),
                provisioning_status: info.provisioning_status.clone(),
                identity: info.identity.clone(),
                capabilities: info.capabilities,
                duplicate_id: info.duplicate_id.clone(),
            })
            .collect()
    }

    /// Routes a one-shot command, under the id its caller chose, to an agent.
    pub(crate) fn execute_command_rest(&mut self, request: ExecuteCommandRequest) {
        if request.reply.is_closed() {
            return;
        }
        let request_id = request.request_id;
        log!(
            Level::Trace,
            "Routing REST command: agent_id={}, request_id={}, command={:?}",
            request.agent_id,
            request_id,
            request.command
        );
        let Some(agent_connection) = self.agents.by_id.get_mut(&request.agent_id) else {
            let _ = request.reply.send(CommandOutcome::error(
                redoor_protocol::wire::command::CommandErrorKind::NotFound,
                format!("Agent not found: {}", request.agent_id),
            ));
            return;
        };
        let cancelable = request.cancel_on_abandon
            && request.command.policy().cancel_scope == CancelScope::Request;
        if !agent_connection.send_command(request_id, request.command) {
            let _ = request.reply.send(CommandOutcome::error(
                redoor_protocol::wire::command::CommandErrorKind::ServiceUnavailable,
                format!("Agent control queue is full: {}", request.agent_id),
            ));
            return;
        }
        self.flows.insert(
            request_id,
            Flow::Command(CommandFlow {
                request_id,
                agent_id: request.agent_id.clone(),
                cancelable,
                reply: request.reply,
            }),
        );
    }

    /// Drops a one-shot command whose caller gave up and stops it on the agent when the agent
    /// can stop it (request cancel scope); other commands are short or bounded by their own
    /// agent-side timeouts and simply finish unobserved.
    pub(crate) fn abandon_command(&mut self, flow_id: super::flows::FlowId, agent_id: &AgentId) {
        match self.flows.get(flow_id) {
            Some(Flow::Command(command)) if &command.agent_id == agent_id => {}
            _ => {
                // Benign: the answer or the tick's pruning got there before the abandon.
                log!(
                    Level::Debug,
                    "Abandoned command already settled: agent_id={}, request_id={}",
                    agent_id,
                    flow_id
                );
                return;
            }
        }
        if let Some(Flow::Command(command)) = self.flows.remove(flow_id) {
            self.cancel_abandoned(&command);
        }
    }

    /// Stops an already removed, abandoned command on its agent when the agent registered it
    /// for cancellation. Shared by explicit abandonment and the tick's pruning of closed
    /// replies, so whichever notices the departed caller first still stops the work.
    pub(crate) fn cancel_abandoned(&mut self, command: &CommandFlow) {
        log!(
            Level::Debug,
            "Abandoned command: agent_id={}, request_id={}, cancelable={}",
            command.agent_id,
            command.request_id,
            command.cancelable
        );
        if command.cancelable {
            // A retained delivery task finishes on its own, a withdrawn command's local
            // result finds no flow, and a closed lane means the connection is gone and its
            // teardown already stopped the command.
            let _ = self.cancel_on_agent(
                &command.agent_id,
                command.request_id,
                redoor_protocol::wire::partials::CancelReason::Canceled,
            );
        }
    }

    /// Delivers a one-shot command's result to its REST caller.
    pub(crate) fn finish_command(
        &mut self,
        flow_id: super::flows::FlowId,
        response: RouteResponse,
    ) {
        // Only the agent the command was sent to may answer it; any other agent naming the
        // same request id must not resolve (or drop) the caller's reply.
        let owned = matches!(
            self.flows.get(flow_id),
            Some(Flow::Command(command)) if command.agent_id == response.agent_id
        );
        if !owned {
            log!(
                Level::Warning,
                "Command response agent mismatch: request_id={}, agent_id={}",
                response.request_id,
                response.agent_id
            );
            return;
        }
        if let Some(Flow::Command(command)) = self.flows.remove(flow_id) {
            let _ = command.reply.send(response.result);
        }
    }

    /// Opens a terminal as one stream of the agent's connection.
    ///
    /// Output gets an inbound slot and input an interactive-lane producer before
    /// `terminal_open` is queued, so no frame of the terminal can arrive unroutable.
    pub(crate) fn open_terminal(&mut self, request: OpenTerminalRequest) {
        let stream = self.next_id();
        let result = self
            .open_stream(&request.agent_id, stream, true)
            .and_then(|connection| {
                let link = connection.link();
                let output = connection.streams.open_inbound(
                    StreamLease::new(stream, link.clone(), 0),
                    TERMINAL_CREDIT_WINDOW_FRAMES,
                );
                let input = OutboundStream::new(
                    StreamLease::new(stream, link, 0),
                    connection.streams.open_outbound(
                        stream,
                        TERMINAL_CREDIT_WINDOW_FRAMES,
                        OutboundStart::FullWindow,
                    ),
                    true,
                );
                let events = connection.streams.open_terminal_events(stream);
                let open = ServerToAgent::TerminalOpen {
                    stream,
                    size: request.size,
                    cwd: request.cwd.clone(),
                };
                Self::admit_stream(connection, stream, open)?;
                Ok(TerminalStream {
                    stream,
                    output,
                    input,
                    events,
                })
            });
        if request.reply.send(result).is_err() {
            // The bridge gave up waiting; nobody will ever close the stream it would have got.
            self.close_stream(&request.agent_id, stream);
        }
    }

    /// Opens a live log stream as one stream of the agent's connection.
    pub(crate) fn open_log_stream(&mut self, request: OpenAgentLogStreamRequest) {
        let stream = self.next_id();
        let result = self
            .open_stream(&request.agent_id, stream, false)
            .and_then(|connection| {
                let output = connection.streams.open_inbound(
                    StreamLease::new(stream, connection.link(), 0),
                    STREAM_CREDIT_WINDOW_FRAMES,
                );
                Self::admit_stream(connection, stream, ServerToAgent::LogStreamOpen { stream })?;
                Ok(LogStream { stream, output })
            });
        if request.reply.send(result).is_err() {
            // The bridge gave up waiting; nobody will ever close the stream it would have got.
            self.close_stream(&request.agent_id, stream);
        }
    }

    /// Reserves a terminal or log stream slot on the agent's connection, within its cap.
    fn open_stream(
        &mut self,
        agent_id: &AgentId,
        stream: RequestId,
        terminal: bool,
    ) -> Result<&mut AgentConnection, RouterError> {
        let connection =
            self.agents
                .by_id
                .get_mut(agent_id)
                .ok_or_else(|| RouterError::AgentNotFound {
                    agent_id: agent_id.to_string(),
                })?;
        let (open, limit, kind) = if terminal {
            (
                &mut connection.terminals,
                MAX_TERMINALS_PER_CONNECTION,
                "terminals",
            )
        } else {
            (
                &mut connection.log_streams,
                MAX_LOG_STREAMS_PER_CONNECTION,
                "log streams",
            )
        };
        if open.len() >= limit {
            return Err(RouterError::StreamLimitReached {
                agent_id: agent_id.to_string(),
                kind,
            });
        }
        open.insert(stream);
        Ok(connection)
    }

    /// Queues the frame that opens a stream, undoing the reservation when the lane is full.
    fn admit_stream(
        connection: &mut AgentConnection,
        stream: RequestId,
        open: ServerToAgent,
    ) -> Result<(), RouterError> {
        if connection.send_request(stream, open) {
            return Ok(());
        }
        connection.streams.close(stream);
        connection.terminals.remove(&stream);
        connection.log_streams.remove(&stream);
        Err(RouterError::ControlQueueFull {
            agent_id: connection.agent_id.to_string(),
        })
    }

    /// Forgets a terminal or log stream whose bridge ended and stops it on the agent.
    pub(crate) fn close_stream(&mut self, agent_id: &AgentId, stream: RequestId) {
        let Some(connection) = self.agents.by_id.get_mut(agent_id) else {
            return;
        };
        let known = connection.terminals.remove(&stream) | connection.log_streams.remove(&stream);
        if !known {
            return;
        }
        connection.streams.close(stream);
        // The agent may still be producing. A stream whose open frame is still queued is
        // withdrawn and needs nothing else, since terminals and log streams have no result.
        let _ = connection.cancel_request(
            stream,
            redoor_protocol::wire::partials::CancelReason::Canceled,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actors::lanes::ControlLanes;
    use crate::actors::router::state::RouterState;
    use redoor_protocol::wire::request;
    use tokio::sync::oneshot;

    /// Builds isolated router state without starting a router mailbox task.
    fn test_state() -> RouterState {
        let refresh_task = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        RouterState::new(refresh_task)
    }

    /// Inserts one authoritative connection for `agent_id`.
    fn insert_control(state: &mut RouterState, agent_id: &str) {
        let (lanes, _receivers) = ControlLanes::bounded(64, 16);
        let request = RegisterAgentRequest::for_test(
            &redoor_core::test_support::test_agent_id(agent_id),
            lanes,
            super::super::streams::ConnectionStreams::new(
                redoor_core::test_support::test_agent_id(agent_id),
            ),
        );
        state.commit_registration(request);
    }

    /// Inserts a pending one-shot command owned by `agent_id` and returns its reply port.
    fn insert_command(
        state: &mut RouterState,
        id: u64,
        agent_id: &str,
    ) -> oneshot::Receiver<CommandOutcome> {
        let (reply, receiver) = oneshot::channel();
        let request_id = redoor_protocol::ids::RequestId::new(id);
        state.flows.insert(
            request_id,
            Flow::Command(CommandFlow {
                request_id,
                agent_id: redoor_core::test_support::test_agent_id(agent_id),
                cancelable: false,
                reply,
            }),
        );
        receiver
    }

    /// Builds the router message a session sends for an agent's `command_response`.
    fn response_message(agent_id: &str, socket_id: SocketId, id: u64) -> super::super::RouterMsg {
        super::super::RouterMsg::RouteResponse(RouteResponse {
            agent_id: redoor_core::test_support::test_agent_id(agent_id),
            socket_id,
            request_id: redoor_protocol::ids::RequestId::new(id),
            result: CommandOutcome::Ok(serde_json::Value::Null),
        })
    }

    /// A response may only resolve a command when it arrives on the owning agent's current
    /// session; request ids are sequential, so anything else could forge results.
    #[tokio::test]
    async fn command_response_requires_owning_agent_and_current_session() {
        let mut state = test_state();
        insert_control(&mut state, "owner");
        insert_control(&mut state, "other");
        let owner_socket = state.agents.by_id[&redoor_core::test_support::test_agent_id("owner")]
            .socket_id
            .clone();
        let other_socket = state.agents.by_id[&redoor_core::test_support::test_agent_id("other")]
            .socket_id
            .clone();
        let mut reply = insert_command(&mut state, 7, "owner");

        // A session that never registered (or was replaced) cannot speak for the owner.
        state.handle(response_message("owner", SocketId::new(), 7));
        assert!(
            reply.try_recv().is_err(),
            "unknown session resolved a command"
        );
        // Another authenticated agent cannot answer a request it was never sent.
        state.handle(response_message("other", other_socket, 7));
        assert!(
            reply.try_recv().is_err(),
            "foreign agent resolved a command"
        );
        // The flow survives both attempts, so the real answer still reaches the caller.
        state.handle(response_message("owner", owner_socket, 7));
        assert!(matches!(
            reply.try_recv(),
            Ok(CommandOutcome::Ok(serde_json::Value::Null))
        ));
        state.ui.refresh_check_task.abort();
    }

    /// A different agent id claiming a live agent's name is refused instead of taking over.
    #[tokio::test]
    async fn duplicate_name_from_another_agent_id_is_rejected() {
        let mut state = test_state();
        let (owner_lanes, _owner_receivers) = ControlLanes::bounded(4, 4);
        let mut owner = RegisterAgentRequest::for_test(
            &redoor_core::test_support::test_agent_id("owner"),
            owner_lanes,
            super::super::streams::ConnectionStreams::new(
                redoor_core::test_support::test_agent_id("owner"),
            ),
        );
        owner.agent_name = "owner".to_string();
        state.register_agent(owner);
        let (lanes, mut receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            &redoor_core::test_support::test_agent_id("impostor"),
            lanes,
            super::super::streams::ConnectionStreams::new(
                redoor_core::test_support::test_agent_id("impostor"),
            ),
        );
        request.agent_name = "owner".to_string();
        let (reply, decision) = oneshot::channel();
        request.reply = Some(reply);

        state.register_agent(request);

        // The session learns about the refusal so it can close the socket.
        assert!(matches!(
            decision.await.unwrap(),
            Err(RegistrationRejection {
                reason: RejectReason::DuplicateName,
                ..
            })
        ));
        // The agent reads `rejected` as its first and only frame.
        assert!(matches!(
            receivers.priority.try_recv(),
            Ok(ServerToAgent::Rejected {
                reason: RejectReason::DuplicateName,
                ..
            })
        ));
        // The live owner keeps its connection and the impostor gets none.
        assert!(
            state
                .agents
                .by_id
                .contains_key(&redoor_core::test_support::test_agent_id("owner"))
        );
        assert!(
            !state
                .agents
                .by_id
                .contains_key(&redoor_core::test_support::test_agent_id("impostor"))
        );
        state.ui.refresh_check_task.abort();
    }

    /// A reconnect of the same agent replaces its stale connection and evicts the old one.
    #[tokio::test]
    async fn reconnect_of_the_same_agent_evicts_the_previous_connection() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let (old_lanes, mut old_receivers) = ControlLanes::bounded(4, 4);
        state.register_agent(RegisterAgentRequest::for_test(
            &agent_id,
            old_lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        ));
        let (new_lanes, mut new_receivers) = ControlLanes::bounded(4, 4);
        let replacement = RegisterAgentRequest::for_test(
            &agent_id,
            new_lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        );
        let replacement_socket = replacement.socket_id.clone();

        state.register_agent(replacement);

        let old_frames: Vec<_> =
            std::iter::from_fn(|| old_receivers.priority.try_recv().ok()).collect();
        // The replaced process is told to exit instead of lingering as a zombie.
        assert!(matches!(
            old_frames.last(),
            Some(ServerToAgent::Evicted { .. })
        ));
        // The reconnect is welcomed like any first connection.
        assert!(matches!(
            new_receivers.priority.try_recv(),
            Ok(ServerToAgent::Welcome { connection_id }) if connection_id == replacement_socket
        ));
        // Routing now belongs to the replacement session.
        assert!(
            state
                .agents
                .is_current_session(&agent_id, &replacement_socket)
        );
        state.ui.refresh_check_task.abort();
    }

    /// The tick's pruning of a command whose caller left must stop the agent's work just like
    /// explicit abandonment; otherwise whichever path ran first decided whether it was canceled.
    #[tokio::test]
    async fn pruning_abandoned_cancelable_command_cancels_it_on_the_agent() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("prune-agent");
        let (lanes, mut receivers) = ControlLanes::bounded(64, 16);
        state.commit_registration(RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        ));
        // Drain the welcome queued by registration.
        assert!(matches!(
            receivers.priority.try_recv(),
            Ok(ServerToAgent::Welcome { .. })
        ));
        let cancelable = insert_command(&mut state, 11, "prune-agent");
        if let Some(Flow::Command(command)) = state
            .flows
            .get_mut(redoor_protocol::ids::RequestId::new(11))
        {
            command.cancelable = true;
        }
        let quiet = insert_command(&mut state, 12, "prune-agent");
        drop(cancelable);
        drop(quiet);
        state.tick();
        // Only the request-scoped command is canceled; the other is just forgotten.
        assert!(matches!(
            receivers.priority.try_recv(),
            Ok(ServerToAgent::Cancel { id: request_id, reason: redoor_protocol::wire::partials::CancelReason::Canceled })
                if request_id == redoor_protocol::ids::RequestId::new(11)
        ));
        assert!(receivers.priority.try_recv().is_err());
        // Both abandoned flows are gone from the table.
        assert_eq!(state.flows.len(), 0);
        state.ui.refresh_check_task.abort();
    }

    /// Verifies retry projection removes the old socket before reporting a fresh start.
    #[tokio::test]
    async fn retry_lifecycle_evicts_existing_managed_connection() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("managed-retry");
        let (register_reply, register_receiver) = oneshot::channel();
        state.register_managed(RegisterManagedAgentRequest {
            agent_id: agent_id.clone(),
            name: "managed-retry".to_string(),
            default_directory: Some("/tmp".to_string()),
            configuration_editable: true,
            ssh_target: None,
            reply: register_reply,
        });
        register_receiver
            .await
            .expect("managed inventory registration acknowledged");
        insert_control(&mut state, "managed-retry");

        state.apply_managed_lifecycle(ApplyManagedLifecycleRequest {
            agent_id: agent_id.clone(),
            snapshot: crate::watchdog::WatchdogSnapshot {
                attempt_generation: 2,
                desired_running: true,
                status: AgentConnectionStatus::Starting,
                connection_issue: None,
                provisioning_status: Vec::new(),
                socket_id: None,
            },
            evict_existing: true,
            reply: None,
        });

        // REST success must not leave a dead socket available for routing or redirect.
        assert!(!state.agents.by_id.contains_key(&agent_id));
        // The retained managed row remains visible as the replacement attempt starts.
        assert_eq!(
            state.agents.known_by_id[&agent_id].status,
            AgentConnectionStatus::Starting
        );
        assert_eq!(state.agents.known_by_id[&agent_id].socket_id, None);
    }

    /// The single connection carries every stream, so an accepted hello is fully usable.
    #[tokio::test]
    async fn registration_marks_the_agent_connected() {
        let mut state = test_state();
        insert_control(&mut state, "agent");
        // Clients that gate transfers on Connected may start them right after the welcome.
        assert_eq!(
            state.agents.known_by_id[&redoor_core::test_support::test_agent_id("agent")].status,
            AgentConnectionStatus::Connected
        );
        state.ui.refresh_check_task.abort();
    }

    /// Terminal and log streams are capped per connection and freed when their bridge ends.
    #[tokio::test]
    async fn terminal_streams_are_capped_and_closing_cancels_them_on_the_agent() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("agent");
        let (lanes, mut receivers) = ControlLanes::bounded(64, 16);
        state.commit_registration(RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        ));
        let open = |state: &mut RouterState| {
            let (reply, receiver) = oneshot::channel();
            state.open_terminal(super::super::messages::OpenTerminalRequest {
                agent_id: redoor_core::test_support::test_agent_id("agent"),
                size: redoor_protocol::wire::terminal::TerminalSize::new(24, 80).unwrap(),
                cwd: "/".to_string(),
                reply,
            });
            receiver
        };
        let mut streams = Vec::new();
        for _ in 0..MAX_TERMINALS_PER_CONNECTION {
            let terminal = open(&mut state).await.unwrap().unwrap();
            streams.push(terminal.stream);
        }
        // The agent learns each terminal's stream id from its open frame, which the writer
        // claims before writing it.
        let first = receivers.commands.try_recv().unwrap();
        assert!(matches!(
            first.frame,
            ServerToAgent::TerminalOpen { stream, .. } if stream == streams[0]
        ));
        assert!(first.ticket.unwrap().mark_written());
        // One more would exceed the agent's own limit, so the server refuses it first.
        assert!(matches!(
            open(&mut state).await.unwrap(),
            Err(RouterError::StreamLimitReached { .. })
        ));

        state.close_stream(&agent_id, streams[0]);
        // Closing stops the PTY on the agent with the ordinary cancel frame.
        let frames: Vec<_> = std::iter::from_fn(|| receivers.priority.try_recv().ok()).collect();
        assert!(frames.iter().any(
            |frame| matches!(frame, ServerToAgent::Cancel { id, reason } if *id == streams[0])
        ));
        state.close_stream(&agent_id, streams[1]);
        // A terminal whose open frame was never written is withdrawn: a cancel could
        // overtake the open frame and leave the PTY running.
        assert!(receivers.priority.try_recv().is_err());
        let second = receivers.commands.try_recv().unwrap();
        assert!(!second.ticket.unwrap().mark_written());
        // The freed slot admits a new terminal.
        assert!(open(&mut state).await.unwrap().is_ok());
        state.ui.refresh_check_task.abort();
    }

    /// Verifies command overload is explicit while priority cancellation remains admitted.
    #[tokio::test]
    async fn full_control_queue_rejects_commands_and_preserves_priority_lane() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("bounded-agent");
        let (lanes, mut receivers) = ControlLanes::bounded(1, 1);
        state.commit_registration(RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        ));
        // Remove the welcome so the reserved lane is available for cancellation.
        assert!(matches!(
            receivers.priority.recv().await,
            Some(ServerToAgent::Welcome { .. })
        ));

        let (first_reply, first_receiver) = oneshot::channel();
        let request_id = state.next_id();
        state.execute_command_rest(ExecuteCommandRequest {
            agent_id: agent_id.clone(),
            command: redoor_protocol::wire::command::Command::GetAgentDetails(
                request::GetAgentDetails {},
            ),
            request_id,
            cancel_on_abandon: true,
            reply: first_reply,
        });
        // The admitted command owns exactly one pending reply while its frame fills the lane.
        assert_eq!(state.flows.len(), 1);
        drop(first_receiver);

        let (overload_reply, overload_receiver) = oneshot::channel();
        let request_id = state.next_id();
        state.execute_command_rest(ExecuteCommandRequest {
            agent_id: agent_id.clone(),
            command: redoor_protocol::wire::command::Command::GetAgentDetails(
                request::GetAgentDetails {},
            ),
            request_id,
            cancel_on_abandon: true,
            reply: overload_reply,
        });
        // Rejected commands never enter pending state, and the periodic tick prunes the
        // timed-out caller's reply port.
        assert_eq!(state.flows.len(), 1);
        state.flows.prune_abandoned_commands();
        assert_eq!(state.flows.len(), 0);
        assert!(matches!(
            overload_receiver.await.expect("overload reply delivered"),
            CommandOutcome::Error(redoor_protocol::wire::request::CommandError {
                kind: redoor_protocol::wire::command::CommandErrorKind::ServiceUnavailable,
                ..
            })
        ));

        let connection = &state.agents.by_id[&agent_id];
        assert!(connection.send_priority_message(ServerToAgent::Cancel {
            id: redoor_protocol::ids::RequestId::new(99),
            reason: redoor_protocol::wire::partials::CancelReason::Canceled
        }));
        // Priority admission succeeds despite the unread ordinary command frame.
        assert!(matches!(
            receivers.priority.recv().await,
            Some(ServerToAgent::Cancel { .. })
        ));
        // The ordinary queue remains bounded to its single admitted frame.
        assert!(matches!(
            receivers.commands.recv().await.map(|queued| queued.frame),
            Some(ServerToAgent::Command {
                command: redoor_protocol::wire::command::Command::GetAgentDetails(
                    request::GetAgentDetails {}
                ),
                ..
            })
        ));
    }

    /// Verifies an explicit abandon stops a request-scoped command on the agent without
    /// waiting for the periodic prune, and that repeating it is a harmless no-op.
    #[tokio::test]
    async fn abandon_command_cancels_request_scoped_command_on_agent() {
        let mut state = test_state();
        let agent_id = redoor_core::test_support::test_agent_id("abandon-agent");
        let (lanes, mut receivers) = ControlLanes::bounded(4, 4);
        state.commit_registration(RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        ));
        assert!(matches!(
            receivers.priority.recv().await,
            Some(ServerToAgent::Welcome { .. })
        ));

        let (reply, _receiver) = oneshot::channel();
        let request_id = state.next_id();
        state.execute_command_rest(ExecuteCommandRequest {
            agent_id: agent_id.clone(),
            command: redoor_protocol::wire::command::Command::RestoreTrash(request::RestoreTrash {
                location_id: "l".to_string(),
                item_id: "i".to_string(),
                destination_path: "/tmp/restored".to_string(),
            }),
            request_id,
            cancel_on_abandon: true,
            reply,
        });
        // The command is written, so a cancel frame is needed to stop it.
        let queued = receivers.commands.try_recv().unwrap();
        assert!(queued.ticket.unwrap().mark_written());
        assert_eq!(state.flows.len(), 1);

        state.abandon_command(request_id, &agent_id);
        // The flow is gone and the agent was told to stop it.
        assert_eq!(state.flows.len(), 0);
        assert!(matches!(
            receivers.priority.try_recv(),
            Ok(ServerToAgent::Cancel { id, .. }) if id == request_id
        ));
        // A second abandon finds nothing and must not send another cancel.
        state.abandon_command(request_id, &agent_id);
        assert!(receivers.priority.try_recv().is_err());
        state.ui.refresh_check_task.abort();
    }

    /// Registers a connected test agent with an explicit name and returns its id.
    fn register_named(state: &mut RouterState, label: &str, name: &str) -> AgentId {
        let agent_id = redoor_core::test_support::test_agent_id(label);
        let (lanes, _receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        );
        request.agent_name = name.to_string();
        state.register_agent(request);
        agent_id
    }

    /// Refuses a `hello` and returns the rejection the session would see.
    fn rejection_for(state: &mut RouterState, agent_id: AgentId, name: &str) -> RejectReason {
        let (lanes, _receivers) = ControlLanes::bounded(4, 4);
        let mut request = RegisterAgentRequest::for_test(
            &agent_id,
            lanes,
            super::super::streams::ConnectionStreams::new(agent_id.clone()),
        );
        request.agent_name = name.to_string();
        let (reply, mut decision) = oneshot::channel();
        request.reply = Some(reply);
        state.register_agent(request);
        match decision.try_recv() {
            Ok(Err(rejection)) => rejection.reason,
            other => panic!("expected a rejection, got {other:?}"),
        }
    }

    /// Ids are stored in token scopes and names address devices, so a `hello` that breaks
    /// either format is refused before it can enter the inventory.
    #[tokio::test]
    async fn hello_with_invalid_id_or_name_is_rejected() {
        let mut state = test_state();
        // Readable ids from earlier versions are not accepted.
        assert_eq!(
            rejection_for(&mut state, AgentId::unchecked("pi"), "pi"),
            RejectReason::InvalidIdentity
        );
        // A missing id deserializes as an empty string and is refused the same way.
        assert_eq!(
            rejection_for(&mut state, AgentId::unchecked(""), "pi"),
            RejectReason::InvalidIdentity
        );
        let valid = redoor_core::test_support::test_agent_id("valid");
        // A name that looks like an id would make name-or-id lookups ambiguous.
        assert_eq!(
            rejection_for(&mut state, valid.clone(), "dev_abcdefghijklmnopqrst"),
            RejectReason::InvalidIdentity
        );
        // ':' and '/' would break `device:path` and URLs.
        assert_eq!(
            rejection_for(&mut state, valid, "a:b"),
            RejectReason::InvalidIdentity
        );
        // Nothing reached the inventory.
        assert!(state.agents.known_by_id.is_empty());
        state.ui.refresh_check_task.abort();
    }

    /// Requests accept a name or an id; an exact id wins and unknown values resolve to nothing.
    #[tokio::test]
    async fn resolve_device_prefers_ids_then_names() {
        let mut state = test_state();
        let pi = register_named(&mut state, "pi", "pi");
        let laptop = register_named(&mut state, "laptop", "laptop");
        // A name resolves to the device that currently has it.
        assert_eq!(state.resolve_device("pi"), Some(pi.clone()));
        // An id resolves to its device regardless of names.
        assert_eq!(state.resolve_device(laptop.as_str()), Some(laptop));
        // Unknown values are "device not found".
        assert_eq!(state.resolve_device("nope"), None);
        state.ui.refresh_check_task.abort();
    }

    /// A name reserved for a managed rename cannot be taken by a standalone agent that
    /// connects while the config edit runs, and is free again once released.
    #[tokio::test]
    async fn reserved_name_refuses_a_standalone_hello_until_released() {
        let mut state = test_state();
        let managed = redoor_core::test_support::test_agent_id("managed");
        assert!(
            state
                .reserve_name(managed.clone(), "pi".to_string())
                .is_ok()
        );
        // A standalone agent claiming the reserved name is refused like a live holder.
        assert_eq!(
            rejection_for(
                &mut state,
                redoor_core::test_support::test_agent_id("standalone"),
                "pi"
            ),
            RejectReason::DuplicateName
        );
        // A second edit reserving the same name for another device is refused too.
        let other = redoor_core::test_support::test_agent_id("other");
        assert_eq!(
            state.reserve_name(other.clone(), "pi".to_string()),
            Err(managed.clone())
        );
        state.agents.reserved_names.remove(&managed);
        // Once released, the name is free again.
        assert!(state.reserve_name(other, "pi".to_string()).is_ok());
        state.ui.refresh_check_task.abort();
    }

    /// Any listed device holds its name for reservations, even a disconnected one, so a
    /// create or rename never produces two rows with one name.
    #[tokio::test]
    async fn reserve_name_refuses_names_of_listed_devices() {
        let mut state = test_state();
        let holder = register_named(&mut state, "holder", "pi");
        let socket = state.agents.by_id[&holder].socket_id.clone();
        state.unregister_agent(holder.clone(), socket);
        // The disconnected device is still listed as `pi`.
        assert_eq!(
            state.reserve_name(
                redoor_core::test_support::test_agent_id("managed"),
                "pi".to_string()
            ),
            Err(holder.clone())
        );
        // A device may always reserve its own current name.
        assert!(state.reserve_name(holder, "pi".to_string()).is_ok());
        state.ui.refresh_check_task.abort();
    }

    /// A new device may take the name of a disconnected standalone agent, and the stale row is
    /// dropped so the name keeps pointing at exactly one device.
    #[tokio::test]
    async fn new_device_takes_the_name_of_a_disconnected_standalone_agent() {
        let mut state = test_state();
        let old = register_named(&mut state, "old", "pi");
        let socket = state.agents.by_id[&old].socket_id.clone();
        state.unregister_agent(old.clone(), socket);
        let new = register_named(&mut state, "new", "pi");
        // The name now resolves to the new device only.
        assert_eq!(state.resolve_device("pi"), Some(new));
        assert!(!state.agents.known_by_id.contains_key(&old));
        state.ui.refresh_check_task.abort();
    }
}
