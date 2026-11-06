//! Who sent a request, as far as the server can tell, for log lines and diagnostics.
//!
//! Behind a reverse proxy (Nginx Proxy Manager, Caddy, Traefik) every TCP peer is the proxy,
//! so the peer address alone names the same host for every client. The proxy passes the real
//! client in `X-Forwarded-For` or `X-Real-IP`. Any client can send those headers itself, so the
//! claim is only ever shown next to the peer address and never used for security decisions such
//! as login rate limiting.

use std::fmt;
use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{HeaderMap, request::Parts},
};

/// Header each proxy appends the address it received from to, so it holds the whole chain.
const FORWARDED_FOR_HEADER: &str = "x-forwarded-for";

/// Header Nginx-based proxies set to the client address when they do not send
/// `X-Forwarded-For`.
const REAL_IP_HEADER: &str = "x-real-ip";

/// Longest forwarded value kept. The header is client controlled and ends up in logs and the
/// in-memory refused-agent list, so an oversized one is cut instead of copied whole.
const MAX_FORWARDED_LEN: usize = 256;

/// The TCP peer of a request plus the client address a proxy claims to have forwarded for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClientAddress {
    /// Address of the TCP connection; trustworthy, but the proxy when there is one.
    pub(crate) peer: SocketAddr,
    /// Forwarded client chain from `X-Forwarded-For` (or `X-Real-IP`), unverified.
    pub(crate) forwarded_for: Option<String>,
}

impl ClientAddress {
    /// Combines the TCP peer with the forwarding headers of the request.
    pub(crate) fn new(peer: SocketAddr, headers: &HeaderMap) -> Self {
        Self {
            peer,
            forwarded_for: forwarded_for(headers),
        }
    }
}

/// Reads the forwarded client chain from the request headers.
///
/// `X-Forwarded-For` wins because it carries the whole chain through several proxies;
/// `X-Real-IP` is the fallback for proxies that only set that one. Values that are not visible
/// ASCII are ignored, so the header cannot smuggle control characters into log lines.
fn forwarded_for(headers: &HeaderMap) -> Option<String> {
    let value = [FORWARDED_FOR_HEADER, REAL_IP_HEADER]
        .into_iter()
        .filter_map(|name| headers.get(name)?.to_str().ok())
        .map(str::trim)
        .find(|value| !value.is_empty())?;
    // `to_str` only accepts visible ASCII, so cutting at any byte index is a char boundary.
    Some(value[..value.len().min(MAX_FORWARDED_LEN)].to_string())
}

/// Formats the address for log lines: the peer, and the forwarded client when a proxy named one.
impl fmt::Display for ClientAddress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.forwarded_for {
            Some(forwarded) => write!(formatter, "{} (forwarded for {forwarded})", self.peer),
            None => write!(formatter, "{}", self.peer),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for ClientAddress {
    type Rejection = <ConnectInfo<SocketAddr> as FromRequestParts<S>>::Rejection;

    /// Reads the peer from the connect info the listener attaches and the forwarding headers,
    /// so handlers that log a client take one extractor instead of two.
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ConnectInfo(peer) = ConnectInfo::<SocketAddr>::from_request_parts(parts, state).await?;
        Ok(Self::new(peer, &parts.headers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// The peer used by every case; a proxy's address in a typical deployment.
    fn peer() -> SocketAddr {
        "10.87.1.10:40318".parse().expect("valid socket address")
    }

    /// Verifies the forwarded chain is read, preferred over `X-Real-IP` and shown in logs.
    #[test]
    fn forwarded_for_is_read_and_formatted() {
        let mut headers = HeaderMap::new();
        // Without a proxy, the log shows the peer alone.
        assert_eq!(
            ClientAddress::new(peer(), &headers).to_string(),
            "10.87.1.10:40318"
        );

        headers.insert(REAL_IP_HEADER, HeaderValue::from_static("203.0.113.9"));
        // Proxies that only set `X-Real-IP` still name the client.
        assert_eq!(
            ClientAddress::new(peer(), &headers)
                .forwarded_for
                .as_deref(),
            Some("203.0.113.9")
        );

        headers.insert(
            FORWARDED_FOR_HEADER,
            HeaderValue::from_static("203.0.113.5, 10.0.0.2"),
        );
        // `X-Forwarded-For` wins, and the whole chain is logged so every hop is visible.
        assert_eq!(
            ClientAddress::new(peer(), &headers).to_string(),
            "10.87.1.10:40318 (forwarded for 203.0.113.5, 10.0.0.2)"
        );
    }

    /// Verifies a client-controlled header cannot grow without bound or carry control bytes.
    #[test]
    fn hostile_forwarded_values_are_bounded() {
        let mut headers = HeaderMap::new();
        let long = "1".repeat(MAX_FORWARDED_LEN * 4);
        headers.insert(
            FORWARDED_FOR_HEADER,
            HeaderValue::from_str(&long).expect("ASCII header"),
        );
        // An oversized header is cut so it cannot bloat logs or the refused-agent list.
        assert_eq!(
            ClientAddress::new(peer(), &headers)
                .forwarded_for
                .map(|value| value.len()),
            Some(MAX_FORWARDED_LEN)
        );

        headers.insert(
            FORWARDED_FOR_HEADER,
            HeaderValue::from_bytes(b"203.0.113.5\xff").expect("opaque header bytes"),
        );
        // A non-ASCII value is dropped rather than written into a log line.
        assert_eq!(ClientAddress::new(peer(), &headers).forwarded_for, None);
    }
}
