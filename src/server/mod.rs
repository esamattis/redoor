mod agent_helpers;
mod agent_logs;
mod agent_transfers;
mod agents;
mod auth;
mod files;
mod logs;
#[cfg(target_os = "linux")]
mod pam;
mod raw;
mod responses;
mod restart;
mod routes;
pub(crate) mod state;
mod terminals;
mod transfers;
mod ui;
mod watchdog;
mod websocket_security;
mod ws;

pub(crate) use auth::{AuthState, LoginCredentials};
pub(crate) use redoor::watchdog::WatchdogRegistry;
pub(crate) use routes::build_app;
pub(crate) use state::{CoordinatorArgs, ServerState};
pub(crate) use watchdog::register_agents;
