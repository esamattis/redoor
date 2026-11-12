//! `rd-open`: opens a path from a redoor terminal in the web UI.
//!
//! The agent writes a small `rd-open` script into its data directory, puts that directory
//! first on every terminal shell's `PATH` and listens on a private Unix socket. The script
//! runs this binary's hidden `redoor agent open`, which finds the socket and the terminal's
//! token in its environment and asks the agent to open the path. The agent checks the token,
//! stats the path and tells the server, which asks the browsers to show it.
//!
//! The socket and the script are per agent (its data directory), because several agents of
//! different users, apps or builds can run on one host, and the environment of a shell names
//! the agent that owns it. The per-terminal token keeps other local processes from steering
//! browsers: only a shell started by the agent knows one.

use crate::runtime::AgentHandle;
use crate::terminal::registry::TerminalSessions;
use anyhow::{Context, Result, bail};
use redoor_core::log;
use redoor_protocol::{api::ui_events::OpenPathKind, wire::log::Level};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// Names the agent's socket in a terminal shell's environment.
pub const SOCKET_ENV: &str = "REDOOR_OPEN_SOCKET";
/// Carries the terminal's secret token in its shell's environment.
pub const TOKEN_ENV: &str = "REDOOR_OPEN_TOKEN";
/// The command people type; short because it is typed by hand in a shell.
const COMMAND_NAME: &str = "rd-open";
/// Bounds one request line, which is only a token and a path, so a misbehaving local client
/// cannot make the agent buffer without limit.
const MAX_MESSAGE_BYTES: u64 = 64 * 1024;
/// Bounds one exchange on either side, so neither a stalled client nor a stalled agent can
/// hang the other.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);

/// One request line from `redoor agent open` to the agent.
#[derive(Debug, Serialize, Deserialize)]
struct OpenRequest {
    /// The terminal's token, proving the request comes from one of the agent's shells.
    token: String,
    /// Absolute, lexically normalized path to open.
    path: String,
}

/// The agent's one reply line, so the command can print why nothing opened.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum OpenReply {
    /// The server was told; whether a browser shows it is up to the browsers.
    Sent,
    Failed {
        message: String,
    },
}

/// What a terminal shell needs to reach its agent's `rd-open` socket.
#[derive(Clone, Debug)]
pub(crate) struct ShellOpenEnv {
    /// The agent's socket, advertised through [`SOCKET_ENV`].
    socket: PathBuf,
    /// Directory holding the `rd-open` script, put first on the shell's `PATH`.
    bin_dir: PathBuf,
}

impl ShellOpenEnv {
    /// Points shells at `socket`, with the `rd-open` script in `bin_dir`.
    pub(crate) fn new(socket: PathBuf, bin_dir: PathBuf) -> Self {
        Self { socket, bin_dir }
    }

    /// Variables one shell gets: the socket, its own token and `PATH` with the script's
    /// directory first. `path` is the `PATH` the shell would otherwise get; login shells may
    /// still rebuild it from profile files, which then hides `rd-open`, but most keep it.
    pub(crate) fn variables(
        &self,
        token: &str,
        path: Option<OsString>,
    ) -> Vec<(&'static str, OsString)> {
        let mut search_path = OsString::from(self.bin_dir.as_os_str());
        if let Some(path) = path.filter(|path| !path.is_empty()) {
            search_path.push(":");
            search_path.push(path);
        }
        vec![
            (SOCKET_ENV, self.socket.clone().into_os_string()),
            (TOKEN_ENV, OsString::from(token)),
            ("PATH", search_path),
        ]
    }
}

/// The agent's listening socket together with the environment that points shells to it.
pub(crate) struct OpenListener {
    env: ShellOpenEnv,
    listener: UnixListener,
}

