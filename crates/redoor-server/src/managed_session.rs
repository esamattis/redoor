//! Reading the ensure report of a managed agent's session (`redoor agent managed`), shared by
//! local and SSH sessions.

use std::time::Duration;

use redoor_protocol::wire::managed::{DaemonReport, EnsureFailure, EnsureReport};
use tokio::io::AsyncReadExt;
use tokio::process::Child;

/// Longest accepted report line. A report is a few hundred bytes; the bound keeps a broken
/// remote shell printing garbage from making the server buffer without limit.
const MAX_REPORT_LINE_BYTES: usize = 16 * 1024;
/// How much of a failed session's stderr is kept for its explanation.
const MAX_STDERR_BYTES: usize = 8 * 1024;
/// How long a session that ended before its report may take to be reaped and drained.
const ENDED_SESSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a session produced no daemon.
#[derive(Debug)]
pub(crate) enum ReportError {
    /// The session ended before printing a report, typically because the transport failed.
    Ended {
        /// Exit status of the session process, when it could be reaped in time.
        status: Option<std::process::ExitStatus>,
        /// Bounded tail of its stderr.
        stderr: Vec<u8>,
    },
    /// The ensure step ran and reported that no daemon runs.
    Failed(EnsureFailure),
    /// Reading the report failed, or it was not a report.
    Invalid(String),
}

impl ReportError {
    /// One message for the lifecycle UI, for transports without their own wording.
    pub(crate) fn message(&self, process_name: &str) -> String {
        match self {
            Self::Ended { status, stderr } => {
                let mut message = match status.and_then(|status| status.code()) {
                    Some(code) => format!(
                        "{process_name} exited with status code {code} before reporting its daemon"
                    ),
                    None => format!("{process_name} ended before reporting its daemon"),
                };
                let stderr = crate::watchdog::sanitize_diagnostic_output(stderr);
                let stderr = stderr.trim();
                if !stderr.is_empty() {
                    message.push('\n');
                    message.push_str(stderr);
                }
                message
            }
            Self::Failed(failure) => failure_message(failure),
            Self::Invalid(message) => message.clone(),
        }
    }
}

/// Joins a failure's message and the daemon's stderr, which usually says why.
pub(crate) fn failure_message(failure: &EnsureFailure) -> String {
    let stderr = crate::watchdog::sanitize_diagnostic_output(failure.stderr_tail.as_bytes());
    let stderr = stderr.trim();
    if stderr.is_empty() {
        failure.message.clone()
    } else {
        format!("{}\n{stderr}", failure.message)
    }
}

/// Reads the report line from the session's stdout.
///
/// Reads one byte at a time, so nothing after the report is consumed: the holder's end line
/// stays in the pipe for the watchdog, which explains the session's exit with it.
pub(crate) async fn read_report(child: &mut Child) -> Result<DaemonReport, ReportError> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ReportError::Invalid("the session's stdout is not piped".to_string()))?;
    let line = read_line(&mut stdout).await;
    child.stdout = Some(stdout);
    let line = match line {
        Ok(Some(line)) => line,
        Ok(None) => return Err(ended(child).await),
        Err(error) => {
            return Err(ReportError::Invalid(format!(
                "failed to read the session's report: {error}"
            )));
        }
    };
    match serde_json::from_str::<EnsureReport>(&line) {
        Ok(EnsureReport::Ready(report)) => Ok(report),
        Ok(EnsureReport::Failed(failure)) => {
            // The command exits right after the report; reaping it keeps no zombie around.
            let _ = tokio::time::timeout(ENDED_SESSION_TIMEOUT, child.wait()).await;
            Err(ReportError::Failed(failure))
        }
        Err(error) => Err(ReportError::Invalid(format!(
            "unexpected report from the session: {error}: {}",
            crate::watchdog::sanitize_diagnostic_output(line.as_bytes())
        ))),
    }
}

/// Reads one line, without its ending; `None` at end of file before a full line.
pub(crate) async fn read_line(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        if reader.read(&mut byte).await? == 0 {
            return Ok(None);
        }
        if byte[0] == b'\n' {
            let text = String::from_utf8_lossy(&line);
            return Ok(Some(text.trim_end_matches('\r').to_string()));
        }
        if line.len() >= MAX_REPORT_LINE_BYTES {
            return Err(std::io::Error::other(format!(
                "report line is longer than {MAX_REPORT_LINE_BYTES} bytes"
            )));
        }
        line.push(byte[0]);
    }
}

/// Explains a session that ended before its report with its status and stderr.
pub(crate) async fn ended(child: &mut Child) -> ReportError {
    let stderr = child.stderr.take();
    let read_stderr = async {
        match stderr {
            Some(stderr) => redoor_core::bounded_tail::read_bounded_tail(stderr, MAX_STDERR_BYTES)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        }
    };
    let (status, stderr) = tokio::join!(
        tokio::time::timeout(ENDED_SESSION_TIMEOUT, child.wait()),
        tokio::time::timeout(ENDED_SESSION_TIMEOUT, read_stderr),
    );
    ReportError::Ended {
        status: status.ok().and_then(Result::ok),
        stderr: stderr.unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// Runs `script` as a fake session.
    fn session(script: &str) -> Child {
        tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    /// A report is parsed and the end line after it stays for the watchdog.
    #[tokio::test]
    async fn report_leaves_the_rest_of_stdout_in_the_pipe() {
        let report = serde_json::to_string(&EnsureReport::Ready(DaemonReport {
            outcome: redoor_protocol::wire::managed::EnsureOutcome::Kept,
            pid: 7,
            binary: redoor_core::identity::current_binary_identity(),
            spec_hash: "spec".to_string(),
        }))
        .unwrap();
        let mut child = session(&format!("echo '{report}'; echo end"));

        let daemon = read_report(&mut child).await.unwrap();
        // The report names the daemon the server will accept.
        assert_eq!(daemon.pid, 7);
        let mut rest = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut rest)
            .await
            .unwrap();
        // The end line is not swallowed by the report reader.
        assert_eq!(rest, "end\n");
    }

    /// A session that dies before its report is explained by its stderr, and a failed
    /// ensure step by its own message.
    #[tokio::test]
    async fn early_end_and_failure_are_explained() {
        let mut child = session("echo 'Permission denied (publickey)' >&2; exit 255");
        let error = read_report(&mut child).await.unwrap_err();
        let message = error.message("SSH process");
        // The transport's own reason reaches the UI with the exit status.
        assert!(message.contains("status code 255"), "{message}");
        assert!(message.contains("Permission denied"), "{message}");

        let mut child = session(
            r#"echo '{"failed":{"message":"daemon exited during startup","stderr_tail":"bad home"}}'; exit 1"#,
        );
        let message = read_report(&mut child).await.unwrap_err().message("x");
        // A failed ensure step shows its message and the daemon's stderr.
        assert_eq!(message, "daemon exited during startup\nbad home");
    }
}
