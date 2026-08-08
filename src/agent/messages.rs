use redoor::{log_protocol::LogStreamId, terminal_protocol::TerminalId};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Internal events consumed by the single agent runtime actor.
pub(crate) enum AgentMsg {
    Connect,
    ScheduleReconnect {
        error: String,
    },
    WebSocketMessage {
        connection_generation: u64,
        text: String,
    },
    /// Carries a oneshot so setup can wait until `ws_transfer_tx` is installed before authenticating.
    TransferConnected {
        control_generation: u64,
        transfer_generation: u64,
        token: String,
        sender: mpsc::Sender<WsMessage>,
        shutdown: watch::Sender<bool>,
        /// Reports whether the actor accepted this generation so auth cannot race readiness.
        installed: oneshot::Sender<bool>,
    },
    TransferConnectionLost {
        control_generation: u64,
        transfer_generation: u64,
        reason: String,
    },
    ReconnectTransfer {
        control_generation: u64,
        transfer_generation: u64,
        token: String,
    },
    ConnectionLost {
        connection_generation: u64,
        reason: String,
    },
    SendWebSocketMessage {
        msg: WsMessage,
    },
    TerminalFinished {
        terminal_id: TerminalId,
    },
    LogStreamFinished {
        log_stream_id: LogStreamId,
    },
    ExitWithError,
}
