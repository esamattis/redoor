//! How managed local agents reach the server they run beside.

/// How server-managed agents reach this server's own listener.
///
/// Managed agents always connect to `localhost`, directly or through an SSH reverse tunnel, so
/// the certificate of a TLS listener can never match the name they connect with (and a
/// self-signed one is not trusted anyway). They skip certificate verification instead: the
/// traffic never leaves the machine before it enters the tunnel, exactly like the plain
/// `ws://localhost` connection used without TLS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalServerEndpoint {
    /// Listener port of this server.
    pub port: u16,
    /// Whether the listener serves HTTPS, so agents must use `wss://`.
    pub tls: bool,
}

impl LocalServerEndpoint {
    /// Host and port agents put in their URL: the TLS server name and HTTP `Host` they send.
    pub fn authority(&self) -> String {
        format!("localhost:{}", self.port)
    }

    /// Agent WebSocket URL of a local agent, which reaches the listener directly.
    pub fn agent_ws_url(&self) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!(
            "{scheme}://{}{}",
            self.authority(),
            redoor_protocol::wire::handshake::AGENT_WS_PATH
        )
    }
}

#[cfg(test)]
mod tests {
    use super::LocalServerEndpoint;

    /// A TLS listener must be reached with `wss://`, or the agent would speak plain HTTP to it.
    #[test]
    fn agent_url_follows_listener_tls() {
        let plain = LocalServerEndpoint {
            port: 7666,
            tls: false,
        };
        let tls = LocalServerEndpoint { tls: true, ..plain };
        // Without TLS the URL is unchanged from before built-in HTTPS existed.
        assert_eq!(plain.agent_ws_url(), "ws://localhost:7666/api/v1/agent/ws");
        // With TLS only the scheme changes; the agent still connects to loopback.
        assert_eq!(tls.agent_ws_url(), "wss://localhost:7666/api/v1/agent/ws");
    }
}
