//! Exercise cookie behavior over real HTTP and durable state, rather than mocking client internals.

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use cookie_store::CookieStore;
use redoor::commands::{AgentListResponse, LoginRequest};
use reqwest::{Method, Url};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

use super::{
    client::RemoteClient,
    format_agents,
    session::{Session, SessionStore},
};

/// Owns a mock API and filesystem root so tests cannot share credentials or sockets.
struct Fixture {
    root: crate::test_support::TempDir,
    store: SessionStore,
    url: String,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    /// The mock rotates cookies and rejects stale tokens just like a real authentication service.
    async fn new() -> Self {
        let root = crate::test_support::TempDir::create();
        let store = SessionStore::new(root.path().join("namespace"));
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/prefix/api/v1/login", post(login))
            .route("/prefix/api/v1/agents", get(agents))
            .route("/prefix/api/v1/logout", post(logout))
            .route("/prefix/rejected", get(rejected))
            .route("/prefix/failure", get(failure))
            .route("/prefix/permission", get(permission))
            .route("/prefix/redirect", get(redirect))
            .route("/prefix/stream", get(stream))
            .with_state(calls.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/prefix", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            root,
            store,
            url,
            calls,
            task,
        }
    }

    /// Uses the same login implementation as the credential-prompt command.
    async fn authenticate(&self) {
        RemoteClient::login(
            self.store.clone(),
            &self.url,
            "user".into(),
            "secret".into(),
        )
        .await
        .unwrap();
    }
}

impl Drop for Fixture {
    /// Aborting the listener avoids leaked servers even if an assertion panics.
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Failed logins deliberately set a destructive cookie to verify isolation from saved credentials.
async fn login(Json(body): Json<LoginRequest>) -> impl IntoResponse {
    if body.username == "no-cookie" {
        return (
            StatusCode::OK,
            [(header::SET_COOKIE, "unrelated=value; Path=/")],
            Json(serde_json::json!({"username": "no-cookie"})),
        );
    }
    if body.username == "user" && body.password == "secret" {
        (
            StatusCode::OK,
            [(
                header::SET_COOKIE,
                "redoor_session=first; Path=/prefix; HttpOnly; SameSite=Lax; Max-Age=3600",
            )],
            Json(serde_json::json!({"username": "user"})),
        )
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(
                header::SET_COOKIE,
                "redoor_session=; Path=/prefix; Max-Age=0",
            )],
            Json(serde_json::json!({"error": "wrong password"})),
        )
    }
}

/// HTTP success is insufficient if a proxy or broken server fails to issue an applicable cookie.
#[tokio::test]
async fn successful_response_without_auth_cookie_preserves_session() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let previous = fixture.store.load().await.unwrap();
    let error = RemoteClient::login(
        fixture.store.clone(),
        &fixture.url,
        "no-cookie".into(),
        "secret".into(),
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("usable session cookie"),
        "Malformed login success must fail with an actionable explanation"
    );
    assert_eq!(
        fixture.store.load().await.unwrap().generation,
        previous.generation,
        "An unusable login must not replace existing authentication"
    );
}

/// Enforces rotation across separate client loads and returns a legitimate empty inventory.
async fn agents(State(calls): State<Arc<AtomicUsize>>, headers: HeaderMap) -> impl IntoResponse {
    let expected = if calls.load(Ordering::SeqCst) == 0 {
        "redoor_session=first"
    } else {
        "redoor_session=rotated"
    };
    if !headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains(expected))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    calls.fetch_add(1, Ordering::SeqCst);
    (
        [(
            header::SET_COOKIE,
            "redoor_session=rotated; Path=/prefix; HttpOnly; Max-Age=3600",
        )],
        Json(serde_json::json!({"agents": []})),
    )
        .into_response()
}

/// Logout must receive the rotated persisted credential, not the original login token.
async fn logout(State(calls): State<Arc<AtomicUsize>>, headers: HeaderMap) -> impl IntoResponse {
    if headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        != Some("redoor_session=rotated")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    calls.fetch_add(100, Ordering::SeqCst);
    (
        [(
            header::SET_COOKIE,
            "redoor_session=; Path=/prefix; Max-Age=0",
        )],
        Json(serde_json::json!({"logged_out": true})),
    )
        .into_response()
}

/// Cookie deletion on rejected authentication still has to be written to disk.
async fn rejected() -> impl IntoResponse {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::SET_COOKIE,
            "redoor_session=; Path=/prefix; Max-Age=0",
        )],
    )
}

/// A normal API failure must not be mistaken for an empty agent list or authentication failure.
async fn failure() -> impl IntoResponse {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": "inventory unavailable"})),
    )
}

