//! Verify real CLI dispatch, namespace selection, and stdout contracts across separate processes.

use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use cookie_store::CookieStore;
use std::{os::unix::fs::PermissionsExt, path::Path, process::Output};

#[path = "../src/test_support.rs"]
mod test_support;

/// Each CLI process gets an isolated HOME and explicit environment, avoiding global test races.
async fn cli(home: &Path, args: &[&str]) -> Output {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_redoor"))
        .args(args)
        .env("HOME", home)
        .env_remove("REDOOR_APP_NAME")
        .output()
        .await
        .unwrap()
}

/// The endpoint rejects missing cookies, proving the CLI really reads its saved authentication.
async fn agents(headers: HeaderMap) -> impl IntoResponse {
    if headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        != Some("redoor_session=cli-session")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(serde_json::json!({"agents": []})).into_response()
}

/// Existing logout is public but receives cookies when available.
async fn logout() -> impl IntoResponse {
    Json(serde_json::json!({"logged_out": true}))
}

/// Executing the binary proves output/exit behavior and root namespace flags beyond parser unit tests.
#[tokio::test]
async fn remote_cli_persistent_session_namespace_and_output() {
    let root = test_support::TempDir::create();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new()
        .route("/api/v1/agents", get(agents))
        .route("/api/v1/agents/a/exec", post(exec_fixture))
        .route("/api/v1/logout", post(logout));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut jar = CookieStore::default();
    jar.parse("redoor_session=cli-session; Path=/; Max-Age=3600", &url)
        .unwrap();
    let directory = root.path().join(".local/share/isolated");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let file = directory.join("remote-session.json");
    let payload = serde_json::json!({"version": 1, "generation": uuid::Uuid::new_v4(), "server_url": url.as_str(), "cookies": jar.iter_any().collect::<Vec<_>>()});
    tokio::fs::write(&file, serde_json::to_vec(&payload).unwrap())
        .await
        .unwrap();
    tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
        .await
        .unwrap();
    let output = cli(
        root.path(),
        &["--app-name", "isolated", "remote", "agents", "--json"],
    )
    .await;
    // JSON stdout must be directly parseable by scripts, without progress or login messages.
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "Successful agent listing must not emit diagnostics"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        serde_json::json!({"agents": []}),
        "JSON must preserve the API-shaped empty list"
    );
    let output = cli(root.path(), &["remote", "agents", "--app-name", "isolated"]).await;
    // Global namespace flags must work after subcommands as well as before them.
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "No agents available."
    );
    let output = cli(root.path(), &["remote", "agents"]).await;
    // A different namespace must not borrow credentials, even with the same HOME.
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("remote login"));
    let output = cli(
        root.path(),
        &["remote", "cp", "--json", "/missing", "agent:/missing"],
    )
    .await;
    // Copy scripts must receive the same terminal JSON shape even when no session can be loaded.
    assert!(!output.status.success());
    let failure: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(failure["status"], "failed");
    assert!(failure["error"].as_str().unwrap().contains("remote login"));
    let output = cli(
        root.path(),
        &["remote", "exec", "--json", "a", "--", "true"],
    )
    .await;
    // Execution failures before admission must retain the machine-readable event contract.
    assert_eq!(output.status.code(), Some(125));
    let event: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(event["type"], "error");
    assert!(event["message"].as_str().unwrap().contains("remote login"));
    let output = cli(
        root.path(),
        &[
            "--app-name",
            "isolated",
            "remote",
            "exec",
            "a",
            "--",
            "complete",
            "a b",
            "",
            "$HOME",
        ],
    )
    .await;
    // Successful HTTP transport must preserve a remote nonzero exit and independent local pipes.
    assert_eq!(output.status.code(), Some(23));
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");
    let output = cli(
        root.path(),
        &[
            "--app-name",
            "isolated",
            "remote",
            "exec",
            "--json",
            "a",
            "--",
            "truncated",
        ],
    )
    .await;
    // HTTP EOF without a terminal event cannot be interpreted as remote success, even with status 200.
    assert_eq!(output.status.code(), Some(125));
    let records: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.first().unwrap()["type"], "stdout");
    assert_eq!(records.last().unwrap()["type"], "error");
    assert!(
        records.last().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("without a terminal event")
    );
    let output = cli(root.path(), &["--app-name", "isolated", "remote", "logout"]).await;
    // Logout should have no stdout and delete the state used by the prior process.
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!tokio::fs::try_exists(&file).await.unwrap());
    let output = cli(root.path(), &["remote", "--help"]).await;
    assert!(
        output.status.success(),
        "The remote namespace must expose its command help"
    );
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(
        help.contains("login")
            && help.contains("logout")
            && help.contains("agents")
            && help.contains("cp")
            && help.contains("exec"),
        "Remote help must document the implemented login, inventory and copy commands"
    );
    server.abort();
}

