//! Exercise token authentication over real HTTP and durable state, and the login prompt flow
//! with scripted answers, rather than mocking client internals.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{delete, get},
};
use clap::Parser;
use redoor_protocol::api::{
    agents::{AgentInfoResponse, AgentListResponse},
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
    credentials::{CredentialStore, Credentials, LOGIN_REQUIRED},
    format_agents,
    login::{Expiry, LoginFlow, Prompter, TokenRequestArgs, TokenRequestPlan},
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
        "connection_id": null, "last_seen_at": null, "connection_issue": null, "provisioning_status": [],
        "binary": null, "supports_native_open": false,
        "supports_move_to_trash": false, "supports_trash": false,
        "supports_upload_preconditions": false, "uid": null, "is_root": false,
        "duplicate_id": null
    })
}

/// Two agents for the device prompt.
fn inventory() -> Vec<AgentInfoResponse> {
    ["a", "b"]
        .into_iter()
        .map(|id| serde_json::from_value(agent_json(id, &format!("Agent {id}"))).unwrap())
        .collect()
}

/// One scripted answer; `Default` accepts whatever the prompt preselected.
enum Answer {
    Default,
    Indexes(Vec<usize>),
    Index(usize),
}

/// What a prompt showed, so tests can check defaults and ordering.
#[derive(Clone, Debug, PartialEq)]
struct Asked {
    prompt: String,
    defaults: Vec<bool>,
    default_index: Option<usize>,
    default_text: Option<String>,
}

/// Answers prompts from a script and records what was asked.
struct ScriptedPrompter {
    answers: Mutex<VecDeque<Answer>>,
    asked: Arc<Mutex<Vec<Asked>>>,
}

impl ScriptedPrompter {
    /// Returns the prompter and a handle to inspect the prompts afterwards.
    fn new(answers: Vec<Answer>) -> (Self, Arc<Mutex<Vec<Asked>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                answers: Mutex::new(answers.into()),
                asked: asked.clone(),
            },
            asked,
        )
    }

    /// Records one prompt and takes the next answer; running out is a test bug.
    fn next(&self, asked: Asked) -> Answer {
        self.asked.lock().unwrap().push(asked);
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("the flow asked more questions than the script answers")
    }
}

impl Prompter for ScriptedPrompter {
    /// Accepts the default text.
    fn input(&self, prompt: &str, default: Option<&str>) -> anyhow::Result<String> {
        self.next(Asked {
            prompt: prompt.to_owned(),
            defaults: vec![],
            default_index: None,
            default_text: default.map(str::to_owned),
        });
        Ok(default.unwrap_or_default().to_owned())
    }

    /// Passwords are not part of the planning tests.
    fn password(&self, prompt: &str) -> anyhow::Result<String> {
        anyhow::bail!("unexpected password prompt: {prompt}")
    }

    /// Returns the scripted selection or the preselected items.
    fn multi_select(
        &self,
        prompt: &str,
        _items: &[String],
        defaults: &[bool],
    ) -> anyhow::Result<Vec<usize>> {
        let answer = self.next(Asked {
            prompt: prompt.to_owned(),
            defaults: defaults.to_vec(),
            default_index: None,
            default_text: None,
        });
        Ok(match answer {
            Answer::Indexes(indexes) => indexes,
            _ => defaults
                .iter()
                .enumerate()
                .filter_map(|(index, checked)| checked.then_some(index))
                .collect(),
        })
    }

    /// Returns the scripted index or the default.
    fn select(&self, prompt: &str, _items: &[String], default: usize) -> anyhow::Result<usize> {
        let answer = self.next(Asked {
            prompt: prompt.to_owned(),
            defaults: vec![],
            default_index: Some(default),
            default_text: None,
        });
        Ok(match answer {
            Answer::Index(index) => index,
            _ => default,
        })
    }

    /// Accepts the default.
    fn confirm(&self, prompt: &str, default: bool) -> anyhow::Result<bool> {
        self.next(Asked {
            prompt: prompt.to_owned(),
            defaults: vec![],
            default_index: None,
            default_text: None,
        });
        Ok(default)
    }
}

/// Parses login flags exactly like the real command line.
#[derive(Parser)]
struct LoginCli {
    #[command(flatten)]
    args: TokenRequestArgs,
}

/// Builds login arguments from a flag list.
fn login_args(flags: &[&str]) -> TokenRequestArgs {
    let mut argv = vec!["login", "http://127.0.0.1:7666"];
    argv.extend_from_slice(flags);
    LoginCli::try_parse_from(argv).unwrap().args
}

