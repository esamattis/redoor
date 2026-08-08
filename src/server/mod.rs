mod agent_helpers;
mod agents;
mod auth;
mod config;
mod files;
#[cfg(target_os = "linux")]
mod pam;
mod raw;
mod responses;
mod routes;
pub(crate) mod state;
mod terminals;
mod transfers;
mod ui;
mod watchdog;
mod ws;

pub(crate) use auth::{AuthState, LoginCredentials};
pub(crate) use config::{
    create_default_config_if_missing, create_default_config_if_missing_with_token,
    parse_agent_token_file, parse_config_file, spawn_agents,
};
pub(crate) use redoor::watchdog::WatchdogRegistry;
pub(crate) use routes::build_app;
pub(crate) use state::{CoordinatorArgs, ServerState};
