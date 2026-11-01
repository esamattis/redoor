//! Usage examples shown at the end of each `redoor server|agent|upgrade ...` command's `--help`.
//!
//! The startup flags, utility subcommands and service managers share one namespace per role,
//! so examples show which invocations start a process and which only manage one. They live
//! together so the wording, URLs and relay IDs stay consistent across commands.

/// Shown by `redoor server --help`.
pub(crate) const SERVER: &str = "Examples:
  # Run the server in the foreground with the default config
  redoor server

  # Listen on all interfaces on a custom port
  redoor server --bind 0.0.0.0 --port 8080

  # Use a specific config file and run in the background
  redoor server --config ./config.toml --daemon

  # Log debug output as JSON lines
  redoor server --log-level debug --log-format json

  # Keep a separate config, data and service namespace
  redoor --app-name redoor-staging server";

/// Shown by `redoor server stop --help`.
pub(crate) const SERVER_STOP: &str = "Examples:
  # Stop a server started with --daemon
  redoor server stop";

/// Shown by `redoor server status --help`.
pub(crate) const SERVER_STATUS: &str = "Examples:
  # Check whether the server is running
  redoor server status";

/// Shown by `redoor server logs --help`.
pub(crate) const SERVER_LOGS: &str = "Examples:
  # Print the last 500 log lines
  redoor server logs

  # Print the last 50 lines and keep following new entries
  redoor server logs -n 50 -f

  # Read the log of a server using another config file
  redoor server logs --config ./config.toml";

/// Shown by `redoor server systemd --help`.
pub(crate) const SERVER_SYSTEMD: &str = "Examples:
  # Install and start a user service for the current user
  redoor server systemd install --start

  # Install and start a system service
  sudo redoor server systemd install --start

  # Check the service state
  redoor server systemd status";

/// Shown by `redoor server launchd --help`.
pub(crate) const SERVER_LAUNCHD: &str = "Examples:
  # Install and start the server as a LaunchAgent
  redoor server launchd install --start

  # Restart it after changing the config
  redoor server launchd restart";

/// Shown by `redoor agent --help`.
pub(crate) const AGENT: &str = "Examples:
  # Connect to a server, reading the token from the environment
  REDOOR_AGENT_TOKEN=secret redoor agent https://redoor.example.com

  # Pass the token and the name shown in the UI as flags
  redoor agent https://redoor.example.com --token secret --name laptop

  # Use the server URL and token from a config file and run in the background
  redoor agent --config ./config.toml --daemon

  # Open the UI in another directory and disable the desktop notification
  redoor agent https://redoor.example.com --home /srv --notification off

  # Connect to a server that uses a self-signed certificate
  redoor agent https://192.168.1.10:7666 --token secret --insecure-tls";

/// Shown by `redoor agent stop --help`.
pub(crate) const AGENT_STOP: &str = "Examples:
  # Stop an agent started with --daemon
  redoor agent stop";

/// Shown by `redoor agent status --help`.
pub(crate) const AGENT_STATUS: &str = "Examples:
  # Check whether the standalone agent is running
  redoor agent status";

/// Shown by `redoor agent logs --help`.
pub(crate) const AGENT_LOGS: &str = "Examples:
  # Print the last 500 log lines
  redoor agent logs

  # Print the last 50 lines and keep following new entries
  redoor agent logs -n 50 -f

  # Read a log file in a custom location
  redoor agent logs --log /var/log/redoor-agent.log";

/// Shown by `redoor agent systemd --help`.
pub(crate) const AGENT_SYSTEMD: &str = "Examples:
  # Install and start a user service for the current user
  redoor agent systemd install --start

  # Install and start a system service
  sudo redoor agent systemd install --start

  # Stop the agent and keep it from starting at boot
  redoor agent systemd disable --now";

/// Shown by `redoor agent launchd --help`.
pub(crate) const AGENT_LAUNCHD: &str = "Examples:
  # Install and start the agent as a LaunchAgent
  redoor agent launchd install --start

  # Show the launchctl output while checking the service
  redoor agent launchd status --verbose";

/// Shown by `redoor agent relay --help`.
pub(crate) const RELAY: &str = "Examples:
  # List the [[relays]] entries in the config
  redoor agent relay ls

  # Start the relay with ID production in the background
  redoor agent relay start production --daemon

  # Check and stop it
  redoor agent relay status production
  redoor agent relay stop production

  # Install it as a systemd service and start it now and on every boot
  redoor agent relay systemd install production --start";

/// Shown by `redoor agent relay ls --help`.
pub(crate) const RELAY_LS: &str = "Examples:
  # List the relay IDs in the default config
  redoor agent relay ls

  # List the relay IDs in another config file
  redoor agent relay ls --config ./config.toml";

/// Shown by `redoor agent relay start --help`.
pub(crate) const RELAY_START: &str = "Examples:
  # Run a relay in the foreground until interrupted
  redoor agent relay start production

  # Run it in the background using another config file
  redoor agent relay start production --config ./config.toml --daemon";

