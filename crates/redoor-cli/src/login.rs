//! `redoor remote login` and `redoor remote create-token`.
//!
//! Both exchange the account password for a transient browser session, use it to create an
//! access token with the permissions the user picks, and log the session out again. The
//! password never leaves this flow, and only the scoped token is kept.

use std::{future::Future, io::IsTerminal, sync::Arc};

use anyhow::{Context, Result, bail};
use clap::{Args, ValueEnum};
use jiff::{SignedDuration, Timestamp, Unit};
use redoor_protocol::{
    api::{
        agents::{AgentInfoResponse, AgentListResponse},
        auth::{LoginRequest, SessionLength},
        tokens::{
            AccessTokenResponse, AccessTokenSecretResponse, CreateAccessTokenRequest, DeviceScope,
            Permission,
        },
    },
    ids::AgentId,
};
use reqwest::{Method, RequestBuilder, StatusCode, Url, header};
use tokio::io::AsyncBufReadExt;

use super::{
    client::RemoteClient,
    credentials::{CredentialStore, Credentials},
};

/// How many passwords an interactive login accepts before giving up, like `sudo`.
const PASSWORD_ATTEMPTS: usize = 3;
/// Name of the browser session cookie returned by `POST /api/v1/login`.
const SESSION_COOKIE: &str = "redoor_session";
/// Reported when the user presses Ctrl-C, whichever prompt or request was running.
const LOGIN_CANCELED: &str = "Login canceled";

/// Abstracts terminal interaction so `LoginFlow` ordering and defaults are testable with
/// scripted answers instead of a TTY.
pub(crate) trait Prompter: Send + Sync + 'static {
    /// Free text with an optional prefilled default.
    fn input(&self, prompt: &str, default: Option<&str>) -> Result<String>;
    /// Hidden text.
    fn password(&self, prompt: &str) -> Result<String>;
    /// Any number of items; `defaults` marks the preselected ones.
    fn multi_select(&self, prompt: &str, items: &[String], defaults: &[bool])
    -> Result<Vec<usize>>;
    /// Exactly one item.
    fn select(&self, prompt: &str, items: &[String], default: usize) -> Result<usize>;
    /// Yes or no.
    fn confirm(&self, prompt: &str, default: bool) -> Result<bool>;
}

/// Real prompts on stderr, so stdout stays clean for `create-token` JSON.
pub(crate) struct DialoguerPrompter;

impl DialoguerPrompter {
    /// Restores the cursor after an aborted prompt, which dialoguer may leave hidden, and
    /// reports Ctrl-C (which `console` surfaces as an interrupted read) as a cancellation.
    fn finish<T>(result: dialoguer::Result<T>) -> Result<T> {
        result.map_err(|error| {
            let _ = dialoguer::console::Term::stderr().show_cursor();
            let dialoguer::Error::IO(io) = &error;
            if io.kind() == std::io::ErrorKind::Interrupted {
                // End the prompt line so the message does not run into it.
                eprintln!();
                anyhow::anyhow!(LOGIN_CANCELED)
            } else {
                anyhow::Error::from(error)
            }
        })
    }
}

/// Terminal settings captured before the first prompt, so Ctrl-C can undo what an
/// interrupted prompt changed. A password prompt turns echo off and a selection list hides
/// the cursor; neither is restored when the prompt thread never returns.
struct TerminalState {
    /// `None` when stdin is not a terminal, in which case there is nothing to restore.
    termios: Option<nix::sys::termios::Termios>,
}

impl TerminalState {
    /// Snapshots stdin's terminal settings when prompts will be shown.
    fn capture(interactive: bool) -> Self {
        let termios = interactive
            .then(|| nix::sys::termios::tcgetattr(std::io::stdin()).ok())
            .flatten();
        Self { termios }
    }

    /// Puts echo and the cursor back and ends the half-drawn prompt line.
    fn restore(&self) {
        if let Some(termios) = &self.termios {
            let _ = nix::sys::termios::tcsetattr(
                std::io::stdin(),
                nix::sys::termios::SetArg::TCSANOW,
                termios,
            );
            let _ = dialoguer::console::Term::stderr().show_cursor();
            eprintln!();
        }
    }
}

impl Prompter for DialoguerPrompter {
    /// Reads one line with the default shown and accepted on enter.
    fn input(&self, prompt: &str, default: Option<&str>) -> Result<String> {
        let mut input = dialoguer::Input::<String>::new().with_prompt(prompt);
        if let Some(default) = default {
            input = input.default(default.to_owned());
        }
        Self::finish(input.interact_text_on(&dialoguer::console::Term::stderr()))
    }

