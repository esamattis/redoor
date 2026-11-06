//! Streams one unit's journal: the last lines, then new entries until the reader goes away.
//!
//! One `journalctl -n N -f` run serves both, so history and live output share a stream and
//! nothing is lost or repeated between them. The entries go out as NDJSON
//! [`SystemdJournalEvent`] lines through the search stream driver, which batches them and
//! waits for stream credit, so a slow browser stalls `journalctl` instead of growing memory.

use super::parse::parse_journal_line;
use super::process::SystemdTool;
use super::scope::Manager;
use crate::commands::search_stream::{MatchSink, SearchStream};
use redoor_protocol::{
    api::systemd::{SystemdJournalEntry, SystemdJournalEvent},
    wire::{command::CommandErrorKind, request::CommandError},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// Fields requested from `journalctl`; `__REALTIME_TIMESTAMP` is always included.
const OUTPUT_FIELDS: &str = "MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER";
/// Longest journal line passed on. `--all` keeps long messages whole, so this is what bounds
/// the memory one entry can take; longer entries are replaced by a note.
const MAX_JOURNAL_LINE_BYTES: usize = 64 * 1024;
/// Most error output of `journalctl` kept for the final `end` line.
const MAX_STDERR_BYTES: usize = 4096;
/// Where journald keeps persistent and volatile journals.
const JOURNAL_DIRECTORIES: [&str; 2] = ["/var/log/journal", "/run/log/journal"];

/// Builds the `journalctl` run for one unit of `manager`: JSON output, the last `lines`
/// entries, then follow.
///
/// A root agent reads another user's units with explicit journal matches instead of
/// `--user-unit`, because `--user-unit` matches the caller's own UID, which would be root's.
pub(super) fn journal_tool(manager: &Manager, unit: &str, lines: u32) -> SystemdTool {
    let tool = match manager {
        Manager::System => SystemdTool::journalctl().args([format!("--unit={unit}")]),
        Manager::User {
            account,
            switch_user: false,
        } => SystemdTool::user_journalctl(account).args([format!("--unit={unit}")]),
        Manager::User {
            account,
            switch_user: true,
        } => {
            let uid = format!("_UID={}", account.uid);
            SystemdTool::journalctl().args([
                format!("_SYSTEMD_USER_UNIT={unit}"),
                uid.clone(),
                "+".to_string(),
                format!("USER_UNIT={unit}"),
                uid,
            ])
        }
    };
    tool.args([
        "--output=json".to_string(),
        format!("--output-fields={OUTPUT_FIELDS}"),
        // Long messages arrive whole instead of as `null`; the line cap bounds them instead.
        "--all".to_string(),
        format!("--lines={lines}"),
        "--follow".to_string(),
    ])
}

/// Explains, when the agent cannot read the system journal, why system unit logs are
/// missing; `None` when it can, or when there is no system journal to check.
///
/// `journalctl` itself only prints a hint for this in its text formats, not with `-o json`,
/// so the agent checks whether it may open the system journal file the way journalctl
/// would. Opening honours ACLs, which some distributions use to grant `adm` or `wheel`.
pub(super) async fn system_journal_access_problem() -> Option<String> {
    let machine_id = tokio::fs::read_to_string("/etc/machine-id").await.ok()?;
    let machine_id = machine_id.trim();
    for directory in JOURNAL_DIRECTORIES {
        let path = format!("{directory}/{machine_id}/system.journal");
        match tokio::fs::File::open(&path).await {
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Some(
                    "The agent's account cannot read the system journal, so log entries of system units are not shown. Add the account to the systemd-journal or adm group, or run the agent as root."
                        .to_string(),
                );
            }
            Err(_) => {}
        }
    }
    None
}

