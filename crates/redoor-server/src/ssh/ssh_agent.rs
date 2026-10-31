//! An in-process ssh-agent that gives one `ssh` process signatures from a managed key.
//!
//! "ssh-agent" here always means the OpenSSH key agent protocol, never the redoor agent
//! that runs on devices. OpenSSH only accepts a key from a file or from an ssh-agent; this
//! one keeps the private key inside the server process and hands `ssh` only signatures, so
//! a decrypted key never touches the disk and is never given to another process.
//!
//! **One socket per ssh process.** [`SshAgentSocket::bind`] creates a fresh 0700 directory
//! under `$XDG_RUNTIME_DIR` (or the temp dir) holding the 0600 socket and `id.pub`, the
//! public key `ssh` is pointed at with `IdentityFile` and `IdentitiesOnly`. The path must
//! stay short (Unix socket paths are limited to 104 to 108 bytes) and must not contain `%`
//! or `$`, which `ssh` expands in `IdentityAgent`.
//!
//! **Who may connect.** Every connection's peer must run as the server's uid, and where the
//! platform reports it, be the spawned `ssh` process itself.
//!
//! **Lifetime.** `ssh` uses the ssh-agent only while authenticating and closes the
//! connection right after. The socket stops accepting and its directory is removed after
//! the first successful signature, after the first served connection ends, when the guard
//! of a short-lived `ssh` is dropped (its process exited), or at the latest after
//! [`SSH_AGENT_LIFETIME`], for an `ssh` that exited before it ever connected.
//!
//! **Protocol.** Hand-written instead of a library because only two requests are needed:
//! `REQUEST_IDENTITIES` answers with the one key, `SIGN_REQUEST` signs only for that key.
//! Everything else, including `session-bind@openssh.com`, gets `FAILURE`: `ssh` already
//! enforces the host key pin, and the socket is protected by its mode, the peer check and
//! its short lifetime, not by session binding.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use redoor_core::log;
use redoor_protocol::wire::log::Level;
use ssh_encoding::{Decode, Encode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;

use super::keys::SshPrivateKey;

/// `SSH_AGENT_FAILURE`.
const SSH_AGENT_FAILURE: u8 = 5;
/// `SSH_AGENTC_REQUEST_IDENTITIES`.
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
/// `SSH_AGENT_IDENTITIES_ANSWER`.
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
/// `SSH_AGENTC_SIGN_REQUEST`.
const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
/// `SSH_AGENT_SIGN_RESPONSE`.
const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

/// Largest ssh-agent message accepted. Sign requests carry a session hash and a few names,
/// far below this; a larger length is a broken or hostile peer, and the connection is closed
/// instead of buffering it.
const MAX_SSH_AGENT_MESSAGE_LEN: u32 = 256 * 1024;

/// Upper bound of a socket's life, for an `ssh` that exited before it connected. Longer
/// than any authentication (connect timeout, proxy jumps, slow hosts) can take.
pub(super) const SSH_AGENT_LIFETIME: Duration = Duration::from_secs(120);

/// Longest socket path accepted; the smallest `sun_path` among supported platforms (macOS)
/// is 104 bytes including the terminating zero.
const MAX_SOCKET_PATH_LEN: usize = 100;

/// File name of the socket inside its directory, short to keep the path short.
const SOCKET_FILE: &str = "s";
/// File name of the public key `ssh` is pointed at with `IdentityFile`.
const PUBLIC_KEY_FILE: &str = "id.pub";

/// A bound ssh-agent socket for one `ssh` process, not yet serving.
pub(super) struct SshAgentSocket {
    /// The socket's directory, removed when dropped.
    dir: SshAgentDir,
    /// The bound listener; connections wait in its backlog until [`Self::serve`].
    listener: UnixListener,
    /// The key the ssh-agent signs with.
    key: Arc<SshPrivateKey>,
}

impl SshAgentSocket {
    /// Creates the private directory, the public key file and the listening socket.
    pub(super) async fn bind(key: Arc<SshPrivateKey>) -> std::io::Result<Self> {
        let dir = SshAgentDir::create().await?;
        tokio::fs::write(
            dir.public_key_path(),
            format!("{}\n", key.public_key_openssh()),
        )
        .await?;
        let listener = UnixListener::bind(dir.socket_path())?;
        // The directory already keeps other users out; the mode documents the intent and
        // covers platforms that ignore directory permissions for sockets.
        tokio::fs::set_permissions(
            dir.socket_path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .await?;
        Ok(Self { dir, listener, key })
    }

    /// The socket `ssh` is given as `IdentityAgent`.
    pub(super) fn socket_path(&self) -> PathBuf {
        self.dir.socket_path()
    }

    /// The public key file `ssh` is given as `IdentityFile`.
    pub(super) fn public_key_path(&self) -> PathBuf {
        self.dir.public_key_path()
    }

    /// Starts answering requests from the `ssh` process `peer_pid` (`None` when its pid is
    /// unknown, which leaves only the uid check). Returns the guard that ends the socket.
    pub(super) fn serve(self, peer_pid: Option<u32>) -> SshAgentGuard {
        let stop = Arc::new(Notify::new());
        tokio::spawn(
            SshAgentServer {
                dir: Some(self.dir),
                listener: Some(self.listener),
                key: self.key,
                peer_pid,
                signed: false,
            }
            .run(stop.clone()),
        );
        SshAgentGuard { stop: Some(stop) }
    }
}

/// Ends a serving ssh-agent socket when dropped, for an `ssh` process whose exit is
/// awaited by its owner. Long-lived `ssh` processes detach it instead.
pub(super) struct SshAgentGuard {
    /// Signalled on drop; `None` once detached.
    stop: Option<Arc<Notify>>,
}

impl SshAgentGuard {
    /// Leaves the ssh-agent running until its own end conditions (first signature, first
    /// served connection, lifetime), for an `ssh` child whose owner cannot hold the guard.
    pub(super) fn detach(mut self) {
        self.stop = None;
    }
}

impl Drop for SshAgentGuard {
    /// Stops the ssh-agent, because the `ssh` process it served has exited.
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            // `notify_one` stores the wakeup, so a stop before the task first waits is kept.
            stop.notify_one();
        }
    }
}