    /// Reads a password without echo.
    fn password(&self, prompt: &str) -> Result<String> {
        Self::finish(
            dialoguer::Password::new()
                .with_prompt(prompt)
                .interact_on(&dialoguer::console::Term::stderr()),
        )
    }

    /// Shows a checkbox list.
    fn multi_select(
        &self,
        prompt: &str,
        items: &[String],
        defaults: &[bool],
    ) -> Result<Vec<usize>> {
        Self::finish(
            dialoguer::MultiSelect::new()
                .with_prompt(prompt)
                // The long item descriptions would be echoed as one wrapped line; the
                // confirmation summary lists the choices compactly instead.
                .report(false)
                .items_checked(items.iter().zip(defaults.iter().copied()))
                .interact_on(&dialoguer::console::Term::stderr()),
        )
    }

    /// Shows a single-choice list.
    fn select(&self, prompt: &str, items: &[String], default: usize) -> Result<usize> {
        Self::finish(
            dialoguer::Select::new()
                .with_prompt(prompt)
                .items(items)
                .default(default)
                .interact_on(&dialoguer::console::Term::stderr()),
        )
    }

    /// Asks a yes/no question.
    fn confirm(&self, prompt: &str, default: bool) -> Result<bool> {
        Self::finish(
            dialoguer::Confirm::new()
                .with_prompt(prompt)
                .default(default)
                .interact_on(&dialoguer::console::Term::stderr()),
        )
    }
}

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

/// Parses `--devices` as `all` or a comma-separated list of device names or ids; the server
/// stores the resolved ids, so the scope does not follow a name to another device later.
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

/// Token lifetimes offered by the prompt; short enough by default that a forgotten token
/// expires on its own.
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
    /// Prompt order; the default is the second entry.
    const CHOICES: [Expiry; 4] = [
        Expiry::Days30,
        Expiry::Days90,
        Expiry::Days365,
        Expiry::Never,
    ];

    /// Human label for the prompt.
    fn label(self) -> &'static str {
        match self {
            Expiry::Days30 => "30 days",
            Expiry::Days90 => "90 days",
            Expiry::Days365 => "1 year",
            Expiry::Never => "Never",
        }
    }

    /// The absolute expiry for a token created at `now`.
    fn expires_at(self, now: Timestamp) -> Option<Timestamp> {
        let days = match self {
            Expiry::Days30 => 30,
            Expiry::Days90 => 90,
            Expiry::Days365 => 365,
            Expiry::Never => return None,
        };
        let expiry = now + SignedDuration::from_hours(24 * days);
        // Whole seconds keep the timestamp readable in `status` and the UI.
        Some(expiry.round(Unit::Second).unwrap_or(expiry))
    }
}

/// Options shared by `login` and `create-token`. Every value can be given as a flag; a
/// missing one is prompted for on a terminal, so scripts and humans use the same command.
#[derive(Args, Clone, Debug)]
pub struct TokenRequestArgs {
    /// Server base URL, for example http://127.0.0.1:7666.
    server_url: String,
    /// Login username (default prompt value: $USER).
    #[arg(long)]
    username: Option<String>,
    /// Read the password as one line from stdin instead of prompting (for scripts).
    #[arg(long)]
    password_stdin: bool,
    /// Comma-separated permissions (files:read, files:write, files:delete, commands:execute,
    /// agents:manage) or "all".
    #[arg(long, value_name = "LIST", value_parser = parse_permissions)]
    permissions: Option<PermissionList>,
    /// "all" (including devices added later) or comma-separated device ids.
    #[arg(long, value_name = "all|ID,ID...", value_parser = parse_devices)]
    devices: Option<DeviceScope>,
    /// Token name shown in the UI (default: "redoor remote on <hostname>").
    #[arg(long)]
    name: Option<String>,
    /// Token lifetime.
    #[arg(long, value_enum)]
    expires: Option<Expiry>,
    /// Create the token without the final confirmation.
    #[arg(long)]
    yes: bool,
    /// Skip TLS certificate verification, for a server with a self-signed certificate.
    /// `login` saves this for later commands. Anyone able to intercept the connection could
    /// then read the password and the token.
    /// The falsey parser reads the environment like `insecure_tls_from_environment` does.
    #[arg(
        long,
        env = super::credentials::INSECURE_TLS_ENV,
        value_parser = clap::builder::FalseyValueParser::new()
    )]
    insecure_tls: bool,
}

impl TokenRequestArgs {
    /// Prompts need a terminal on both ends; reading the password from stdin rules them out.
    fn interactive(&self) -> bool {
        !self.password_stdin && std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
    }
}

