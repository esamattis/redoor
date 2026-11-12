//! Every terminal session of the agent process.
//!
//! Sessions belong to the process, not to a connection: a shell keeps running while the
//! server restarts or the network drops, and the next connection reports it again. The
//! registry is the only place sessions are created, found and closed.

use super::session::{SessionsChanged, TerminalSessionHandle, spawn_session};
use crate::open_path::ShellOpenEnv;
use redoor_core::log;
use redoor_protocol::{
    api::terminals::TerminalSessionStatus,
    ids::{TerminalSessionId, UnixTimestampMillis},
    wire::{
        command::CommandErrorKind,
        log::Level,
        request::{CommandError, CreateTerminal},
        terminal::TerminalSessionRecord,
    },
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokio::sync::watch;

/// Shells one agent runs at once. Each holds a PTY, a mirror thread and about 2 MiB of
/// screen, and an attached one also a stream of the connection.
pub(crate) const MAX_RUNNING_TERMINALS: usize = 8;
/// Sessions kept at once, running or exited. Exited ones keep their final screen until their
/// tab closes, so this bounds their memory.
pub(crate) const MAX_TERMINAL_SESSIONS: usize = 64;

/// Cheap-to-clone handle to the process's sessions. The lock is never held across `.await`.
#[derive(Clone)]
pub(crate) struct TerminalSessions {
    sessions: Arc<Mutex<Vec<TerminalSessionHandle>>>,
    /// Signals every change of the list or of a session's status, so the current
    /// connection can send the new list.
    changed: SessionsChanged,
    /// Where shells find the `rd-open` socket; `None` when it could not be set up, so
    /// terminals still start without the command.
    open_env: Option<ShellOpenEnv>,
    /// `rd-open` token of each session's shell, so a request proves which terminal sent it.
    open_tokens: Arc<Mutex<HashMap<String, TerminalSessionId>>>,
}

impl Default for TerminalSessions {
    fn default() -> Self {
        Self::new(None)
    }
}

impl TerminalSessions {
    /// Creates an empty registry whose shells get `open_env` for `rd-open`.
    pub(crate) fn new(open_env: Option<ShellOpenEnv>) -> Self {
        Self {
            sessions: Arc::default(),
            changed: Arc::new(watch::channel(()).0),
            open_env,
            open_tokens: Arc::default(),
        }
    }

    /// Locks the token map, tolerating poison because every operation leaves it valid.
    fn open_tokens(&self) -> MutexGuard<'_, HashMap<String, TerminalSessionId>> {
        self.open_tokens
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether `token` belongs to a shell that still runs, so only the agent's own terminals
    /// can open paths in the browsers, and not after their tab was closed.
    pub(crate) fn accepts_open_token(&self, token: &str) -> bool {
        let Some(id) = self.open_tokens().get(token).copied() else {
            return false;
        };
        self.get(id)
            .is_some_and(|session| session.record().status == TerminalSessionStatus::Running)
    }

    /// The `rd-open` variables of a new shell with its fresh token, registered for `id`.
    ///
    /// The token is random and per shell: it lives only in that shell's environment and its
    /// children's, which is what lets the agent tell a terminal from any other local process.
    fn issue_open_env(
        &self,
        id: TerminalSessionId,
        server_env: &std::collections::BTreeMap<String, String>,
    ) -> Vec<(&'static str, OsString)> {
        let Some(open_env) = &self.open_env else {
            return Vec::new();
        };
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.open_tokens().insert(token.clone(), id);
        // A device's own PATH from `terminal_env` replaces the agent's, so extend that one.
        let path = server_env
            .get("PATH")
            .map(OsString::from)
            .or_else(|| std::env::var_os("PATH"));
        open_env.variables(&token, path)
    }

    /// Forgets the `rd-open` token of session `id`.
    fn revoke_open_token(&self, id: TerminalSessionId) {
        self.open_tokens().retain(|_, session| *session != id);
    }

    /// Locks the list, tolerating poison because every operation leaves it valid.
    fn sessions(&self) -> MutexGuard<'_, Vec<TerminalSessionHandle>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a shell and registers its session.
    pub(crate) fn create(
        &self,
        request: CreateTerminal,
    ) -> Result<TerminalSessionRecord, CommandError> {
        request.size.validate().map_err(|error| {
            CommandError::new(CommandErrorKind::InvalidInput, error.to_string())
        })?;
        let mut sessions = self.sessions();
        if sessions
            .iter()
            .any(|session| session.record().id == request.id)
        {
            return Err(CommandError::new(
                CommandErrorKind::AlreadyExists,
                "Terminal session already exists",
            ));
        }
        let running = sessions
            .iter()
            .filter(|session| session.record().status == TerminalSessionStatus::Running)
            .count();
        if running >= MAX_RUNNING_TERMINALS {
            return Err(CommandError::new(
                CommandErrorKind::Conflict,
                "Too many terminals are open on this agent",
            ));
        }
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(CommandError::new(
                CommandErrorKind::Conflict,
                "Too many terminal sessions are open; close some terminal tabs",
            ));
        }
        let open_env = self.issue_open_env(request.id, &request.env);
        let io = super::start_pty(request.size, &request.cwd, &request.env, &open_env).map_err(
            |error| {
                self.revoke_open_token(request.id);
                log!(
                    Level::Warning,
                    "Failed to start a terminal: cwd={}, error={:#}",
                    request.cwd,
                    error
                );
                CommandError::new(
                    CommandErrorKind::Internal,
                    format!("Failed to start terminal: {error:#}"),
                )
            },
        )?;
        let record = TerminalSessionRecord {
            id: request.id,
            cwd: request.cwd,
            title: request.title,
            number: request.number,
            created_at: UnixTimestampMillis::now(),
            status: TerminalSessionStatus::Running,
            activity: Default::default(),
        };
        log!(
            Level::Info,
            "Terminal created: id={}, cwd={}",
            record.id,
            record.cwd
        );
        sessions.push(spawn_session(
            record.clone(),
            request.size,
            io,
            self.changed.clone(),
        ));
        drop(sessions);
        self.changed.send_replace(());
        Ok(record)
    }

    /// The session to attach to, if it exists.
    pub(crate) fn get(&self, id: TerminalSessionId) -> Option<TerminalSessionHandle> {
        self.sessions()
            .iter()
            .find(|session| session.record().id == id)
            .cloned()
    }

    /// Ends and forgets a session; returns whether it existed. Answers once its attachment
    /// was told and its shell told to stop.
    pub(crate) async fn close(&self, id: TerminalSessionId) -> bool {
        let removed = {
            let mut sessions = self.sessions();
            let index = sessions
                .iter()
                .position(|session| session.record().id == id);
            index.map(|index| sessions.remove(index))
        };
        let Some(session) = removed else {
            return false;
        };
        self.revoke_open_token(id);
        session.close().await;
        log!(Level::Info, "Terminal closed: id={}", id);
        self.changed.send_replace(());
        true
    }

    /// Every session, in creation order, as the server lists them.
    pub(crate) fn records(&self) -> Vec<TerminalSessionRecord> {
        self.sessions()
            .iter()
            .map(TerminalSessionHandle::record)
            .collect()
    }

    /// Follows changes of the list, so a connection can send each new version.
    pub(crate) fn subscribe(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_protocol::wire::terminal::TerminalSize;

    fn create(cwd: &str) -> CreateTerminal {
        CreateTerminal {
            id: TerminalSessionId::new(),
            cwd: cwd.to_string(),
            title: "t".to_string(),
            number: 1,
            size: TerminalSize::new(24, 80).unwrap(),
            env: Default::default(),
        }
    }

    /// A created session is listed and announced, and closing it removes it again.
    #[tokio::test]
    async fn create_lists_and_close_forgets_a_session() {
        let sessions = TerminalSessions::default();
        let mut changed = sessions.subscribe();
        let record = sessions.create(create("/")).unwrap();
        // The connection learns about the new session without polling.
        assert!(changed.has_changed().unwrap());
        changed.mark_unchanged();
        // The record carries what a restarted server needs to list the tab again.
        assert_eq!(sessions.records(), vec![record.clone()]);
        assert!(sessions.close(record.id).await);
        assert!(changed.has_changed().unwrap());
        assert!(sessions.records().is_empty());
        // A second close finds nothing, so the server can tell a stale id.
        assert!(!sessions.close(record.id).await);
    }

    /// The running cap is a clear conflict, and closing a session frees its slot.
    #[tokio::test]
    async fn refuses_shells_beyond_the_running_limit() {
        let sessions = TerminalSessions::default();
        let mut created = Vec::new();
        for _ in 0..MAX_RUNNING_TERMINALS {
            created.push(sessions.create(create("/")).unwrap());
        }
        let error = sessions.create(create("/")).unwrap_err();
        // The server shows this message on the refused tab.
        assert_eq!(error.message, "Too many terminals are open on this agent");
        assert!(matches!(error.kind, CommandErrorKind::Conflict));
        for record in created {
            sessions.close(record.id).await;
        }
        // Closed sessions free their slots.
        assert!(sessions.create(create("/")).is_ok());
    }

    /// A shell that cannot start is an error for the creator, not a listed dead session.
    #[tokio::test]
    async fn missing_directory_fails_the_create() {
        let sessions = TerminalSessions::default();
        let error = sessions
            .create(create("/nonexistent/redoor-terminal-cwd"))
            .unwrap_err();
        // The reason reaches the creating window.
        assert!(error.message.starts_with("Failed to start terminal"));
        assert!(sessions.records().is_empty());
    }

    /// Only a running shell's own token is accepted, and closing its tab revokes it, so no
    /// other local process and no stale shell can steer the browsers.
    #[tokio::test]
    async fn open_tokens_follow_their_session() {
        let sessions = TerminalSessions::new(Some(ShellOpenEnv::new(
            "/nonexistent/terminal-open.sock".into(),
            "/nonexistent/terminal-bin".into(),
        )));
        let record = sessions.create(create("/")).unwrap();
        let token = sessions
            .open_tokens()
            .iter()
            .find(|(_, id)| **id == record.id)
            .map(|(token, _)| token.clone())
            .unwrap();
        // The shell's token opens paths while its shell runs.
        assert!(sessions.accepts_open_token(&token));
        // A guessed token is refused.
        assert!(!sessions.accepts_open_token("guess"));
        sessions.close(record.id).await;
        // The closed terminal's token no longer works, and the map does not grow.
        assert!(!sessions.accepts_open_token(&token));
        assert!(sessions.open_tokens().is_empty());
    }
}
