//! `redoor remote login` and `redoor remote create-token`.
//!
//! Both get their token through the browser, like `gh auth login` (the OAuth device
//! authorization flow, RFC 8628): the CLI asks the server for a login request, prints a URL
//! and a code, and waits while the user opens the URL in a signed-in browser, types the code,
//! adjusts the token and approves it after signing in again. The CLI never handles a
//! password, OIDC-only servers can log it in too, and no script can mint a token without a
//! person approving it in the browser.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use redoor_protocol::{
    api::{
        cli_logins::{
            CliLoginWaitResponse, CliTokenDefaults, StartCliLoginRequest, StartCliLoginResponse,
            TokenLifetime, WaitCliLoginRequest,
        },
        tokens::{AccessTokenResponse, AccessTokenSecretResponse, DeviceScope, Permission},
    },
    ids::AgentId,
};
use reqwest::{Method, StatusCode, Url, header};

use super::{
    client::RemoteClient,
    credentials::{CredentialStore, Credentials},
};

/// How long one `wait` request may take: the server answers within 30 s, plus slack for a
/// slow network, so a dead connection is noticed instead of hanging forever.
const WAIT_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
/// Reported when the user presses Ctrl-C while the CLI waits.
const LOGIN_CANCELED: &str = "Login canceled";

/// A comma-separated permission list, or `all`; a newtype so clap treats it as one value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PermissionList(pub(crate) Vec<Permission>);

/// Parses `--permissions`, rejecting unknown names so a typo cannot silently grant less.
fn parse_permissions(value: &str) -> Result<PermissionList, String> {
    if value.trim() == "all" {
        return Ok(PermissionList(Permission::ALL.to_vec()));
    }
    let permissions = value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::parse)
        .collect::<Result<Vec<Permission>, _>>()?;
    if permissions.is_empty() {
        return Err("--permissions needs at least one permission".into());
    }
    Ok(PermissionList(permissions))
}

/// Parses `--devices` as `all` or a comma-separated list of device names or ids. The approval
/// page matches them against the device list, and the server stores the resolved ids, so the
/// scope does not follow a name to another device later.
fn parse_devices(value: &str) -> Result<DeviceScope, String> {
    if value.trim() == "all" {
        return Ok(DeviceScope::All);
    }
    let device_ids = value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(AgentId::unchecked)
        .collect::<Vec<_>>();
    if device_ids.is_empty() {
        return Err("--devices needs 'all' or at least one device name or id".into());
    }
    Ok(DeviceScope::Only { device_ids })
}

/// Token lifetimes `--expires` accepts; the approval page offers the same choices.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub(crate) enum Expiry {
    #[value(name = "30d")]
    Days30,
    #[value(name = "90d")]
    Days90,
    #[value(name = "365d")]
    Days365,
    #[value(name = "never")]
    Never,
}

impl Expiry {
    /// The same choice in the wire vocabulary the approval page reads.
    fn lifetime(self) -> TokenLifetime {
        match self {
            Expiry::Days30 => TokenLifetime::Days30,
            Expiry::Days90 => TokenLifetime::Days90,
            Expiry::Days365 => TokenLifetime::Days365,
            Expiry::Never => TokenLifetime::Never,
        }
    }
}

/// Options shared by `login` and `create-token`. The token flags only prefill the approval
/// form in the browser, where the user has the final say.
#[derive(Args, Clone, Debug)]
pub struct TokenRequestArgs {
    /// Server base URL, for example http://127.0.0.1:7666.
    server_url: String,
    /// Comma-separated permissions (files:read, files:write, files:delete, commands:execute,
    /// agents:manage) or "all". Default: all but files:delete.
    #[arg(long, value_name = "LIST", value_parser = parse_permissions)]
    permissions: Option<PermissionList>,
    /// "all" (including devices added later) or comma-separated device names or ids.
    /// Default: all.
    #[arg(long, value_name = "all|ID,ID...", value_parser = parse_devices)]
    devices: Option<DeviceScope>,
    /// Token name shown in the UI (default: "redoor remote on <hostname>").
    #[arg(long)]
    name: Option<String>,
    /// Token lifetime. Default: 90d.
    #[arg(long, value_enum)]
    expires: Option<Expiry>,
    /// Skip TLS certificate verification, for a server with a self-signed certificate.
    /// `login` saves this for later commands. Anyone able to intercept the connection could
    /// then read the token.
    /// The falsey parser reads the environment like `insecure_tls_from_environment` does.
    #[arg(
        long,
        env = super::credentials::INSECURE_TLS_ENV,
        value_parser = clap::builder::FalseyValueParser::new()
    )]
    insecure_tls: bool,
}

