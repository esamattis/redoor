//! Websocket entry point for browser UI events.

use crate::actors;
use axum::{
    Extension,
    extract::{
        State as AxumState,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use redoor_core::websocket::WebSocketTimeouts;
use redoor_protocol::api::ui_events::UiEvent;
use uuid::Uuid;

use super::{
    auth::ActiveSession,
    session_watch::{SessionWatch, close_for_ended_session},
    state::ServerState,
};

/// Route: `GET /api/v1/ui/ws`
pub(crate) async fn ui_websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
    Extension(session): Extension<ActiveSession>,
) -> impl IntoResponse {
    let timeouts = state.runtime.ws_timeouts;
    let watch = SessionWatch::new(state.auth.clone(), &session);
    ws.on_upgrade(move |socket| handle_ui_socket(socket, state.router_ref, timeouts, watch))
}

/// Relays UI events from the router to the websocket until either side closes.
async fn forward_ui_events(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    rx_out: &mut tokio::sync::mpsc::UnboundedReceiver<UiEvent>,
    timeouts: WebSocketTimeouts,
) {
    let mut keepalive = timeouts.keepalive_interval();
    loop {
        let event = tokio::select! {
            _ = keepalive.tick() => {
                if sender.send(WsMessage::Ping(bytes::Bytes::new())).await.is_err() {
                    return;
                }
                continue;
            }
            event = rx_out.recv() => event,
        };
        let Some(event) = event else {
            return;
        };
        let json = match serde_json::to_string(&event) {
            Ok(json) => json,
            Err(error) => {
                redoor_core::log_failure!(
                    Level::Error,
                    "Failed to serialize UI websocket event: {}",
                    error
                );
                continue;
            }
        };

        if sender.send(WsMessage::Text(json.into())).await.is_err() {
            return;
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

/// Streams UI events to one browser until it disconnects, the router stops or the session
/// ends.
async fn handle_ui_socket(
    socket: WebSocket,
    router_ref: actors::router::RouterHandle,
    timeouts: WebSocketTimeouts,
    watch: SessionWatch,
) {
    let subscriber_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let (tx_out, mut rx_out) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();

    if let Err(error) = router_ref
        .send_async(actors::router::RouterMsg::RegisterUiSubscriber(
            actors::router::RegisterUiSubscriberRequest {
                subscriber_id: subscriber_id.clone(),
                sender: tx_out,
            },
        ))
        .await
    {
        redoor_core::log_failure!(
            Level::Error,
            "Failed to queue UI subscriber registration: subscriber_id={}, error={}",
            subscriber_id,
            error
        );
        return;
    }

    let session_ended = tokio::select! {
        _ = forward_ui_events(&mut sender, &mut rx_out, timeouts) => false,
        _ = wait_for_ui_disconnect(&mut receiver) => false,
        () = watch.ended() => true,
    };
    if session_ended {
        close_for_ended_session(&mut sender).await;
    }

    if let Err(error) = router_ref
        .send_async(actors::router::RouterMsg::UnregisterUiSubscriber {
            subscriber_id: subscriber_id.clone(),
        })
        .await
    {
        redoor_core::log_failure!(
            Level::Error,
            "Failed to queue UI subscriber cleanup: subscriber_id={}, error={}",
            subscriber_id,
            error
        );
    }
}
