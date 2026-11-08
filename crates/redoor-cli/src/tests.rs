//! Exercise token authentication and the browser login flow over real HTTP and durable
//! state, rather than mocking client internals.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{delete, get, post},
};
use clap::Parser;
use redoor_protocol::api::{
    agents::AgentListResponse,
    cli_logins::{CliTokenDefaults, StartCliLoginResponse, TokenLifetime},
    tokens::{DeviceScope, Permission},
};
use reqwest::Method;
use std::{
    collections::VecDeque,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

use super::{
    client::RemoteClient,
    credentials::{CredentialStore, Credentials, LOGIN_REQUIRED, insecure_tls_from_environment},
    format_agents,
    login::{BrowserLogin, TokenRequestArgs},
};

/// The bearer value the mock server accepts.
const TOKEN: &str = "test-token";

/// Owns a mock API and filesystem root so tests cannot share credentials or sockets.
struct Fixture {
    root: redoor_core::test_support::TempDir,
    store: CredentialStore,
    url: String,
    revocations: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    /// Starts the mock under a path prefix, like a reverse-proxied deployment.
    async fn new() -> Self {
        let root = redoor_core::test_support::TempDir::create();
        let store = CredentialStore::new(root.path().join("namespace"));
        let revocations = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/prefix/api/v1/agents", get(agents))
            .route("/prefix/api/v1/tokens/current", delete(revoke))
            .route("/prefix/failure", get(failure))
            .route("/prefix/permission", get(permission))
            .route("/prefix/redirect", get(redirect))
            .route("/prefix/stream", get(stream))
            .with_state(revocations.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/prefix", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            root,
            store,
            url,
            revocations,
            task,
        }
    }

    /// Saves credentials the way `login` does.
    async fn authenticate(&self, token: &str) {
        self.store
            .save(&Credentials {
                version: 1,
                server_url: self.url.clone(),
                token: token.to_owned(),
                token_id: Uuid::new_v4(),
                insecure_tls: false,
            })
            .await
            .unwrap();
    }

    /// Path of the saved credentials file.
    fn credentials_path(&self) -> std::path::PathBuf {
        self.root.path().join("namespace/remote-credentials.json")
    }
}

impl Drop for Fixture {
    /// Aborting the listener avoids leaked servers even if an assertion panics.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Whether the request carries the accepted bearer token.
fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some("Bearer test-token")
}

/// Rejects anything but the bearer token, proving the client really sends it.
async fn agents(headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(serde_json::json!({"agents": []})).into_response()
}

/// Counts self-revocations so logout can be verified server-side.
async fn revoke(
    State(revocations): State<Arc<AtomicUsize>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    revocations.fetch_add(1, Ordering::SeqCst);
    Json(serde_json::json!({"deleted": true})).into_response()
}

/// A normal API failure must not be mistaken for an empty agent list or authentication failure.
async fn failure() -> impl IntoResponse {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": "inventory unavailable"})),
    )
}

/// A missing token permission is a 403 with the server's explanation.
async fn permission() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({"error": "Token lacks commands:execute on device a"})),
    )
}

/// Following even same-origin redirects could hide a login page behind a successful HTTP status.
async fn redirect() -> impl IntoResponse {
    (
        StatusCode::FOUND,
        [(header::LOCATION, "/prefix/api/v1/agents")],
    )
}

/// A body that never finishes models long downloads without timers or large buffers.
async fn stream() -> impl IntoResponse {
    axum::body::Body::from_stream(futures_util::stream::pending::<
        Result<bytes::Bytes, std::io::Error>,
    >())
}

/// A long download must not hold anything that blocks independent control requests.
#[tokio::test]
async fn unfinished_stream_does_not_block_control_requests() {
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    let client = RemoteClient::load(&fixture.store).await.unwrap();
    let _stream = client
        .send(client.request(Method::GET, "stream").unwrap())
        .await
        .unwrap();
    let list: AgentListResponse = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.get_json("api/v1/agents"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        list.agents.is_empty(),
        "Control requests must complete while a separate response body remains open"
    );
}

