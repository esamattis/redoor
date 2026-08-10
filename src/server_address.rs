//! Shared parsing for redoor server addresses used by the agent and relay.
//!
//! Operators may pass `http(s)://` or `ws(s)://` URLs. HTTP schemes are
//! normalized to WebSocket schemes, and the WebSocket path is always `/ws`.

use std::fmt;
use std::str::FromStr;

/// Canonical redoor server endpoint after scheme and path normalization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ServerAddress {
    /// Whether the agent should use `wss://` (from `https://` or `wss://` input).
    secure: bool,
    /// Hostname or IP without IPv6 brackets.
    host: String,
    /// Explicit TCP port after applying scheme defaults.
    port: u16,
}

impl ServerAddress {
    /// Parses a server URL and emits a warning when a non-`/ws` path is rewritten.
    pub(crate) fn parse_with_warning(value: &str) -> Result<Self, String> {
        let (address, warning) = parse_server_address(value)?;
        if let Some(warning) = warning {
            eprintln!("WARNING: {warning}");
        }
        Ok(address)
    }

    /// Returns true when the connection must use TLS (`wss://`).
    pub(crate) fn is_secure(&self) -> bool {
        self.secure
    }

    /// Destination hostname or IP without IPv6 brackets.
    pub(crate) fn host(&self) -> &str {
        &self.host
    }

    /// Destination TCP port after applying scheme defaults.
    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// Host:port authority with brackets restored for IPv6 literals.
    pub(crate) fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// Canonical WebSocket URL the agent connects to (`…/ws`).
    pub(crate) fn websocket_url(&self) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        let omit_port = (!self.secure && self.port == 80) || (self.secure && self.port == 443);
        if omit_port {
            if self.host.contains(':') {
                format!("{scheme}://[{}]/ws", self.host)
            } else {
                format!("{scheme}://{}/ws", self.host)
            }
        } else {
            format!("{scheme}://{}/ws", self.authority())
        }
    }
}

impl FromStr for ServerAddress {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse_with_warning(value)
    }
}

impl fmt::Display for ServerAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.websocket_url())
    }
}

/// Parses one server URL into a normalized address plus an optional path warning.
fn parse_server_address(value: &str) -> Result<(ServerAddress, Option<String>), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("server address must not be empty".to_string());
    }

    let url = reqwest::Url::parse(trimmed).map_err(|error| {
        format!("server address must be an http(s):// or ws(s):// URL ({error})")
    })?;

    let secure = match url.scheme() {
        "http" | "ws" => false,
        "https" | "wss" => true,
        scheme => {
            return Err(format!(
                "server address must be an http(s):// or ws(s):// URL; unsupported scheme '{scheme}'"
            ));
        }
    };

    if !url.username().is_empty() || url.password().is_some() {
        return Err("server address must not include userinfo".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("server address must not include a query or fragment".to_string());
    }

    // `host_str()` may already include IPv6 brackets depending on URL crate version.
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "server address must include a host".to_string())?;
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
        .to_string();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err("server host must not be empty or contain whitespace".to_string());
    }

    let port = match url.port() {
        Some(port) => {
            if port == 0 {
                return Err("server port must be an integer from 1 to 65535".to_string());
            }
            port
        }
        None => {
            if secure {
                443
            } else {
                80
            }
        }
    };

    let path = url.path();
    let warning = match path {
        "" | "/" | "/ws" => None,
        other => Some(format!(
            "server path '{other}' is ignored; WebSocket path is always /ws"
        )),
    };

    // Rebuild through the URL crate so invalid host characters fail early.
    let candidate = ServerAddress { secure, host, port };
    reqwest::Url::parse(&candidate.websocket_url())
        .map_err(|_| "server host is not valid in a WebSocket authority".to_string())?;

    Ok((candidate, warning))
}

#[cfg(test)]
mod tests {
    use super::ServerAddress;

    /// Covers the http(s)/ws(s) shapes operators are expected to paste.
    #[test]
    fn accepts_documented_url_shapes() {
        let cases = [
            (
                "https://redoor.example.com",
                "wss://redoor.example.com/ws",
                true,
                443,
            ),
            (
                "https://redoor.example.com:443",
                "wss://redoor.example.com/ws",
                true,
                443,
            ),
            (
                "http://redoor.example.com:8888",
                "ws://redoor.example.com:8888/ws",
                false,
                8888,
            ),
            (
                "http://redoor.example.com",
                "ws://redoor.example.com/ws",
                false,
                80,
            ),
            (
                "wss://redoor.example.com",
                "wss://redoor.example.com/ws",
                true,
                443,
            ),
            (
                "wss://redoor.example.com:443",
                "wss://redoor.example.com/ws",
                true,
                443,
            ),
            (
                "ws://redoor.example.com:8888",
                "ws://redoor.example.com:8888/ws",
                false,
                8888,
            ),
            (
                "ws://redoor.example.com",
                "ws://redoor.example.com/ws",
                false,
                80,
            ),
        ];

        for (input, expected_url, secure, port) in cases {
            let (address, warning) =
                super::parse_server_address(input).expect("documented URL should parse");
            // Pathless inputs must not warn; the canonical path is implied.
            assert_eq!(warning, None);
            assert_eq!(address.is_secure(), secure);
            assert_eq!(address.port(), port);
            assert_eq!(address.websocket_url(), expected_url);
        }
    }

    /// Forces an unexpected path onto `/ws` so operators cannot invent endpoints.
    #[test]
    fn rewrites_non_ws_paths_with_warning() {
        let (address, warning) = super::parse_server_address("https://redoor.example.com/custom")
            .expect("URL with path should still parse");

        assert_eq!(address.websocket_url(), "wss://redoor.example.com/ws");
        let warning = warning.expect("non-/ws paths must warn");
        assert!(warning.contains("/custom"));
        assert!(warning.contains("/ws"));
    }

    /// Keeps IPv6 destinations unambiguous for both SSH forwards and WSS authorities.
    #[test]
    fn accepts_bracketed_ipv6() {
        let address = "ws://[2001:db8::10]:4000"
            .parse::<ServerAddress>()
            .expect("bracketed IPv6 URL should parse");

        assert_eq!(address.host(), "2001:db8::10");
        assert_eq!(address.port(), 4000);
        assert_eq!(address.authority(), "[2001:db8::10]:4000");
        assert_eq!(address.websocket_url(), "ws://[2001:db8::10]:4000/ws");
    }

    /// Rejects bare host:port so relay and agent share one URL-shaped contract.
    #[test]
    fn rejects_host_port_without_scheme() {
        let error = super::parse_server_address("redoor.example:3000")
            .expect_err("bare host:port must be rejected");
        assert!(
            error.contains("http(s)://") || error.contains("ws(s)://") || error.contains("URL")
        );
    }

    /// Rejects credentials and query strings that would leak into the WebSocket URL.
    #[test]
    fn rejects_userinfo_and_query() {
        for input in [
            "https://user:pass@redoor.example.com",
            "wss://redoor.example.com/ws?token=1",
            "ws://redoor.example.com/ws#frag",
        ] {
            super::parse_server_address(input)
                .expect_err("userinfo/query/fragment must be rejected");
        }
    }
}
