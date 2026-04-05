use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

#[derive(Clone)]
pub(crate) enum AgentMsg {
    Connect,
    ConnectionEstablished,
    ConnectionFailed { error: String },
    WebSocketMessage { text: String },
    WebSocketBinaryMessage { bytes: Vec<u8> },
    ConnectionLost { reason: String },
    Reconnect,
    SendWebSocketMessage { msg: WsMessage },
    SendWebSocketBinary { bytes: Vec<u8> },
    Shutdown,
    ExitWithError,
}
