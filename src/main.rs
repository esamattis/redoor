use redoor::actors;
use redoor::commands::{
    AgentInfoResponse, AgentListResponse, CatResponse, Command, CommandResult, EchoResponse,
    ErrorResponse, LsResponse,
};

use axum::{
    Json, Router,
    extract::{
        Path, State as AxumState,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use ractor::{ActorRef, call_t};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

#[derive(Clone)]
struct ServerState {
    router_ref: ActorRef<actors::router::RouterMsg>,
}

#[tokio::main]
async fn main() {
    use ractor::Actor;

    let (router_ref, _) = actors::router::RouterActor::spawn(None, actors::router::RouterActor, ())
        .await
        .expect("Failed to spawn RouterActor");

    let _ = actors::command_executor::CommandExecutorActor::spawn(
        None,
        actors::command_executor::CommandExecutorActor,
        (),
    )
    .await
    .expect("Failed to spawn CommandExecutorActor");

    let server_state = ServerState {
        router_ref: router_ref.clone(),
    };

    let app = Router::new()
        .route("/ws", get(websocket_handler))
        .route("/", get(index_handler))
        .route("/api/v1/agents", get(list_agents_handler))
        .route("/api/v1/agents/{agent}", get(get_agent_details_handler))
        .route("/api/v1/agents/{agent}/ls/{*path}", get(ls_agent_handler))
        .route("/api/v1/agents/{agent}/cat/{*path}", get(cat_agent_handler))
        .route("/api/v1/agents/{agent}/echo", post(echo_agent_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(server_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("Server running on http://0.0.0.0:3000");
    axum::serve(listener, app).await.unwrap();
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state.router_ref))
}

async fn handle_socket(socket: WebSocket, router_ref: ActorRef<actors::router::RouterMsg>) {
    let socket_id = Uuid::new_v4().to_string();
    actors::session::handle_websocket(socket, socket_id, router_ref).await;
}

async fn index_handler() -> impl IntoResponse {
    let html = include_str!("../index.html");
    axum::response::Html(html)
}

async fn list_agents_handler(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::GetAgentList { reply },
        5000
    ) {
        Ok(agents) => {
            let response = AgentListResponse {
                agents: agents
                    .into_iter()
                    .map(|(id, name)| AgentInfoResponse { id, name })
                    .collect(),
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => {
            let error_msg = format!("Failed to get agents: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

async fn get_agent_details_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::GetAgentDetails,
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::GetAgentDetails(details) => {
                if details.name.is_empty() {
                    (
                        StatusCode::NOT_FOUND,
                        Json(ErrorResponse {
                            error: format!("Agent not found: {}", agent),
                        }),
                    )
                        .into_response()
                } else {
                    (StatusCode::OK, Json(details)).into_response()
                }
            }
            CommandResult::Error { message } => {
                let status = if message.contains("not found") {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to get agent details: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}

async fn ls_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Ls { path: Some(path) },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::Ls(ls_result) => (
                StatusCode::OK,
                Json(LsResponse {
                    files: ls_result.files,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => {
                let status = if message.contains("not found")
                    || message.contains("No such file")
                    || message.contains("not a directory")
                {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute ls command: {:?}", e);
            let status = StatusCode::INTERNAL_SERVER_ERROR;
            (status, Json(ErrorResponse { error: error_msg })).into_response()
        }
    }
}

async fn cat_agent_handler(
    Path((agent, path)): Path<(String, String)>,
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Cat { path },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::Cat(cat_result) => (
                StatusCode::OK,
                Json(CatResponse {
                    content: cat_result.content,
                    path: cat_result.path,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => {
                let status = if message.contains("not found")
                    || message.contains("No such file")
                    || message.contains("not a directory")
                {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, Json(ErrorResponse { error: message })).into_response()
            }
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute cat command: {:?}", e);
            let status = StatusCode::INTERNAL_SERVER_ERROR;
            (status, Json(ErrorResponse { error: error_msg })).into_response()
        }
    }
}

async fn echo_agent_handler(
    Path(agent): Path<String>,
    AxumState(state): AxumState<ServerState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let message = match payload.get("message") {
        Some(msg) if msg.is_string() => msg.as_str().unwrap().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Missing or invalid 'message' field in request body".to_string(),
                }),
            )
                .into_response();
        }
    };

    match call_t!(
        &state.router_ref,
        |reply| actors::router::RouterMsg::ExecuteCommandRest {
            agent_id: agent.clone(),
            command: Command::Echo {
                message: message.clone()
            },
            reply,
        },
        30000
    ) {
        Ok(result) => match result {
            CommandResult::Echo(echo_result) => (
                StatusCode::OK,
                Json(EchoResponse {
                    message: echo_result.message,
                }),
            )
                .into_response(),
            CommandResult::Error { message } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: message }),
            )
                .into_response(),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Unexpected result type".to_string(),
                }),
            )
                .into_response(),
        },
        Err(e) => {
            let error_msg = format!("Failed to execute echo command: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: error_msg }),
            )
                .into_response()
        }
    }
}