/// Produces a valid HTTP stream or clean truncation to separate transport status from process status.
async fn exec_fixture(
    Json(request): Json<redoor::exec_protocol::ExecRequest>,
) -> axum::response::Response {
    use redoor::exec_protocol::ExecEvent;
    let mut events = vec![ExecEvent::Stdout {
        data: b"out".to_vec(),
    }];
    if request.argv[0] == "complete" {
        // The wire request must retain each argv boundary, including empty arguments and metacharacters.
        assert_eq!(request.argv, ["complete", "a b", "", "$HOME"]);
        events.push(ExecEvent::Stderr {
            data: b"err".to_vec(),
        });
        events.push(ExecEvent::Exit {
            code: Some(23),
            signal: None,
        });
    }
    let mut bytes = Vec::new();
    for event in events {
        bytes.extend(serde_json::to_vec(&event).unwrap());
        bytes.push(b'\n');
    }
    ([("Content-Type", "application/x-ndjson")], bytes).into_response()
}

/// Pauses admission so interruption cannot lose the id of a copy already accepted by the server.
#[derive(Clone, Default)]
struct CopyAdmission {
    started: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Notify>,
    canceled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// The source exists while the resulting destination is absent, matching exact-path copy semantics.
async fn copy_metadata(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> axum::response::Response {
    if path == "destination" {
        return StatusCode::NOT_FOUND.into_response();
    }
    Json(serde_json::json!({"path": "/source", "mime_type": "application/octet-stream", "file_size": 1, "is_file": true, "is_dir": false, "editable": false, "viewable_image": false, "one_time_tokens": []})).into_response()
}

/// An accepted request remains alive long enough to observe a real process signal before its id arrives.
async fn admit_copy(
    axum::extract::State(state): axum::extract::State<CopyAdmission>,
) -> impl IntoResponse {
    state.started.notify_one();
    state.release.notified().await;
    Json(serde_json::json!({"copy_request_id": 42}))
}

/// Records that the CLI canceled precisely the admitted transfer, never another client's copy.
async fn cancel_copy(
    axum::extract::State(state): axum::extract::State<CopyAdmission>,
) -> impl IntoResponse {
    state
        .canceled
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Json(serde_json::json!({"transfer_id": 42, "status": "accepted"}))
}

/// A short accepted-but-unanswered POST must not orphan server-side work when Ctrl-C arrives.
#[tokio::test]
async fn remote_cp_interruption_during_admission_recovers_id_and_cancels() {
    let root = test_support::TempDir::create();
    let state = CopyAdmission::default();
    let app = Router::new()
        .route("/api/v1/agents/a/metadata/{*path}", get(copy_metadata))
        .route("/api/v1/copy", post(admit_copy))
        .route(
            "/api/v1/transfers/progress",
            get(|| async { std::future::pending::<Json<serde_json::Value>>().await }),
        )
        .route("/api/v1/transfers/42", axum::routing::delete(cancel_copy))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut jar = CookieStore::default();
    jar.parse("redoor_session=copy-test; Path=/; Max-Age=3600", &url)
        .unwrap();
    let directory = root.path().join(".local/share/redoor");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let session = directory.join("remote-session.json");
    tokio::fs::write(&session, serde_json::to_vec(&serde_json::json!({"version": 1, "generation": uuid::Uuid::new_v4(), "server_url": url.as_str(), "cookies": jar.iter_any().collect::<Vec<_>>()})).unwrap()).await.unwrap();
    tokio::fs::set_permissions(&session, std::fs::Permissions::from_mode(0o600))
        .await
        .unwrap();
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_redoor"))
        .args(["remote", "cp", "--json", "a:/source", "a:/destination"])
        .env("HOME", root.path())
        .env_remove("REDOOR_APP_NAME")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), state.started.notified())
        .await
        .unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    state.release.notify_one();
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    // JSON and exit status prove the CLI handled the signal rather than dying in the default handler.
    assert_eq!(output.status.code(), Some(1));
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["error"].as_str().unwrap().contains("interrupted"));
    // Cancellation after the delayed response proves admission ownership survived the dropped operation.
    assert!(state.canceled.load(std::sync::atomic::Ordering::SeqCst));
    server.abort();
}

