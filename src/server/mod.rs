mod agent_helpers;
mod agents;
mod config;
mod files;
mod raw;
mod responses;
mod routes;
pub(crate) mod state;
mod transfers;
mod ui;
mod watchdog;
mod ws;

pub(crate) use config::{parse_config_file, spawn_agents};
pub(crate) use redoor::watchdog::WatchdogRegistry;
pub(crate) use routes::build_app;
pub(crate) use state::{CoordinatorArgs, ServerState};
