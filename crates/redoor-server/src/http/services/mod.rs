//! Transport-neutral operations shared by REST handlers and MCP tools.
//!
//! REST and MCP differ only in how they parse requests and render results; starting
//! transfers, consuming agent output and streaming uploads live here once, so the two
//! surfaces cannot drift (MCP reads once lacked the cancel-on-drop REST downloads had).

pub(crate) mod output;
pub(crate) mod search;
pub(crate) mod transfer;
pub(crate) mod upload;
