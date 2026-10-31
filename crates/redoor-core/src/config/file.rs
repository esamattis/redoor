//! Serde model of the TOML file plus the semantic checks serde cannot express.
//!
//! The raw structs mirror the file one-to-one so `deny_unknown_fields` surfaces typos
//! with the offending line, and type/range errors come from serde with the exact
//! location. Everything that depends on more than one key (credential pairs,
//! local-vs-SSH entries, duplicate identities, platform support) lives in
//! the `validate` methods, which produce the public, already-checked config types.

use std::collections::HashSet;
use std::path::PathBuf;

use redoor_protocol::ids::{AgentId, validate_device_name};
use serde::Deserialize;

use super::{
    AgentConfig, AgentSection, AuthMode, LocalAgentConfig, OidcConfig, RedoorConfig, RelayConfig,
    ServerSection, SshBackedAgentConfig, parse_relay_id, parse_server_username,
};

/// Whole-document shape; every section is optional because roles validate their own needs.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawConfig {
    /// Shared registration secret; required, but checked in `validate` for a clearer message.
    agent_token: Option<String>,
    server: Option<RawServerSection>,
    agent: Option<RawAgentSection>,
    #[serde(default)]
    agents: Vec<RawAgentEntry>,
    #[serde(default)]
    relays: Vec<RawRelay>,
}

/// `[server]` as written; credentials stay optional until the pair rule is applied.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawServerSection {
    port: Option<u16>,
    bind: Option<String>,
    log: Option<String>,
    log_max_size: Option<RawByteSize>,
    log_level: Option<String>,
    log_format: Option<String>,
    username: Option<String>,
    password: Option<String>,
    #[serde(default)]
    cookie_secure: bool,
    #[serde(default)]
    mcp_allowed_origins: Vec<String>,
    oidc: Option<RawOidcSection>,
}

/// `[server.oidc]` as written; required keys are checked in `validate` for clearer messages.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOidcSection {
    issuer: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    redirect_url: Option<String>,
    allowed_groups: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    provider_name: Option<String>,
    session_lifetime_days: Option<u64>,
}

/// Default idle lifetime of OIDC sessions: long enough that daily use rarely revisits the
/// provider, short enough that an abandoned browser stops working within a month.
const DEFAULT_OIDC_SESSION_LIFETIME_DAYS: u64 = 30;
/// Scopes that release the subject, display name and `groups` claim on common providers.
const DEFAULT_OIDC_SCOPES: [&str; 3] = ["openid", "profile", "groups"];
/// Browsers cap cookie lifetimes at 400 days, so longer server-side sessions would be unusable.
const MAX_OIDC_SESSION_LIFETIME_DAYS: u64 = 400;

/// `[agent]` as written.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentSection {
    partial_max_age_days: Option<u64>,
    server: Option<String>,
    name: Option<String>,
    home: Option<String>,
    log: Option<String>,
    log_max_size: Option<RawByteSize>,
    log_level: Option<String>,
    log_format: Option<String>,
}

/// One `[[agents]]` row; the union of SSH and local keys because `local` selects the kind.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentEntry {
    id: Option<String>,
    #[serde(default)]
    local: bool,
    target: Option<String>,
    username: Option<String>,
    ssh_port: Option<u16>,
    name: Option<String>,
    remote_bin: Option<String>,
    home: Option<String>,
    log: Option<String>,
    password: Option<String>,
    managed_ssh_key: Option<bool>,
}

/// One `[[relays]]` row.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRelay {
    id: Option<String>,
    agent_id: Option<String>,
    target: Option<String>,
    server: Option<String>,
    username: Option<String>,
    ssh_port: Option<u16>,
    name: Option<String>,
    remote_bin: Option<String>,
    binary_source: Option<String>,
    home: Option<String>,
    log: Option<String>,
    log_max_size: Option<RawByteSize>,
    #[serde(default)]
    insecure: bool,
    agent_app_name: Option<String>,
    password: Option<String>,
}

/// A size as written: plain bytes, or a string with a unit such as `"10MB"`.
///
/// Both forms are accepted because sizes like ten megabytes are unreadable as bytes, while
/// scripts that generate the file find plain integers easiest.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawByteSize {
    /// Exact byte count.
    Bytes(u64),
    /// Number with an optional `B`, `KB`, `MB` or `GB` suffix.
    Text(String),
}

