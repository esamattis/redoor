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
        cancel: &mut watch::Receiver<bool>,
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

    /// Preserves normal completion under backpressure without retaining workers during teardown.
    async fn terminal(
        &mut self,
        event: ExecEvent,
        cancel: &mut watch::Receiver<bool>,
    ) -> anyhow::Result<()> {
        if matches!(event, ExecEvent::Canceled | ExecEvent::TimedOut) {
            // These paths must finish so generation shutdown can join the worker even with a full lane.
            return tokio::time::timeout(std::time::Duration::from_secs(5), self.send(event, true))
                .await?;
        }
        // execute may already have observed the watch update, so changed() alone is insufficient.
        anyhow::ensure!(
            !*cancel.borrow() && cancel.has_changed().is_ok(),
            "Execution canceled before terminal delivery"
        );
        tokio::select! {
            biased;
            _ = cancel.changed() => anyhow::bail!("Execution canceled during terminal delivery"),
            result = self.send(event, true) => result,
        }
    }
}

/// Emits a terminal event even for spawn failures; generation teardown drops the process guard.
pub(super) async fn run(
    request_id: RequestId,
    request: ExecRequest,
    write: mpsc::Sender<Message>,
    mut cancel: watch::Receiver<bool>,
    control: mpsc::Sender<Message>,
    agent_id: redoor::types::AgentId,
) {
    let mut worker = ExecWorker {
        request_id,
        write,
        index: ChunkIndex::new(0),
    };
    let event = worker
        .execute(request, &mut cancel)
        .await
        .unwrap_or_else(|error| ExecEvent::Error {
            message: error.to_string(),
        });
    if worker.terminal(event, &mut cancel).await.is_err() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use redoor::{
        commands::{CommandErrorKind, CommandResult},
        streaming::StreamChunk,
        types::AgentId,
    };
    use std::time::Duration;

    /// Uses a real nonzero exit so delivery cannot accidentally substitute a local success or failure.
    fn exit_request() -> ExecRequest {
        ExecRequest {
            argv: vec!["sh".into(), "-c".into(), "exit 37".into()],
            cwd: None,
            env: Default::default(),
            timeout_ms: None,
        }
    }

    /// Saturates the actual framed-payload sender without involving socket buffer sizes or wall time.
    async fn blocked_worker() -> (ExecWorker, mpsc::Receiver<Message>) {
        let (write, receiver) = mpsc::channel(1);
        write.send(Message::binary(vec![0])).await.unwrap();
        (
            ExecWorker {
                request_id: RequestId::new(41),
                write,
                index: ChunkIndex::new(0),
            },
            receiver,
        )
    }

    /// A completed and reaped process must retain its remote status for arbitrarily slow consumers.
    #[tokio::test]
    async fn normal_exit_waits_beyond_five_seconds_and_preserves_control_lane() {
        let (mut worker, mut payload) = blocked_worker().await;
        let (_cancel_sender, mut cancel) = watch::channel(false);
        let event = worker.execute(exit_request(), &mut cancel).await.unwrap();
        // This also synchronizes with child reaping before testing terminal-only backpressure.
        assert!(matches!(
            event,
            ExecEvent::Exit {
                code: Some(37),
                signal: None
            }
        ));
        tokio::time::pause();
        let terminal = worker.terminal(event, &mut cancel);
        tokio::pin!(terminal);
        // Polling installs the blocked enqueue before advancing virtual time.
        assert!(poll!(&mut terminal).is_pending());
        tokio::time::advance(Duration::from_secs(60)).await;
        // Normal completion has no five-second fallback (or other delivery deadline).
        assert!(poll!(&mut terminal).is_pending());

        let (control, mut responses) = mpsc::channel(1);
        super::super::AgentActor
            .send_command_response(
                &control,
                &AgentId::from("terminal-test"),
                RequestId::new(42),
                CommandResult::error(CommandErrorKind::ServiceUnavailable, "independent response"),
            )
            .await;
        // Control delivery remains independent while the shared binary lane is full.
        assert!(matches!(responses.try_recv(), Ok(Message::Text(_))));
        payload.recv().await.unwrap();
        terminal.await.unwrap();
        let Message::Binary(bytes) = payload.recv().await.unwrap() else {
            panic!("Expected framed terminal event");
        };
        let chunk = StreamChunk::from_bytes(&bytes).unwrap();
        // Resuming the consumer must deliver the last frame and the actual nonzero remote exit.
        assert!(chunk.is_last);
        assert!(matches!(
            serde_json::from_slice::<ExecEvent>(&chunk.data).unwrap(),
            ExecEvent::Exit {
                code: Some(37),
                signal: None
            }
        ));
    }

    /// Cancellation and both disconnect signals must release a normal terminal enqueue immediately.
    #[tokio::test(start_paused = true)]
    async fn blocked_normal_terminal_observes_cancel_and_disconnect() {
        for mode in 0..3 {
            let (mut worker, payload) = blocked_worker().await;
            let (sender, mut cancel) = watch::channel(false);
            let terminal = worker.terminal(
                ExecEvent::Exit {
                    code: Some(37),
                    signal: None,
                },
                &mut cancel,
            );
            tokio::pin!(terminal);
            // All cases start blocked on the same saturated lane.
            assert!(poll!(&mut terminal).is_pending());
            match mode {
                0 => sender.send(true).unwrap(),
                1 => drop(sender), // Generation teardown clears the local cancellation registry.
                _ => drop(payload), // Transfer disconnection closes the payload sender.
            }
            // No clock advancement is needed to release cancellation/disconnection.
            assert!(matches!(
                poll!(&mut terminal),
                std::task::Poll::Ready(Err(_))
            ));
        }
    }

    /// Already-observed cancellation must not be lost when execute hands ownership back to run.
    #[tokio::test(start_paused = true)]
    async fn observed_cancel_releases_terminal() {
        let (mut worker, _payload) = blocked_worker().await;
        let (sender, mut cancel) = watch::channel(false);
        sender.send(true).unwrap();
        cancel.changed().await.unwrap();
        // changed() has consumed this version, but the current true value still cancels delivery.
        assert!(
            worker
                .terminal(
                    ExecEvent::Exit {
                        code: Some(37),
                        signal: None
                    },
                    &mut cancel
                )
                .await
                .is_err()
        );
    }

    /// Teardown may wait briefly for terminal delivery, but even blocked control cannot prevent joining.
    #[tokio::test(start_paused = true)]
    async fn teardown_fallback_is_bounded_on_both_lanes() {
        let (worker, _payload) = blocked_worker().await;
        let (_sender, cancel) = watch::channel(true);
        let (control, mut responses) = mpsc::channel(1);
        let task = run(
            worker.request_id,
            exit_request(),
            worker.write,
            cancel,
            control,
            AgentId::from("terminal-test"),
        );
        tokio::pin!(task);
        // An already canceled request takes the bounded terminal path without spawning a process.
        assert!(poll!(&mut task).is_pending());
        tokio::time::advance(Duration::from_secs(6)).await;
        // The independent fallback closes router ownership when terminal delivery is impossible.
        assert!(poll!(&mut task).is_ready());
        let Message::Text(text) = responses.recv().await.unwrap() else {
            panic!("Expected control fallback");
        };
        // The fallback must name the affected execution, rather than abandoning server ownership.
        assert!(
            matches!(serde_json::from_str::<redoor::types::Message>(&text).unwrap(), redoor::types::Message::CommandResponse { request_id, .. } if request_id == RequestId::new(41))
        );

        let (worker, _payload) = blocked_worker().await;
        let (_sender, cancel) = watch::channel(true);
        let (control, _responses) = mpsc::channel(1);
        control.send(Message::text("occupied")).await.unwrap();
        let task = run(
            worker.request_id,
            exit_request(),
            worker.write,
            cancel,
            control,
            AgentId::from("terminal-test"),
        );
        tokio::pin!(task);
        // Saturating control as well exercises the second cleanup deadline.
        assert!(poll!(&mut task).is_pending());
        tokio::time::advance(Duration::from_secs(6)).await;
        // The fallback is now blocked, but retains its own finite cleanup budget.
        assert!(poll!(&mut task).is_pending());
        tokio::time::advance(Duration::from_secs(6)).await;
        // Joining the worker cannot hang even when neither lane drains.
        assert!(poll!(&mut task).is_ready());
    }
}