/// Authentication, permission and server failures each produce their own guidance.
#[tokio::test]
async fn api_errors_are_distinct_from_authentication_failures() {
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    let client = RemoteClient::load(&fixture.store).await.unwrap();
    let error = client
        .send(client.request(Method::GET, "failure").unwrap())
        .await
        .unwrap_err();
    // Normal API errors retain useful server context instead of claiming credentials expired.
    assert!(
        error
            .to_string()
            .contains("500 Internal Server Error: inventory unavailable")
    );
    let error = client
        .send(client.request(Method::GET, "redirect").unwrap())
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("302 Found"),
        "API redirects must not silently reach another endpoint"
    );
    let error = client
        .send(client.request(Method::GET, "permission").unwrap())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("403 Forbidden: Token lacks commands:execute"),
        "A missing permission must name it instead of asking for a new login"
    );
    fixture.authenticate("wrong-token").await;
    let client = RemoteClient::load(&fixture.store).await.unwrap();
    let error = client
        .get_json::<AgentListResponse>("api/v1/agents")
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        LOGIN_REQUIRED,
        "A rejected token must tell users how to recover"
    );
}

/// Logout revokes the token server-side and always removes it locally.
#[tokio::test]
async fn logout_revokes_and_forgets_the_token() {
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    super::status::logout(fixture.store.clone()).await.unwrap();
    assert_eq!(
        fixture.revocations.load(Ordering::SeqCst),
        1,
        "Logout must revoke the token on the server"
    );
    assert!(
        fixture.store.load().await.unwrap().is_none(),
        "Logout must remove the local credentials"
    );
    // Logging out twice is harmless.
    super::status::logout(fixture.store.clone()).await.unwrap();
}

/// Local logout must remain useful when the selected server cannot revoke the token.
#[tokio::test]
async fn offline_logout_removes_local_credentials() {
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    fixture.task.abort();
    // Waiting for the aborted listener ensures the test never races a still-running server.
    while !fixture.task.is_finished() {
        tokio::task::yield_now().await;
    }
    let error = super::status::logout(fixture.store.clone())
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("Local credentials removed"),
        "An unconfirmed revocation must be reported"
    );
    assert!(
        fixture.store.load().await.unwrap().is_none(),
        "Credentials must be removed even when the server is unreachable"
    );
}

/// Saved credentials round-trip and are written privately.
#[tokio::test]
async fn credentials_round_trip_privately() {
    let fixture = Fixture::new().await;
    // Nothing saved yet reads as "not logged in", not as an error.
    assert!(fixture.store.load().await.unwrap().is_none());
    fixture.authenticate(TOKEN).await;
    let loaded = fixture.store.load().await.unwrap().unwrap();
    // The saved token and server are exactly what login wrote.
    assert_eq!(loaded.token, TOKEN);
    assert_eq!(loaded.server_url, fixture.url);
    let mode = tokio::fs::metadata(fixture.credentials_path())
        .await
        .unwrap()
        .permissions()
        .mode();
    // Other local users cannot read the token.
    assert_eq!(mode & 0o777, 0o600);
    let directory_mode = tokio::fs::metadata(fixture.root.path().join("namespace"))
        .await
        .unwrap()
        .permissions()
        .mode();
    // Nor list or replace files in its directory.
    assert_eq!(directory_mode & 0o777, 0o700);
}

/// Unsafe files and symlinks are refused instead of trusted or followed.
#[tokio::test]
async fn unsafe_storage_is_rejected() {
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    let path = fixture.credentials_path();
    tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .await
        .unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "World-readable credentials must not be loaded"
    );
    tokio::fs::remove_file(&path).await.unwrap();
    let target = fixture.root.path().join("target");
    tokio::fs::write(&target, b"private external data")
        .await
        .unwrap();
    tokio::fs::symlink(&target, &path).await.unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "Credential symlinks must not be followed"
    );
    fixture.authenticate(TOKEN).await;
    assert_eq!(
        tokio::fs::read(&target).await.unwrap(),
        b"private external data",
        "Atomic replacement must not overwrite symlink targets"
    );
    let linked = CredentialStore::new(fixture.root.path().join("linked-namespace"));
    tokio::fs::symlink(
        fixture.root.path().join("namespace"),
        fixture.root.path().join("linked-namespace"),
    )
    .await
    .unwrap();
    assert!(
        linked.load().await.is_err(),
        "A symlinked credentials directory must be refused"
    );
}