/// File permission errors use 403 in Redoor and must remain API errors for future transfers.
async fn permission() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({"error": "Permission denied: /private"})),
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

/// Authentication and cookie persistence must not hold locks until a streamed body completes.
#[tokio::test]
async fn unfinished_stream_does_not_block_control_requests() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let client = RemoteClient::load(fixture.store.clone()).await.unwrap();
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

/// Local logout must remain useful when the selected server cannot invalidate its cookie.
#[tokio::test]
async fn offline_logout_removes_local_credentials() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    fixture.task.abort();
    // Waiting for the aborted listener ensures the test never races a still-running server.
    while !fixture.task.is_finished() {
        tokio::task::yield_now().await;
    }
    let error = RemoteClient::logout(fixture.store.clone())
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("Local session removed"),
        "Offline logout must explain remote invalidation failed"
    );
    assert!(
        fixture.store.load().await.is_err(),
        "Transport failures must not leave locally usable credentials behind"
    );
}

/// Builds an owned cookie snapshot without changing Max-Age on subsequent reloads.
fn session(url: &str, cookies: &[&str]) -> Session {
    let url = Url::parse(url).unwrap();
    let mut jar = CookieStore::default();
    for cookie in cookies {
        let _ = jar.parse(cookie, &url);
    }
    Session {
        version: 1,
        generation: Uuid::new_v4(),
        server_url: url.to_string(),
        cookies: jar.iter_any().cloned().collect(),
    }
}

/// Real HTTP round-trips cover persistence, failed-login isolation, rotation, permissions, and logout.
#[tokio::test]
async fn login_rotation_failed_login_and_logout() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let directory = fixture.root.path().join("namespace");
    // Credentials and their containing directory must be inaccessible to other users.
    assert_eq!(
        tokio::fs::metadata(&directory)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        tokio::fs::metadata(directory.join("remote-session.json"))
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let saved = tokio::fs::read(directory.join("remote-session.json"))
        .await
        .unwrap();
    let error = RemoteClient::login(
        fixture.store.clone(),
        &fixture.url,
        "user".into(),
        "bad".into(),
    )
    .await
    .unwrap_err();
    // A destructive Set-Cookie on a failed login must not damage the last successful login.
    assert!(error.to_string().contains("invalid username or password"));
    assert_eq!(
        saved,
        tokio::fs::read(directory.join("remote-session.json"))
            .await
            .unwrap()
    );
    for _ in 0..2 {
        let client = RemoteClient::load(fixture.store.clone()).await.unwrap();
        let list: AgentListResponse = client.get_json("api/v1/agents").await.unwrap();
        // An empty inventory is success, and a new invocation must send the rotated cookie.
        assert!(list.agents.is_empty());
    }
    RemoteClient::logout(fixture.store.clone()).await.unwrap();
    // Both remote invalidation and local deletion are required; repeating logout is harmless.
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 102);
    assert!(
        !tokio::fs::try_exists(directory.join("remote-session.json"))
            .await
            .unwrap()
    );
    RemoteClient::logout(fixture.store.clone()).await.unwrap();
}