/// The directory of one socket. Dropping it removes the socket and the public key file
/// and then the empty directory, so no socket outlives its use.
struct SshAgentDir {
    /// The directory itself.
    path: PathBuf,
}

impl SshAgentDir {
    /// Creates a new 0700 directory with a random name under the runtime or temp dir.
    async fn create() -> std::io::Result<Self> {
        let base = runtime_dir();
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| {
            std::io::Error::other(format!("the OS random source is unavailable: {error}"))
        })?;
        let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = base.join(format!("redoor-ssh-agent-{name}"));
        let socket = path.join(SOCKET_FILE);
        let text = socket.to_string_lossy();
        if text.len() > MAX_SOCKET_PATH_LEN
            || text.contains(['%', '$'])
            || text.contains(char::is_whitespace)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "Cannot create the ssh-agent socket for the managed SSH key at '{text}': the path must be at most {MAX_SOCKET_PATH_LEN} bytes and must not contain '%', '$' or whitespace. Set XDG_RUNTIME_DIR or TMPDIR to a short plain directory."
                ),
            ));
        }
        let mut builder = tokio::fs::DirBuilder::new();
        builder.mode(0o700);
        // Not recursive: a fresh random name must not exist yet, so an existing path (or a
        // symlink planted there) fails instead of being reused.
        builder.create(&path).await?;
        Ok(Self { path })
    }

    /// The socket inside the directory.
    fn socket_path(&self) -> PathBuf {
        self.path.join(SOCKET_FILE)
    }

    /// The public key file inside the directory.
    fn public_key_path(&self) -> PathBuf {
        self.path.join(PUBLIC_KEY_FILE)
    }
}

impl Drop for SshAgentDir {
    /// Removes the two files and the directory in the background; the directory is not
    /// deleted recursively, so nothing but these files can ever be removed.
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            for file in [SOCKET_FILE, PUBLIC_KEY_FILE] {
                let _ = tokio::fs::remove_file(path.join(file)).await;
            }
            if let Err(error) = tokio::fs::remove_dir(&path).await
                && error.kind() != std::io::ErrorKind::NotFound
            {
                redoor_core::log_failure!(
                    Level::Warn,
                    "Failed to remove an ssh-agent socket directory: path={}, error={}",
                    path.display(),
                    error
                );
            }
        });
    }
}

/// The directory sockets are created in: `$XDG_RUNTIME_DIR` when set (a per-user tmpfs on
/// Linux), else the temp dir. Both are short enough for socket paths.
fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(std::env::temp_dir)
}

