use redoor::{log_protocol::LogStreamId, terminal_protocol::TerminalId};
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
    WebSocketBinaryMessage {
        connection_generation: u64,
        bytes: Vec<u8>,
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