/// The environment override needs both variables, so a half-set environment fails loudly.
#[test]
fn environment_override_requires_both_variables() {
    let both =
        Credentials::from_environment(Some("http://127.0.0.1:7666".into()), Some(TOKEN.into()))
            .unwrap()
            .unwrap();
    // Both set: the environment wins over any saved login.
    assert_eq!(both.token, TOKEN);
    // Neither set (or empty): fall back to the saved login.
    assert!(
        Credentials::from_environment(None, Some(String::new()))
            .unwrap()
            .is_none()
    );
    // Only one set is a configuration mistake.
    assert!(Credentials::from_environment(Some("http://x".into()), None).is_err());
    assert!(Credentials::from_environment(None, Some(TOKEN.into())).is_err());
}

/// `REDOOR_REMOTE_INSECURE_TLS` reads like clap's flag env values, so every command agrees.
#[test]
fn insecure_tls_environment_uses_flag_values() {
    // Unset and the usual "off" spellings keep certificate verification on.
    for off in [
        None,
        Some(""),
        Some("0"),
        Some("false"),
        Some("No"),
        Some("off"),
    ] {
        assert!(
            !insecure_tls_from_environment(off.map(str::to_owned)),
            "{off:?}"
        );
    }
    // Any other value turns it off, as `--insecure-tls` does.
    for on in ["1", "true", "yes", "TRUE"] {
        assert!(insecure_tls_from_environment(Some(on.to_owned())), "{on}");
    }
}

/// Logins saved before `insecure_tls` existed must keep loading, with verification on.
#[tokio::test]
async fn credentials_without_insecure_tls_load_with_verification() {
    let directory = redoor_core::test_support::TempDir::create();
    let store = CredentialStore::new(directory.path().to_path_buf());
    store
        .save(&Credentials {
            version: 1,
            server_url: "https://redoor.example".to_owned(),
            token: TOKEN.to_owned(),
            token_id: Uuid::new_v4(),
            insecure_tls: false,
        })
        .await
        .unwrap();
    let path = directory.path().join("remote-credentials.json");
    let mut saved: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    saved.as_object_mut().unwrap().remove("insecure_tls");
    tokio::fs::write(&path, serde_json::to_vec(&saved).unwrap())
        .await
        .unwrap();

    let loaded = store.load().await.unwrap().unwrap();
    // The missing field must default to verifying the server certificate.
    assert!(!loaded.insecure_tls);
}

/// URL validation prevents accidental credential disclosure and preserves reverse-proxy prefixes.
#[tokio::test]
async fn url_validation_and_request_origin_guard() {
    for invalid in [
        "ftp://example.com",
        "example.com",
        "https://user:secret@example.com",
        "https://example.com?key=secret",
        "https://example.com/#fragment",
    ] {
        assert!(
            RemoteClient::parse_server(invalid).is_err(),
            "Unsafe or ambiguous server URLs must fail: {invalid}"
        );
    }
    let fixture = Fixture::new().await;
    fixture.authenticate(TOKEN).await;
    let client = RemoteClient::load(&fixture.store).await.unwrap();
    assert!(
        client
            .endpoint("/api/v1/agents")
            .unwrap()
            .path()
            .starts_with("/prefix/"),
        "API paths must retain the deployment prefix"
    );
    assert!(
        client
            .request(Method::GET, "https://unrelated.com/")
            .is_err(),
        "Builders must not target an unrelated origin"
    );
    assert!(
        client.request(Method::GET, "../elsewhere").is_err(),
        "API paths must not escape the deployment prefix"
    );
    let external = reqwest::Client::new().get("http://127.0.0.1:1/");
    assert!(
        client
            .send(external)
            .await
            .unwrap_err()
            .to_string()
            .contains("selected server"),
        "Even externally constructed builders must be checked before sending"
    );
}

/// Formatting retains script-visible fields and makes IDs and connection state useful to humans.
#[test]
fn readable_and_json_agent_output() {
    let empty = AgentListResponse { agents: vec![] };
    assert_eq!(
        format_agents(&empty, false).unwrap(),
        "No devices available.",
        "Empty readable inventories should succeed"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&format_agents(&empty, true).unwrap()).unwrap(),
        serde_json::json!({"agents": []}),
        "Empty JSON must remain an API-shaped list"
    );
    let payload = serde_json::json!({"agents": [agent_json("agent-123", "Host With Spaces")]});
    let agents: AgentListResponse = serde_json::from_value(payload.clone()).unwrap();
    let readable = format_agents(&agents, false).unwrap();
    assert!(
        readable.contains("agent-123")
            && readable.contains("Host With Spaces")
            && readable.contains("connected"),
        "Readable output must expose identifiers, names and state"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&format_agents(&agents, true).unwrap()).unwrap(),
        payload,
        "JSON output must preserve the complete API response"
    );
}