/// Accepting every default gives the CLI-oriented policy the plan promises.
#[tokio::test]
async fn interactive_defaults_preselect_cli_permissions() {
    let (prompter, asked) = ScriptedPrompter::new(vec![
        Answer::Default,
        Answer::Default,
        Answer::Default,
        Answer::Default,
    ]);
    let flow = LoginFlow::new(prompter, true, login_args(&[]));
    let plan = flow.plan(&inventory()).await.unwrap();
    let asked = asked.lock().unwrap().clone();
    // Everything but files:delete is preselected, because only rm and mv need it.
    assert_eq!(asked[0].defaults, vec![true, true, false, true, true]);
    // All devices is the default scope, and 90 days the default expiry.
    assert_eq!(asked[1].default_index, Some(0));
    assert_eq!(asked[3].default_index, Some(1));
    // The default name says which machine holds the token.
    assert!(
        asked[2]
            .default_text
            .as_deref()
            .is_some_and(|name| name.starts_with("redoor remote on "))
    );
    assert_eq!(
        (plan.permissions, plan.devices, plan.expiry),
        (
            vec![
                Permission::FilesRead,
                Permission::FilesWrite,
                Permission::CommandsExecute,
                Permission::AgentsManage
            ],
            DeviceScope::All,
            Expiry::Days90
        )
    );
}

/// Flags answer everything, so scripted logins never block on a prompt.
#[tokio::test]
async fn flags_skip_prompts() {
    let (prompter, asked) = ScriptedPrompter::new(vec![]);
    let flow = LoginFlow::new(
        prompter,
        true,
        login_args(&[
            "--permissions",
            "files:read,agents:manage",
            "--devices",
            "a,b",
            "--name",
            "ci",
            "--expires",
            "never",
        ]),
    );
    let plan = flow.plan(&inventory()).await.unwrap();
    // No prompt was shown.
    assert!(asked.lock().unwrap().is_empty());
    assert_eq!(
        plan,
        TokenRequestPlan {
            name: "ci".into(),
            permissions: vec![Permission::FilesRead, Permission::AgentsManage],
            devices: DeviceScope::Only {
                device_ids: vec![
                    redoor_protocol::ids::AgentId::unchecked("a"),
                    redoor_protocol::ids::AgentId::unchecked("b")
                ]
            },
            expiry: Expiry::Never,
        }
    );
    let (prompter, _) = ScriptedPrompter::new(vec![]);
    let all = LoginFlow::new(
        prompter,
        false,
        login_args(&["--permissions", "all", "--name", "ci"]),
    )
    .plan(&inventory())
    .await
    .unwrap();
    // "all" expands to every permission, and scripts default to all devices and 90 days.
    assert_eq!(all.permissions, Permission::ALL.to_vec());
    assert_eq!(
        (all.devices, all.expiry),
        (DeviceScope::All, Expiry::Days90)
    );
    // Unknown permission names are rejected rather than granting less than asked.
    let mut argv = vec!["login", "http://127.0.0.1:7666"];
    argv.extend(["--permissions", "devices:read"]);
    assert!(LoginCli::try_parse_from(argv).is_err());
}

/// An empty permission selection is asked again, and "only" devices needs at least one.
#[tokio::test]
async fn empty_selections_are_prompted_again() {
    let (prompter, asked) = ScriptedPrompter::new(vec![
        Answer::Indexes(vec![]),
        Answer::Indexes(vec![0]),
        Answer::Index(1),
        Answer::Indexes(vec![]),
        Answer::Indexes(vec![1]),
        Answer::Default,
        Answer::Default,
    ]);
    let flow = LoginFlow::new(prompter, true, login_args(&[]));
    let plan = flow.plan(&inventory()).await.unwrap();
    let prompts = asked
        .lock()
        .unwrap()
        .iter()
        .map(|asked| asked.prompt.clone())
        .collect::<Vec<_>>();
    // The permission and device lists were each shown twice.
    assert_eq!(
        prompts
            .iter()
            .filter(|p| p.starts_with("Permissions"))
            .count(),
        2
    );
    assert_eq!(prompts.iter().filter(|p| *p == "Select devices").count(), 2);
    assert_eq!(plan.permissions, vec![Permission::FilesRead]);
    assert_eq!(
        plan.devices,
        DeviceScope::Only {
            device_ids: vec![redoor_protocol::ids::AgentId::unchecked("b")]
        }
    );
}

/// Without a terminal the missing required flags are named up front, before any request.
#[tokio::test]
async fn non_interactive_login_names_missing_flags() {
    let (prompter, asked) = ScriptedPrompter::new(vec![]);
    let flow = LoginFlow::new(prompter, false, login_args(&["--username", "user"]));
    let error = flow.issue().await.unwrap_err().to_string();
    // Every missing flag is listed, so one retry is enough.
    assert!(error.contains("--password-stdin") && error.contains("--permissions"));
    assert!(!error.contains("--username"));
    // Nothing was prompted.
    assert!(asked.lock().unwrap().is_empty());
}