/// Shown by `redoor agent relay stop --help`.
pub(crate) const RELAY_STOP: &str = "Examples:
  # Stop a background relay
  redoor agent relay stop production";

/// Shown by `redoor agent relay status --help`.
pub(crate) const RELAY_STATUS: &str = "Examples:
  # Check whether a relay is running
  redoor agent relay status production";

/// Shown by `redoor agent relay logs --help`.
pub(crate) const RELAY_LOGS: &str = "Examples:
  # Print the last 500 lines of a relay's log
  redoor agent relay logs production

  # Print the last 50 lines
  redoor agent relay logs production -n 50";

/// Shown by `redoor agent relay systemd --help`.
pub(crate) const RELAY_SYSTEMD: &str = "Examples:
  # Install and start a user service for the relay with ID production
  redoor agent relay systemd install production --start

  # Restart it after changing its [[relays]] entry
  redoor agent relay systemd restart production

  # Check the service state
  redoor agent relay systemd status production";

/// Shown by `redoor agent relay launchd --help`.
pub(crate) const RELAY_LAUNCHD: &str = "Examples:
  # Install and start the relay with ID production as a LaunchAgent
  redoor agent relay launchd install production --start

  # Restart it after changing its [[relays]] entry
  redoor agent relay launchd restart production";

/// Shown by `redoor agent|server systemd|launchd install --help` and the relay equivalents;
/// the leaf commands are shared by every role and both managers, so the examples mix them.
pub(crate) const SERVICE_INSTALL: &str = "Examples:
  # Install and enable the server service without starting it
  redoor server systemd install

  # Install, enable and start the agent service
  redoor agent systemd install --start

  # Install the agent as a macOS LaunchAgent and start it
  redoor agent launchd install --start

  # Install and start the relay with ID production
  redoor agent relay systemd install production --start";

/// Shown by `... uninstall --help`.
pub(crate) const SERVICE_UNINSTALL: &str = "Examples:
  # Remove the server service; the config file is kept
  redoor server systemd uninstall

  # Remove the agent LaunchAgent
  redoor agent launchd uninstall

  # Remove the service of the relay with ID production
  redoor agent relay systemd uninstall production";

/// Shown by `... start --help` of the service managers.
pub(crate) const SERVICE_START: &str = "Examples:
  # Start the installed server service
  redoor server systemd start

  # Start the installed agent LaunchAgent
  redoor agent launchd start

  # Start the installed service of the relay with ID production
  redoor agent relay systemd start production";

/// Shown by `... stop --help` of the service managers.
pub(crate) const SERVICE_STOP: &str = "Examples:
  # Stop the server service until it is started again or the machine reboots
  redoor server systemd stop

  # Stop the agent LaunchAgent until the next login
  redoor agent launchd stop

  # Stop the service of the relay with ID production
  redoor agent relay launchd stop production";

/// Shown by `... restart --help` of the service managers.
pub(crate) const SERVICE_RESTART: &str = "Examples:
  # Apply config changes to the running server service
  redoor server systemd restart

  # Restart the agent LaunchAgent
  redoor agent launchd restart

  # Apply [[relays]] changes to the service of the relay with ID production
  redoor agent relay systemd restart production";

/// Shown by `... status --help` of the service managers.
pub(crate) const SERVICE_STATUS: &str = "Examples:
  # Show whether the server service is installed, enabled and running
  redoor server systemd status

  # Show the agent LaunchAgent state
  redoor agent launchd status

  # Show the service state of the relay with ID production
  redoor agent relay systemd status production";

/// Shown by `... enable --help` of the service managers.
pub(crate) const SERVICE_ENABLE: &str = "Examples:
  # Start the server service automatically again
  redoor server systemd enable

  # Start the agent LaunchAgent automatically at login again
  redoor agent launchd enable

  # Start the relay with ID production automatically again
  redoor agent relay systemd enable production";

/// Shown by `... disable --help` of the service managers.
pub(crate) const SERVICE_DISABLE: &str = "Examples:
  # Keep the server service from starting automatically, leaving it running
  redoor server systemd disable

  # Disable automatic startup of the agent and stop it now
  redoor agent systemd disable --now

  # Same for the relay with ID production
  redoor agent relay systemd disable production --now";

/// Shown by `redoor agent|server launchd refresh-local-network-permission --help`.
pub(crate) const REFRESH_LOCAL_NETWORK_PERMISSION: &str = "Examples:
  # Make macOS ask for Local Network access for the agent again
  redoor agent launchd refresh-local-network-permission

  # Same for the server, showing the launchctl output
  redoor server launchd refresh-local-network-permission --verbose

  # Same for the LaunchAgent of the relay with ID production
  redoor agent relay launchd refresh-local-network-permission production";

/// Shown by `redoor upgrade --help`.
pub(crate) const UPGRADE: &str = "Examples:
  # Install the latest release and restart the running server, agents and relays
  redoor upgrade

  # Install a specific release
  redoor upgrade v1.3.1

  # Replace the binary system-wide, including root-owned services
  sudo redoor upgrade

  # Only replace the binary; restart the processes later yourself
  redoor upgrade --no-restart";
