//! Runs pipe-based processes independently of the control mailbox and bounds every output read.

use crate::commands::ctx::Reply;
use crate::runtime::cancel::Registration;
use crate::transfers::stream::StreamWriter;
use redoor_protocol::{
    ids::RequestId,
    wire::{
        exec::{ExecEvent, ExecOutput, ExecRequest},
        request,
    },
};
use std::{os::unix::process::ExitStatusExt, process::Stdio};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

/// Owns the process group so disconnect, timeout and dropped tasks also stop descendants.
struct ProcessGroup(i32);

impl Drop for ProcessGroup {
    /// Group cleanup is synchronous signal delivery, never a blocking process wait.
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.0),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

/// Holds stream ordering while each event remains small enough for one bounded HTTP record.
struct ExecWorker {
    stream: StreamWriter,
}

impl ExecWorker {
    /// Sends one read as its own NDJSON line rather than collecting process output.
    ///
    /// The line is encoded straight from the borrowed read buffer into one exactly sized
    /// allocation, which then moves into the stream frame without another copy.
    async fn send(&mut self, event: ExecOutput<'_>) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.stream.send(event.ndjson_line(), false).await,
            "Execution output connection closed"
        );
        Ok(())
    }

    /// Reads both pipes fairly and waits for their EOF before reporting exit, retaining trailing bytes.
    async fn output(&mut self, child: &mut tokio::process::Child) -> anyhow::Result<ExecEvent> {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Missing stdout pipe"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("Missing stderr pipe"))?;
        let mut out = [0u8; 8192];
        let mut err = [0u8; 8192];
        let (mut out_open, mut err_open) = (true, true);
        while out_open || err_open {
            let event = tokio::select! {
                count = stdout.read(&mut out), if out_open => (true, count?),
                count = stderr.read(&mut err), if err_open => (false, count?),
            };
            match event {
                (true, 0) => out_open = false,
                (false, 0) => err_open = false,
                (true, count) => {
                    self.send(ExecOutput::Stdout {
                        data: &out[..count],
                    })
                    .await?
                }
                (false, count) => {
                    self.send(ExecOutput::Stderr {
                        data: &err[..count],
                    })
                    .await?
                }
            }
        }
        let status = child.wait().await?;
        Ok(ExecEvent::Exit {
            code: status.code(),
            signal: status.signal(),
        })
    }

    /// Keeps cancellation/deadlines outside pipe writes so backpressure cannot hide control requests.
    async fn execute(
        &mut self,
        request: ExecRequest,
        cancel: &CancellationToken,
    ) -> anyhow::Result<ExecEvent> {
        request.validate().map_err(anyhow::Error::msg)?;
        if cancel.is_cancelled() {
            return Ok(ExecEvent::Canceled);
        }
        let mut command = tokio::process::Command::new(&request.argv[0]);
        command
            .args(&request.argv[1..])
            // The token would let the command pass as the server; a request can still set
            // the variable explicitly.
            .env_remove(redoor_core::process::AGENT_TOKEN_ENV)
            .envs(request.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        if let Some(cwd) = request.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn()?;
        let group = ProcessGroup(
            child
                .id()
                .ok_or_else(|| anyhow::anyhow!("Missing process ID"))? as i32,
        );
        let deadline = async {
            match request.timeout_ms {
                Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
                None => std::future::pending::<()>().await,
            }
        };
        let event = tokio::select! {
            result = self.output(&mut child) => result,
            _ = cancel.cancelled() => Ok(ExecEvent::Canceled),
            _ = deadline => Ok(ExecEvent::TimedOut),
        };
        drop(group);
        // Reap the direct child asynchronously after group termination, including cancellation paths.
        let _ = child.wait().await;
        event
    }
}

