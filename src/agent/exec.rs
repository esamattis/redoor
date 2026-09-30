//! Runs pipe-based processes independently of the control mailbox and bounds every output read.

use redoor::{
    exec_protocol::{ExecEvent, ExecRequest},
    streaming::StreamChunkFrameRequest,
    types::{ChunkIndex, RequestId},
};
use std::{os::unix::process::ExitStatusExt, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, watch},
};
use tokio_tungstenite::tungstenite::Message;

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
    request_id: RequestId,
    write: mpsc::Sender<Message>,
    index: ChunkIndex,
}

impl ExecWorker {
    /// Serializes one bounded event rather than collecting process output.
    async fn send(&mut self, event: ExecEvent, last: bool) -> anyhow::Result<()> {
        let mut data = serde_json::to_vec(&event)?;
        data.push(b'\n');
        anyhow::ensure!(
            super::raw::send_framed_stream_bytes(
                &self.write,
                &mut self.index,
                StreamChunkFrameRequest::new(self.request_id, &data).is_last(last)
            )
            .await,
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
                    self.send(
                        ExecEvent::Stdout {
                            data: out[..count].to_vec(),
                        },
                        false,
                    )
                    .await?
                }
                (false, count) => {
                    self.send(
                        ExecEvent::Stderr {
                            data: err[..count].to_vec(),
                        },
                        false,
                    )
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
        mut cancel: watch::Receiver<bool>,
    ) -> anyhow::Result<ExecEvent> {
        request.validate().map_err(anyhow::Error::msg)?;
        if *cancel.borrow() {
            return Ok(ExecEvent::Canceled);
        }
        let mut command = tokio::process::Command::new(&request.argv[0]);
        command
            .args(&request.argv[1..])
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
            _ = cancel.changed() => Ok(ExecEvent::Canceled),
            _ = deadline => Ok(ExecEvent::TimedOut),
        };
        drop(group);
        // Reap the direct child asynchronously after group termination, including cancellation paths.
        let _ = child.wait().await;
        event
    }
}

/// Emits a terminal event even for spawn failures; generation teardown drops the process guard.
pub(super) async fn run(
    request_id: RequestId,
    request: ExecRequest,
    write: mpsc::Sender<Message>,
    cancel: watch::Receiver<bool>,
    control: mpsc::Sender<Message>,
    agent_id: redoor::types::AgentId,
) {
    let mut worker = ExecWorker {
        request_id,
        write,
        index: ChunkIndex::new(0),
    };
    let event = worker
        .execute(request, cancel)
        .await
        .unwrap_or_else(|error| ExecEvent::Error {
            message: error.to_string(),
        });
    if !matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), worker.send(event, true)).await,
        Ok(Ok(()))
    ) {
        // If the payload lane cannot deliver completion, the independent control lane closes server ownership.
        let result = redoor::commands::CommandResult::error(
            redoor::commands::CommandErrorKind::ServiceUnavailable,
            "Execution terminal event could not be delivered",
        );
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            super::AgentActor.send_command_response(&control, &agent_id, request_id, result),
        )
        .await;
    }
}
