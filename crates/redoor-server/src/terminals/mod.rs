//! Server-owned terminal sessions.
//!
//! A session owns its agent terminal stream, so the shell lives until the session is closed
//! instead of until a browser socket closes. Browsers attach to a session to view it, one at
//! a time, and get the mirrored screen first. This is long-lived server state, not HTTP, so
//! the REST and websocket handlers in `http` only look sessions up here.

pub(crate) mod emulator;
mod pending_tail;