/// The token to request, resolved from flags, prompts and defaults.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TokenRequestPlan {
    pub(crate) name: String,
    pub(crate) permissions: Vec<Permission>,
    pub(crate) devices: DeviceScope,
    pub(crate) expiry: Expiry,
}

impl TokenRequestPlan {
    /// The REST body for this plan, with the expiry counted from `now`.
    fn request(&self, now: Timestamp) -> CreateAccessTokenRequest {
        CreateAccessTokenRequest {
            name: self.name.clone(),
            permissions: self.permissions.clone(),
            devices: self.devices.clone(),
            expires_at: self.expiry.expires_at(now).map(|value| value.to_string()),
        }
    }
}

/// One `login` or `create-token` run: collects answers, then talks to the server.
pub(crate) struct LoginFlow<P: Prompter> {
    prompter: Arc<P>,
    interactive: bool,
    args: TokenRequestArgs,
}

impl<P: Prompter> LoginFlow<P> {
    /// `interactive` is passed in so tests can script prompts without a terminal.
    pub(crate) fn new(prompter: P, interactive: bool, args: TokenRequestArgs) -> Self {
        Self {
            prompter: Arc::new(prompter),
            interactive,
            args,
        }
    }

    /// Logs in, creates the token and always logs the transient session out again, also
    /// when the user presses Ctrl-C.
    pub(crate) async fn issue(&self) -> Result<(Url, AccessTokenSecretResponse)> {
        let server = RemoteClient::parse_server(&self.args.server_url)?;
        self.require_flags()?;
        let terminal = TerminalState::capture(self.interactive);
        let username = interruptible(&terminal, self.username()).await?;
        if self.args.insecure_tls {
            eprintln!("Warning: TLS certificate verification is disabled for {server}");
        }
        let session = interruptible(&terminal, self.open_session(&server, &username)).await?;
        let result = interruptible(&terminal, async {
            let agents = session.agents().await?;
            let plan = self.plan(&agents).await?;
            if !self.confirm(&plan).await? {
                bail!("Token creation canceled");
            }
            session.create_token(&plan.request(Timestamp::now())).await
        })
        .await;
        // The session was only needed to create the token; leaving it alive would keep a
        // full-access credential around for a week.
        session.logout().await;
        Ok((server, result?))
    }

    /// Without a terminal nothing can be prompted, so every required value must be a flag.
    fn require_flags(&self) -> Result<()> {
        if self.interactive {
            return Ok(());
        }
        let mut missing = Vec::new();
        if self.args.username.is_none() {
            missing.push("--username");
        }
        if !self.args.password_stdin {
            missing.push("--password-stdin");
        }
        if self.args.permissions.is_none() {
            missing.push("--permissions");
        }
        if !missing.is_empty() {
            bail!(
                "Not running interactively; pass {} (see `redoor remote login --help`)",
                missing.join(", ")
            );
        }
        Ok(())
    }

    /// Runs one blocking prompt off the async workers.
    async fn ask<T, F>(&self, question: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&P) -> Result<T> + Send + 'static,
    {
        let prompter = self.prompter.clone();
        tokio::task::spawn_blocking(move || question(&prompter))
            .await
            .context("Prompt task failed")?
    }

    /// The flag, or a prompt prefilled with the local user name.
    async fn username(&self) -> Result<String> {
        if let Some(username) = &self.args.username {
            return Ok(username.clone());
        }
        let default = std::env::var("USER").ok();
        let username = self
            .ask(move |prompter| prompter.input("Username", default.as_deref()))
            .await?;
        Ok(username.trim().to_owned())
    }

    /// Reads the password from stdin for scripts, or prompts without echo.
    async fn password(&self) -> Result<String> {
        if self.args.password_stdin {
            let mut line = String::new();
            tokio::io::BufReader::new(tokio::io::stdin())
                .read_line(&mut line)
                .await?;
            return Ok(line.trim_end_matches(['\r', '\n']).to_owned());
        }
        self.ask(|prompter| prompter.password("Password")).await
    }

    /// Retries a wrong password on a terminal; scripts fail at once.
    async fn open_session(&self, server: &Url, username: &str) -> Result<TransientSession> {
        let attempts = if self.interactive {
            PASSWORD_ATTEMPTS
        } else {
            1
        };
        for attempt in 1..=attempts {
            let password = self.password().await?;
            if let Some(session) =
                TransientSession::open(server, username, password, self.args.insecure_tls).await?
            {
                return Ok(session);
            }
            if attempt < attempts {
                eprintln!("Invalid username or password, try again");
            }
        }
        bail!("Login failed: invalid username or password")
    }

