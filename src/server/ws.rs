use axum::{
    extract::{
        State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor::types::SocketId;
use redoor::watchdog::WatchdogRegistry;
use redoor::{Level, actors, commands::UiEvent, log};
use uuid::Uuid;

use super::state::ServerState;

/// Route: `GET /ws`
pub(crate) async fn websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    let router_ref = state.router_ref;
    let watchdog_registry = state.watchdog_registry;
    ws.on_upgrade(move |socket| handle_socket(socket, router_ref, watchdog_registry))
}

/// Route: `GET /api/v1/ui/ws`
pub(crate) async fn ui_websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ui_socket(socket, state.router_ref))
}

async fn handle_socket(
    socket: WebSocket,
    router_ref: actors::router::RouterHandle,
    watchdog_registry: WatchdogRegistry,
) {
    let socket_id = SocketId::new();
    actors::session::handle_websocket(socket, socket_id, router_ref, watchdog_registry).await;
}

/// Relays UI events from the router to the websocket until either side closes.
async fn forward_ui_events(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    rx_out: &mut tokio::sync::mpsc::UnboundedReceiver<UiEvent>,
) {
    while let Some(event) = rx_out.recv().await {
        let json = match serde_json::to_string(&event) {
            Ok(json) => json,
            Err(error) => {
                log!(
                    Level::Error,
                    "Failed to serialize UI websocket event: {}",
                    error
                );
                continue;
            }
        };

        if sender.send(WsMessage::Text(json.into())).await.is_err() {
            break;
        }
    }
}

/// Waits for the UI websocket receive side to fail or close.
async fn wait_for_ui_disconnect(receiver: &mut futures_util::stream::SplitStream<WebSocket>) {
    while let Some(message_result) = receiver.next().await {
        if message_result.is_err() {
            break;
        }
    }
}

async fn handle_ui_socket(socket: WebSocket, router_ref: actors::router::RouterHandle) {
    let subscriber_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let (tx_out, mut rx_out) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();

    let _ = router_ref.send(actors::router::RouterMsg::RegisterUiSubscriber(
        actors::router::RegisterUiSubscriberRequest {
            subscriber_id: subscriber_id.clone(),
            sender: tx_out,
        },
    ));

    tokio::select! {
        _ = forward_ui_events(&mut sender, &mut rx_out) => {}
        _ = wait_for_ui_disconnect(&mut receiver) => {}
    }

    let _ = router_ref.send(actors::router::RouterMsg::UnregisterUiSubscriber { subscriber_id });
}