/// The running ssh-agent of one socket.
struct SshAgentServer {
    /// Dropped (removing the files) as soon as the socket stops accepting.
    dir: Option<SshAgentDir>,
    /// Dropped as soon as the socket stops accepting.
    listener: Option<UnixListener>,
    /// The key it signs with.
    key: Arc<SshPrivateKey>,
    /// The only process allowed to connect, where the platform reports peer pids.
    peer_pid: Option<u32>,
    /// Whether a signature was handed out, which ends the socket.
    signed: bool,
}

/// Why one connection's serving loop ended.
enum ConnectionEnd {
    /// The peer closed the connection or broke the protocol.
    Closed,
    /// The guard was dropped or the lifetime ran out.
    Stopped,
}

impl SshAgentServer {
    /// Accepts the first permitted connection and serves it, then ends; stops early when
    /// the guard is dropped or the lifetime runs out.
    async fn run(mut self, stop: Arc<Notify>) {
        let deadline = tokio::time::sleep(SSH_AGENT_LIFETIME);
        tokio::pin!(deadline);
        loop {
            let Some(listener) = &self.listener else {
                return;
            };
            let stream = tokio::select! {
                _ = stop.notified() => return,
                _ = &mut deadline => return,
                accepted = listener.accept() => accepted,
            };
            match stream {
                Ok((stream, _)) if self.permits(&stream) => {
                    // `ssh` opens one ssh-agent connection per authentication, so once it
                    // is done nothing else may use the socket.
                    let served = self.serve_connection(stream, &stop, deadline.as_mut());
                    let _ = served.await;
                    return;
                }
                Ok(_) => {}
                Err(error) => {
                    redoor_core::log_failure!(
                        Level::Warn,
                        "The in-process ssh-agent stopped accepting connections: error={}",
                        error
                    );
                    return;
                }
            }
        }
    }

    /// Whether the connecting process runs as this server's user and, where the platform
    /// reports it, is the `ssh` process the socket was made for.
    fn permits(&self, stream: &UnixStream) -> bool {
        let Ok(credentials) = stream.peer_cred() else {
            log!(
                Level::Warning,
                "Refused an ssh-agent connection whose peer could not be identified"
            );
            return false;
        };
        let own_uid = nix::unistd::getuid().as_raw();
        let pid_matches = match (self.peer_pid, credentials.pid()) {
            (Some(expected), Some(actual)) => i64::from(expected) == i64::from(actual),
            _ => true,
        };
        if credentials.uid() != own_uid || !pid_matches {
            log!(
                Level::Warning,
                "Refused an ssh-agent connection from another process: uid={}, pid={:?}, expected_pid={:?}",
                credentials.uid(),
                credentials.pid(),
                self.peer_pid
            );
            return false;
        }
        true
    }

    /// Answers requests on one connection until the peer closes it or the ssh-agent stops.
    async fn serve_connection(
        &mut self,
        mut stream: UnixStream,
        stop: &Notify,
        mut deadline: std::pin::Pin<&mut tokio::time::Sleep>,
    ) -> ConnectionEnd {
        loop {
            let request = tokio::select! {
                _ = stop.notified() => return ConnectionEnd::Stopped,
                _ = &mut deadline => return ConnectionEnd::Stopped,
                request = read_message(&mut stream) => request,
            };
            let Ok(Some(request)) = request else {
                return ConnectionEnd::Closed;
            };
            let response = self.respond(&request);
            if write_message(&mut stream, &response).await.is_err() {
                return ConnectionEnd::Closed;
            }
            if self.signed && self.listener.is_some() {
                // Authentication is done; nothing may connect again.
                self.listener = None;
                self.dir = None;
            }
        }
    }

    /// The response to one request.
    fn respond(&mut self, request: &[u8]) -> Vec<u8> {
        let mut reader = request;
        match u8::decode(&mut reader) {
            Ok(SSH_AGENTC_REQUEST_IDENTITIES) => self.identities(),
            Ok(SSH_AGENTC_SIGN_REQUEST) => {
                self.sign(reader).unwrap_or_else(|| vec![SSH_AGENT_FAILURE])
            }
            _ => vec![SSH_AGENT_FAILURE],
        }
    }

    /// `SSH_AGENT_IDENTITIES_ANSWER` with the one key.
    fn identities(&self) -> Vec<u8> {
        let mut response = vec![SSH_AGENT_IDENTITIES_ANSWER];
        let encoded = (|| -> Result<(), ssh_encoding::Error> {
            1u32.encode(&mut response)?;
            self.key_blob()?.encode(&mut response)?;
            "redoor managed key".encode(&mut response)
        })();
        match encoded {
            Ok(()) => response,
            Err(_) => vec![SSH_AGENT_FAILURE],
        }
    }

