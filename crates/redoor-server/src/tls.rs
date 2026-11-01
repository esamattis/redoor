//! Built-in HTTPS: the server certificate and the listener that terminates TLS.
//!
//! The certificate comes from operator files or is a self-signed one the server creates in
//! its data directory, so private deployments get encrypted browser and agent connections
//! without a reverse proxy or a domain name. Handshakes run in their own tasks: one slow or
//! silent client must never stop the listener from accepting everyone else.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use redoor_core::config::ServerTls;
use redoor_core::log;
use redoor_protocol::wire::log::Level;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinError, JoinSet};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use tokio_util::either::Either;

/// Longest a client may take to finish its TLS handshake before its connection is dropped,
/// so abandoned connections cannot pile up.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Validity of a generated certificate. Apple platforms refuse server certificates valid for
/// more than 825 days, even self-signed ones a user accepted, and phones use the UI.
const SELF_SIGNED_VALIDITY_DAYS: i64 = 825;
/// A generated certificate this close to expiring is replaced on start, so it never expires
/// on a server that is restarted now and then.
const SELF_SIGNED_RENEW_BEFORE_DAYS: u64 = 30;
/// Directory under the data directory holding the generated certificate.
const SELF_SIGNED_DIRECTORY: &str = "tls";

/// A server certificate as found on disk, ready to build the TLS acceptor from.
pub(crate) struct ServerCertificate {
    /// PEM certificate chain, leaf first.
    cert: PathBuf,
    /// PEM private key of the leaf.
    key: PathBuf,
}

impl ServerCertificate {
    /// Locates the certificate `[server.tls]` selects, creating the self-signed one when it is
    /// missing or about to expire.
    ///
    /// `bind` and the machine's names go into a new self-signed certificate, so clients that
    /// pin or trust it can still verify the name they connect with.
    pub(crate) async fn prepare(tls: &ServerTls, data_dir: &Path, bind: &str) -> Result<Self> {
        match tls {
            ServerTls::Files { cert, key } => Ok(Self::files(cert, key)),
            ServerTls::SelfSigned => {
                let directory = data_dir.join(SELF_SIGNED_DIRECTORY);
                let certificate = Self {
                    cert: directory.join("self-signed-cert.pem"),
                    key: directory.join("self-signed-key.pem"),
                };
                if certificate.needs_new_self_signed().await? {
                    certificate.generate_self_signed(&directory, bind).await?;
                }
                Ok(certificate)
            }
        }
    }

    /// Operator-provided PEM files, used as they are.
    pub(crate) fn files(cert: &Path, key: &Path) -> Self {
        Self {
            cert: cert.to_path_buf(),
            key: key.to_path_buf(),
        }
    }

    /// Path of the certificate chain, logged so operators can find or replace it.
    pub(crate) fn cert_path(&self) -> &Path {
        &self.cert
    }

    /// Whether the self-signed certificate must be (re)created: a file is missing, or the
    /// certificate expires soon.
    ///
    /// Only expiry triggers a renewal. Any other problem keeps the files, so a server never
    /// silently swaps a certificate that browsers and pinned clients already accepted.
    async fn needs_new_self_signed(&self) -> Result<bool> {
        for path in [&self.cert, &self.key] {
            let exists = tokio::fs::try_exists(path)
                .await
                .with_context(|| format!("Failed to inspect '{}'", path.display()))?;
            if !exists {
                return Ok(true);
            }
        }
        let chain = self.read_chain().await?;
        let Some(leaf) = chain.first() else {
            return Ok(true);
        };
        Ok(expires_within(
            leaf,
            Duration::from_secs(SELF_SIGNED_RENEW_BEFORE_DAYS * 24 * 60 * 60),
        ))
    }

    /// Creates a new key and certificate and writes them with owner-only permissions.
    ///
    /// Both are written to temp files and renamed into place, so a crash leaves either the
    /// previous pair or a missing file, which the next start replaces, never a torn file.
    async fn generate_self_signed(&self, directory: &Path, bind: &str) -> Result<()> {
        let names = self_signed_names(bind).await;
        let (cert_pem, key_pem) = self_signed_pem(&names)?;
        let mut builder = tokio::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(directory)
            .await
            .with_context(|| format!("Failed to create '{}'", directory.display()))?;
        write_private_file(&self.key, key_pem.as_bytes()).await?;
        write_private_file(&self.cert, cert_pem.as_bytes()).await?;
        log!(
            Level::Info,
            "Generated self-signed TLS certificate: cert={}, names={}",
            self.cert.display(),
            names.join(",")
        );
        Ok(())
    }

