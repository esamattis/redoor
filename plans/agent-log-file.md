# Plan: Agent log file config option

## Goal

Add a `log` config option to **ssh** `[[agents]]` entries (local agents already
have one) and change the implementation for **both** agent kinds so that, when
configured, the **spawned process's stdout/stderr is redirected to the
specified file** instead of passing `--log` to the agent binary. The agent
itself keeps writing to stdout/stderr; the redirect happens at the spawn site:

- **ssh agents** — the `ssh` process's stdout/stderr is redirected. ssh
  forwards the remote agent's stdout/stderr back to the local ssh process,
  which then lands in the local log file.
- **local agents** — the `redoor agent` child process's stdout/stderr is
  redirected (replaces the previous `--log` flag forwarding).

This gives a uniform mechanism for both agent kinds: the log file is a **local**
file path on the machine running the server, and the agent binary is agnostic
to where its stdout/stderr ends up.

## Files to change

1. `src/ssh.rs` — add `log` to `SshAgentConfig`, add `log_file` to
   `SshRunOptions`, redirect stdio in `SshHost::run`, forward the option from
   `start_ssh_agent`.
2. `src/server/config.rs` — remove the `log` rejection in `parse_ssh_entry`,
   parse and forward `log` into `SshAgentConfig`; change `start_local_agent` to
   redirect stdio instead of passing `--log`; update tests.
3. `config.toml` — add commented `# log = "..."` examples.

## Detailed steps

### 1. `src/ssh.rs`

#### 1a. Add `log` field to `SshAgentConfig` (around line 77)

```rust
#[derive(Debug, Clone)]
pub(crate) struct SshAgentConfig {
    pub(crate) username: Option<String>,
    pub(crate) ssh_port: u16,
    pub(crate) name: Option<String>,
    pub(crate) remote_bin: Option<String>,
    pub(crate) dir: Option<String>,
    pub(crate) target: String,
    /// Optional local log file path. When set, the ssh process's
    /// stdout/stderr is redirected to this file so the remote agent's
    /// logs (forwarded through ssh) are captured locally. The file is
    /// opened in append mode so agent restarts accumulate logs.
    pub(crate) log: Option<String>,
}
```

Update the struct literal in `run` (around line 621) to set `log: None`:

```rust
let config = SshAgentConfig {
    username: args.username,
    ssh_port: args.ssh_port,
    name: args.name,
    remote_bin: Some(args.remote_bin),
    dir: args.dir,
    target: args.target,
    log: None,
};
```

> `SshArgs` does **not** get a `--log` flag in this plan — the feature is
> config-file only. `redoor ssh` CLI users can rely on the agent's own
> `--log` if needed in the future.

#### 1b. Add `log_file` to `SshRunOptions` (around line 388)

```rust
#[derive(Default)]
pub(crate) struct SshRunOptions {
    pub(crate) reverse_forwards: Vec<ReverseForward>,
    pub(crate) compressed: bool,
    /// When set, the ssh process's stdout/stderr is redirected (append
    /// mode) to this local file path. Used only for the long-running
    /// agent run so sniff/upload diagnostics still go to the terminal.
    pub(crate) log_file: Option<String>,
}
```

Add a builder method:

```rust
impl SshRunOptions {
    // ... existing methods ...

    /// Sets a local log file to redirect the ssh process's stdout/stderr into.
    pub(crate) fn with_log_file(mut self, path: impl Into<String>) -> Self {
        self.log_file = Some(path.into());
        self
    }
}
```

#### 1c. Redirect stdio in `SshHost::run` (around line 490)

Replace the unconditional `Stdio::inherit()` for stdout/stderr with a
conditional redirect:

```rust
ssh.stdin(Stdio::inherit());

if let Some(log_path) = &options.log_file {
    // Open in append mode via the async tokio API, then convert to a
    // std::fs::File so it can be turned into a Stdio for the child.
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await?;
    // Clone the handle so stdout and stderr can both write to the same file.
    let file_for_stderr = file.try_clone().await?;
    let stdout_file = file.into_std();
    let stderr_file = file_for_stderr.into_std();
    ssh.stdout(Stdio::from(stdout_file));
    ssh.stderr(Stdio::from(stderr_file));
} else {
    ssh.stdout(Stdio::inherit());
    ssh.stderr(Stdio::inherit());
}
```

> `run_captured` and `upload_via_cat` are **not** changed — the sniff and
> upload are one-shot setup steps whose diagnostics belong in the terminal.

#### 1d. Forward the log file in `start_ssh_agent` (around line 675)

Change the options builder for the final agent run:

```rust
let mut options = SshRunOptions::default().with_reverse_forward(redoor_port, redoor_port);
if let Some(log) = &config.log {
    options = options.with_log_file(log);
}
```

Update the info log to include the log path:

```rust
log!(
    Level::Info,
    "Starting redoor agent on remote host: name={}, ws_url={}, remote_bin={}, dir={:?}, log={:?}",
    agent_name,
    ws_url,
    remote_bin,
    config.dir,
    config.log,
);
```

### 2. `src/server/config.rs`

#### 2a. Remove the `log` rejection in `parse_ssh_entry` (lines 205–211)

Delete this block:

```rust
if entry.get("log").and_then(|item| item.as_str()).is_some() {
    bail!(
        "agents entry #{} has 'log' which only applies to local agents (local = true); \
         remove 'log' or set 'local = true'",
        index
    );
}
```

#### 2b. Parse `log` in `parse_ssh_entry` and add it to the returned struct

After the `dir` parse (around line 252):

