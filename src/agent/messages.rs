use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

#[derive(Clone)]
pub(crate) enum AgentMsg {
    Connect,
    ConnectionEstablished,
    ConnectionFailed { error: String },
    WebSocketMessage { text: String },
    ConnectionLost { reason: String },
    Reconnect,
    SendWebSocketMessage { msg: WsMessage },
    ExitWithError,
}