impl TokenRequestArgs {
    /// The token the approval form starts from: the flags, or the defaults a CLI needs.
    /// Everything but `files:delete` by default, because only `rm` and `mv` need it.
    pub(crate) fn defaults(&self, host_name: &str) -> CliTokenDefaults {
        CliTokenDefaults {
            name: self
                .name
                .clone()
                .unwrap_or_else(|| format!("redoor remote on {host_name}")),
            permissions: self.permissions.clone().map_or_else(
                || {
                    Permission::ALL
                        .into_iter()
                        .filter(|permission| *permission != Permission::FilesDelete)
                        .collect()
                },
                |PermissionList(permissions)| permissions,
            ),
            devices: self.devices.clone().unwrap_or(DeviceScope::All),
            lifetime: self.expires.map_or(TokenLifetime::Days90, Expiry::lifetime),
        }
    }
}

/// This machine's name, shown on the approval page so the user can tell their own request
/// from one somebody else sent them.
fn host_name() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|name| name.into_string().ok())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "unknown host".to_owned())
}

/// The CLI login routes of one server.
pub(crate) struct BrowserLogin {
    http: reqwest::Client,
    server: Url,
}

impl BrowserLogin {
    /// Validates the server URL before anything is sent to it.
    pub(crate) fn new(server_url: &str, insecure_tls: bool) -> Result<Self> {
        Ok(Self {
            http: RemoteClient::transport(insecure_tls)?,
            server: RemoteClient::parse_server(server_url)?,
        })
    }

    /// Asks the server for a login request.
    async fn start(&self, request: &StartCliLoginRequest) -> Result<StartCliLoginResponse> {
        let response = self
            .http
            .post(self.server.join("api/v1/cli-logins")?)
            .timeout(Duration::from_secs(30))
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(request)?)
            .send()
            .await
            .context("Login request failed")?;
        let response = RemoteClient::check_response(response).await?;
        serde_json::from_slice(&response.bytes().await?).context("Invalid login response")
    }

    /// The page the user approves the request on. Joined relative to the server URL, so a
    /// server behind a path prefix keeps it.
    pub(crate) fn approval_url(&self, started: &StartCliLoginResponse) -> Result<Url> {
        Ok(self
            .server
            .join(started.approval_path.trim_start_matches('/'))?)
    }

    /// One long poll. The server removes a request once it answered `approved` or `denied`,
    /// and forgets it after ten minutes, so a 404 means it expired.
    async fn wait(&self, started: &StartCliLoginResponse) -> Result<CliLoginWaitResponse> {
        let path = format!("api/v1/cli-logins/{}/wait", started.id);
        let response = self
            .http
            .request(Method::POST, self.server.join(&path)?)
            .timeout(WAIT_REQUEST_TIMEOUT)
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&WaitCliLoginRequest {
                poll_secret: started.poll_secret.clone(),
            })?)
            .send()
            .await
            .context("Waiting for the approval failed")?;
        if response.status() == StatusCode::NOT_FOUND {
            bail!("The login request expired before it was approved; run the command again");
        }
        let response = RemoteClient::check_response(response).await?;
        serde_json::from_slice(&response.bytes().await?).context("Invalid approval response")
    }

    /// Starts a request for `defaults`, tells the user where to approve it and waits until
    /// the browser approves or denies it, it expires, or the user presses Ctrl-C.
    pub(crate) async fn issue(
        &self,
        defaults: CliTokenDefaults,
    ) -> Result<AccessTokenSecretResponse> {
        let started = self
            .start(&StartCliLoginRequest {
                host_name: host_name(),
                token: defaults,
            })
            .await?;
        // stderr, so `create-token`'s stdout stays clean JSON.
        eprintln!(
            "To approve this login, open this page in a browser where you are signed in to Redoor:

    {}

and enter the code {}

Waiting for approval (expires in {} minutes, Ctrl-C cancels)...",
            self.approval_url(&started)?,
            started.user_code,
            started.expires_in_seconds / 60
        );
        tokio::select! {
            result = self.wait_for_answer(&started) => result,
            _ = tokio::signal::ctrl_c() => bail!(LOGIN_CANCELED),
        }
    }

    /// Polls until the browser decided; each poll waits on the server, so this does not spin.
    async fn wait_for_answer(
        &self,
        started: &StartCliLoginResponse,
    ) -> Result<AccessTokenSecretResponse> {
        loop {
            match self.wait(started).await? {
                CliLoginWaitResponse::Pending => {}
                CliLoginWaitResponse::Denied => bail!("The login was denied in the browser"),
                CliLoginWaitResponse::Approved(token) => return Ok(token),
            }
        }
    }
}