impl RawByteSize {
    /// Resolves the byte count; zero is rejected because a log that may hold nothing
    /// would be emptied on every check.
    fn parse(self, key: &str) -> Result<u64, Invalid> {
        let bytes = match self {
            Self::Bytes(bytes) => Some(bytes),
            Self::Text(text) => Self::parse_text(&text),
        };
        bytes.filter(|bytes| *bytes > 0).ok_or_else(|| {
            invalid(format!(
                "{key} must be a positive byte count or a size such as \"512KB\", \"10MB\" or \"1GB\""
            ))
        })
    }

    /// Parses `<number><unit>` with binary multiples, matching how `ls -h` and most log
    /// tools report sizes.
    fn parse_text(text: &str) -> Option<u64> {
        let text = text.trim();
        let digits_end = text
            .find(|character: char| !character.is_ascii_digit())
            .unwrap_or(text.len());
        let (number, unit) = text.split_at(digits_end);
        let multiplier: u64 = match unit.trim().to_ascii_uppercase().as_str() {
            "" | "B" => 1,
            "K" | "KB" | "KIB" => 1024,
            "M" | "MB" | "MIB" => 1024 * 1024,
            "G" | "GB" | "GIB" => 1024 * 1024 * 1024,
            _ => return None,
        };
        number.parse::<u64>().ok()?.checked_mul(multiplier)
    }
}

/// Parses an optional size key with its path in the error.
fn parse_byte_size(value: Option<RawByteSize>, key: &str) -> Result<Option<u64>, Invalid> {
    value.map(|value| value.parse(key)).transpose()
}

/// A violated cross-key rule; the text names the key path and how to fix it.
///
/// Kept private and path-less: `parse_config_str` attaches the file path when it turns
/// this into the public [`super::Invalid`].
pub(super) struct Invalid(pub(super) String);

/// Shorthand for building a rule violation from any message.
fn invalid(message: impl Into<String>) -> Invalid {
    Invalid(message.into())
}

impl RawConfig {
    /// Applies cross-key rules and converts into the public config model.
    pub(super) fn validate(self) -> Result<RedoorConfig, Invalid> {
        let agent_token = self
            .agent_token
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                invalid(
                    "agent_token must be a non-empty string at the top level of the config file",
                )
            })?;
        let server = self.server.map(RawServerSection::validate).transpose()?;
        let agent = self.agent.map(RawAgentSection::validate).transpose()?;
        let agents = self
            .agents
            .into_iter()
            .enumerate()
            .map(|(index, entry)| entry.validate(index))
            .collect::<Result<Vec<_>, _>>()?;
        let mut relays: Vec<RelayConfig> = Vec::with_capacity(self.relays.len());
        for (index, relay) in self.relays.into_iter().enumerate() {
            let relay = relay.validate(index)?;
            if relays.iter().any(|existing| existing.id == relay.id) {
                return Err(invalid(format!("duplicate relay ID '{}'", relay.id)));
            }
            relays.push(relay);
        }
        reject_duplicate_device_ids(&agents, &relays)?;
        Ok(RedoorConfig {
            agent_token,
            server,
            agent,
            agents,
            relays,
        })
    }
}

/// Rejects two entries with the same device id, naming both.
///
/// Copying an `[[agents]]` or `[[relays]]` block copies its id, which would silently merge
/// two devices. Ids are opaque, so a duplicate is never intended and every role may refuse it.
fn reject_duplicate_device_ids(
    agents: &[AgentConfig],
    relays: &[RelayConfig],
) -> Result<(), Invalid> {
    let agent_ids = agents.iter().enumerate().filter_map(|(index, agent)| {
        agent.id().map(|id| {
            (
                id,
                format!("[[agents]] entry #{index} ('{}')", agent.effective_name()),
            )
        })
    });
    let relay_ids = relays.iter().filter_map(|relay| {
        relay
            .agent
            .id
            .as_ref()
            .map(|id| (id, format!("[[relays]] entry '{}'", relay.id)))
    });
    let mut seen: Vec<(&AgentId, String)> = Vec::new();
    for (id, label) in agent_ids.chain(relay_ids) {
        if let Some((_, first)) = seen.iter().find(|(existing, _)| *existing == id) {
            return Err(invalid(format!(
                "duplicate device id '{id}' in {first} and {label}; remove the id from the copied entry so a new one is generated"
            )));
        }
        seen.push((id, label));
    }
    Ok(())
}

/// Rejects managed rows whose effective names break the device name rules or collide,
/// before any supervisor exists.
///
/// Not part of `validate`: only the server registers managed agents, so other roles reading
/// the same file (logs, relays, service install) must not fail on it.
pub(super) fn validate_managed_agent_names(agents: &[AgentConfig]) -> Result<(), Invalid> {
    let mut names = HashSet::new();
    for (index, agent) in agents.iter().enumerate() {
        let name = agent.effective_name();
        validate_device_name(&name)
            .map_err(|error| invalid(format!("agents entry #{index}: {error}")))?;
        if !names.insert(name.clone()) {
            return Err(invalid(format!(
                "duplicate managed agent name '{name}' in [[agents]]; set a distinct 'name' on one of the entries"
            )));
        }
    }
    Ok(())
}

