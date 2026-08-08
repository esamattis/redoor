use redoor::terminal_protocol::TerminalId;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// Internal events consumed by the single agent runtime actor.
pub(crate) enum AgentMsg {
    Connect,
    ScheduleReconnect { error: String },
    WebSocketMessage { text: String },
    WebSocketBinaryMessage { bytes: Vec<u8> },
    ConnectionLost { reason: String },
    SendWebSocketMessage { msg: WsMessage },
    TerminalFinished { terminal_id: TerminalId },
    ExitWithError,
}