/// Runs one process, streams its output events and returns the exit event as the result.
///
/// The output stream ends with `FIN` once the process is done, and the exit status follows it
/// as the command's result on the same lane, so the server has all output when it learns the
/// status. The result spends no credit, so only output the server never reads can delay it,
/// and a cancel still stops the process and produces the result.
pub(crate) async fn run(
    request: ExecRequest,
    stream: StreamWriter,
    registration: Registration<RequestId>,
) -> Reply {
    let cancel = registration.token().clone();
    let mut worker = ExecWorker { stream };
    let event = worker
        .execute(request, &cancel)
        .await
        .unwrap_or_else(|error| ExecEvent::Error {
            message: error.to_string(),
        });
    drop(registration);
    worker.stream.send(bytes::Bytes::new(), true).await;
    Reply::stream::<request::Exec>(worker.stream, Ok(event))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::cancel::CancelRegistry;
    use crate::runtime::responder::OutboundFrame;
    use redoor_protocol::wire::request::AgentRequest;
    use tokio::sync::mpsc;

    /// Builds an exec request for `script` run by `sh`.
    fn shell(script: &str) -> ExecRequest {
        ExecRequest {
            argv: vec!["sh".into(), "-c".into(), script.into()],
            cwd: None,
            env: Default::default(),
            timeout_ms: None,
        }
    }

    /// Runs one execution over a recording lane and returns its frames and reply.
    async fn run_recorded(request: ExecRequest, cancel_first: bool) -> (Vec<OutboundFrame>, Reply) {
        let (lane, mut frames) = mpsc::channel(64);
        let registry = CancelRegistry::new(None);
        let registration = registry.register(RequestId::new(41)).unwrap();
        if cancel_first {
            registration.cancel();
        }
        let reply = run(
            request,
            StreamWriter::for_test(lane, RequestId::new(41)),
            registration,
        )
        .await;
        let mut recorded = Vec::new();
        while let Ok(frame) = frames.try_recv() {
            recorded.push(frame);
        }
        (recorded, reply)
    }

    /// Extracts the exec event of a streamed reply.
    fn exit_event(reply: Reply) -> ExecEvent {
        let Reply::Stream { outcome, .. } = reply else {
            panic!("exec results follow their stream");
        };
        request::Exec::decode(outcome).expect("exec answers with its event")
    }

    /// Verifies output, then FIN, with the real exit status carried by the result.
    #[tokio::test]
    async fn output_ends_with_fin_and_the_result_carries_the_exit_status() {
        let (frames, reply) = run_recorded(shell("printf hi; exit 37"), false).await;

        let last = frames.last().and_then(OutboundFrame::as_stream).unwrap();
        // FIN is the last frame of the stream, after every output event.
        assert!(last.is_last && last.data.is_empty());
        let output: Vec<u8> = frames[..frames.len() - 1]
            .iter()
            .filter_map(OutboundFrame::as_stream)
            .flat_map(|chunk| chunk.data.clone())
            .collect();
        let stdout: Vec<u8> = std::str::from_utf8(&output)
            .unwrap()
            .lines()
            .flat_map(|line| match serde_json::from_str(line).unwrap() {
                ExecEvent::Stdout { data } => data,
                _ => Vec::new(),
            })
            .collect();
        // The output events precede FIN on the same lane and decode back to the raw bytes.
        assert_eq!(stdout, b"hi");
        // The nonzero status reaches the server as the result, not as stream data.
        assert!(matches!(
            exit_event(reply),
            ExecEvent::Exit {
                code: Some(37),
                signal: None
            }
        ));
    }

    /// Verifies a canceled execution still reports one result.
    #[tokio::test]
    async fn canceled_execution_reports_canceled() {
        let (_frames, reply) = run_recorded(shell("sleep 60"), true).await;

        // The cancel is acknowledged by the command's own result.
        assert!(matches!(exit_event(reply), ExecEvent::Canceled));
    }

    /// Verifies a lost connection does not change the reported outcome.
    #[tokio::test]
    async fn closed_lane_keeps_the_actual_error() {
        let (lane, frames) = mpsc::channel(1);
        drop(frames);
        let registry = CancelRegistry::new(None);
        let registration = registry.register(RequestId::new(41)).unwrap();

        let reply = run(
            ExecRequest {
                argv: vec![],
                cwd: None,
                env: Default::default(),
                timeout_ms: None,
            },
            StreamWriter::for_test(lane, RequestId::new(41)),
            registration,
        )
        .await;

        // Validation failures are reported as an error event rather than invented success.
        assert!(matches!(exit_event(reply), ExecEvent::Error { .. }));
    }
}