/// Parses an optional configured device id with the entry label in the error.
fn parse_optional_id(value: Option<String>, label: &str) -> Result<Option<AgentId>, Invalid> {
    value
        .map(|value| AgentId::parse(&value).map_err(|error| invalid(format!("{label}: {error}"))))
        .transpose()
}

impl RawServerSection {
    /// Resolves the login backend and checks values serde only sees as plain strings.
    fn validate(self) -> Result<ServerSection, Invalid> {
        let log_level = parse_named(self.log_level, "server.log_level")?;
        let log_format = parse_named(self.log_format, "server.log_format")?;
        let username = self
            .username
            .map(|value| parse_server_username(&value).map_err(invalid))
            .transpose()?;
        if self.password.as_deref() == Some("") {
            return Err(invalid(
                "server.password must be a non-empty string when set",
            ));
        }
        // Requiring the pair keeps a half-configured file from silently falling back to
        // system auth while still embedding one of the secrets.
        let auth = match (username, self.password) {
            (Some(username), Some(password)) => AuthMode::Configured { username, password },
            (Some(_), None) => {
                return Err(invalid(
                    "server.password is required when server.username is set",
                ));
            }
            (None, Some(_)) => {
                return Err(invalid(
                    "server.username is required when server.password is set",
                ));
            }
            (None, None) => system_account_auth()?,
        };
        if let Some(origin) = self
            .mcp_allowed_origins
            .iter()
            .find(|origin| !origin.starts_with("http://") && !origin.starts_with("https://"))
        {
            return Err(invalid(format!(
                "server.mcp_allowed_origins entries must be absolute HTTP(S) origins; got '{origin}'"
            )));
        }
        Ok(ServerSection {
            port: self.port,
            bind: self.bind,
            log: self.log,
            log_max_size: parse_byte_size(self.log_max_size, "server.log_max_size")?,
            log_level,
            log_format,
            auth,
            cookie_secure: self.cookie_secure,
            mcp_allowed_origins: self.mcp_allowed_origins,
            oidc: self.oidc.map(RawOidcSection::validate).transpose()?,
        })
    }
}

impl RawOidcSection {
    /// Requires every key the authorization code flow needs and rejects settings that would
    /// weaken it, so a typo fails at startup instead of at the first sign-in.
    fn validate(self) -> Result<OidcConfig, Invalid> {
        let required = |value: Option<String>, key: &str| match value {
            Some(value) if !value.trim().is_empty() => Ok(value),
            _ => Err(invalid(format!(
                "server.oidc.{key} is required and must be non-empty"
            ))),
        };
        let issuer = required(self.issuer, "issuer")?;
        let client_id = required(self.client_id, "client_id")?;
        let client_secret = required(self.client_secret, "client_secret")?;
        let redirect_url = required(self.redirect_url, "redirect_url")?;
        let issuer_url = parse_oidc_url(&issuer, "issuer")?;
        if issuer_url.query().is_some() || issuer_url.fragment().is_some() {
            return Err(invalid(
                "server.oidc.issuer must not contain a query or fragment",
            ));
        }
        let redirect_url = parse_oidc_url(&redirect_url, "redirect_url")?;
        if !redirect_url.path().ends_with(OIDC_CALLBACK_PATH) {
            return Err(invalid(format!(
                "server.oidc.redirect_url must end with {OIDC_CALLBACK_PATH}"
            )));
        }
        // Omitting the key is the explicit way to allow every account. An empty list is
        // refused instead of guessed at, because it could mean "nobody" as well as "anybody".
        let allowed_groups = match self.allowed_groups {
            None => None,
            Some(groups) => {
                let groups: Vec<String> = groups
                    .into_iter()
                    .filter(|group| !group.trim().is_empty())
                    .collect();
                if groups.is_empty() {
                    return Err(invalid(
                        "server.oidc.allowed_groups must list at least one group; omit it to allow every account",
                    ));
                }
                Some(groups)
            }
        };
        let days = self
            .session_lifetime_days
            .unwrap_or(DEFAULT_OIDC_SESSION_LIFETIME_DAYS);
        if !(1..=MAX_OIDC_SESSION_LIFETIME_DAYS).contains(&days) {
            return Err(invalid(format!(
                "server.oidc.session_lifetime_days must be between 1 and {MAX_OIDC_SESSION_LIFETIME_DAYS}"
            )));
        }
        let provider_name = match self.provider_name {
            Some(name) if name.trim().is_empty() => {
                return Err(invalid(
                    "server.oidc.provider_name must be non-empty when set",
                ));
            }
            Some(name) => name,
            None => "single sign-on".to_string(),
        };
        let mut scopes = self.scopes.unwrap_or_else(|| {
            DEFAULT_OIDC_SCOPES
                .iter()
                .map(|scope| scope.to_string())
                .collect()
        });
        if let Some(scope) = scopes
            .iter()
            .find(|scope| scope.is_empty() || scope.contains(char::is_whitespace))
        {
            return Err(invalid(format!(
                "server.oidc.scopes entries must be single non-empty words; got '{scope}'"
            )));
        }
        // OIDC providers only return an ID token for the `openid` scope.
        if !scopes.iter().any(|scope| scope == "openid") {
            scopes.insert(0, "openid".to_string());
        }
        Ok(OidcConfig {
            issuer,
            client_id,
            client_secret,
            redirect_url,
            allowed_groups,
            scopes,
            provider_name,
            session_lifetime: std::time::Duration::from_secs(days * 24 * 60 * 60),
        })
    }
}

