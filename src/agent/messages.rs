use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

pub(crate) enum AgentMsg {
    Connect,
    ScheduleReconnect { error: String },
    WebSocketMessage { text: String },
    WebSocketBinaryMessage { bytes: Vec<u8> },
    ConnectionLost { reason: String },
    SendWebSocketMessage { msg: WsMessage },
    ExitWithError,
}
