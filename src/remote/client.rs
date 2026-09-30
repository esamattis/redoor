//! Authenticated HTTP transport without response buffering or transfer-wide timeouts.

use anyhow::{Context, Result, ensure};
use cookie_store::CookieStore;
use redoor::commands::{LoginRequest, LoginResponse};
use reqwest::{Method, RequestBuilder, Response, StatusCode, Url, header};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::session::{LOGIN_REQUIRED, Session, SessionStore};

/// Retains HTTP status so optional metadata can distinguish missing paths from permission failures.
#[derive(Debug, thiserror::Error)]
#[error("Remote API returned {status}: {detail}")]
pub struct RemoteApiError {
    pub status: StatusCode,
    pub detail: String,
}

/// Cloneable transport for independent streaming and control operations; never locks during network IO.
#[derive(Clone)]
pub struct RemoteClient {
    http: reqwest::Client,
    store: SessionStore,
    server: Url,
    generation: Uuid,
}

impl RemoteClient {
    /// Validates the selected server before credentials can be put on the wire.
    pub fn parse_server(server: &str) -> Result<Url> {
        let mut url =
            Url::parse(server).context("SERVER_URL must be an absolute HTTP or HTTPS URL")?;
        ensure!(
            matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
            "SERVER_URL must use HTTP or HTTPS"
        );
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "SERVER_URL must not contain credentials, a query, or a fragment"
        );
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        Ok(url)
    }

    /// Disables redirects so credentials never follow an API redirect to a different origin.
    fn transport() -> Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()?)
    }

    /// Pins the selected login generation while leaving rotated cookies fresh for every request.
    pub async fn load(store: SessionStore) -> Result<Self> {
        let session = store.load().await?;
        let server = Self::parse_server(&session.server_url)?;
        session.cookie_header(&server.join("api/v1/agents")?)?;
        Ok(Self {
            http: Self::transport()?,
            store,
            server,
            generation: session.generation,
        })
    }

    /// Stages login in an isolated jar; even a failed response with Set-Cookie cannot alter saved state.
    pub async fn login(
        store: SessionStore,
        server: &str,
        username: String,
        password: String,
    ) -> Result<LoginResponse> {
        let server = Self::parse_server(server)?;
        let url = server.join("api/v1/login")?;
        let response = Self::transport()?
            .post(url.clone())
            .timeout(std::time::Duration::from_secs(30))
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&LoginRequest { username, password })?)
            .send()
            .await?;
        let headers = Self::cookie_updates(&response);
        if response.status() == StatusCode::UNAUTHORIZED {
            anyhow::bail!(
                "Login failed: invalid username or password; previous remote session preserved"
            );
        }
        let response = Self::check_response(response).await?;
        let login = serde_json::from_slice::<LoginResponse>(&response.bytes().await?)
            .context("Invalid login response")?;
        let mut jar = CookieStore::default();
        for cookie in &headers {
            let _ = jar.parse(cookie, &url);
        }
        let session = Session {
            version: 1,
            generation: Uuid::new_v4(),
            server_url: server.to_string(),
            cookies: jar.iter_any().cloned().collect(),
        };
        session.cookie_header(&server.join("api/v1/agents")?).context("Login did not issue a usable session cookie (check HTTPS and server cookie_secure)")?;
        store.replace(&session).await?;
        Ok(login)
    }

    /// Resolves API paths relative to a deployment prefix while forbidding origin/path escapes.
    pub fn endpoint(&self, path: &str) -> Result<Url> {
        let url = self.server.join(path.trim_start_matches('/'))?;
        ensure!(
            url.origin() == self.server.origin() && url.path().starts_with(self.server.path()),
            "Remote request must target the selected server"
        );
        Ok(url)
    }

    /// Lets transfers attach streaming bodies/query options without bypassing authenticated send.
    pub fn request(&self, method: Method, path: &str) -> Result<RequestBuilder> {
        Ok(self.http.request(method, self.endpoint(path)?))
    }

    /// Applies fresh cookies and persists all response updates before exposing the streaming body.
    pub async fn send(&self, builder: RequestBuilder) -> Result<Response> {
        let mut request = builder.build()?;
        ensure!(
            request.url().origin() == self.server.origin()
                && request.url().path().starts_with(self.server.path()),
            "Remote request must target the selected server"
        );
        let session = self.store.load().await?;
        ensure!(session.generation == self.generation, LOGIN_REQUIRED);
        let cookie = session.cookie_header(request.url())?;
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse()?);
        let response = self
            .http
            .execute(request)
            .await
            .context("Remote request failed")?;
        self.store
            .update_cookies(
                self.generation,
                response.url(),
                &Self::cookie_updates(&response),
            )
            .await?;
        Self::check_response(response).await
    }

    /// Decodes typed control responses while send remains usable for bounded-memory transfers.
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .send(
                self.request(Method::GET, path)?
                    .timeout(std::time::Duration::from_secs(30)),
            )
            .await?;
        serde_json::from_slice(&response.bytes().await?).context("Invalid remote API response")
    }

    /// Uses existing API payload types without requiring reqwest's optional JSON feature.
    pub fn json_request<T: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: &T,
    ) -> Result<RequestBuilder> {
        Ok(self
            .request(method, path)?
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(body)?))
    }

    /// Always clears local credentials, including when the server is offline or auth has expired.
    pub async fn logout(store: SessionStore) -> Result<()> {
        let session = match store.load().await {
            Ok(session) => session,
            Err(error) if error.to_string() == LOGIN_REQUIRED => return Ok(()),
            Err(error) => return Err(error),
        };
        let result = async {
            let client = Self {
                http: Self::transport()?,
                server: Self::parse_server(&session.server_url)?,
                generation: session.generation,
                store: store.clone(),
            };
            client
                .send(
                    client
                        .request(Method::POST, "api/v1/logout")?
                        .timeout(std::time::Duration::from_secs(30)),
                )
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        store.remove(session.generation).await?;
        match result {
            Err(error) if error.to_string() == LOGIN_REQUIRED => Ok(()),
            result => result.context("Local session removed; server logout did not complete"),
        }
    }

    /// Reads each Set-Cookie separately; comma splitting would corrupt Expires attributes.
    fn cookie_updates(response: &Response) -> Vec<String> {
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_owned))
            .collect()
    }

    /// Keeps authentication guidance distinct from API failures and bounds error-body memory.
    async fn check_response(mut response: Response) -> Result<Response> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        // Redoor uses 403 for remote filesystem permissions; only 401 means rejected login.
        if status == StatusCode::UNAUTHORIZED {
            anyhow::bail!(LOGIN_REQUIRED);
        }
        let mut bytes = Vec::new();
        while bytes.len() < 8192 {
            let Some(chunk) = response.chunk().await? else {
                break;
            };
            bytes.extend_from_slice(&chunk[..chunk.len().min(8192 - bytes.len())]);
        }
        let detail = serde_json::from_slice::<redoor::commands::ErrorResponse>(&bytes)
            .map(|body| body.error)
            .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).into_owned());
        Err(RemoteApiError { status, detail }.into())
    }
}