    /// `SSH_AGENT_SIGN_RESPONSE` for a request naming this key, or `None` for anything
    /// else (another key, malformed fields, a failed signature).
    fn sign(&mut self, mut body: &[u8]) -> Option<Vec<u8>> {
        let blob = Vec::<u8>::decode(&mut body).ok()?;
        let data = Vec::<u8>::decode(&mut body).ok()?;
        // Flags only select RSA hash variants; ed25519 has one signature form.
        let _flags = u32::decode(&mut body).ok()?;
        if blob != self.key_blob().ok()? {
            log!(
                Level::Warning,
                "The in-process ssh-agent refused to sign for a key it does not hold"
            );
            return None;
        }
        let signature = self.key.sign(&data).ok()?;
        let mut encoded_signature = Vec::new();
        signature.encode(&mut encoded_signature).ok()?;
        let mut response = vec![SSH_AGENT_SIGN_RESPONSE];
        encoded_signature.encode(&mut response).ok()?;
        self.signed = true;
        log!(
            Level::Debug,
            "The in-process ssh-agent signed an authentication request: fingerprint={}",
            self.key.fingerprint()
        );
        Some(response)
    }

    /// The key's public key blob, the form ssh-agent messages name keys by.
    fn key_blob(&self) -> Result<Vec<u8>, ssh_encoding::Error> {
        let mut blob = Vec::new();
        self.key.public_key().key_data().encode(&mut blob)?;
        Ok(blob)
    }
}

/// Reads one length-prefixed message; `None` at a clean end of the connection. An empty or
/// oversized message is an error, so the connection is closed.
async fn read_message(stream: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>> {
    let length = match stream.read_u32().await {
        Ok(length) => length,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    };
    if length == 0 || length > MAX_SSH_AGENT_MESSAGE_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("ssh-agent message of {length} bytes"),
        ));
    }
    let mut message = vec![0u8; length as usize];
    stream.read_exact(&mut message).await?;
    Ok(Some(message))
}

/// Writes one length-prefixed message.
async fn write_message(stream: &mut UnixStream, message: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(message.len()).map_err(std::io::Error::other)?;
    stream.write_u32(length).await?;
    stream.write_all(message).await?;
    stream.flush().await
}

