//! Server address, TLS settings and the mutually authenticated upgrade of the agent's one
//! connection.

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use redoor_protocol::wire::agent_auth::{
    AGENT_NONCE_HEADER, AGENT_PROOF_HEADER, AgentTokenKey, HandshakeNonce, HandshakeNonces,
    SERVER_NONCE_HEADER, SERVER_PROOF_HEADER, TokenProof,
};
use redoor_protocol::wire::handshake::{AGENT_VERSION_HEADER, PROTOCOL, ProtocolMismatchResponse};
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpStream, UnixStream};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config,
    tungstenite::{
        self,
        client::IntoClientRequest,
        handshake::client::{Request, Response},
        http::{HeaderValue, StatusCode, header},
    },
};

/// A byte stream to the server, TCP or a Unix socket, before TLS and WebSocket framing.
pub(crate) trait ServerStream:
    AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug
{
}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug> ServerStream for T {}

/// WebSocket stream type shared by every control and data-plane agent connection.
///
/// Boxed so a TCP connection and the Unix socket of an SSH stream-local forward share one
/// socket type, and everything above the transport stays the same for both.
pub(crate) type AgentSocket = WebSocketStream<MaybeTlsStream<Box<dyn ServerStream>>>;

/// Where the agent opens its stream when it differs from the URL's authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConnectAddress {
    /// `host:port` of an SSH reverse forward or the server's own listener.
    Tcp(String),
    /// The Unix socket of an SSH stream-local reverse forward. A managed daemon outlives its
    /// SSH session, so it needs an address the next session's forward can listen on again,
    /// which a random port cannot promise.
    Unix(std::path::PathBuf),
}

impl std::fmt::Display for ConnectAddress {
    /// Shows the address in connection errors.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Tcp(address) => formatter.write_str(address),
            Self::Unix(path) => write!(formatter, "unix:{}", path.display()),
        }
    }
}

/// Why an authenticated upgrade failed.
///
/// A wrong token, a server that cannot prove the token or an incompatible protocol cannot fix
/// itself by retrying soon, so the runtime tells these apart from transport errors: it retries
/// them only at the slowest pace, and a supervised agent leaves them to its owner.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectError {
    /// The server answered `401`: the agent token is wrong, or the server predates the token
    /// proof and still expects the token itself.
    #[error(
        "the server rejected the agent's proof of the token (401 Unauthorized); check the agent token, or upgrade the server if it is older than the agent"
    )]
    Unauthorized,
    /// The server accepted the upgrade without proving it knows the token, so it may not be
    /// the server the agent belongs to. The agent drops the socket before sending anything.
    #[error(
        "the server did not prove it knows the agent token; the server URL may point at a wrong or fraudulent server, or the server's agent token differs"
    )]
    ServerUnproven,
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