/// Gets a token for `args` through the browser.
async fn issue(args: &TokenRequestArgs) -> Result<(Url, AccessTokenSecretResponse)> {
    let login = BrowserLogin::new(&args.server_url, args.insecure_tls)?;
    if args.insecure_tls {
        eprintln!(
            "Warning: TLS certificate verification is disabled for {}",
            login.server
        );
    }
    let token = login.issue(args.defaults(&host_name())).await?;
    Ok((login.server, token))
}

/// `redoor remote login`: saves the new token, replacing (and revoking) a previous login to
/// the same server so re-logins do not leave orphan tokens behind.
pub(crate) async fn login(store: CredentialStore, args: TokenRequestArgs) -> Result<()> {
    let insecure_tls = args.insecure_tls;
    let (server, issued) = issue(&args).await?;
    if let Ok(Some(previous)) = store.load().await
        && RemoteClient::parse_server(&previous.server_url).is_ok_and(|url| url == server)
        // The same server just answered with these TLS settings, so revoke with them too.
        && let Ok(client) = RemoteClient::from_credentials(Credentials {
            insecure_tls: previous.insecure_tls || insecure_tls,
            ..previous
        })
        && let Ok(request) = client.request(Method::DELETE, "api/v1/tokens/current")
    {
        let _ = client
            .send(request.timeout(std::time::Duration::from_secs(30)))
            .await;
    }
    store
        .save(&Credentials {
            version: 1,
            server_url: server.to_string(),
            token: issued.token,
            token_id: issued
                .metadata
                .id
                .parse()
                .context("Server returned an invalid token id")?,
            insecure_tls,
        })
        .await?;
    eprintln!(
        "Logged in to {server} with token \"{}\" ({})",
        issued.metadata.name.escape_debug(),
        describe(&issued.metadata)
    );
    Ok(())
}

/// `redoor remote create-token`: prints the token as JSON for MCP clients and scripts and
/// saves nothing.
pub(crate) async fn create_token(args: TokenRequestArgs) -> Result<()> {
    let (server, issued) = issue(&args).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "token": issued.token,
            "metadata": issued.metadata,
            "mcp_endpoint": server.join("mcp")?.to_string(),
        }))?
    );
    Ok(())
}

/// One-line policy summary: permissions, devices and expiry.
pub(crate) fn describe(token: &AccessTokenResponse) -> String {
    format!(
        "{}; {}; {}",
        permission_names(&token.permissions),
        device_summary(&token.devices),
        token
            .expires_at
            .as_deref()
            .map_or_else(|| "never expires".to_owned(), |at| format!("expires {at}"))
    )
}

/// Comma-separated wire names, as users type them in flags.
fn permission_names(permissions: &[Permission]) -> String {
    permissions
        .iter()
        .map(|permission| permission.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// "all devices" or the escaped device ids.
pub(crate) fn device_summary(devices: &DeviceScope) -> String {
    match devices {
        DeviceScope::All => "all devices".to_owned(),
        DeviceScope::Only { device_ids } => format!(
            "devices {}",
            device_ids
                .iter()
                .map(|id| id.to_string().escape_debug().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
