mod types;
use redoor::{Level, log};
use types::{AgentSender, Message};

use axum::{
    Router,
    extract::{
        State,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    agents: Arc<Mutex<HashMap<String, AgentSender>>>,
    agent_names: Arc<Mutex<HashMap<String, String>>>,
    agent_socket_ids: Arc<Mutex<HashMap<String, String>>>,
    web_clients: Arc<Mutex<Vec<AgentSender>>>,
}

#[tokio::main]
async fn main() {
    let app_state = AppState {
        agents: Arc::new(Mutex::new(HashMap::new())),
        agent_names: Arc::new(Mutex::new(HashMap::new())),
        agent_socket_ids: Arc::new(Mutex::new(HashMap::new())),
        web_clients: Arc::new(Mutex::new(Vec::new())),
    };

    let app = Router::new()
        .route("/ws", get(websocket_handler))
        .route("/", get(index_handler))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://0.0.0.0:3000");
    axum::serve(listener, app).await.unwrap();
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split::<WsMessage>();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let socket_id = Uuid::new_v4().to_string();
    let agent_id = Arc::new(Mutex::new(String::new()));
    let is_agent = Arc::new(Mutex::new(false));
    let tx_for_recv = tx.clone();

    log!(Level::Info, "New connection: socket_id={}", socket_id);

    let state_clone = state.clone();
    let socket_id_clone = socket_id.clone();
    let agent_id_for_recv = agent_id.clone();
    let is_agent_clone = is_agent.clone();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if sender.send(WsMessage::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let WsMessage::Text(text) = msg {
                if let Ok(message) = serde_json::from_str::<Message>(&text) {
                    match message {
                        Message::AgentRegister {
                            agent_id: id,
                            agent_name,
                        } => {
                            *agent_id_for_recv.lock().await = id.clone();
                            *is_agent_clone.lock().await = true;

                            state_clone
                                .agents
                                .lock()
                                .await
                                .insert(id.clone(), tx_for_recv.clone());
                            state_clone
                                .agent_names
                                .lock()
                                .await
                                .insert(id.clone(), agent_name.clone());
                            state_clone
                                .agent_socket_ids
                                .lock()
                                .await
                                .insert(id.clone(), socket_id_clone.clone());

                            state_clone
                                .web_clients
                                .lock()
                                .await
                                .retain(|tx| !std::ptr::eq(tx, &tx_for_recv));

                            log!(
                                Level::Info,
                                "Agent registered: agent_id={}, agent_name={}, socket_id={}",
                                id,
                                agent_name,
                                socket_id_clone
                            );
                            broadcast_agent_list(&state_clone).await;
                        }
                        Message::AgentUnregister { agent_id: id } => {
                            state_clone.agents.lock().await.remove(&id);
                            state_clone.agent_names.lock().await.remove(&id);
                            state_clone.agent_socket_ids.lock().await.remove(&id);
                            log!(Level::Info, "Agent unregistered: agent_id={}", id);
                            broadcast_agent_list(&state_clone).await;
                        }
                        Message::Command {
                            agent_id: id,
                            command,
                            args,
                        } => {
                            log!(
                                Level::Info,
                                "Command received: agent_id={}, command={}, args={:?}",
                                id,
                                command,
                                args
                            );
                            if let Some(agent_tx) = state_clone.agents.lock().await.get(&id) {
                                let _ = agent_tx.send(Message::Command {
                                    agent_id: id,
                                    command,
                                    args,
                                });
                            } else {
                                let _ = tx_for_recv.send(Message::Error {
                                    message: format!("Agent {} not found", id),
                                });
                            }
                        }
                        Message::CommandResponse { result, .. } => {
                            log!(
                                Level::Info,
                                "Command response received: socket_id={}, result={}",
                                socket_id_clone,
                                result
                            );
                            let _ = tx_for_recv.send(Message::CommandResponse {
                                agent_id: socket_id_clone.clone(),
                                result,
                            });
                        }
                        _ => {
                            let _ = tx_for_recv.send(Message::Error {
                                message: "Unknown message type".to_string(),
                            });
                        }
                    }
                } else {
                    let _ = tx_for_recv.send(Message::Error {
                        message: "Invalid JSON".to_string(),
                    });
                }
            }
        }
    });

    state.web_clients.lock().await.push(tx.clone());
    broadcast_agent_list(&state).await;

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    let id = agent_id.lock().await.clone();
    let agent_flag = *is_agent.lock().await;
    if !agent_flag {
        state
            .web_clients
            .lock()
            .await
            .retain(|tx_inner| !std::ptr::eq(tx_inner, &tx));
    }
    if !id.is_empty() {
        state.agents.lock().await.remove(&id);
        state.agent_names.lock().await.remove(&id);
        state.agent_socket_ids.lock().await.remove(&id);
        log!(
            Level::Info,
            "Agent disconnected: agent_id={}, socket_id={}",
            id,
            socket_id
        );
        broadcast_agent_list(&state).await;
    } else {
        log!(
            Level::Info,
            "Web client disconnected: socket_id={}",
            socket_id
        );
    }
}

async fn broadcast_agent_list(state: &AppState) {
    let agents = state.agent_names.lock().await.clone();
    let list_msg = Message::AgentList { agents };

    let web_clients = state.web_clients.lock().await;
    for tx in web_clients.iter() {
        let _ = tx.send(list_msg.clone());
    }
}

async fn index_handler() -> impl IntoResponse {
    let html = include_str!("../index.html");
    axum::response::Html(html)
}
