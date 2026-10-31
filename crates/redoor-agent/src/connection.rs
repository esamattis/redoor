//! Server address, TLS settings and the authenticated upgrade of the agent's one connection.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use redoor_protocol::wire::handshake::{AGENT_VERSION_HEADER, PROTOCOL, ProtocolMismatchResponse};
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config, connect_async,
    tungstenite::{
        self,
        client::IntoClientRequest,
        handshake::client::{Request, Response},
        http::{HeaderValue, StatusCode, header},
    },
};

/// WebSocket stream type shared by every control and data-plane agent connection.
pub(crate) type AgentSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Why an authenticated upgrade failed.
///
/// A wrong token or an incompatible protocol cannot fix itself by retrying soon, so the runtime
/// tells these apart from transport errors: it retries them only at the slowest pace, and a
/// supervised agent leaves them to its owner.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectError {
    /// The server answered `401`: the agent token is wrong.
    #[error("the server rejected the agent token (401 Unauthorized)")]
    Unauthorized,
    /// The server answered `426`: it speaks a different protocol version.
    #[error(
        "the server speaks {server_protocol} (version {server_version}) but this agent speaks {agent_protocol}; upgrade the agent"
    )]
    ProtocolMismatch {
        server_protocol: String,
        server_version: String,
        agent_protocol: &'static str,
    },
    /// Anything else (network, TLS, unexpected status); retrying may succeed.
    #[error(transparent)]
    Transport(#[from] anyhow::Error),
}

impl ConnectError {
    /// Whether only an operator can make a later attempt succeed.
    pub(crate) fn needs_operator(&self) -> bool {
        !matches!(self, Self::Transport(_))
    }

    /// Classifies a non-`101` upgrade answer by its status and body.
    fn from_http(response: &tungstenite::http::Response<Option<Vec<u8>>>) -> Self {
        match response.status() {
            StatusCode::UNAUTHORIZED => Self::Unauthorized,
            StatusCode::UPGRADE_REQUIRED => {
                let body = response
                    .body()
                    .as_deref()
                    .and_then(|body| serde_json::from_slice::<ProtocolMismatchResponse>(body).ok());
                Self::ProtocolMismatch {
                    server_protocol: body
                        .as_ref()
                        .map(|body| body.server_protocol.clone())
                        .unwrap_or_else(|| "an unknown protocol".to_string()),
                    server_version: body
                        .map(|body| body.server_version)
                        .unwrap_or_else(|| "unknown".to_string()),
                    agent_protocol: PROTOCOL,
                }
            }
            status => Self::Transport(anyhow::anyhow!(
                "WebSocket upgrade was answered with HTTP {status}"
            )),
        }
    }
}

/// Builds an upgrade request that authenticates with `token` and offers [`PROTOCOL`].
fn authenticated_request(url: &str, token: &str) -> Result<Request> {
    let mut request = url
        .into_client_request()
        .context("invalid agent websocket URL")?;
    let headers = request.headers_mut();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .context("agent token is not a valid HTTP header value")?,
    );
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(PROTOCOL),
    );
    headers.insert(
        AGENT_VERSION_HEADER,
        HeaderValue::from_str(&redoor_core::identity::current_binary_identity().version)
            .context("agent version is not a valid HTTP header value")?,
    );
    Ok(request)
}

/// Separates the logical WebSocket server identity from an optional tunnel TCP endpoint.
#[derive(Clone, Debug)]
pub(crate) struct AgentConnection {
    /// URL whose authority supplies TLS SNI and the WebSocket HTTP Host value.
    server_url: String,
    /// Physical endpoint used only to establish TCP before TLS and WebSocket negotiation.
    connect_address: Option<String>,
    /// Explicit opt-out from certificate verification for private WSS deployments.
    insecure_tls: bool,
}

impl AgentConnection {
    /// Validates one immutable connection policy before any reconnecting tasks clone it.
    pub(crate) fn new(
        server_url: String,
        connect_address: Option<String>,
        insecure_tls: bool,
    ) -> Result<Self> {
        let url = url::Url::parse(&server_url).context("invalid agent websocket URL")?;
        if !matches!(url.scheme(), "ws" | "wss") {
            bail!("agent websocket URL must use ws:// or wss://");
        }
        if insecure_tls && url.scheme() != "wss" {
            bail!("insecure TLS requires a wss:// agent websocket URL");
        }
        if insecure_tls && connect_address.is_none() {
            bail!("insecure TLS requires an explicit tunnel connection address");
        }
        Ok(Self {
            server_url,
            connect_address,
            insecure_tls,
        })
    }

    /// Returns the logical URL used to derive control and secondary websocket paths.
    pub(crate) fn server_url(&self) -> &str {
        &self.server_url
    }

