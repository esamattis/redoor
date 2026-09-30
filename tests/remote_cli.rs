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
    connected_inventory().await.into_response()
}

/// Supplies a live unmanaged agent so admission tests bypass managed startup without skipping inventory.
async fn connected_inventory() -> Json<serde_json::Value> {
    Json(serde_json::json!({"agents": [{
        "id": "a", "name": "a", "cwd": null, "managed": false,
        "configuration_editable": false, "ssh_target": null, "status": "connected",
        "connected_at": null, "connection_id": null, "last_seen_at": null,
        "connection_issue": null, "provisioning_status": [], "binary": null,
        "supports_self_exec": false, "supports_native_open": false,
        "supports_move_to_trash": false, "supports_trash": false,
        "uid": null, "is_root": false
    }]}))
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
        .route("/api/v1/agents/{agent}/start", post(lifecycle_fixture))
        .route("/api/v1/agents/{agent}/shutdown", post(lifecycle_fixture))
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
        connected_inventory().await.0,
        "JSON must preserve the complete inventory snapshot"
    );
    let output = cli(root.path(), &["remote", "agents", "--app-name", "isolated"]).await;
    // Global namespace flags must work after subcommands as well as before them.
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("connected")
    );
    for (command, expected_status) in [("start", "starting"), ("stop", "stopped")] {
        let output = cli(
            root.path(),
            &[
                "--app-name",
                "isolated",
                "remote",
                command,
                "ssh agent?#",
                "--json",
            ],
        )
        .await;
        // Authenticated POSTs must retain special characters as one ID and expose the full snapshot.
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["agent"]["id"], "ssh agent?#");
        assert_eq!(response["agent"]["status"], expected_status);
        assert_eq!(response["agent"]["ssh_target"], "user@host");
        let output = cli(
            root.path(),
            &["--app-name", "isolated", "remote", command, "ssh agent?#"],
        )
        .await;
        // Human output reports actual state instead of claiming an asynchronous start connected.
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            format!("ssh agent?#: {expected_status}")
        );
        for (id, error) in [
            ("missing", "Agent not found"),
            ("external", "Agent is external"),
        ] {
            let output = cli(
                root.path(),
                &["--app-name", "isolated", "remote", command, id],
            )
            .await;
            // Lifecycle failures must remain failures, with no successful snapshot on stdout.
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(String::from_utf8_lossy(&output.stderr).contains(error));
        }
        let output = cli(root.path(), &["remote", command, "ssh agent?#"]).await;
        // Lifecycle control shares the same namespace authentication boundary as inventory.
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("remote login"));
    }
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
            && help.contains("start")
            && help.contains("stop")
            && help.contains("exec"),
        "Remote help must document the implemented login, inventory and copy commands"
    );
    server.abort();
}

/// Mirrors lifecycle acceptance while checking real HTTP method, authentication, and encoded IDs.
async fn lifecycle_fixture(
    headers: HeaderMap,
    axum::extract::Path(agent): axum::extract::Path<String>,
    uri: axum::http::Uri,
) -> axum::response::Response {
    if headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        != Some("redoor_session=cli-session")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if agent != "ssh agent?#" {
        let (status, error) = if agent == "external" {
            (
                StatusCode::CONFLICT,
                "Agent is external and cannot be managed",
            )
        } else {
            (StatusCode::NOT_FOUND, "Agent not found")
        };
        return (status, Json(serde_json::json!({"error": error}))).into_response();
    }
    let status = if uri.path().ends_with("/start") {
        "starting"
    } else {
        "stopped"
    };
    Json(serde_json::json!({"agent": {
        "id": agent, "name": "SSH agent", "cwd": null, "managed": true,
        "configuration_editable": true, "ssh_target": "user@host", "status": status,
        "connected_at": null, "connection_id": null, "last_seen_at": null,
        "connection_issue": null, "provisioning_status": [], "binary": null,
        "supports_self_exec": false, "supports_native_open": false,
        "supports_move_to_trash": false, "supports_trash": false
    }}))
    .into_response()
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
        .route("/api/v1/agents", get(connected_inventory))
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
        .route("/api/v1/agents", get(connected_inventory))
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

/// Drives inventory changes by observed requests so startup tests never depend on scheduler delays.
#[derive(Default)]
struct StartupFixture {
    mode: &'static str,
    polls: std::sync::atomic::AtomicUsize,
    starts: std::sync::atomic::AtomicUsize,
    executions: std::sync::atomic::AtomicUsize,
}

impl StartupFixture {
    /// Retains the same provisioning line across polls to exercise progress deduplication.
    async fn snapshot(&self, initial: bool) -> serde_json::Value {
        use std::sync::atomic::Ordering;
        let mut agent = connected_inventory().await.0["agents"][0].clone();
        agent["managed"] = serde_json::json!(true);
        agent["ssh_target"] = serde_json::json!("user@host");
        let status = if initial {
            if self.mode == "already-starting" {
                "starting"
            } else {
                "stopped"
            }
        } else if self.polls.load(Ordering::SeqCst) < 3 {
            "starting"
        } else {
            match self.mode {
                "failure" => "disconnected",
                "shutdown" => "stopped",
                _ => "connected",
            }
        };
        agent["status"] = serde_json::json!(status);
        if !initial {
            agent["provisioning_status"] =
                serde_json::json!([{"at": 1, "message": "Uploading SSH binary"}]);
        }
        if status == "disconnected" {
            agent["connection_issue"] = serde_json::json!("SSH authentication failed");
        }
        agent
    }
}

/// A polling inventory lets the CLI observe provisioning before either registration or failure.
async fn startup_inventory(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<StartupFixture>>,
) -> Json<serde_json::Value> {
    let initial = state
        .polls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        == 0;
    Json(serde_json::json!({"agents": [state.snapshot(initial).await]}))
}

/// Only POST can accept startup; refusing admission must never reach the user command.
async fn startup_start(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<StartupFixture>>,
) -> axum::response::Response {
    state
        .starts
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if state.mode == "refused" {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Supervisor unavailable"})),
        )
            .into_response();
    }
    Json(serde_json::json!({"agent": state.snapshot(false).await})).into_response()
}

