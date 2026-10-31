//! The Redoor server: REST API, browser UI, and the websocket hub agents connect to.
// An `async fn` that never awaits hides that it cannot block; actor handlers must stay that way.
#![warn(clippy::unused_async)]

pub mod actors;
mod binaries;
pub mod http;
mod one_time_token_registry;
mod protocol_mismatches;
pub mod ssh;
pub mod startup;
pub(crate) mod terminals;
pub(crate) mod vault;
mod watchdog;