    /// SHA-256 fingerprint of the leaf certificate in the colon-separated form browsers show,
    /// so a user accepting a self-signed certificate can check it is the server's.
    pub(crate) async fn fingerprint(&self) -> Result<String> {
        use sha2::Digest;
        let chain = self.read_chain().await?;
        let leaf = chain.first().with_context(|| {
            format!(
                "TLS certificate '{}' contains no PEM certificate",
                self.cert.display()
            )
        })?;
        let digest = sha2::Sha256::digest(leaf.as_ref());
        Ok(digest
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":"))
    }

    /// Reads the PEM certificate chain.
    async fn read_chain(&self) -> Result<Vec<CertificateDer<'static>>> {
        let pem = tokio::fs::read(&self.cert)
            .await
            .with_context(|| format!("Failed to read TLS certificate '{}'", self.cert.display()))?;
        let chain = CertificateDer::pem_slice_iter(&pem)
            .collect::<Result<Vec<_>, _>>()
            .with_context(|| format!("Invalid PEM in TLS certificate '{}'", self.cert.display()))?;
        Ok(chain)
    }

    /// Loads the files into the acceptor the listener uses.
    pub(crate) async fn acceptor(&self) -> Result<TlsAcceptor> {
        let chain = self.read_chain().await?;
        anyhow::ensure!(
            !chain.is_empty(),
            "TLS certificate '{}' contains no PEM certificate",
            self.cert.display()
        );
        let key_pem = tokio::fs::read(&self.key)
            .await
            .with_context(|| format!("Failed to read TLS key '{}'", self.key.display()))?;
        let key = PrivateKeyDer::from_pem_slice(&key_pem)
            .with_context(|| format!("Invalid PEM in TLS key '{}'", self.key.display()))?;
        let mut config = rustls::ServerConfig::builder_with_provider(crypto_provider())
            .with_safe_default_protocol_versions()
            .context("The TLS crypto provider supports no default protocol version")?
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .with_context(|| {
                format!(
                    "TLS key '{}' does not fit certificate '{}'",
                    self.key.display(),
                    self.cert.display()
                )
            })?;
        // HTTP/1.1 only, like browsers use over plain HTTP: over HTTP/2 they would open
        // WebSockets with extended CONNECT, which the `get` WebSocket routes do not accept.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(TlsAcceptor::from(Arc::new(config)))
    }
}

/// The process-wide rustls provider, or aws-lc-rs, which this binary compiles in.
fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
}

/// Whether `leaf` is no longer valid `margin` from now.
///
/// Verifies the certificate against itself as the only trust anchor, which checks validity
/// dates without another X.509 parser. Self-signed certificates only, since a chain would
/// need its issuer as the anchor.
fn expires_within(leaf: &CertificateDer<'static>, margin: Duration) -> bool {
    let mut roots = rustls::RootCertStore::empty();
    if roots.add(leaf.clone()).is_err() {
        return false;
    }
    let Ok(verifier) = rustls::client::WebPkiServerVerifier::builder_with_provider(
        roots.into(),
        crypto_provider(),
    )
    .build() else {
        return false;
    };
    let Some(then) = UnixTime::now().as_secs().checked_add(margin.as_secs()) else {
        return false;
    };
    let result = rustls::client::danger::ServerCertVerifier::verify_server_cert(
        verifier.as_ref(),
        leaf,
        &[],
        &ServerName::try_from("localhost").expect("localhost is a valid server name"),
        &[],
        UnixTime::since_unix_epoch(Duration::from_secs(then)),
    );
    matches!(
        result,
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::Expired | rustls::CertificateError::ExpiredContext { .. }
        ))
    )
}

/// Names a new self-signed certificate is valid for: loopback, the hostname, the bind
/// address and the primary LAN address, the names clients of a private server connect with.
async fn self_signed_names(bind: &str) -> Vec<String> {
    let mut names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Some(hostname) = nix::unistd::gethostname()
        .ok()
        .and_then(|name| name.into_string().ok())
    {
        names.push(hostname);
    }
    let bind_is_wildcard = bind
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_unspecified());
    if !bind_is_wildcard {
        names.push(bind.to_string());
    }
    if let Some(address) = redoor_core::identity::external_ip().await {
        names.push(address);
    }
    // rcgen rejects non-ASCII DNS names, and one odd hostname must not stop the server.
    names.retain(|name| !name.is_empty() && name.is_ascii());
    let mut seen = std::collections::HashSet::new();
    names.retain(|name| seen.insert(name.to_ascii_lowercase()));
    names
}

