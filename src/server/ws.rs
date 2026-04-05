use axum::{
    extract::{
        State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use ractor::ActorRef;
use redoor::{Level, actors, commands::UiEvent, log};
use uuid::Uuid;

use super::state::ServerState;

/// Route: `GET /ws`
pub(crate) async fn websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state.router_ref))
}

/// Route: `GET /api/v1/ui/ws`
pub(crate) async fn ui_websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ui_socket(socket, state.router_ref))
}

async fn handle_socket(socket: WebSocket, router_ref: ActorRef<actors::router::RouterMsg>) {
    let socket_id = Uuid::new_v4().to_string();
    actors::session::handle_websocket(socket, socket_id, router_ref).await;
}

async fn handle_ui_socket(socket: WebSocket, router_ref: ActorRef<actors::router::RouterMsg>) {
    let subscriber_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let (tx_out, mut rx_out) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();

    let _ = router_ref.cast(actors::router::RouterMsg::RegisterUiSubscriber(
        actors::router::RegisterUiSubscriberRequest {
            subscriber_id: subscriber_id.clone(),
            sender: tx_out,
        },
    ));

    tokio::select! {
        _ = async {
            while let Some(event) = rx_out.recv().await {
                let json = match serde_json::to_string(&event) {
                    Ok(json) => json,
                    Err(error) => {
                        log!(Level::Error, "Failed to serialize UI websocket event: {}", error);
                        continue;
                    }
                };

                if sender.send(WsMessage::Text(json.into())).await.is_err() {
                    break;
                }
            }
        } => {}
        _ = async {
            while let Some(message_result) = receiver.next().await {
                if message_result.is_err() {
                    break;
                }
            }
        } => {}
    }

    let _ = router_ref.cast(actors::router::RouterMsg::UnregisterUiSubscriber { subscriber_id });
}