/// Starts `journalctl`, reports readiness and streams its entries until canceled.
///
/// Errors before readiness (an unknown user, a missing `journalctl`) are the command's result
/// with no data, so the server answers them with an HTTP status.
pub(super) async fn stream(
    search: &mut SearchStream<'_>,
    tool: SystemdTool,
    access_problem: Option<String>,
) -> Result<(), CommandError> {
    let mut child = tool.spawn()?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(CommandError::new(
            CommandErrorKind::Internal,
            "journalctl started without output pipes",
        ));
    };
    search.ready().await?;
    search
        .run(|sink| async move {
            if let Some(message) = access_problem
                && !sink
                    .send(SystemdJournalEvent::AccessLimited { message })
                    .await
            {
                return Ok(SystemdJournalEvent::End { message: None });
            }
            let (_, stderr) = tokio::join!(
                forward_entries(stdout, &sink),
                redoor_core::bounded_tail::read_bounded_tail(stderr, MAX_STDERR_BYTES)
            );
            let status = child.wait().await;
            Ok(end_event(status, stderr))
        })
        .await
}

/// Sends every journal line of `stdout` as an entry until it ends or the writer stops.
async fn forward_entries(stdout: impl AsyncRead + Unpin, sink: &MatchSink<SystemdJournalEvent>) {
    let mut lines = CappedLines::new(stdout, MAX_JOURNAL_LINE_BYTES);
    while let Ok(Some(line)) = lines.next().await {
        let entry = match line {
            JournalLine::Complete(bytes) => match parse_journal_line(&bytes) {
                Some(entry) => entry,
                None => continue,
            },
            JournalLine::TooLong { bytes } => SystemdJournalEntry {
                timestamp_us: None,
                priority: None,
                pid: None,
                identifier: None,
                message: format!("[A journal entry of {bytes} bytes was too long to show]"),
            },
        };
        if !sink.send(SystemdJournalEvent::Entry { entry }).await {
            return;
        }
    }
}

/// The last line of a stream whose `journalctl` exited; carries its error output when it
/// failed, so the UI can say why the log stopped.
fn end_event(
    status: std::io::Result<std::process::ExitStatus>,
    stderr: std::io::Result<Vec<u8>>,
) -> SystemdJournalEvent {
    let stderr = stderr
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();
    let message = match status {
        Ok(status) if status.success() && stderr.is_empty() => None,
        Ok(status) if stderr.is_empty() => Some(format!("journalctl exited with {status}")),
        Ok(_) => Some(stderr),
        Err(error) => Some(format!("Failed to wait for journalctl: {error}")),
    };
    SystemdJournalEvent::End { message }
}

/// One line read by [`CappedLines`].
#[derive(Debug, PartialEq, Eq)]
enum JournalLine {
    Complete(Vec<u8>),
    /// A line longer than the cap; its bytes were skipped.
    TooLong {
        bytes: usize,
    },
}

/// Reads newline-terminated lines without ever holding more than `limit` bytes of one, so a
/// huge journal entry cannot grow agent memory.
struct CappedLines<R> {
    reader: BufReader<R>,
    limit: usize,
}

impl<R: AsyncRead + Unpin> CappedLines<R> {
    /// Wraps a pipe.
    fn new(reader: R, limit: usize) -> Self {
        Self {
            reader: BufReader::new(reader),
            limit,
        }
    }

    /// The next line without its newline, or `None` at the end of the input. A last line
    /// without a newline still counts.
    async fn next(&mut self) -> std::io::Result<Option<JournalLine>> {
        let mut line = Vec::new();
        let mut length = 0;
        loop {
            let buffer = self.reader.fill_buf().await?;
            if buffer.is_empty() {
                return Ok((length > 0).then(|| self.finish(line, length)));
            }
            let newline = buffer.iter().position(|byte| *byte == b'\n');
            let chunk = &buffer[..newline.unwrap_or(buffer.len())];
            let room = self.limit.saturating_sub(line.len());
            line.extend_from_slice(&chunk[..chunk.len().min(room)]);
            length += chunk.len();
            let consumed = chunk.len() + usize::from(newline.is_some());
            self.reader.consume(consumed);
            if newline.is_some() {
                return Ok(Some(self.finish(line, length)));
            }
        }
    }