    /// Resolves the token policy from flags, prompts and defaults.
    pub(crate) async fn plan(&self, agents: &[AgentInfoResponse]) -> Result<TokenRequestPlan> {
        Ok(TokenRequestPlan {
            permissions: self.permissions().await?,
            devices: self.devices(agents).await?,
            name: self.name().await?,
            expiry: self.expiry().await?,
        })
    }

    /// Everything but `files:delete` is preselected: delete is only needed by `rm` and `mv`.
    async fn permissions(&self) -> Result<Vec<Permission>> {
        if let Some(PermissionList(permissions)) = &self.args.permissions {
            return Ok(permissions.clone());
        }
        let items = Permission::ALL
            .iter()
            .map(|permission| format!("{} — {}", permission.as_str(), permission.summary()))
            .collect::<Vec<_>>();
        let defaults = Permission::ALL.map(|permission| permission != Permission::FilesDelete);
        loop {
            let (items, defaults) = (items.clone(), defaults.to_vec());
            let chosen = self
                .ask(move |prompter| {
                    prompter.multi_select(
                        "Permissions (space toggles, enter accepts)",
                        &items,
                        &defaults,
                    )
                })
                .await?;
            if !chosen.is_empty() {
                return Ok(chosen
                    .into_iter()
                    .filter_map(|index| Permission::ALL.get(index).copied())
                    .collect());
            }
            eprintln!("Select at least one permission");
        }
    }

    /// All devices by default, which is what the CLI needs; or a chosen subset.
    async fn devices(&self, agents: &[AgentInfoResponse]) -> Result<DeviceScope> {
        if let Some(devices) = &self.args.devices {
            return Ok(devices.clone());
        }
        if !self.interactive {
            return Ok(DeviceScope::All);
        }
        let scopes = vec![
            "All devices (including devices added later)".to_owned(),
            "Only selected devices".to_owned(),
        ];
        let scope = self
            .ask(move |prompter| prompter.select("Devices", &scopes, 0))
            .await?;
        if scope == 0 {
            return Ok(DeviceScope::All);
        }
        if agents.is_empty() {
            bail!("The server has no devices to select");
        }
        let items = agents
            .iter()
            .map(|agent| {
                let status = serde_json::to_value(&agent.status)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "unknown".to_owned());
                // Remote-provided strings are escaped so they cannot control the terminal.
                format!(
                    "{} ({}) — {status}",
                    agent.name.escape_debug(),
                    agent.id.to_string().escape_debug()
                )
            })
            .collect::<Vec<_>>();
        loop {
            let (items, defaults) = (items.clone(), vec![false; agents.len()]);
            let chosen = self
                .ask(move |prompter| prompter.multi_select("Select devices", &items, &defaults))
                .await?;
            if !chosen.is_empty() {
                return Ok(DeviceScope::Only {
                    device_ids: chosen
                        .into_iter()
                        .filter_map(|index| agents.get(index).map(|agent| agent.id.clone()))
                        .collect(),
                });
            }
            eprintln!("Select at least one device");
        }
    }

    /// Defaults to naming the machine, so the UI shows where each token lives.
    async fn name(&self) -> Result<String> {
        if let Some(name) = &self.args.name {
            return Ok(name.clone());
        }
        let hostname = nix::unistd::gethostname()
            .ok()
            .and_then(|name| name.into_string().ok())
            .unwrap_or_else(|| "this machine".to_owned());
        let default = format!("redoor remote on {hostname}");
        if !self.interactive {
            return Ok(default);
        }
        let name = self
            .ask(move |prompter| prompter.input("Token name", Some(&default)))
            .await?;
        Ok(name.trim().to_owned())
    }

    /// 90 days unless chosen otherwise.
    async fn expiry(&self) -> Result<Expiry> {
        if let Some(expiry) = self.args.expires {
            return Ok(expiry);
        }
        if !self.interactive {
            return Ok(Expiry::Days90);
        }
        let labels = Expiry::CHOICES
            .iter()
            .map(|choice| choice.label().to_owned())
            .collect::<Vec<_>>();
        let index = self
            .ask(move |prompter| prompter.select("Expires", &labels, 1))
            .await?;
        Ok(Expiry::CHOICES
            .get(index)
            .copied()
            .unwrap_or(Expiry::Days90))
    }

    /// Shows what will be granted and asks once, unless told not to.
    async fn confirm(&self, plan: &TokenRequestPlan) -> Result<bool> {
        if self.args.yes || !self.interactive {
            return Ok(true);
        }
        let expiry = match plan.expiry {
            Expiry::Never => "never expires".to_owned(),
            expiry => format!("expires in {}", expiry.label().to_lowercase()),
        };
        eprintln!(
            "Token \"{}\": {}; {}; {expiry}",
            plan.name,
            permission_names(&plan.permissions),
            device_summary(&plan.devices),
        );
        self.ask(|prompter| prompter.confirm("Create token?", true))
            .await
    }
}

