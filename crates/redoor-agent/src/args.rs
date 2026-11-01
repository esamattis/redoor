//! Command-line arguments of `redoor agent`.

use clap::Args;
use redoor_core::logging::LogFormat;
use redoor_protocol::wire::log::Level;

/// Arguments for `redoor agent`.
///
/// Every field is `Option` so `agent::run` can apply the same
/// CLI > env > config file > default precedence as the server. Clap `env`
/// fills configurable fields when their flags are omitted.
#[derive(Args)]
#[command(author, version, about)]
pub struct AgentArgs {
    /// Detach the agent from the terminal and continue running in the background.
    #[arg(long)]
    pub daemon: bool,
    /// Redoor server URL (`http(s)://` or `ws(s)://`) without pathnname
    #[arg(env = "REDOOR_AGENT_WS")]
    pub(crate) server: Option<String>,
    /// Physical TCP endpoint used by an SSH tunnel while the URL retains TLS and HTTP identity.
    #[arg(long, hide = true)]
    pub(crate) connect_address: Option<String>,
    /// Skip TLS certificate verification, for a server with a self-signed certificate.
    /// Anyone able to intercept the connection could then impersonate the server.
    /// Also set by `REDOOR_AGENT_INSECURE_TLS` and `[agent].insecure_tls`.
    /// The falsey parser lets the environment use `1`/`0` and empty values, not only
    /// `true`/`false`.
    #[arg(
        long,
        env = "REDOOR_AGENT_INSECURE_TLS",
        value_parser = clap::builder::FalseyValueParser::new()
    )]
    pub(crate) insecure_tls: bool,
    /// Ties an SSH-launched agent to its relay session so a lost channel cannot orphan it.
    #[arg(long, hide = true)]
    pub(crate) exit_on_stdin_eof: bool,
    /// Registration name shown in the UI. Defaults to the computer hostname.
    /// Overrides `REDOOR_AGENT_NAME` and `[agent].name`.
    #[arg(long, env = "REDOOR_AGENT_NAME")]
    pub(crate) name: Option<String>,
    /// Device id assigned by the server or relay config for managed agents. When set, the
    /// agent never reads or writes `<data_dir>/agent-id`, because several managed entries may
    /// share one data dir.
    #[arg(long, hide = true)]
    pub(crate) agent_id: Option<String>,
    /// Shared secret from top-level `agent_token` so registration cannot be spoofed.
    /// Overrides `REDOOR_AGENT_TOKEN` and the config file.
    #[arg(long, env = "REDOOR_AGENT_TOKEN")]
    pub(crate) token: Option<String>,
    /// Path to the shared TOML config. Defaults under `/etc/<app-name>` when
    /// root, otherwise `~/.config/<app-name>`.
    #[arg(long)]
    pub(crate) config: Option<String>,
    /// Agent log file path. Overrides `REDOOR_AGENT_LOG` and `[agent].log`.
    /// Defaults to `~/.local/share/<app-name>/agent.log` for non-root users.
    #[arg(long, env = "REDOOR_AGENT_LOG")]
    pub(crate) log: Option<String>,
    /// Initial threshold. CLI overrides role environment, TOML, and the info default.
    #[arg(long = "log-level")]
    pub(crate) log_level: Option<Level>,
    /// Process output format. CLI overrides role environment, TOML, and line.
    #[arg(long = "log-format")]
    pub(crate) log_format: Option<LogFormat>,
    /// Home directory opened by the UI without limiting filesystem access.
    /// Overrides `REDOOR_AGENT_HOME` and `[agent].home`.
    #[arg(long, env = "REDOOR_AGENT_HOME")]
    pub(crate) home: Option<String>,
    /// Overrides platform mount discovery with one exact same-device trash root.
    #[arg(long, env = "REDOOR_AGENT_TRASH_DIRECTORY")]
    pub(crate) trash_directory: Option<String>,
    /// Seconds to wait after connecting before notifying the desktop, or `off` to disable it.
    #[arg(
        long,
        env = "REDOOR_AGENT_NOTIFICATION",
        default_value = "5",
        value_parser = parse_notification_delay
    )]
    pub(crate) notification: Option<NotificationDelay>,
}

impl AgentArgs {
    /// Whether CLI/env already supply the two settings no default can replace.
    ///
    /// When they do, a missing conventional config file is fine; otherwise the agent
    /// prompts for a pasted config instead of failing later with a missing-server error.
    pub(crate) fn has_required_settings(&self) -> bool {
        self.server
            .as_deref()
            .is_some_and(|value| !value.is_empty())
            && self.token.as_deref().is_some_and(|value| !value.is_empty())
    }
}

/// Parsed startup-notification setting kept explicit so disabling cannot resemble a valid delay.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NotificationDelay {
    /// Suppresses startup desktop notifications entirely.
    Off,
    /// Waits this many whole seconds after a fully authenticated connection.
    Seconds(u64),
}

/// Accepts a non-negative whole-second delay or the explicit `off` switch.
fn parse_notification_delay(value: &str) -> Result<NotificationDelay, String> {
    if value.eq_ignore_ascii_case("off") {
        return Ok(NotificationDelay::Off);
    }

    value
        .parse::<u64>()
        .map(NotificationDelay::Seconds)
        .map_err(|_| "notification delay must be a whole number of seconds or 'off'".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keeps the human-readable disable value distinct from numeric delays.
    #[test]
    fn parses_notification_off_switch() {
        // Case-insensitive parsing avoids surprising environment configuration differences.
        assert_eq!(parse_notification_delay("OFF"), Ok(NotificationDelay::Off));
    }

    /// Prevents the removed numeric sentinel from remaining an undocumented compatibility path.
    #[test]
    fn rejects_negative_notification_delay() {
        // Only non-negative seconds or the explicit `off` value are valid.
        assert!(parse_notification_delay("-1").is_err());
    }
}