    /// Connects to an endpoint that authenticates during the upgrade with `token` and requires
    /// the agent protocol, classifying rejections so the caller can stop retrying.
    pub(crate) async fn connect_authenticated(
        &self,
        url: &str,
        token: &str,
    ) -> Result<AgentSocket, ConnectError> {
        let request = authenticated_request(url, token)?;
        let (socket, _response) = self.upgrade(request).await?;
        Ok(socket)
    }

    /// Performs the upgrade directly or through the tunnel endpoint, retaining the URL's
    /// authority for TLS and HTTP when TCP goes through a tunnel.
    async fn upgrade(&self, request: Request) -> Result<(AgentSocket, Response), ConnectError> {
        let result = match &self.connect_address {
            None => connect_async(request).await,
            Some(connect_address) => {
                let tcp = TcpStream::connect(connect_address).await.with_context(|| {
                    format!("failed to reach routed server through {connect_address}")
                })?;
                let connector = self.insecure_tls.then(insecure_connector);
                client_async_tls_with_config(request, tcp, None, connector).await
            }
        };
        result.map_err(|error| match error {
            tungstenite::Error::Http(response) => ConnectError::from_http(&response),
            other => ConnectError::Transport(
                anyhow::Error::new(other).context("TLS handshake or WebSocket upgrade failed"),
            ),
        })
    }
}

/// Builds the deliberately unsafe verifier only after the user explicitly selects insecure mode.
fn insecure_connector() -> Connector {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    let supported = provider.signature_verification_algorithms;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the selected Rustls provider supports default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertificateVerification { supported }))
        .with_no_client_auth();
    Connector::Rustls(Arc::new(config))
}

/// Accepts any server certificate while still proving possession of its private key.
#[derive(Debug)]
struct NoCertificateVerification {
    /// Provider algorithms retain normal TLS handshake-signature verification.
    supported: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for NoCertificateVerification {
    /// Skips chain, expiry, and hostname checks as requested by insecure mode.
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    /// Verifies TLS 1.2 signatures even though certificate trust is explicitly disabled.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, certificate, signature, &self.supported)
    }

