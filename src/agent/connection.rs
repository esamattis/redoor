use std::sync::Arc;

use anyhow::{Context, Result, bail};
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, client_async_tls_with_config, connect_async,
    tungstenite::handshake::client::Response,
};

/// WebSocket stream type shared by every control and data-plane agent connection.
pub(crate) type AgentSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

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
        let url = reqwest::Url::parse(&server_url).context("invalid agent websocket URL")?;
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

    /// Opens TCP through the tunnel when configured while retaining URL authority for TLS and HTTP.
    pub(crate) async fn connect(&self, url: &str) -> Result<(AgentSocket, Response)> {
        let Some(connect_address) = &self.connect_address else {
            return connect_async(url)
                .await
                .context("failed to connect to WebSocket server");
        };
        let tcp = TcpStream::connect(connect_address)
            .await
            .with_context(|| format!("failed to reach routed server through {connect_address}"))?;
        let connector = self.insecure_tls.then(insecure_connector);
        client_async_tls_with_config(url, tcp, None, connector)
            .await
            .context("TLS handshake or WebSocket upgrade failed")
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
                    Ok(response)
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

        let (_socket, _response) = connection
            .connect("ws://redoor.example:8443/api/v1/agent-transfer/ws")
            .await
            .unwrap();

        // The reverse proxy must see the route authority rather than localhost tunnel details.
        assert_eq!(authority_receiver.await.unwrap(), "redoor.example:8443");
        server.await.unwrap();
    }

    /// Confirms insecure WSS still supplies logical SNI and Host through the physical tunnel.
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
                    Ok(response)
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

        let (_socket, _response) = connection
            .connect("wss://redoor.example:443/api/v1/agent-transfer/ws")
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

        let result = connection.connect(connection.server_url()).await;

        // Trusted mode must never silently accept a self-signed routed endpoint.
        assert!(result.is_err());
        // The server observing a client TLS alert confirms rejection happened during verification.
        assert!(server.await.unwrap().is_err());
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