    /// Classifies a finished line by its full length.
    fn finish(&self, line: Vec<u8>, length: usize) -> JournalLine {
        if length > self.limit {
            JournalLine::TooLong { bytes: length }
        } else {
            JournalLine::Complete(line)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::scope::Account;
    use super::*;
    use std::path::PathBuf;

    /// A test account with a fixed UID.
    fn account(name: &str, uid: u32) -> Account {
        Account {
            name: name.to_string(),
            uid,
            gid: uid,
            home: PathBuf::from(format!("/home/{name}")),
        }
    }

    /// The arguments after the program name.
    fn args(tool: &SystemdTool) -> Vec<String> {
        tool.argv()[1..].to_vec()
    }

    /// Verifies the common follow arguments of every journal run.
    #[test]
    fn system_journal_shows_history_then_follows() {
        let tool = journal_tool(&Manager::System, "nginx.service", 200);
        // One run delivers the last lines and then follows, so nothing falls between them.
        assert_eq!(
            args(&tool),
            [
                "--no-pager",
                "--quiet",
                "--unit=nginx.service",
                "--output=json",
                "--output-fields=MESSAGE,PRIORITY,_PID,SYSLOG_IDENTIFIER",
                "--all",
                "--lines=200",
                "--follow",
            ]
        );
        // System logs are read as the agent itself.
        assert_eq!(tool.switches_to(), None);
    }

    /// Verifies the agent's own user units are read from its user journal.
    #[test]
    fn own_user_journal_uses_user_mode() {
        let tool = journal_tool(
            &Manager::User {
                account: account("me", 1000),
                switch_user: false,
            },
            "app.service",
            5,
        );
        // `--user` selects the user's journal and its unit field.
        assert_eq!(
            args(&tool)[..4],
            ["--user", "--no-pager", "--quiet", "--unit=app.service"]
        );
        assert_eq!(tool.switches_to(), None);
    }

    /// Verifies root reads another user's units with explicit matches on their UID.
    #[test]
    fn root_reads_other_users_with_explicit_matches() {
        let tool = journal_tool(
            &Manager::User {
                account: account("alice", 1001),
                switch_user: true,
            },
            "app.service",
            5,
        );
        // `--user-unit` would match root's own UID, so the matches name alice's UID.
        assert_eq!(
            args(&tool)[2..7],
            [
                "_SYSTEMD_USER_UNIT=app.service",
                "_UID=1001",
                "+",
                "USER_UNIT=app.service",
                "_UID=1001",
            ]
        );
        // Root reads every journal file, so it does not switch to the user.
        assert_eq!(tool.switches_to(), None);
    }

    /// Verifies lines are split, capped and the last unterminated line still counts.
    #[tokio::test]
    async fn capped_lines_split_and_bound_lines() {
        let input = b"short
this line is too long
last"
            .to_vec();
        let mut lines = CappedLines::new(input.as_slice(), 10);
        // Lines within the cap arrive whole without their newline.
        assert_eq!(
            lines.next().await.unwrap(),
            Some(JournalLine::Complete(b"short".to_vec()))
        );
        // Longer lines are skipped and reported with their length, never buffered whole.
        assert_eq!(
            lines.next().await.unwrap(),
            Some(JournalLine::TooLong { bytes: 21 })
        );
        // A final line without a newline is not lost.
        assert_eq!(
            lines.next().await.unwrap(),
            Some(JournalLine::Complete(b"last".to_vec()))
        );
        assert_eq!(lines.next().await.unwrap(), None);
    }

    /// Verifies the final event explains a failed journalctl and stays quiet otherwise.
    #[test]
    fn end_event_reports_failures() {
        use std::os::unix::process::ExitStatusExt;
        let ok = std::process::ExitStatus::from_raw(0);
        let failed = std::process::ExitStatus::from_raw(1 << 8);
        // A clean exit needs no explanation.
        assert_eq!(
            end_event(Ok(ok), Ok(Vec::new())),
            SystemdJournalEvent::End { message: None }
        );
        // journalctl's own error text is the best explanation.
        assert_eq!(
            end_event(
                Ok(failed),
                Ok(b"Failed to open journal
"
                .to_vec())
            ),
            SystemdJournalEvent::End {
                message: Some("Failed to open journal".to_string())
            }
        );
        // Without error text the exit status still says it failed.
        assert!(matches!(
            end_event(Ok(failed), Ok(Vec::new())),
            SystemdJournalEvent::End { message: Some(_) }
        ));
    }
}