/// A connected agent in the REST inventory shape.
fn agent_json(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": name, "cwd": null, "managed": false,
        "configuration_editable": false, "ssh_target": null, "status": "connected", "connected_at": null,
        "connection_id": null, "last_seen_at": null, "connection_issue": null, "provisioning_status": [], "last_failed_attempt": null,
        "binary": null, "supports_native_open": false,
        "supports_move_to_trash": false, "supports_trash": false,
        "supports_upload_preconditions": false, "uid": null, "is_root": false, "systemd": null,
        "duplicate_id": null
    })
}

/// Parses login flags exactly like the real command line.
#[derive(Parser)]
struct LoginCli {
    #[command(flatten)]
    args: TokenRequestArgs,
}

/// Builds login arguments from a flag list.
fn login_args(server: &str, flags: &[&str]) -> TokenRequestArgs {
    let mut argv = vec!["login", server];
    argv.extend_from_slice(flags);
    LoginCli::try_parse_from(argv).unwrap().args
}

/// The flags only prefill the browser form; without them the CLI suggests what it needs.
#[test]
fn flags_prefill_the_approval_form() {
    let defaults = login_args("http://127.0.0.1:7666", &[]).defaults("laptop");
    // Everything but files:delete, because only rm and mv need it.
    assert_eq!(
        defaults.permissions,
        vec![
            Permission::FilesRead,
            Permission::FilesWrite,
            Permission::CommandsExecute,
            Permission::AgentsManage
        ]
    );
    // All devices for 90 days, named after the machine that holds the token.
    assert_eq!(
        (defaults.devices, defaults.lifetime, defaults.name.as_str()),
        (
            DeviceScope::All,
            TokenLifetime::Days90,
            "redoor remote on laptop"
        )
    );
    let flagged = login_args(
        "http://127.0.0.1:7666",
        &[
            "--permissions",
            "files:read,agents:manage",
            "--devices",
            "a,b",
            "--name",
            "ci",
            "--expires",
            "never",
        ],
    )
    .defaults("laptop");
    // Every flag ends up in the request the browser form starts from.
    assert_eq!(
        flagged,
        CliTokenDefaults {
            name: "ci".into(),
            permissions: vec![Permission::FilesRead, Permission::AgentsManage],
            devices: DeviceScope::Only {
                device_ids: vec![
                    redoor_protocol::ids::AgentId::unchecked("a"),
                    redoor_protocol::ids::AgentId::unchecked("b")
                ]
            },
            lifetime: TokenLifetime::Never,
        }
    );
    // "all" expands to every permission.
    assert_eq!(
        login_args("http://127.0.0.1:7666", &["--permissions", "all"])
            .defaults("laptop")
            .permissions,
        Permission::ALL.to_vec()
    );
    // Unknown permission names are rejected rather than suggesting less than asked.
    assert!(
        LoginCli::try_parse_from(["login", "http://127.0.0.1:7666", "--permissions", "x:y"])
            .is_err()
    );
    // The password flags are gone: the browser does the signing in.
    assert!(
        LoginCli::try_parse_from(["login", "http://127.0.0.1:7666", "--password-stdin"]).is_err()
    );
}

/// What the mock CLI login server saw and still has to answer.
#[derive(Default)]
struct MockCliLogin {
    /// The body of the start request.
    started: Mutex<Option<serde_json::Value>>,
    /// The poll secrets the waits sent.
    polls: Mutex<Vec<String>>,
    /// Status and body of each wait, in order.
    answers: Mutex<VecDeque<(StatusCode, serde_json::Value)>>,
}