/// Counts admission so a failed startup cannot be disguised by an independently successful exec fixture.
async fn startup_exec(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<StartupFixture>>,
) -> &'static str {
    state
        .executions
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    "{\"type\":\"exit\",\"code\":0,\"signal\":null}
"
}

/// Capturing the real CLI pipes proves startup logs never corrupt JSON and failure blocks admission.
#[tokio::test]
async fn remote_exec_waits_for_managed_startup_and_reports_progress_and_failures() {
    use std::sync::atomic::Ordering;
    for mode in [
        "stopped",
        "already-starting",
        "failure",
        "shutdown",
        "refused",
    ] {
        let root = test_support::TempDir::create();
        let state = std::sync::Arc::new(StartupFixture {
            mode,
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/prefix/",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let app = Router::new()
            .route("/prefix/api/v1/agents", get(startup_inventory))
            .route("/prefix/api/v1/agents/a/start", post(startup_start))
            .route("/prefix/api/v1/agents/a/exec", post(startup_exec))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut jar = CookieStore::default();
        jar.parse("redoor_session=startup; Path=/prefix; Max-Age=3600", &url)
            .unwrap();
        let directory = root.path().join(".local/share/redoor");
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let session = directory.join("remote-session.json");
        tokio::fs::write(
            &session,
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "generation": uuid::Uuid::new_v4(), "server_url": url.as_str(),
                "cookies": jar.iter_any().collect::<Vec<_>>()
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::set_permissions(&session, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        let output = cli(
            root.path(),
            &["remote", "exec", "--json", "a", "--", "true"],
        )
        .await;
        let stderr = String::from_utf8(output.stderr).unwrap();
        let event: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let success = matches!(mode, "stopped" | "already-starting");
        // API acceptance is insufficient: the CLI must poll inventory before admitting execution.
        assert_eq!(
            output.status.code(),
            Some(if success { 0 } else { 125 }),
            "{mode}: {stderr}"
        );
        assert_eq!(
            state.executions.load(Ordering::SeqCst),
            usize::from(success)
        );
        assert_eq!(
            state.starts.load(Ordering::SeqCst),
            usize::from(mode != "already-starting")
        );
        assert!(stderr.contains("Agent a is not running"));
        // A retained provisioning step must appear once, even when returned by multiple polls.
        assert_eq!(
            stderr.matches("Uploading SSH binary").count(),
            usize::from(mode != "refused")
        );
        if success {
            assert_eq!(event["type"], "exit");
            assert!(stderr.contains("Agent a: connected"));
        } else {
            // Startup failure goes to stderr and preserves exec's structured stdout failure contract.
            assert_eq!(event["type"], "error");
            assert!(stderr.contains("Failed to start agent a"));
            assert!(stderr.contains(match mode {
                "failure" => "SSH authentication failed",
                "shutdown" => "was stopped during startup",
                _ => "Supervisor unavailable",
            }));
        }
        server.abort();
    }
}