/// Route that finishes OIDC sign-in; the configured redirect URL must point at it.
pub(super) const OIDC_CALLBACK_PATH: &str = "/api/v1/auth/oidc/callback";

/// Accepts HTTPS everywhere and plain HTTP only for loopback hosts, so codes, tokens and the
/// client secret never cross a network unencrypted while local test providers still work.
fn parse_oidc_url(value: &str, key: &str) -> Result<url::Url, Invalid> {
    let url = url::Url::parse(value)
        .map_err(|error| invalid(format!("server.oidc.{key} is not a valid URL: {error}")))?;
    if OidcConfig::is_secure_url(&url) {
        Ok(url)
    } else {
        Err(invalid(format!(
            "server.oidc.{key} must be an https:// URL (http:// is only allowed for localhost)"
        )))
    }
}

/// Selects PAM login where it exists; other platforms need explicit TOML credentials.
fn system_account_auth() -> Result<AuthMode, Invalid> {
    #[cfg(target_os = "linux")]
    {
        Ok(AuthMode::SystemAccount)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(invalid(
            "server.username and server.password are required on this platform; system-account (PAM) login is only supported on Linux",
        ))
    }
}

impl RawAgentSection {
    /// Rejects empty overrides and parses the enum-like settings.
    fn validate(self) -> Result<AgentSection, Invalid> {
        let non_empty = |value: Option<String>, key: &str| match value {
            Some(value) if value.is_empty() => Err(invalid(format!(
                "agent.{key} must be a non-empty string when set"
            ))),
            other => Ok(other),
        };
        Ok(AgentSection {
            partial_max_age_days: self.partial_max_age_days,
            server: non_empty(self.server, "server")?,
            name: non_empty(self.name, "name")?,
            home: non_empty(self.home, "home")?,
            log: non_empty(self.log, "log")?,
            log_max_size: parse_byte_size(self.log_max_size, "agent.log_max_size")?,
            log_level: parse_named(non_empty(self.log_level, "log_level")?, "agent.log_level")?,
            log_format: parse_named(
                non_empty(self.log_format, "log_format")?,
                "agent.log_format",
            )?,
        })
    }
}

impl RawAgentEntry {
    /// Splits the row into the SSH or local model selected by `local`.
    fn validate(mut self, index: usize) -> Result<AgentConfig, Invalid> {
        let home = self.home.take();
        if self.local {
            self.validate_local(index, home)
        } else {
            self.validate_ssh(index, home)
        }
    }

    /// Rejects SSH-only keys so a pasted SSH row with `local = true` fails clearly instead of
    /// starting an agent that silently ignores them.
    fn validate_local(self, index: usize, home: Option<String>) -> Result<AgentConfig, Invalid> {
        if self.target.is_some() {
            return Err(invalid(format!(
                "agents entry #{index} has both 'local = true' and a 'target'; local agents do not use ssh, remove 'target'"
            )));
        }
        let ssh_only = [
            ("username", self.username.is_some()),
            ("ssh_port", self.ssh_port.is_some()),
            ("remote_bin", self.remote_bin.is_some()),
            ("password", self.password.is_some()),
            ("managed_ssh_key", self.managed_ssh_key.is_some()),
        ];
        if let Some((key, _)) = ssh_only.into_iter().find(|(_, present)| *present) {
            return Err(invalid(format!(
                "agents entry #{index} has '{key}' which only applies to SSH-backed agents (local = true); remove '{key}'"
            )));
        }
        Ok(AgentConfig::Local(LocalAgentConfig {
            id: parse_optional_id(self.id, &format!("agents entry #{index} 'id'"))?,
            name: self.name,
            home,
            log: self.log,
        }))
    }

