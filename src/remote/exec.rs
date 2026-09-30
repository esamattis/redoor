//! Streams execution records to local pipes without collecting remote output.

use super::{client::RemoteClient, session::SessionStore};
use anyhow::{Context, Result, ensure};
use clap::Args;
use redoor::exec_protocol::{ExecEvent, ExecRequest};
use tokio::io::AsyncWriteExt;

/// Requires an explicit separator so command flags can never become CLI options.
#[derive(Args, Debug)]
pub struct ExecArgs {
    #[arg(long)]
    cwd: Option<String>,
    /// Override an environment variable; repeat for multiple variables (last value wins).
    #[arg(long, value_parser = parse_env)]
    env: Vec<(String, String)>,
    /// Agent-side deadline, e.g. 250ms, 30s, 5m, 2h, or 1d.
    #[arg(long, value_parser = parse_duration)]
    timeout: Option<u64>,
    /// Emit lossless newline-delimited JSON output and terminal events.
    #[arg(long)]
    json: bool,
    /// Device ID from `redoor remote devices`.
    #[arg(value_name = "DEVICE")]
    agent: String,
    #[arg(last = true, required = true, num_args = 1..)]
    argv: Vec<String>,
}

/// Splits only the first equals sign, preserving empty values and embedded equals signs.
fn parse_env(value: &str) -> std::result::Result<(String, String), String> {
    let (key, value) = value.split_once('=').ok_or("--env requires KEY=VALUE")?;
    if key.is_empty() || key.contains('\0') || value.contains('\0') {
        return Err("--env requires a nonempty key and no NUL".into());
    }
    Ok((key.to_owned(), value.to_owned()))
}

/// Converts common explicit duration units to a bounded millisecond API deadline.
fn parse_duration(value: &str) -> std::result::Result<u64, String> {
    let (number, unit) = if let Some(v) = value.strip_suffix("ms") {
        (v, 1u64)
    } else if let Some(v) = value.strip_suffix('s') {
        (v, 1000)
    } else if let Some(v) = value.strip_suffix('m') {
        (v, 60_000)
    } else if let Some(v) = value.strip_suffix('h') {
        (v, 3_600_000)
    } else if let Some(v) = value.strip_suffix('d') {
        (v, 86_400_000)
    } else {
        return Err("--timeout requires a duration such as 250ms, 30s, 5m, 2h or 1d".into());
    };
    let ms = number
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(unit))
        .filter(|ms| *ms > 0 && *ms <= 31_536_000_000)
        .ok_or("--timeout must be a positive integer duration at most 365 days")?;
    Ok(ms)
}

/// Owns local output handles while terminal events carry the process result independently of transport.
struct Output {
    json: bool,
    stdout: tokio::io::Stdout,
    stderr: tokio::io::Stderr,
}

impl Output {
    /// Emits and flushes each event so live consumers do not wait for remote exit.
    async fn event(&mut self, event: &ExecEvent) -> Result<Option<i32>> {
        if self.json {
            let mut bytes = serde_json::to_vec(event)?;
            bytes.push(b'\n');
            self.stdout.write_all(&bytes).await?;
            self.stdout.flush().await?;
        } else {
            match event {
                ExecEvent::Stdout { data } => {
                    self.stdout.write_all(data).await?;
                    self.stdout.flush().await?;
                }
                ExecEvent::Stderr { data } => {
                    self.stderr.write_all(data).await?;
                    self.stderr.flush().await?;
                }
                _ => {}
            }
        }
        Ok(match event {
            ExecEvent::Exit { code, signal } => {
                Some(code.unwrap_or_else(|| signal.map_or(125, |signal| 128 + signal)))
            }
            ExecEvent::TimedOut => {
                if !self.json {
                    eprintln!("Remote execution timed out");
                }
                Some(124)
            }
            ExecEvent::Canceled => {
                if !self.json {
                    eprintln!("Remote execution canceled");
                }
                Some(130)
            }
            ExecEvent::Error { message } => {
                if !self.json {
                    eprintln!("Remote execution failed: {message}");
                }
                Some(125)
            }
            _ => None,
        })
    }

    /// Bounds partial records even if a server sends malformed or unterminated NDJSON.
    async fn consume(&mut self, mut response: reqwest::Response) -> Result<i32> {
        let mut record = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .context("Execution transport failed")?
        {
            for byte in chunk {
                ensure!(record.len() < 65_536, "Execution record exceeds 64 KiB");
                if byte == b'\n' {
                    let event: ExecEvent =
                        serde_json::from_slice(&record).context("Invalid execution event")?;
                    record.clear();
                    if let Some(code) = self.event(&event).await? {
                        return Ok(code);
                    }
                } else {
                    record.push(byte);
                }
            }
        }
        anyhow::bail!(
            "Execution transport closed without a terminal event (remote exit status unknown)"
        )
    }
}

/// Handles interruption over the whole admission/read operation; closing HTTP cancels remote ownership.
pub async fn run(store: SessionStore, args: ExecArgs) -> i32 {
    let mut output = Output {
        json: args.json,
        stdout: tokio::io::stdout(),
        stderr: tokio::io::stderr(),
    };
    // Install SIGINT before any request can be admitted.
    let mut interrupt =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
            Ok(signal) => signal,
            Err(error) => {
                eprintln!("Cannot install interruption handler: {error}");
                return 125;
            }
        };
    let mut terminate =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(error) => {
                eprintln!("Cannot install termination handler: {error}");
                return 125;
            }
        };
    let operation = async {
        let request = ExecRequest {
            argv: args.argv,
            cwd: args.cwd,
            env: args.env.into_iter().collect(),
            timeout_ms: args.timeout,
        };
        request.validate().map_err(anyhow::Error::msg)?;
        let client = RemoteClient::load(store).await?;
        client.ensure_agent_running(&args.agent).await?;
        let mut url = client.endpoint("api/v1/agents/")?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid server URL"))?
            .pop_if_empty()
            .push(&args.agent)
            .push("exec");
        let response = client
            .send(client.json_request(reqwest::Method::POST, url.as_str(), &request)?)
            .await?;
        output.consume(response).await
    };
    let result = tokio::select! {
        result = operation => result,
        _ = interrupt.recv() => Err(anyhow::anyhow!("interrupted: remote execution canceled by closing its stream")),
        _ = terminate.recv() => Err(anyhow::anyhow!("interrupted: remote execution canceled by closing its stream")),
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            let interrupted = error.to_string().starts_with("interrupted:");
            let message = format!("{error:#}");
            if args.json {
                let event = if interrupted {
                    ExecEvent::Canceled
                } else {
                    ExecEvent::Error {
                        message: message.clone(),
                    }
                };
                // A blocked local JSON pipe must not prevent interruption from finishing remote cleanup.
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(1), output.event(&event))
                        .await;
            }
            eprintln!("{message}");
            if interrupted { 130 } else { 125 }
        }
    }
}
