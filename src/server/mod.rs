mod agent_helpers;
mod agent_logs;
mod agent_transfers;
mod agents;
mod auth;
mod config;
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
#[cfg(target_os = "linux")]
pub(crate) use config::default_log_directory;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use config::standalone_agent_is_fully_configured;
pub(crate) use config::{
    create_default_config_if_missing, default_agent_log_path, default_config_path,
    default_server_log_path, parse_config_file, require_server_section,
};
pub(crate) use redoor::watchdog::WatchdogRegistry;
pub(crate) use routes::build_app;
pub(crate) use state::{CoordinatorArgs, ServerState};
pub(crate) use watchdog::register_agents;