impl OpenListener {
    /// Writes the `rd-open` script and binds the socket in `data_dir`.
    ///
    /// The script is rewritten on every start so it always names the binary that runs now,
    /// also after an upgrade or when another build took over the data directory.
    pub(crate) async fn install(data_dir: &Path) -> Result<Self> {
        let bin_dir = data_dir.join("terminal-bin");
        tokio::fs::create_dir_all(&bin_dir)
            .await
            .with_context(|| format!("failed to create {}", bin_dir.display()))?;
        let executable =
            redoor_core::executable::current().context("failed to locate the redoor binary")?;
        let script = script(&locate_sh().await, &executable);
        write_executable(&bin_dir.join(COMMAND_NAME), &script).await?;

        let socket = data_dir.join("terminal-open.sock");
        // A previous run of this agent leaves its socket behind, and bind refuses to reuse it.
        match tokio::fs::remove_file(&socket).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to remove stale {}", socket.display()));
            }
        }
        let listener = UnixListener::bind(&socket)
            .with_context(|| format!("failed to listen on {}", socket.display()))?;
        // Only the agent's own account may connect; the token is the second line of defense.
        tokio::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
            .await
            .with_context(|| format!("failed to restrict {}", socket.display()))?;
        Ok(Self {
            env: ShellOpenEnv::new(socket, bin_dir),
            listener,
        })
    }

    /// The environment terminal shells get so `rd-open` reaches this listener.
    pub(crate) fn env(&self) -> ShellOpenEnv {
        self.env.clone()
    }

    /// Answers `rd-open` requests for the life of the process. Each client gets its own task,
    /// so one that never writes cannot hold up the next.
    pub(crate) fn serve(self, sessions: TerminalSessions, agent: AgentHandle) {
        tokio::spawn(async move {
            loop {
                match self.listener.accept().await {
                    Ok((stream, _)) => {
                        tokio::spawn(answer(stream, sessions.clone(), agent.clone()));
                    }
                    Err(error) => {
                        log!(
                            Level::Warning,
                            "Failed to accept an rd-open client: {error}"
                        );
                        // Errors such as running out of descriptors persist for a moment;
                        // retrying at once would spin.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
    }
}

/// Reads one request, carries it out and writes the reply.
async fn answer(stream: UnixStream, sessions: TerminalSessions, agent: AgentHandle) {
    let (read, mut write) = stream.into_split();
    let reply = match tokio::time::timeout(EXCHANGE_TIMEOUT, read_line(read)).await {
        Ok(Ok(line)) => match serde_json::from_str::<OpenRequest>(&line) {
            Ok(request) => open(request, &sessions, &agent).await,
            Err(_) => Err("malformed rd-open request".to_string()),
        },
        Ok(Err(error)) => Err(format!("failed to read the rd-open request: {error}")),
        Err(_) => Err("timed out waiting for the rd-open request".to_string()),
    };
    let reply = match reply {
        Ok(()) => OpenReply::Sent,
        Err(message) => OpenReply::Failed { message },
    };
    if let Ok(mut line) = serde_json::to_string(&reply) {
        line.push('\n');
        // The client may have given up already; nothing else needs to know.
        let _ = tokio::time::timeout(EXCHANGE_TIMEOUT, write.write_all(line.as_bytes())).await;
    }
}

/// Checks the token and the path, then asks the server to open it.
async fn open(
    request: OpenRequest,
    sessions: &TerminalSessions,
    agent: &AgentHandle,
) -> Result<(), String> {
    if !sessions.accepts_open_token(&request.token) {
        return Err("this shell is not running in an open redoor terminal".to_string());
    }
    if !request.path.starts_with('/') {
        return Err(format!("{} is not an absolute path", request.path));
    }
    let metadata =
        tokio::fs::metadata(&request.path)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    format!("{}: No such file or directory", request.path)
                }
                _ => format!("{}: {error}", request.path),
            })?;
    let kind = if metadata.is_dir() {
        OpenPathKind::Directory
    } else {
        OpenPathKind::File
    };
    log!(
        Level::Info,
        "Opening path in the UI: path={}, kind={:?}",
        request.path,
        kind
    );
    agent.open_path(request.path, kind).await
}

/// Reads one newline-terminated line of at most [`MAX_MESSAGE_BYTES`].
async fn read_line(read: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<String> {
    let mut line = String::new();
    BufReader::new(read.take(MAX_MESSAGE_BYTES))
        .read_line(&mut line)
        .await?;
    Ok(line)
}

/// The `rd-open` script: hands its arguments to this binary's hidden `agent open`.
fn script(sh: &Path, executable: &Path) -> String {
    format!(
        "#!{}\nexec {} agent open \"$@\"\n",
        sh.display(),
        shell_quote(&executable.to_string_lossy())
    )
}

/// Quotes `value` as one POSIX shell word, so install paths with spaces or quotes still work.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Finds a POSIX shell for the script's `#!` line. Android/Termux has no `/bin/sh`, so the
/// one on `PATH` (Termux's `$PREFIX/bin/sh`) is used there.
async fn locate_sh() -> PathBuf {
    let standard = PathBuf::from("/bin/sh");
    if tokio::fs::try_exists(&standard).await.unwrap_or(false) {
        return standard;
    }
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&search_path) {
        let candidate = dir.join("sh");
        if dir.is_absolute() && tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
    }
    standard
}

/// Replaces `path` with an executable file holding `contents`, through a rename so a shell
/// running `rd-open` at that moment never sees a half-written script.
async fn write_executable(path: &Path, contents: &str) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    tokio::fs::write(&temporary, contents)
        .await
        .with_context(|| format!("failed to write {}", temporary.display()))?;
    tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))
        .await
        .with_context(|| format!("failed to make {} executable", temporary.display()))?;
    tokio::fs::rename(&temporary, path)
        .await
        .with_context(|| format!("failed to install {}", path.display()))
}