/// Creates a self-signed certificate for `names` and returns it and its key as PEM.
fn self_signed_pem(names: &[String]) -> Result<(String, String)> {
    let mut params = rcgen::CertificateParams::new(names.to_vec())
        .context("Invalid name for the self-signed TLS certificate")?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Redoor self-signed certificate");
    // Apple platforms also refuse server certificates without the server-auth usage.
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let today = jiff::Zoned::now().date();
    // A day of slack keeps clients with a slightly late clock from seeing a future certificate.
    let (year, month, day) = ymd(today.yesterday()?)?;
    params.not_before = rcgen::date_time_ymd(year, month, day);
    let last_day = today.checked_add(jiff::Span::new().days(SELF_SIGNED_VALIDITY_DAYS - 1))?;
    let (year, month, day) = ymd(last_day)?;
    params.not_after = rcgen::date_time_ymd(year, month, day);
    let key = rcgen::KeyPair::generate().context("Failed to generate the TLS key")?;
    let cert = params
        .self_signed(&key)
        .context("Failed to sign the self-signed TLS certificate")?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// Splits a calendar date into the parts `rcgen::date_time_ymd` takes.
fn ymd(date: jiff::civil::Date) -> Result<(i32, u8, u8)> {
    let month = u8::try_from(date.month()).context("month out of range")?;
    let day = u8::try_from(date.day()).context("day out of range")?;
    Ok((i32::from(date.year()), month, day))
}

/// Writes `content` to a sibling temp file created with mode 0600, then renames it over
/// `path`, so the key is never briefly readable by others or half-written.
async fn write_private_file(path: &Path, content: &[u8]) -> Result<()> {
    let temp_path = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let result = async {
        let mut file = options.open(&temp_path).await?;
        file.write_all(content).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temp_path, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    result.with_context(|| format!("Failed to write '{}'", path.display()))
}

/// The server's listener: plain TCP, or TCP with TLS terminated before HTTP sees it.
///
/// One type for both so `axum::serve` and its graceful shutdown are set up once. The TCP
/// listener is owned here rather than by a background task, so dropping this on restart closes
/// the port before the process re-execs.
pub(crate) struct ServerListener {
    /// Bound socket; axum's accept loop on it already backs off on errors like `EMFILE`.
    tcp: TcpListener,
    /// Present when the server serves HTTPS.
    tls: Option<TlsHandshakes>,
}

impl ServerListener {
    /// Wraps the bound socket, terminating TLS on it when `acceptor` is given.
    pub(crate) fn new(tcp: TcpListener, acceptor: Option<TlsAcceptor>) -> Self {
        Self {
            tcp,
            tls: acceptor.map(|acceptor| TlsHandshakes {
                acceptor,
                pending: JoinSet::new(),
            }),
        }
    }
}

/// TLS handshakes in progress, each in its own task so a stalled client blocks nobody.
struct TlsHandshakes {
    /// Certificate and protocol settings shared by every connection.
    acceptor: TlsAcceptor,
    /// Running handshakes; dropping the listener aborts them.
    pending: JoinSet<Option<(TlsStream<TcpStream>, SocketAddr)>>,
}

impl TlsHandshakes {
    /// Starts the handshake of a newly accepted connection.
    fn start(&mut self, (stream, peer): (TcpStream, SocketAddr)) {
        let acceptor = self.acceptor.clone();
        self.pending.spawn(async move {
            match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                Ok(Ok(stream)) => Some((stream, peer)),
                // Debug only: browsers abort the handshake whenever they show a certificate
                // warning, so failures are routine with a self-signed certificate.
                Ok(Err(error)) => {
                    log!(
                        Level::Debug,
                        "TLS handshake failed: peer={peer}, error={error}"
                    );
                    None
                }
                Err(_) => {
                    log!(Level::Debug, "TLS handshake timed out: peer={peer}");
                    None
                }
            }
        });
    }

    /// The connection a finished handshake produced, if it succeeded.
    fn finished(
        joined: Result<Option<(TlsStream<TcpStream>, SocketAddr)>, JoinError>,
    ) -> Option<(TlsStream<TcpStream>, SocketAddr)> {
        joined.ok().flatten()
    }
}

impl axum::serve::Listener for ServerListener {
    type Io = Either<TcpStream, TlsStream<TcpStream>>;
    type Addr = SocketAddr;

    /// Returns the next connection ready for HTTP: at once for plain TCP, after a completed
    /// handshake for TLS, accepting new connections while handshakes run.
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let Some(tls) = &mut self.tls else {
            let (stream, peer) = axum::serve::Listener::accept(&mut self.tcp).await;
            return (Either::Left(stream), peer);
        };
        loop {
            tokio::select! {
                accepted = axum::serve::Listener::accept(&mut self.tcp) => tls.start(accepted),
                Some(joined) = tls.pending.join_next() => {
                    if let Some((stream, peer)) = TlsHandshakes::finished(joined) {
                        return (Either::Right(stream), peer);
                    }
                }
            }
        }
    }

    /// Address the socket is bound to.
    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;
    use std::os::unix::fs::PermissionsExt;

    /// Prepares the self-signed certificate in `data_dir` as startup does.
    async fn self_signed(data_dir: &Path) -> ServerCertificate {
        ServerCertificate::prepare(&ServerTls::SelfSigned, data_dir, "0.0.0.0")
            .await
            .expect("the self-signed certificate should be prepared")
    }

    /// The first start creates the pair privately, and later starts reuse it unchanged, so
    /// browsers keep the exception a user accepted.
    #[tokio::test]
    async fn self_signed_certificate_is_created_once_and_reused() {
        let directory = TempDir::create();
        let first = self_signed(directory.path()).await;
        let key_mode = tokio::fs::metadata(&first.key)
            .await
            .unwrap()
            .permissions()
            .mode();
        // Other local users must not be able to read the private key.
        assert_eq!(key_mode & 0o777, 0o600);
        let cert_pem = tokio::fs::read(&first.cert).await.unwrap();

        let second = self_signed(directory.path()).await;
        // A restart must present the very same certificate.
        assert_eq!(tokio::fs::read(&second.cert).await.unwrap(), cert_pem);
        // The generated pair must load into a working acceptor.
        second.acceptor().await.unwrap();
    }

    /// A missing key cannot be recovered, so the pair is created again instead of failing.
    #[tokio::test]
    async fn self_signed_certificate_is_recreated_when_a_file_is_missing() {
        let directory = TempDir::create();
        let first = self_signed(directory.path()).await;
        let cert_pem = tokio::fs::read(&first.cert).await.unwrap();
        tokio::fs::remove_file(&first.key).await.unwrap();

        let second = self_signed(directory.path()).await;
        // A new certificate must match the new key, so the old one cannot be kept.
        assert_ne!(tokio::fs::read(&second.cert).await.unwrap(), cert_pem);
        second.acceptor().await.unwrap();
    }

    /// A certificate close to expiry is replaced, so a long-running install never ends up
    /// presenting an expired one.
    #[tokio::test]
    async fn self_signed_certificate_is_renewed_before_expiry() {
        let directory = TempDir::create();
        let certificate = self_signed(directory.path()).await;
        let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(2021, 1, 1);
        let key = rcgen::KeyPair::generate().unwrap();
        let expired = params.self_signed(&key).unwrap().pem();
        tokio::fs::write(&certificate.cert, &expired).await.unwrap();
        tokio::fs::write(&certificate.key, key.serialize_pem())
            .await
            .unwrap();

        let renewed = self_signed(directory.path()).await;
        // The expired certificate must have been replaced by a fresh one.
        assert_ne!(
            tokio::fs::read_to_string(&renewed.cert).await.unwrap(),
            expired
        );
        let chain = renewed.read_chain().await.unwrap();
        // The replacement must still be valid well past the renewal margin.
        assert!(!expires_within(
            &chain[0],
            Duration::from_secs(SELF_SIGNED_RENEW_BEFORE_DAYS * 24 * 60 * 60)
        ));
    }

    /// A key from another certificate is reported with both paths instead of failing later
    /// during handshakes.
    #[tokio::test]
    async fn mismatched_key_is_rejected_when_loading() {
        let first = TempDir::create();
        let second = TempDir::create();
        let a = self_signed(first.path()).await;
        let b = self_signed(second.path()).await;

        let error = ServerCertificate::files(&a.cert, &b.key)
            .acceptor()
            .await
            .err()
            .expect("a key of another certificate must be rejected");
        // The message must point the operator at the two files that do not belong together.
        assert!(format!("{error:#}").contains("does not fit"), "{error:#}");
    }

    /// A client that opens a connection and never starts its handshake must not stop the
    /// listener from serving the next client.
    #[tokio::test]
    async fn stalled_handshake_does_not_block_other_clients() {
        let directory = TempDir::create();
        let certificate = self_signed(directory.path()).await;
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = tcp.local_addr().unwrap();
        let mut listener = ServerListener::new(tcp, Some(certificate.acceptor().await.unwrap()));
        let server = tokio::spawn(async move {
            let (_stream, peer) = axum::serve::Listener::accept(&mut listener).await;
            peer
        });

        // Connected first, so the listener accepts it first and its handshake stalls.
        let _silent = TcpStream::connect(address).await.unwrap();
        let mut roots = rustls::RootCertStore::empty();
        for cert in certificate.read_chain().await.unwrap() {
            roots.add(cert).unwrap();
        }
        let mut config = rustls::ClientConfig::builder_with_provider(crypto_provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        // Offered like a browser does, so the server's choice can be checked.
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let tcp = TcpStream::connect(address).await.unwrap();
        let client_address = tcp.local_addr().unwrap();
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from("localhost").unwrap(), tcp)
            .await
            .expect("the generated certificate must verify for localhost");

        // The listener must hand over the second client while the first one still stalls.
        assert_eq!(server.await.unwrap(), client_address);
        // HTTP/2 must be declined, keeping browser WebSockets on their `get` routes.
        assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    }
}