/// Models response ownership so a signal before headers must still release accepted remote work.
struct ExecBodyOwner(std::sync::Arc<tokio::sync::Notify>);

/// Separates admission gating from body-drop observation so the test cannot consume its own signal.
#[derive(Clone, Default)]
struct ExecAdmission {
    started: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Notify>,
    dropped: std::sync::Arc<tokio::sync::Notify>,
}

impl Drop for ExecBodyOwner {
    /// Dropping an admitted response mirrors the server's execution cancellation guard.
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

/// Delays admission headers while retaining the execution owner inside an unpolled HTTP body.
async fn admit_exec(
    axum::extract::State(state): axum::extract::State<ExecAdmission>,
) -> axum::response::Response {
    let owner = ExecBodyOwner(state.dropped.clone());
    state.started.notify_one();
    state.release.notified().await;
    let stream = async_stream::stream! {
        let _owner = owner;
        std::future::pending::<()>().await;
        yield Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::new());
    };
    axum::response::Response::new(axum::body::Body::from_stream(stream))
}

/// Unlike detached copy jobs, exec admission owns its response and cancels even before headers arrive.
#[tokio::test]
async fn remote_exec_interruption_during_admission_drops_owned_response() {
    let root = test_support::TempDir::create();
    let state = ExecAdmission::default();
    let app = Router::new()
        .route("/api/v1/agents/a/exec", post(admit_exec))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut jar = CookieStore::default();
    jar.parse("redoor_session=exec-test; Path=/; Max-Age=3600", &url)
        .unwrap();
    let directory = root.path().join(".local/share/redoor");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let session = directory.join("remote-session.json");
    tokio::fs::write(&session, serde_json::to_vec(&serde_json::json!({"version": 1, "generation": uuid::Uuid::new_v4(), "server_url": url.as_str(), "cookies": jar.iter_any().collect::<Vec<_>>()})).unwrap()).await.unwrap();
    tokio::fs::set_permissions(&session, std::fs::Permissions::from_mode(0o600))
        .await
        .unwrap();
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_redoor"))
        .args(["remote", "exec", "--json", "a", "--", "true"])
        .env("HOME", root.path())
        .env_remove("REDOOR_APP_NAME")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), state.started.notified())
        .await
        .unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    // Receiving canceled JSON before admission is released proves the CLI did not wait indefinitely for headers.
    assert_eq!(output.status.code(), Some(130));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["type"],
        "canceled"
    );
    state.release.notify_one();
    // The body may never be polled, but ownership must still be dropped after the disconnected response is built.
    tokio::time::timeout(std::time::Duration::from_secs(5), state.dropped.notified())
        .await
        .unwrap();
    server.abort();
}