impl SshAgentSocket {
    /// The directory of the socket, for tests that check it is removed.
    #[cfg(test)]
    fn dir_path(&self) -> PathBuf {
        self.dir.path.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tokio::process::Command;

    /// Waits until a path is gone, polling the file system instead of sleeping a guess.
    async fn wait_until_removed(path: &Path) {
        for _ in 0..500 {
            if tokio::fs::symlink_metadata(path).await.is_err() {
                return;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{} was not removed", path.display());
    }

    /// A raw ssh-agent client in this process, for the protocol edge cases.
    async fn connect(socket: &Path) -> UnixStream {
        UnixStream::connect(socket).await.unwrap()
    }

    /// Sends one request and reads its response; `None` when the ssh-agent closed the
    /// connection instead of answering.
    async fn round_trip(stream: &mut UnixStream, request: &[u8]) -> Option<Vec<u8>> {
        write_message(stream, request).await.ok()?;
        read_message(stream).await.ok().flatten()
    }

    /// `ssh-add -L`, the stock OpenSSH client, lists exactly the one key.
    #[tokio::test]
    async fn ssh_add_lists_exactly_the_one_key() {
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        let socket = SshAgentSocket::bind(key.clone()).await.unwrap();
        let socket_path = socket.socket_path();
        let child = Command::new("ssh-add")
            .arg("-L")
            .env("SSH_AUTH_SOCK", &socket_path)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let _guard = socket.serve(child.id());
        let output = child.wait_with_output().await.unwrap();
        // ssh-add talked to the in-process ssh-agent successfully.
        assert!(output.status.success(), "{output:?}");
        let listed = String::from_utf8(output.stdout).unwrap();
        let lines: Vec<&str> = listed.lines().collect();
        // Exactly one identity is offered ...
        assert_eq!(lines.len(), 1, "{listed}");
        // ... and it is the managed key.
        assert!(lines[0].starts_with(&key.public_key_openssh()), "{listed}");
    }

    /// `ssh-keygen -Y sign` with only the public key file gets its signature from the
    /// in-process ssh-agent, and the signature verifies against the key.
    #[tokio::test]
    async fn ssh_keygen_signs_through_the_ssh_agent() {
        let home = redoor_core::test_support::TempDir::create();
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        let socket = SshAgentSocket::bind(key.clone()).await.unwrap();
        let message = home.path().join("message");
        tokio::fs::write(&message, "redoor").await.unwrap();
        let child = Command::new("ssh-keygen")
            .args(["-Y", "sign", "-n", "redoor-test", "-f"])
            .arg(socket.public_key_path())
            .arg(&message)
            .env("SSH_AUTH_SOCK", socket.socket_path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let _guard = socket.serve(child.id());
        let output = child.wait_with_output().await.unwrap();
        // The signature was produced without any private key file.
        assert!(output.status.success(), "{output:?}");

        let allowed = home.path().join("allowed_signers");
        tokio::fs::write(&allowed, format!("signer {}\n", key.public_key_openssh()))
            .await
            .unwrap();
        let verify = Command::new("ssh-keygen")
            .args(["-Y", "verify", "-n", "redoor-test", "-I", "signer", "-f"])
            .arg(&allowed)
            .arg("-s")
            .arg(home.path().join("message.sig"))
            .stdin(std::fs::File::open(&message).unwrap())
            .output()
            .await
            .unwrap();
        // The signature is a valid signature of the managed key.
        assert!(verify.status.success(), "{verify:?}");
    }

    /// Unknown messages and sign requests for a foreign key get `FAILURE`, a signature ends
    /// the socket, and an oversized message closes the connection.
    #[tokio::test]
    async fn unknown_requests_and_foreign_keys_fail() {
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        let socket = SshAgentSocket::bind(key.clone()).await.unwrap();
        let socket_path = socket.socket_path();
        let dir = socket.dir_path();
        let _guard = socket.serve(Some(std::process::id()));
        let mut stream = connect(&socket_path).await;

        // An extension request, such as session-bind, is refused.
        let mut extension = vec![27u8];
        "session-bind@openssh.com".encode(&mut extension).unwrap();
        assert_eq!(
            round_trip(&mut stream, &extension).await,
            Some(vec![SSH_AGENT_FAILURE])
        );

        // A sign request for another key is refused.
        let other = SshPrivateKey::generate().unwrap();
        let mut other_blob = Vec::new();
        other
            .public_key()
            .key_data()
            .encode(&mut other_blob)
            .unwrap();
        let mut foreign = vec![SSH_AGENTC_SIGN_REQUEST];
        other_blob.encode(&mut foreign).unwrap();
        b"data".to_vec().encode(&mut foreign).unwrap();
        0u32.encode(&mut foreign).unwrap();
        assert_eq!(
            round_trip(&mut stream, &foreign).await,
            Some(vec![SSH_AGENT_FAILURE])
        );

        // A sign request for the key itself is answered with a signature.
        let mut own_blob = Vec::new();
        key.public_key().key_data().encode(&mut own_blob).unwrap();
        let mut own = vec![SSH_AGENTC_SIGN_REQUEST];
        own_blob.encode(&mut own).unwrap();
        b"data".to_vec().encode(&mut own).unwrap();
        0u32.encode(&mut own).unwrap();
        let response = round_trip(&mut stream, &own).await.unwrap();
        assert_eq!(response[0], SSH_AGENT_SIGN_RESPONSE);
        // After the first signature nothing can connect any more: the socket is gone.
        wait_until_removed(&dir).await;

        // An oversized message closes the connection instead of being buffered.
        stream
            .write_u32(MAX_SSH_AGENT_MESSAGE_LEN + 1)
            .await
            .unwrap();
        assert!(read_message(&mut stream).await.unwrap_or(None).is_none());
    }

    /// A connection from a process other than the expected `ssh` is refused, and dropping
    /// the guard of an exited `ssh` removes the socket.
    #[tokio::test]
    async fn other_processes_cannot_connect_and_the_guard_removes_the_socket() {
        let key = Arc::new(SshPrivateKey::generate().unwrap());
        let socket = SshAgentSocket::bind(key).await.unwrap();
        let socket_path = socket.socket_path();
        let dir = socket.dir_path();
        // Expect a pid that is certainly not this test process.
        let guard = socket.serve(Some(std::process::id().wrapping_add(1)));
        let mut stream = connect(&socket_path).await;
        // The connection is closed without an answer, so no identity leaks to it.
        assert_eq!(
            round_trip(&mut stream, &[SSH_AGENTC_REQUEST_IDENTITIES]).await,
            None
        );
        drop(guard);
        // Dropping the guard ends the ssh-agent and removes its directory.
        wait_until_removed(&dir).await;
    }
}