/// Persisted RFC cookie metadata enforces host, path, secure, absolute expiry, and session-cookie rules.
#[tokio::test]
async fn metadata_survives_round_trip_without_extending_expiry() {
    let fixture = Fixture::new().await;
    let state = session(
        "https://example.com/prefix/",
        &[
            "redoor_session=secret; Domain=example.com; Path=/prefix; Secure; HttpOnly; SameSite=Strict; Max-Age=3600",
            "host_only=one; Path=/prefix",
            "expired=gone; Path=/prefix; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ],
    );
    fixture.store.replace(&state).await.unwrap();
    let restored = fixture.store.load().await.unwrap();
    // Round-trip equality includes absolute expiry and non-persistent cookies, not just name/value.
    assert_eq!(state.cookies, restored.cookies);
    let secure = Url::parse("https://example.com/prefix/api").unwrap();
    assert!(
        restored
            .cookie_header(&secure)
            .unwrap()
            .contains("host_only=one")
    );
    for invalid in [
        "http://example.com/prefix/api",
        "https://unrelated.com/prefix/api",
        "https://example.com/elsewhere",
    ] {
        // No auth cookie may leak over HTTP, to another host, or outside its path scope.
        assert!(
            restored
                .cookie_header(&Url::parse(invalid).unwrap())
                .is_err()
        );
    }
    let subdomain = restored
        .cookie_header(&Url::parse("https://sub.example.com/prefix/api").unwrap())
        .unwrap();
    // Domain cookies cover subdomains, but host-only cookies must not.
    assert!(subdomain.contains("redoor_session=secret"));
    assert!(!subdomain.contains("host_only"));
    let loopback = session(
        "https://127.0.0.1/",
        &["redoor_session=secret; Path=/; Secure"],
    );
    assert!(
        loopback
            .cookie_header(&Url::parse("http://127.0.0.1/").unwrap())
            .is_err(),
        "Secure cookies must not use browsers' HTTP loopback exception"
    );
    let expired = session(
        "https://example.com/",
        &["redoor_session=expired; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
    );
    fixture.store.replace(&expired).await.unwrap();
    // Expired sessions should give actionable guidance without even sending a request.
    assert!(
        RemoteClient::load(fixture.store.clone())
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("remote login")
    );
}

/// Server rejection and error statuses remain distinct, and response cookie deletions are durable.
#[tokio::test]
async fn rejection_updates_cookies_and_api_errors_are_distinct() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let client = RemoteClient::load(fixture.store.clone()).await.unwrap();
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
            .contains("403 Forbidden: Permission denied"),
        "Filesystem permission errors must not direct users to log in again"
    );
    let error = client
        .send(client.request(Method::GET, "rejected").unwrap())
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("remote login"),
        "Rejected authentication must tell users how to recover"
    );
    assert!(
        RemoteClient::load(fixture.store.clone()).await.is_err(),
        "A deleted cookie must remain deleted across invocations"
    );
    RemoteClient::logout(fixture.store.clone()).await.unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "Expired logout must still clear the local session"
    );
}

/// Parallel response merges cannot lose each other's cookies or restore an obsolete login generation.
#[tokio::test]
async fn concurrent_updates_and_generation_guards() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let state = fixture.store.load().await.unwrap();
    let url = Url::parse(&fixture.url).unwrap();
    let first = vec!["one=1; Path=/prefix".into()];
    let second = vec!["two=2; Path=/prefix".into()];
    let (a, b) = tokio::join!(
        fixture.store.update_cookies(state.generation, &url, &first),
        fixture
            .store
            .update_cookies(state.generation, &url, &second)
    );
    a.unwrap();
    b.unwrap();
    let header = fixture
        .store
        .load()
        .await
        .unwrap()
        .cookie_header(&url)
        .unwrap();
    // Merging under the process-wide file lock must retain independent concurrent cookie updates.
    assert!(header.contains("one=1") && header.contains("two=2"));
    fixture.authenticate().await;
    fixture
        .store
        .update_cookies(
            state.generation,
            &url,
            &["redoor_session=stale; Path=/prefix".into()],
        )
        .await
        .unwrap();
    fixture.store.remove(state.generation).await.unwrap();
    let current = fixture.store.load().await.unwrap();
    assert!(
        current
            .cookie_header(&url)
            .unwrap()
            .contains("redoor_session=first"),
        "Stale requests must not modify or remove a newer login"
    );
    fixture.store.remove(current.generation).await.unwrap();
    fixture
        .store
        .update_cookies(current.generation, &url, &first)
        .await
        .unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "Late responses must never resurrect credentials after logout"
    );
}

/// Symlink substitution and insecure existing files must fail before exposing credential contents.
#[tokio::test]
async fn unsafe_storage_is_rejected() {
    let fixture = Fixture::new().await;
    fixture.authenticate().await;
    let path = fixture.root.path().join("namespace/remote-session.json");
    tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .await
        .unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "World-readable sessions must not be loaded"
    );
    tokio::fs::remove_file(&path).await.unwrap();
    let target = fixture.root.path().join("target");
    tokio::fs::write(&target, b"private external data")
        .await
        .unwrap();
    tokio::fs::symlink(&target, &path).await.unwrap();
    assert!(
        fixture.store.load().await.is_err(),
        "Session symlinks must not be followed"
    );
    fixture.authenticate().await;
    assert_eq!(
        tokio::fs::read(target).await.unwrap(),
        b"private external data",
        "Atomic replacement must not overwrite symlink targets"
    );
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
    fixture.authenticate().await;
    let client = RemoteClient::load(fixture.store.clone()).await.unwrap();
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
    let payload = serde_json::json!({"agents": [{
        "id": "agent-123", "name": "Host With Spaces", "cwd": null, "managed": false,
        "configuration_editable": false, "ssh_target": null, "status": "connected", "connected_at": null,
        "connection_id": null, "last_seen_at": null, "connection_issue": null, "provisioning_status": [],
        "binary": null, "supports_self_exec": false, "supports_native_open": false,
        "supports_move_to_trash": false, "supports_trash": false, "uid": null, "is_root": false
    }]});
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