/// Starts a mock server for the CLI login routes behind a path prefix, answering the waits
/// with `answers`.
async fn cli_login_server(
    answers: Vec<(StatusCode, serde_json::Value)>,
) -> (String, Arc<MockCliLogin>, tokio::task::JoinHandle<()>) {
    let mock = Arc::new(MockCliLogin {
        answers: Mutex::new(answers.into()),
        ..MockCliLogin::default()
    });
    let app = Router::new()
        .route(
            "/prefix/api/v1/cli-logins",
            post(
                |State(mock): State<Arc<MockCliLogin>>, Json(body): Json<serde_json::Value>| async move {
                    *mock.started.lock().unwrap() = Some(body);
                    Json(serde_json::json!({
                        "id": "abc",
                        "poll_secret": "poll-secret",
                        "user_code": "BCDF-GHJK",
                        "approval_path": "/cli-login/abc",
                        "expires_in_seconds": 600
                    }))
                },
            ),
        )
        .route(
            "/prefix/api/v1/cli-logins/abc/wait",
            post(
                |State(mock): State<Arc<MockCliLogin>>, Json(body): Json<serde_json::Value>| async move {
                    mock.polls
                        .lock()
                        .unwrap()
                        .push(body["poll_secret"].as_str().unwrap_or_default().to_owned());
                    let (status, body) = mock
                        .answers
                        .lock()
                        .unwrap()
                        .pop_front()
                        .expect("the CLI polled after its final answer");
                    (status, Json(body))
                },
            ),
        )
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/prefix", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, mock, task)
}

/// The CLI keeps polling while the request is pending and returns the approved token.
#[tokio::test]
async fn browser_login_waits_for_the_approval() {
    let token = serde_json::json!({
        "status": "approved",
        "token": "redoor_at_new",
        "metadata": {
            "id": Uuid::new_v4().to_string(), "name": "n", "permissions": ["files:read"],
            "devices": {"kind": "all"}, "created_at": "2026-01-01T00:00:00Z",
            "expires_at": null, "last_used_at": null
        }
    });
    let (url, mock, task) = cli_login_server(vec![
        (StatusCode::OK, serde_json::json!({"status": "pending"})),
        (StatusCode::OK, token),
    ])
    .await;
    let login = BrowserLogin::new(&url, false).unwrap();
    let issued = login
        .issue(login_args(&url, &["--name", "ci"]).defaults("laptop"))
        .await
        .unwrap();
    task.abort();
    // The token from the approved answer is what the command saves or prints.
    assert_eq!(issued.token, "redoor_at_new");
    // A pending answer was followed by another poll, each with the request's secret.
    assert_eq!(
        *mock.polls.lock().unwrap(),
        vec!["poll-secret".to_owned(), "poll-secret".to_owned()]
    );
    let started = mock.started.lock().unwrap().clone().unwrap();
    // The approval page learns the machine and the suggested token.
    assert!(
        started["host_name"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
    );
    assert_eq!(started["token"]["name"], "ci");
    // The approval URL keeps the server's path prefix.
    assert_eq!(
        login
            .approval_url(&StartCliLoginResponse {
                id: "abc".into(),
                poll_secret: String::new(),
                user_code: String::new(),
                approval_path: "/cli-login/abc".into(),
                expires_in_seconds: 0,
            })
            .unwrap()
            .as_str(),
        format!("{url}/cli-login/abc")
    );
}

/// A denial and an expired request end the command with a message that says what to do.
#[tokio::test]
async fn denied_and_expired_logins_fail() {
    let (url, _, task) = cli_login_server(vec![(
        StatusCode::OK,
        serde_json::json!({"status": "denied"}),
    )])
    .await;
    let error = BrowserLogin::new(&url, false)
        .unwrap()
        .issue(login_args(&url, &[]).defaults("laptop"))
        .await
        .unwrap_err();
    task.abort();
    // The user turned it down in the browser.
    assert_eq!(error.to_string(), "The login was denied in the browser");

    let (url, _, task) = cli_login_server(vec![(
        StatusCode::NOT_FOUND,
        serde_json::json!({"error": "gone"}),
    )])
    .await;
    let error = BrowserLogin::new(&url, false)
        .unwrap()
        .issue(login_args(&url, &[]).defaults("laptop"))
        .await
        .unwrap_err();
    task.abort();
    // The request is gone after ten minutes, and the user needs a new one.
    assert!(
        error.to_string().contains("run the command again"),
        "{error}"
    );
}