/// Builds an upgrade request that proves the token over `nonce`, without sending the token
/// itself, and offers [`PROTOCOL`].
fn authenticated_request(
    url: &str,
    key: &AgentTokenKey,
    nonce: &HandshakeNonce,
) -> Result<Request> {
    let mut request = url
        .into_client_request()
        .context("invalid agent websocket URL")?;
    let headers = request.headers_mut();
    headers.insert(AGENT_NONCE_HEADER, hex_header(nonce.as_str()));
    headers.insert(
        AGENT_PROOF_HEADER,
        hex_header(key.upgrade_proof(nonce).as_str()),
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

/// Converts a nonce or proof, which the handshake always encodes as hex, into a header value.
fn hex_header(hex: &str) -> HeaderValue {
    HeaderValue::from_str(hex).expect("hex is a valid header value")
}

/// The nonces of both sides, once the server's upgrade answer proved it knows the token.
fn proven_server_nonces(
    response: &Response,
    key: &AgentTokenKey,
    agent: HandshakeNonce,
) -> Result<HandshakeNonces, ConnectError> {
    let header = |name: &str| response.headers().get(name)?.to_str().ok();
    let server = header(SERVER_NONCE_HEADER)
        .and_then(HandshakeNonce::parse)
        .ok_or(ConnectError::ServerUnproven)?;
    let nonces = HandshakeNonces { agent, server };
    let proven =
        header(SERVER_PROOF_HEADER).is_some_and(|proof| key.server_proof(&nonces).matches(proof));
    if !proven {
        return Err(ConnectError::ServerUnproven);
    }
    Ok(nonces)
}

/// An upgraded connection to a server that proved the token, with the proof the agent's
/// `hello` must carry to finish the handshake.
#[derive(Debug)]
pub(crate) struct AuthenticatedSocket {
    pub(crate) socket: AgentSocket,
    pub(crate) hello_proof: TokenProof,
}

/// Separates the logical WebSocket server identity from an optional tunnel TCP endpoint.
#[derive(Clone, Debug)]
pub(crate) struct AgentConnection {
    /// URL whose authority supplies TLS SNI and the WebSocket HTTP Host value.
    server_url: String,
    /// Physical endpoint used only to establish the stream before TLS and WebSocket
    /// negotiation; the URL's authority when absent.
    connect_address: Option<ConnectAddress>,
    /// Explicit opt-out from certificate verification, for self-signed servers and for
    /// managed agents whose `localhost` tunnel cannot match any server certificate.
    insecure_tls: bool,
}

impl AgentConnection {
    /// Validates one immutable connection policy before any reconnecting tasks clone it.
    pub(crate) fn new(
        server_url: String,
        connect_address: Option<ConnectAddress>,
        insecure_tls: bool,
    ) -> Result<Self> {
        let url = url::Url::parse(&server_url).context("invalid agent websocket URL")?;
        if !matches!(url.scheme(), "ws" | "wss") {
            bail!("agent websocket URL must use ws:// or wss://");
        }
        if insecure_tls && url.scheme() != "wss" {
            bail!("insecure TLS requires an https:// or wss:// server URL");
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

    /// Connects to an endpoint that requires a proof of `token` and the agent protocol during
    /// the upgrade, and accepts the socket only when the server proves the token back. Rejections
    /// are classified so the caller can stop retrying.
    pub(crate) async fn connect_authenticated(
        &self,
        url: &str,
        token: &str,
    ) -> Result<AuthenticatedSocket, ConnectError> {
        let key = AgentTokenKey::new(token);
        let agent_nonce = HandshakeNonce::generate();
        let request = authenticated_request(url, &key, &agent_nonce)?;
        let (socket, response) = self.upgrade(request).await?;
        let nonces = proven_server_nonces(&response, &key, agent_nonce)?;
        Ok(AuthenticatedSocket {
            socket,
            hello_proof: key.hello_proof(&nonces),
        })
    }

    /// Performs the upgrade directly or through the tunnel endpoint, retaining the URL's
    /// authority for TLS and HTTP when TCP goes through a tunnel.
    async fn upgrade(&self, request: Request) -> Result<(AgentSocket, Response), ConnectError> {
        let connector = self.insecure_tls.then(insecure_connector);
        let stream = self.open_stream().await?;
        client_async_tls_with_config(request, stream, None, connector)
            .await
            .map_err(|error| match error {
                tungstenite::Error::Http(response) => ConnectError::from_http(&response),
                other => ConnectError::Transport(
                    anyhow::Error::new(other).context("TLS handshake or WebSocket upgrade failed"),
                ),
            })
    }

    /// Opens the stream the TLS and WebSocket handshakes run on: the connect address when
    /// one is set, otherwise the URL's host and port. TCP streams are tuned so control frames
    /// stay responsive during transfers; a Unix socket tunnel has no such options.
    async fn open_stream(&self) -> Result<Box<dyn ServerStream>, ConnectError> {
        let stream: Box<dyn ServerStream> = match &self.connect_address {
            Some(ConnectAddress::Tcp(address)) => {
                let stream = TcpStream::connect(address)
                    .await
                    .with_context(|| format!("failed to reach routed server through {address}"))?;
                redoor_core::tcp_latency::tune_for_latency(&stream);
                Box::new(stream)
            }
            Some(ConnectAddress::Unix(path)) => {
                Box::new(UnixStream::connect(path).await.with_context(|| {
                    format!(
                        "failed to reach the server through the tunnel socket {}",
                        path.display()
                    )
                })?)
            }
            None => {
                let url =
                    url::Url::parse(&self.server_url).context("invalid agent websocket URL")?;
                let host = url.host_str().context("agent websocket URL has no host")?;
                let port = url
                    .port_or_known_default()
                    .context("agent websocket URL has no port")?;
                let stream = TcpStream::connect(format!("{host}:{port}"))
                    .await
                    .with_context(|| format!("failed to reach the server at {host}:{port}"))?;
                redoor_core::tcp_latency::tune_for_latency(&stream);
                Box::new(stream)
            }
        };
        Ok(stream)
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
    use redoor_protocol::wire::agent_auth::{
        AGENT_NONCE_HEADER, AgentTokenKey, HandshakeNonce, HandshakeNonces, SERVER_NONCE_HEADER,
        SERVER_PROOF_HEADER,
    };
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request as ServerRequest, Response as ServerResponse,
    };
    use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};

    /// Agent token the test servers know.
    const TOKEN: &str = "token";

    /// Echoes the agent protocol, as the real server does when it accepts an upgrade.
    fn with_agent_protocol(mut response: ServerResponse) -> ServerResponse {
        response.headers_mut().insert(
            "sec-websocket-protocol",
            redoor_protocol::wire::handshake::PROTOCOL.parse().unwrap(),
        );
        response
    }

    /// The nonces of one test handshake: the agent's from `request` and a fresh server nonce.
    fn handshake_nonces(request: &ServerRequest) -> HandshakeNonces {
        let agent = request.headers()[AGENT_NONCE_HEADER].to_str().unwrap();
        HandshakeNonces {
            agent: HandshakeNonce::parse(agent).unwrap(),
            server: HandshakeNonce::generate(),
        }
    }

    /// Accepts an upgrade like the real server: echoes the protocol and proves `token` over
    /// the request's nonce. Returns the hello proof the server would then expect.
    fn accept_proving(
        request: &ServerRequest,
        response: ServerResponse,
        token: &str,
    ) -> (ServerResponse, String) {
        let key = AgentTokenKey::new(token);
        let nonces = handshake_nonces(request);
        let mut response = with_agent_protocol(response);
        let headers = response.headers_mut();
        headers.insert(SERVER_NONCE_HEADER, nonces.server.as_str().parse().unwrap());
        headers.insert(
            SERVER_PROOF_HEADER,
            key.server_proof(&nonces).as_str().parse().unwrap(),
        );
        (response, key.hello_proof(&nonces).as_str().to_string())
    }

    /// Accepts an upgrade like the real server that knows [`TOKEN`].
    fn accept_as_server(request: &ServerRequest, response: ServerResponse) -> ServerResponse {
        accept_proving(request, response, TOKEN).0
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
                    Ok(accept_as_server(request, response))
                },
            )
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let connection = AgentConnection::new(
            "ws://redoor.example:8443/ws".to_string(),
            Some(super::ConnectAddress::Tcp(connect_address)),
            false,
        )
        .unwrap();

        let _socket = connection
            .connect_authenticated("ws://redoor.example:8443/api/v1/agent/ws", TOKEN)
            .await
            .unwrap();

        // The reverse proxy must see the route authority rather than localhost tunnel details.
        assert_eq!(authority_receiver.await.unwrap(), "redoor.example:8443");
        server.await.unwrap();
    }

    /// A managed daemon behind an SSH stream-local forward connects through a Unix socket
    /// while the request keeps the server's logical authority.
    // The tungstenite handshake callback signature fixes the large `ErrorResponse` error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn unix_socket_tunnel_retains_logical_http_authority() {
        let directory = redoor_core::test_support::TempDir::create();
        let socket_path = directory.path().join("agent.sock");
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let (authority_sender, authority_receiver) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, move |request: &ServerRequest, response| {
                let authority = request
                    .headers()
                    .get("host")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                let _ = authority_sender.send(authority);
                Ok(accept_as_server(request, response))
            })
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let connection = AgentConnection::new(
            "ws://localhost:7666/api/v1/agent/ws".to_string(),
            Some(super::ConnectAddress::Unix(socket_path)),
            false,
        )
        .unwrap();

        connection
            .connect_authenticated(connection.server_url(), TOKEN)
            .await
            .unwrap();

        // The server sees the URL's authority, not the socket path, as with a TCP tunnel.
        assert_eq!(authority_receiver.await.unwrap(), "localhost:7666");
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
                    Ok(accept_as_server(request, response))
                },
            )
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let connection = AgentConnection::new(
            "wss://redoor.example:443/ws".to_string(),
            Some(super::ConnectAddress::Tcp(connect_address)),
            true,
        )
        .unwrap();

        let _socket = connection
            .connect_authenticated("wss://redoor.example:443/api/v1/agent/ws", TOKEN)
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
            Some(super::ConnectAddress::Tcp(connect_address)),
            false,
        )
        .unwrap();

        let result = connection
            .connect_authenticated(connection.server_url(), TOKEN)
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

    /// Verifies a 401 is classified as a token error and the upgrade carried a proof of the
    /// token but not the token itself.
    #[tokio::test]
    async fn unauthorized_upgrade_needs_operator_and_carries_only_a_proof() {
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
        // A wrong or fraudulent server must never learn the token.
        assert!(!request.contains("secret-token"));
        assert!(!request.contains("authorization:"));
        // The proof travels in the upgrade so the server refuses outsiders without a socket.
        assert!(request.contains("x-redoor-agent-nonce: "));
        assert!(request.contains("x-redoor-agent-proof: "));
        // The agent offers exactly the protocol it implements.
        assert!(request.contains("sec-websocket-protocol: redoor.v7"));
        // The version header lets the server log which build was rejected.
        assert!(request.contains("x-redoor-agent-version: "));
    }

    /// Verifies a 426 names both protocols so the operator knows which side to upgrade.
    #[tokio::test]
    async fn protocol_mismatch_needs_operator_and_names_both_versions() {
        let body = r#"{"server_protocol":"redoor.v8","server_version":"9.9.9","message":"m"}"#;
        let (url, _server) = answer_upgrade(format!(
            "HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let error = connection
            .connect_authenticated(&url, TOKEN)
            .await
            .expect_err("426 must fail the upgrade");

        // Mismatched builds must not reconnect at the fast pace.
        assert!(error.needs_operator());
        let message = error.to_string();
        // The log line explains which protocol each side speaks and what to do.
        assert!(message.contains("redoor.v8") && message.contains("redoor.v7"));
        assert!(message.contains("upgrade the agent"));
    }

    /// Accepts one upgrade on a plain socket with `accept`, then closes it, and returns the
    /// URL to connect to.
    // The tungstenite handshake callback signature fixes the large `ErrorResponse` error type.
    #[allow(clippy::result_large_err)]
    async fn serve_upgrade(
        accept: impl FnOnce(&ServerRequest, ServerResponse) -> ServerResponse + Send + Unpin + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/api/v1/agent/ws", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            // The agent may drop the socket right after the upgrade, so the close may fail.
            if let Ok(mut socket) = accept_hdr_async(stream, |request: &ServerRequest, response| {
                Ok(accept(request, response))
            })
            .await
            {
                let _ = socket.send(Message::Close(None)).await;
            }
        });
        (url, server)
    }

    /// Verifies a proving server yields the hello proof that server expects.
    #[tokio::test]
    async fn proving_server_yields_the_hello_proof_it_expects() {
        let (expected_sender, expected_receiver) = tokio::sync::oneshot::channel();
        let (url, server) = serve_upgrade(move |request, response| {
            let (response, hello_proof) = accept_proving(request, response, TOKEN);
            let _ = expected_sender.send(hello_proof);
            response
        })
        .await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let connected = connection.connect_authenticated(&url, TOKEN).await.unwrap();

        // The hello finishes the handshake only with the proof over this connection's nonces.
        assert_eq!(
            connected.hello_proof.as_str(),
            expected_receiver.await.unwrap()
        );
        server.await.unwrap();
    }

    /// Verifies the agent refuses servers that accept the upgrade without proving the token:
    /// one that sends no proof at all, and one that proves another token.
    #[tokio::test]
    async fn unproven_server_is_refused_and_needs_operator() {
        let no_proof: fn(&ServerRequest, ServerResponse) -> ServerResponse =
            |_request, response| with_agent_protocol(response);
        let other_token: fn(&ServerRequest, ServerResponse) -> ServerResponse =
            |request, response| accept_proving(request, response, "other-token").0;
        for accept in [no_proof, other_token] {
            let (url, server) = serve_upgrade(accept).await;
            let connection = AgentConnection::new(url.clone(), None, false).unwrap();

            let error = connection
                .connect_authenticated(&url, TOKEN)
                .await
                .expect_err("an unproven server must be refused");

            // A fraudulent server never gets a hello or a chance to send commands.
            assert!(matches!(error, super::ConnectError::ServerUnproven));
            // Retrying soon cannot fix a wrong server URL or token.
            assert!(error.needs_operator());
            server.await.unwrap();
        }
    }

    /// Verifies ordinary failures stay retryable.
    #[tokio::test]
    async fn unexpected_status_is_retryable() {
        let (url, _server) =
            answer_upgrade("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n".into())
                .await;
        let connection = AgentConnection::new(url.clone(), None, false).unwrap();

        let error = connection
            .connect_authenticated(&url, TOKEN)
            .await
            .expect_err("503 must fail the upgrade");

        // A restarting server or proxy hiccup keeps the fast reconnect schedule.
        assert!(!error.needs_operator());
    }

    /// Rejects insecure mode on plain WebSockets, where it would silently mean nothing.
    #[test]
    fn insecure_policy_requires_wss() {
        let plain = AgentConnection::new("ws://redoor.example/ws".to_string(), None, true);
        // Certificate policy has no meaning for a plain WebSocket and must fail clearly.
        assert!(
            plain
                .unwrap_err()
                .to_string()
                .contains("requires an https:// or wss://")
        );

        let direct = AgentConnection::new("wss://redoor.example/ws".to_string(), None, true);
        // Standalone agents of self-signed servers connect directly, without a tunnel.
        assert!(direct.is_ok());
    }

    /// Confirms a standalone agent with insecure mode accepts a self-signed server it reaches
    /// directly, as it does with a server using `[server.tls] self_signed = true`.
    // The tungstenite handshake callback signature fixes the large `ErrorResponse` error type.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn insecure_wss_accepts_self_signed_server_without_tunnel() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = self_signed_acceptor();
        let server = tokio::spawn(async move {
            let (stream, _peer) = listener.accept().await.unwrap();
            let tls = acceptor.accept(stream).await.unwrap();
            let mut socket = accept_hdr_async(tls, |request: &ServerRequest, response| {
                Ok(accept_as_server(request, response))
            })
            .await
            .unwrap();
            socket.send(Message::Close(None)).await.unwrap();
        });
        let url = format!("wss://{address}/api/v1/agent/ws");
        let connection = AgentConnection::new(url.clone(), None, true).unwrap();

        // Verification is skipped, so the untrusted certificate must not fail the upgrade.
        connection.connect_authenticated(&url, TOKEN).await.unwrap();
        server.await.unwrap();
    }
}