    /// Verifies TLS 1.3 signatures even though certificate trust is explicitly disabled.
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, certificate, signature, &self.supported)
    }

    /// Advertises exactly the schemes supported by the active cryptographic provider.
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::AgentConnection;
    use futures_util::SinkExt;
    use rcgen::{CertifiedKey, generate_simple_self_signed};
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};

    /// Echoes the agent protocol, as the real server does when it accepts an upgrade.
    fn with_agent_protocol(
        mut response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> tokio_tungstenite::tungstenite::handshake::server::Response {
        response.headers_mut().insert(
            "sec-websocket-protocol",
            redoor_protocol::wire::handshake::PROTOCOL.parse().unwrap(),
        );
        response
    }

    /// Creates a private WSS endpoint so certificate behavior is deterministic and offline.
    fn self_signed_acceptor() -> TlsAcceptor {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec!["redoor.example".to_string()]).unwrap();
        let private_key =
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der()));
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone()], private_key)
            .unwrap();
        TlsAcceptor::from(std::sync::Arc::new(config))
    }

    /// Proves TCP can use a local tunnel while the WebSocket request retains server authority.
    // The tungstenite handshake callback signature fixes the large `ErrorResponse` error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn tunneled_connection_retains_logical_http_authority() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connect_address = listener.local_addr().unwrap().to_string();
        let (authority_sender, authority_receiver) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(
                stream,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    let authority = request
                        .headers()
                        .get("host")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    let _ = authority_sender.send(authority);
                    Ok(with_agent_protocol(response))
                },
            )
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let connection = AgentConnection::new(
            "ws://redoor.example:8443/ws".to_string(),
            Some(connect_address),
            false,
        )
        .unwrap();

        let _socket = connection
            .connect_authenticated("ws://redoor.example:8443/api/v1/agent/ws", "token")
            .await
            .unwrap();

        // The reverse proxy must see the route authority rather than localhost tunnel details.
        assert_eq!(authority_receiver.await.unwrap(), "redoor.example:8443");
        server.await.unwrap();
    }

    /// Confirms insecure WSS still supplies logical SNI and Host through the physical tunnel.
    // The tungstenite handshake callback signature fixes the large `ErrorResponse` error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn insecure_wss_retains_logical_tls_and_http_identity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connect_address = listener.local_addr().unwrap().to_string();
        let acceptor = self_signed_acceptor();
        let (identity_sender, identity_receiver) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            let tls = acceptor.accept(stream).await.unwrap();
            let sni = tls
                .get_ref()
                .1
                .server_name()
                .unwrap_or_default()
                .to_string();
            let mut socket = accept_hdr_async(
                tls,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    let authority = request
                        .headers()
                        .get("host")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    let _ = identity_sender.send((sni, authority));
                    Ok(with_agent_protocol(response))
                },
            )
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let connection = AgentConnection::new(
            "wss://redoor.example:443/ws".to_string(),
            Some(connect_address),
            true,
        )
        .unwrap();

        let _socket = connection
            .connect_authenticated("wss://redoor.example:443/api/v1/agent/ws", "token")
            .await
            .unwrap();

        let (sni, authority) = identity_receiver.await.unwrap();
        // TLS must identify the routed hostname rather than the localhost tunnel endpoint.
        assert_eq!(sni, "redoor.example");
        // The reverse proxy must receive the same logical hostname during WebSocket upgrade.
        assert_eq!(authority, "redoor.example:443");
        server.await.unwrap();
    }

    /// Confirms normal WSS mode rejects the same private certificate accepted by insecure mode.
    #[tokio::test]
    async fn verified_wss_rejects_untrusted_certificate() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connect_address = listener.local_addr().unwrap().to_string();
        let acceptor = self_signed_acceptor();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            acceptor.accept(stream).await
        });
        let connection = AgentConnection::new(
            "wss://redoor.example:443/ws".to_string(),
            Some(connect_address),
            false,
        )
        .unwrap();

        let result = connection
            .connect_authenticated(connection.server_url(), "token")
            .await;

        // Trusted mode must never silently accept a self-signed routed endpoint.
        assert!(result.is_err());
        // The server observing a client TLS alert confirms rejection happened during verification.
        assert!(server.await.unwrap().is_err());
    }

    /// Serves one raw HTTP answer to the next upgrade and returns the request it received.
    async fn answer_upgrade(response: String) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/api/v1/agent/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _peer) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.unwrap();
                request.extend_from_slice(&buffer[..read]);
            }
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap().to_lowercase()
        });
        (url, server)
    }

    /// Verifies a 401 is classified as a token error and the upgrade carried credentials.
    #[tokio::test]
    async fn unauthorized_upgrade_needs_operator_and_carries_credentials() {
        let (url, server) =
            answer_upgrade("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n".into()).await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let error = connection
            .connect_authenticated(&url, "secret-token")
            .await
            .expect_err("401 must fail the upgrade");

        // A wrong token cannot fix itself, so the runtime only retries it slowly.
        assert!(matches!(error, super::ConnectError::Unauthorized));
        assert!(error.needs_operator());
        let request = server.await.unwrap();
        // The token travels in the upgrade, never in a websocket frame.
        assert!(request.contains("authorization: bearer secret-token"));
        // The agent offers exactly the protocol it implements.
        assert!(request.contains("sec-websocket-protocol: redoor.v3"));
        // The version header lets the server log which build was rejected.
        assert!(request.contains("x-redoor-agent-version: "));
    }

    /// Verifies a 426 names both protocols so the operator knows which side to upgrade.
    #[tokio::test]
    async fn protocol_mismatch_needs_operator_and_names_both_versions() {
        let body = r#"{"server_protocol":"redoor.v4","server_version":"9.9.9","message":"m"}"#;
        let (url, _server) = answer_upgrade(format!(
            "HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let error = connection
            .connect_authenticated(&url, "token")
            .await
            .expect_err("426 must fail the upgrade");

        // Mismatched builds must not reconnect at the fast pace.
        assert!(error.needs_operator());
        let message = error.to_string();
        // The log line explains which protocol each side speaks and what to do.
        assert!(message.contains("redoor.v4") && message.contains("redoor.v3"));
        assert!(message.contains("upgrade the agent"));
    }

    /// Verifies ordinary failures stay retryable.
    #[tokio::test]
    async fn unexpected_status_is_retryable() {
        let (url, _server) =
            answer_upgrade("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n".into())
                .await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let error = connection
            .connect_authenticated(&url, "token")
            .await
            .expect_err("503 must fail the upgrade");

        // A restarting server or proxy hiccup keeps the fast reconnect schedule.
        assert!(!error.needs_operator());
    }

    /// Rejects misuse of insecure mode before any reconnect loop starts.
    #[test]
    fn insecure_policy_requires_tunneled_wss() {
        let plain = AgentConnection::new(
            "ws://redoor.example/ws".to_string(),
            Some("localhost:50000".to_string()),
            true,
        );
        // Certificate policy has no meaning for a plain WebSocket and must fail clearly.
        assert!(plain.unwrap_err().to_string().contains("requires a wss://"));

        let direct = AgentConnection::new("wss://redoor.example/ws".to_string(), None, true);
        // Hidden insecure mode must remain coupled to the explicit SSH tunnel endpoint.
        assert!(
            direct
                .unwrap_err()
                .to_string()
                .contains("explicit tunnel connection address")
        );
    }
}