/// Runs one login phase until it finishes or the user presses Ctrl-C.
///
/// Handling the signal here, instead of letting it kill the process, is what lets `issue`
/// still log the transient session out and give the terminal back in a usable state. A
/// blocked prompt thread is abandoned; `main` does not wait for blocking tasks on exit.
async fn interruptible<T>(
    terminal: &TerminalState,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        result = work => result,
        _ = tokio::signal::ctrl_c() => canceled(terminal),
    }
}

/// Restores the terminal and reports the cancellation.
fn canceled<T>(terminal: &TerminalState) -> Result<T> {
    terminal.restore();
    bail!(LOGIN_CANCELED)
}

/// A browser session that exists only while a token is being created.
struct TransientSession {
    http: reqwest::Client,
    server: Url,
    cookie: String,
}

impl TransientSession {
    /// Logs in; `None` means the server rejected the username or password.
    async fn open(
        server: &Url,
        username: &str,
        password: String,
        insecure_tls: bool,
    ) -> Result<Option<Self>> {
        let http = RemoteClient::transport(insecure_tls)?;
        let response = http
            .post(server.join("api/v1/login")?)
            .timeout(std::time::Duration::from_secs(30))
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&LoginRequest {
                username: username.to_owned(),
                password,
                // The session only lives while the token is created, so the shortest length
                // leaves the least behind if the logout at the end fails.
                session_length: SessionLength::Hour,
            })?)
            .send()
            .await
            .context("Login request failed")?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        let response = RemoteClient::check_response(response).await?;
        let cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(|value| {
                let pair = value.split(';').next()?.trim();
                pair.strip_prefix(SESSION_COOKIE)?
                    .strip_prefix('=')
                    .filter(|session| !session.is_empty())
                    .map(|_| pair.to_owned())
            })
            .context("Login did not return a session cookie")?;
        Ok(Some(Self {
            http,
            server: server.clone(),
            cookie,
        }))
    }

    /// Builds a request carrying the session cookie.
    fn request(&self, method: Method, path: &str) -> Result<RequestBuilder> {
        Ok(self
            .http
            .request(method, self.server.join(path)?)
            .timeout(std::time::Duration::from_secs(30))
            .header(header::COOKIE, &self.cookie))
    }

    /// Device inventory for the device prompt.
    async fn agents(&self) -> Result<Vec<AgentInfoResponse>> {
        let response = self.request(Method::GET, "api/v1/agents")?.send().await?;
        let response = RemoteClient::check_response(response).await?;
        let list: AgentListResponse =
            serde_json::from_slice(&response.bytes().await?).context("Invalid device list")?;
        Ok(list.agents)
    }

    /// Creates the token; the response holds the only copy of its secret.
    async fn create_token(
        &self,
        request: &CreateAccessTokenRequest,
    ) -> Result<AccessTokenSecretResponse> {
        let response = self
            .request(Method::POST, "api/v1/tokens")?
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(request)?)
            .send()
            .await?;
        let response = RemoteClient::check_response(response).await?;
        serde_json::from_slice(&response.bytes().await?).context("Invalid token response")
    }

    /// Best effort: a failed logout leaves a session that still expires on its own.
    async fn logout(self) {
        if let Ok(request) = self.request(Method::POST, "api/v1/logout") {
            let _ = request.send().await;
        }
    }
}

/// `redoor remote login`: saves the new token, replacing (and revoking) a previous login to
/// the same server so re-logins do not leave orphan tokens behind.
pub(crate) async fn login(store: CredentialStore, args: TokenRequestArgs) -> Result<()> {
    let interactive = args.interactive();
    let insecure_tls = args.insecure_tls;
    let (server, issued) = LoginFlow::new(DialoguerPrompter, interactive, args)
        .issue()
        .await?;
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
/// saves nothing, replacing the old server-side token command.
pub(crate) async fn create_token(args: TokenRequestArgs) -> Result<()> {
    let interactive = args.interactive();
    let (server, issued) = LoginFlow::new(DialoguerPrompter, interactive, args)
        .issue()
        .await?;
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