    /// Requires the SSH destination; every other field defers to OpenSSH or agent defaults.
    fn validate_ssh(self, index: usize, home: Option<String>) -> Result<AgentConfig, Invalid> {
        let target = self.target.ok_or_else(|| {
            invalid(format!(
                "agents entry #{index} is missing a 'target' string"
            ))
        })?;
        if self.password.as_deref() == Some("") {
            return Err(invalid(format!(
                "agents entry #{index} 'password' must be non-empty when set"
            )));
        }
        let managed_ssh_key = self.managed_ssh_key.unwrap_or(false);
        if managed_ssh_key {
            // A managed key turns password logins off, so both together is a hand edit gone wrong.
            if self.password.is_some() {
                return Err(invalid(format!(
                    "agents entry #{index} has both 'managed_ssh_key' and 'password'; remove 'password'"
                )));
            }
            // The key is stored under the device id, so a key without one is unusable.
            if self.id.is_none() {
                return Err(invalid(format!(
                    "agents entry #{index} has 'managed_ssh_key' but no 'id'"
                )));
            }
        }
        Ok(AgentConfig::SshBacked(SshBackedAgentConfig {
            id: parse_optional_id(self.id, &format!("agents entry #{index} 'id'"))?,
            username: self.username,
            ssh_port: self.ssh_port,
            name: self.name,
            remote_bin: self.remote_bin,
            home,
            target,
            log: self.log,
            password: self.password,
            managed_ssh_key,
        }))
    }
}

impl RawRelay {
    /// Checks identity, URL and TLS settings before any PID file or SSH session exists.
    fn validate(self, index: usize) -> Result<RelayConfig, Invalid> {
        let non_blank = |value: Option<String>, key: &str| match value {
            Some(value) if value.trim().is_empty() => Err(invalid(format!(
                "relays entry #{index} '{key}' must be non-empty"
            ))),
            other => Ok(other),
        };
        let required = |value: Option<String>, key: &str| {
            non_blank(value, key)?.ok_or_else(|| {
                invalid(format!("relays entry #{index} is missing a '{key}' string"))
            })
        };
        let id = parse_relay_id(&required(self.id, "id")?).map_err(invalid)?;
        let target = required(self.target, "target")?;
        let server = required(self.server, "server")?;
        let server_address = server
            .parse::<crate::server_address::ServerAddress>()
            .map_err(|error| invalid(format!("invalid server in relay '{id}': {error}")))?;
        if self.insecure && !server_address.is_secure() {
            return Err(invalid(format!(
                "relay '{id}' insecure = true requires an https:// or wss:// server URL"
            )));
        }
        let agent_app_name = non_blank(self.agent_app_name, "agent_app_name")?
            .map(|value| crate::app_name::parse_app_name(&value).map_err(invalid))
            .transpose()?;
        let agent_id = parse_optional_id(self.agent_id, &format!("relay '{id}' 'agent_id'"))?;
        let log_max_size = parse_byte_size(
            self.log_max_size,
            &format!("relays entry #{index} 'log_max_size'"),
        )?;
        Ok(RelayConfig {
            id,
            server,
            log_max_size,
            insecure: self.insecure,
            binary_source: non_blank(self.binary_source, "binary_source")?.map(PathBuf::from),
            agent_app_name,
            agent: SshBackedAgentConfig {
                id: agent_id,
                username: non_blank(self.username, "username")?,
                ssh_port: self.ssh_port,
                name: non_blank(self.name, "name")?,
                remote_bin: non_blank(self.remote_bin, "remote_bin")?,
                home: non_blank(self.home, "home")?,
                target,
                log: non_blank(self.log, "log")?,
                password: non_blank(self.password, "password")?,
                // Relays keep using the account's own credentials; managed keys are server-only.
                managed_ssh_key: false,
            },
        })
    }
}

/// Parses an enum-like string setting with the type's own vocabulary and the key path.
fn parse_named<T>(value: Option<String>, key: &str) -> Result<Option<T>, Invalid>
where
    T: std::str::FromStr<Err = String>,
{
    value
        .map(|value| {
            value
                .parse::<T>()
                .map_err(|error| invalid(format!("{key}: {error}")))
        })
        .transpose()
}