```rust
let log = entry
    .get("log")
    .and_then(|item| item.as_str())
    .map(|s| s.to_string());
```

And in the struct literal:

```rust
Ok(SshAgentConfig {
    username,
    ssh_port,
    name,
    remote_bin,
    dir,
    target,
    log,
})
```

#### 2c. Change `start_local_agent` to redirect stdio (lines 401–443)

Remove the `--log` flag passing (lines 417–419) and replace the stdio
configuration with a conditional redirect:

```rust
async fn start_local_agent(
    config: LocalAgentConfig,
    redoor_port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let name = config.name.unwrap_or_else(default_local_agent_name);
    let ws_url = format!("ws://localhost:{}/ws", redoor_port);

    let bin = std::env::current_exe()
        .map_err(|e| format!("Failed to determine redoor binary path: {}", e))?;

    let mut command = Command::new(&bin);
    command.arg("agent").arg(&ws_url).arg("--name").arg(&name);

    if let Some(dir) = &config.dir {
        command.arg("-d").arg(dir);
    }

    command.stdin(Stdio::inherit());

    if let Some(log) = &config.log {
        // Redirect the child's stdout/stderr into the log file instead of
        // passing --log to the agent. The agent writes to stdout/stderr
        // and the OS redirect captures it, avoiding double-writes that
        // would happen if both --log and a redirect were used.
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .await?;
        let file_for_stderr = file.try_clone().await?;
        command.stdout(Stdio::from(file.into_std()));
        command.stderr(Stdio::from(file_for_stderr.into_std()));
    } else {
        command.stdout(Stdio::inherit());
        command.stderr(Stdio::inherit());
    }

    log!(
        Level::Info,
        "Starting local redoor agent: name={}, ws_url={}, bin={}, log={:?}",
        name,
        ws_url,
        bin.display(),
        config.log,
    );

    let status = command.status().await?;
    if !status.success() {
        return Err(format!(
            "local agent exited with status {}",
            status.code().unwrap_or(-1)
        )
        .into());
    }
    Ok(())
}
```

> **Why redirect instead of `--log`:** The agent's `--log` flag writes to
> **both** stdout and the file (see `src/logging.rs:90`). If we passed
> `--log` AND redirected stdout to the same file, every line would be
> duplicated. Redirecting stdout/stderr alone is simpler and matches the
> user's "just redirect the process output" requirement.

#### 2d. Update the doc comment on `LocalAgentConfig.log` (lines 41–44)

Update to reflect that the log file is now used for process redirection, not
passed as `--log`:

```rust
/// Log file path. When set, the spawned `redoor agent` process's
/// stdout/stderr is redirected (append mode) to this file. When
/// `None`, stdio is inherited so the agent's logs appear in the
/// server's terminal.
pub(crate) log: Option<String>,
```

### 3. `config.toml` — add examples

```toml
[[agents]]
target = "devbox"
remote_bin = "/home/esamatti/code/redoor/target/debug/redoor"
dir = "/home"
# log = "log/devbox.log"   # optional; redirects the agent's stdout/stderr to this local file

[[agents]]
name = "local"
local = true
dir = "/Users/esamatti/tmp"
# log = "log/local.log"    # optional; redirects the agent's stdout/stderr to this file
```

### 4. Tests in `src/server/config.rs`

#### 4a. Remove `test_parse_config_file_rejects_ssh_with_log` (lines 820–847)

This test verified that `log` on an ssh entry was rejected. Now that `log` is
accepted, this test is obsolete.

#### 4b. Add `test_parse_config_file_ssh_entry_with_log`

Verifies that `log` on an ssh entry is parsed and forwarded into
`SshAgentConfig`:

```rust
/// Verifies that a `log` on an ssh entry is accepted and forwarded into
/// the SshAgentConfig so the operator can capture a remote agent's
/// forwarded stdout/stderr into a local log file.
#[tokio::test]
async fn test_parse_config_file_ssh_entry_with_log() {
    let temp = std::env::temp_dir().join(format!(
        "redoor-agents-test-ssh-log-{}.toml",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let content = r#"
[[agents]]
target = "prod-db"
log = "log/prod-db.log"
"#;
    std::fs::write(&temp, content).unwrap();

    let config = parse_config_file(temp.to_str().unwrap()).await.unwrap();
    std::fs::remove_file(&temp).ok();

    assert_eq!(config.agents.len(), 1);
    let agent = match &config.agents[0] {
        AgentConfig::Ssh(config) => config,
        AgentConfig::Local(_) => panic!("entry without `local = true` should be ssh"),
    };
    assert_eq!(
        agent.log.as_deref(),
        Some("log/prod-db.log"),
        "log should be read from the ssh toml entry"
    );
}
```

#### 4c. Update `test_parse_config_file_full_entry`

Add `log` to the full ssh entry and assert it is parsed. Add after the
`dir = "/srv/app"` line in the first entry's content:

```toml
log = "log/db-agent.log"
```

And the assertion:

```rust
assert_eq!(first.log.as_deref(), Some("log/db-agent.log"));
```

Also update the "no log field" assertion in
`test_parse_config_file_minimal_entry` — currently the test doesn't assert on
`log`, but add one for completeness:

```rust
assert!(agent.log.is_none(), "log should be None when not specified");
```

### 5. Verification

Run `./scripts/build-and-test` which executes:
- `cargo fmt -- --check`
- `cargo test` (runs the updated unit tests)
- `cargo build`
- `pnpm run test` (integration tests)
- `cargo clippy`

No TypeScript bindings are generated by this change (no new REST API response
structs), so `scripts/generate-ts-bindings` is not needed.