/// Resolves `.` and `..` without touching the filesystem, so the UI shows the path as typed
/// rather than where symlinks lead.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => normalized.push("/"),
            Component::CurDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(name) => normalized.push(name),
        }
    }
    normalized
}

/// Runs `redoor agent open <path>`, which `rd-open` executes: asks the agent that owns this
/// terminal to open `path`, relative to the current directory, in the web UI.
///
/// Returns once the agent passed the request on; browsers may still be closed, and the
/// command must not wait for one.
pub async fn run_cli(path: &Path) -> Result<()> {
    let (Some(socket), Some(token)) = (
        std::env::var_os(SOCKET_ENV).filter(|value| !value.is_empty()),
        std::env::var(TOKEN_ENV)
            .ok()
            .filter(|value| !value.is_empty()),
    ) else {
        bail!("{COMMAND_NAME} only works inside a redoor terminal");
    };
    let absolute = if path.is_absolute() {
        normalize(path)
    } else {
        let cwd = std::env::current_dir().context("failed to read the current directory")?;
        normalize(&cwd.join(path))
    };
    let Some(path) = absolute.to_str() else {
        bail!("{} is not valid UTF-8", absolute.display());
    };
    let request = OpenRequest {
        token,
        path: path.to_string(),
    };
    let reply = tokio::time::timeout(EXCHANGE_TIMEOUT, exchange(Path::new(&socket), &request))
        .await
        .context("the redoor agent did not answer")??;
    match reply {
        OpenReply::Sent => Ok(()),
        OpenReply::Failed { message } => bail!("{COMMAND_NAME}: {message}"),
    }
}

/// Sends one request to the agent's socket and reads its reply.
async fn exchange(socket: &Path, request: &OpenRequest) -> Result<OpenReply> {
    let mut stream = UnixStream::connect(socket).await.with_context(|| {
        format!(
            "failed to reach the redoor agent at {}; was it restarted after this terminal opened?",
            socket.display()
        )
    })?;
    let mut line = serde_json::to_string(request)?;
    line.push('\n');
    stream.write_all(line.as_bytes()).await?;
    let reply = read_line(stream).await?;
    serde_json::from_str(&reply).context("the redoor agent sent a malformed reply")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The script must hand every argument to the exact binary, even from a path with quotes.
    #[test]
    fn script_execs_the_binary_with_all_arguments() {
        let script = script(Path::new("/bin/sh"), Path::new("/opt/it's here/redoor"));
        // The shebang names the shell found at install time, which differs on Termux.
        assert!(script.starts_with("#!/bin/sh\n"));
        // `exec` replaces the shell, and "$@" keeps arguments with spaces whole.
        assert!(script.contains(r#"exec '/opt/it'\''s here/redoor' agent open "$@""#));
    }

    /// Relative paths typed in a shell become clean absolute paths for the browser route.
    #[test]
    fn normalizes_dot_segments_lexically() {
        assert_eq!(
            normalize(Path::new("/home/u/./src/../notes.md")),
            PathBuf::from("/home/u/notes.md")
        );
        // `..` at the root stays at the root, as in a shell.
        assert_eq!(normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    /// The script's directory goes first, so `rd-open` wins over anything else on `PATH`.
    #[test]
    fn shell_path_starts_with_the_script_directory() {
        let env = ShellOpenEnv::new(
            PathBuf::from("/data/terminal-open.sock"),
            PathBuf::from("/data/terminal-bin"),
        );
        let variables = env.variables("secret", Some(OsString::from("/usr/bin")));
        // The command finds its agent and proves its terminal through these two.
        assert!(variables.contains(&(SOCKET_ENV, OsString::from("/data/terminal-open.sock"))));
        assert!(variables.contains(&(TOKEN_ENV, OsString::from("secret"))));
        assert!(variables.contains(&("PATH", OsString::from("/data/terminal-bin:/usr/bin"))));
        // Without an inherited PATH the shell still finds the command.
        let variables = env.variables("secret", None);
        assert!(variables.contains(&("PATH", OsString::from("/data/terminal-bin"))));
    }
}
