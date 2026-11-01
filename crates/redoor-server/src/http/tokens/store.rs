//! Server-owned access token store: in-memory table, hashed secrets, durable JSON file.
//!
//! The server process is the only writer, so the store keeps the table in memory and
//! persists it on every mutation instead of re-reading a shared file on every request. That
//! keeps authentication cheap enough for CLI polling and streaming, and needs no
//! cross-process lock.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jiff::{SignedDuration, Timestamp};
use redoor_core::{log, log_error};
use redoor_protocol::{
    api::tokens::{AccessTokenResponse, DeviceScope, Permission},
    ids::AgentId,
    wire::log::Level,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{io::AsyncWriteExt, sync::RwLock};
use uuid::Uuid;

use crate::http::{access::TokenGrant, error::ApiError};

/// Lets a future layout change refuse an unknown file instead of misreading it.
const STORE_VERSION: u32 = 1;
/// Makes leaked tokens recognizable to secret scanners and distinct from other secrets.
const TOKEN_PREFIX: &str = "redoor_at_";
/// Last use is only informational, so persisting it at most once a minute per token keeps
/// authentication from rewriting the file on every request.
const LAST_USED_PERSIST_INTERVAL: SignedDuration = SignedDuration::from_secs(60);
/// Bounds human-facing names so lists and prompts stay readable.
const MAX_NAME_LENGTH: usize = 100;
/// Bounds device ids to the same size the agent registry accepts in practice.
const MAX_DEVICE_ID_LENGTH: usize = 200;

/// Why a token operation failed, so handlers map statuses without matching on message text.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenStoreError {
    /// The requested policy is malformed; the message is safe to show to the user.
    #[error("{0}")]
    Invalid(String),
    /// No token has this id.
    #[error("Access token not found")]
    NotFound,
    /// The token has expired, so editing or rotating it would revive a dead credential.
    #[error("Access token has expired; create a new one instead")]
    Inactive,
    /// The file could not be written; details go to the server log, not the client.
    #[error("Access token storage failed")]
    Storage(#[source] anyhow::Error),
}

impl From<TokenStoreError> for ApiError {
    /// Keeps the token status mapping next to the error it maps.
    fn from(error: TokenStoreError) -> Self {
        match &error {
            TokenStoreError::Invalid(message) => ApiError::bad_request(message.clone()),
            TokenStoreError::NotFound => ApiError::not_found(error.to_string()),
            TokenStoreError::Inactive => ApiError::conflict(error.to_string()),
            TokenStoreError::Storage(source) => {
                log_error!(source, "Access token storage failed");
                ApiError::internal(error.to_string())
            }
        }
    }
}

/// The editable part of a token, validated once here for every caller.
#[derive(Clone, Debug)]
pub(crate) struct TokenPolicy {
    pub(crate) name: String,
    pub(crate) permissions: Vec<Permission>,
    pub(crate) devices: DeviceScope,
}

/// A freshly issued secret with its metadata; the only value that ever holds the secret.
#[derive(Debug)]
pub(crate) struct IssuedToken {
    pub(crate) secret: String,
    pub(crate) metadata: AccessTokenResponse,
}

/// One persisted token. Only the verifier is stored, so the file cannot authenticate.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredToken {
    id: Uuid,
    name: String,
    verifier: String,
    permissions: BTreeSet<Permission>,
    devices: DeviceScope,
    created_at: Timestamp,
    expires_at: Option<Timestamp>,
    last_used_at: Option<Timestamp>,
    /// The last-use value currently on disk, used to throttle last-use writes.
    #[serde(skip)]
    persisted_last_used_at: Option<Timestamp>,
}

impl StoredToken {
    /// Expired tokens stay listed so users see why a client stopped working.
    fn is_expired(&self, now: Timestamp) -> bool {
        self.expires_at.is_some_and(|expiry| expiry <= now)
    }

    /// Builds the secret-free API view.
    fn metadata(&self) -> AccessTokenResponse {
        AccessTokenResponse {
            id: self.id.to_string(),
            name: self.name.clone(),
            permissions: self.permissions.iter().copied().collect(),
            devices: self.devices.clone(),
            created_at: self.created_at.to_string(),
            expires_at: self.expires_at.map(|value| value.to_string()),
            last_used_at: self.last_used_at.map(|value| value.to_string()),
        }
    }

    /// The authorization view handed to request handlers, without lifecycle details. The
    /// name comes along so log lines can say which token made a request.
    fn grant(&self) -> TokenGrant {
        TokenGrant {
            id: self.id,
            name: self.name.clone(),
            permissions: self.permissions.clone(),
            devices: self.devices.clone(),
        }
    }
}

/// On-disk document shape.
#[derive(Serialize, Deserialize)]
struct StoreDocument {
    version: u32,
    tokens: Vec<StoredToken>,
}

/// Cheaply cloneable handle to the single in-memory token table.
#[derive(Clone)]
pub(crate) struct TokenStore {
    path: Arc<PathBuf>,
    /// Writers hold the lock across the file write, so persisted states are never interleaved.
    tokens: Arc<RwLock<Vec<StoredToken>>>,
}

impl TokenStore {
    /// Loads `<data_dir>/tokens/access-tokens.json` once at startup, creating a private directory.
    pub(crate) async fn load(data_dir: &Path) -> anyhow::Result<Self> {
        let directory = data_dir.join("tokens");
        tokio::fs::create_dir_all(&directory)
            .await
            .with_context(|| format!("creating {}", directory.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .await
                .with_context(|| format!("protecting {}", directory.display()))?;
        }
        let path = directory.join("access-tokens.json");
        let tokens = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let document: StoreDocument = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing {}", path.display()))?;
                anyhow::ensure!(
                    document.version == STORE_VERSION,
                    "unsupported access token store version {} in {}",
                    document.version,
                    path.display()
                );
                document
                    .tokens
                    .into_iter()
                    .map(|mut token| {
                        token.persisted_last_used_at = token.last_used_at;
                        token
                    })
                    .collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("reading {}", path.display()));
            }
        };
        Ok(Self {
            path: Arc::new(path),
            tokens: Arc::new(RwLock::new(tokens)),
        })
    }

    /// Mints a new token and returns its secret exactly once.
    pub(crate) async fn create(
        &self,
        policy: TokenPolicy,
        expires_at: Option<Timestamp>,
    ) -> Result<IssuedToken, TokenStoreError> {
        let now = Timestamp::now();
        let policy = validate(policy)?;
        if expires_at.is_some_and(|expiry| expiry <= now) {
            return Err(TokenStoreError::Invalid(
                "Token expiry must be in the future".to_string(),
            ));
        }
        let id = Uuid::new_v4();
        let secret = new_secret(id)?;
        let token = StoredToken {
            id,
            name: policy.name,
            verifier: verifier(&secret),
            permissions: policy.permissions,
            devices: policy.devices,
            created_at: now,
            expires_at,
            last_used_at: None,
            persisted_last_used_at: None,
        };
        let metadata = token.metadata();
        let mut tokens = self.tokens.write().await;
        tokens.push(token);
        if let Err(error) = persist(&self.path, &mut tokens).await {
            // Never hand out a secret the store could forget on restart.
            tokens.retain(|token| token.id != id);
            return Err(error);
        }
        Ok(IssuedToken { secret, metadata })
    }

    /// Lists every token oldest first, without secrets or verifiers.
    pub(crate) async fn list(&self) -> Vec<AccessTokenResponse> {
        let tokens = self.tokens.read().await;
        let mut sorted = tokens.iter().collect::<Vec<_>>();
        sorted.sort_by_key(|token| token.created_at);
        sorted.into_iter().map(StoredToken::metadata).collect()
    }

    /// Reads one token's metadata, used by `/api/v1/tokens/current`.
    pub(crate) async fn get(&self, id: Uuid) -> Option<AccessTokenResponse> {
        self.tokens
            .read()
            .await
            .iter()
            .find(|token| token.id == id)
            .map(StoredToken::metadata)
    }

    /// Replaces the policy in place, so the next request with the same secret sees it.
    pub(crate) async fn update(
        &self,
        id: Uuid,
        policy: TokenPolicy,
    ) -> Result<AccessTokenResponse, TokenStoreError> {
        let policy = validate(policy)?;
        let mut tokens = self.tokens.write().await;
        let index = active_index(&tokens, id)?;
        let previous = tokens[index].clone();
        let token = &mut tokens[index];
        token.name = policy.name;
        token.permissions = policy.permissions;
        token.devices = policy.devices;
        let metadata = token.metadata();
        if let Err(error) = persist(&self.path, &mut tokens).await {
            tokens[index] = previous;
            return Err(error);
        }
        Ok(metadata)
    }

    /// Replaces the secret but keeps the id, so MCP operations owned by the token survive.
    pub(crate) async fn rotate(&self, id: Uuid) -> Result<IssuedToken, TokenStoreError> {
        let secret = new_secret(id)?;
        let mut tokens = self.tokens.write().await;
        let index = active_index(&tokens, id)?;
        let previous = tokens[index].verifier.clone();
        tokens[index].verifier = verifier(&secret);
        let metadata = tokens[index].metadata();
        if let Err(error) = persist(&self.path, &mut tokens).await {
            tokens[index].verifier = previous;
            return Err(error);
        }
        Ok(IssuedToken { secret, metadata })
    }

    /// Deletes a token; any request using it is rejected from now on.
    pub(crate) async fn delete(&self, id: Uuid) -> Result<(), TokenStoreError> {
        let mut tokens = self.tokens.write().await;
        let index = tokens
            .iter()
            .position(|token| token.id == id)
            .ok_or(TokenStoreError::NotFound)?;
        let removed = tokens.remove(index);
        if let Err(error) = persist(&self.path, &mut tokens).await {
            tokens.insert(index, removed);
            return Err(error);
        }
        Ok(())
    }

    /// Verifies a presented secret and records its use; `None` for anything not currently valid.
    pub(crate) async fn authenticate(&self, secret: &str) -> Option<TokenGrant> {
        self.authenticate_at(secret, Timestamp::now()).await
    }

    /// `authenticate` with an explicit clock so expiry and last-use throttling are testable.
    async fn authenticate_at(&self, secret: &str, now: Timestamp) -> Option<TokenGrant> {
        // Hash before parsing so malformed tokens take the same path as unknown ones.
        let presented = verifier(secret);
        let id = parse_token_id(secret)?;
        let mut tokens = self.tokens.write().await;
        let token = tokens.iter_mut().find(|token| token.id == id)?;
        let matches: bool = token.verifier.as_bytes().ct_eq(presented.as_bytes()).into();
        if !matches || token.is_expired(now) {
            return None;
        }
        token.last_used_at = Some(now);
        let grant = token.grant();
        let stale = token
            .persisted_last_used_at
            .is_none_or(|persisted| now.duration_since(persisted) >= LAST_USED_PERSIST_INTERVAL);
        if stale && let Err(error) = persist(&self.path, &mut tokens).await {
            // Last use is informational; failing to record it must not reject the request.
            log!(
                Level::Warning,
                "Failed to record access token use: {error:#}"
            );
        }
        Some(grant)
    }
}

/// Finds a token that may still be edited or rotated.
fn active_index(tokens: &[StoredToken], id: Uuid) -> Result<usize, TokenStoreError> {
    let index = tokens
        .iter()
        .position(|token| token.id == id)
        .ok_or(TokenStoreError::NotFound)?;
    if tokens[index].is_expired(Timestamp::now()) {
        return Err(TokenStoreError::Inactive);
    }
    Ok(index)
}

/// Normalized policy: trimmed name, de-duplicated permissions and device ids.
struct ValidPolicy {
    name: String,
    permissions: BTreeSet<Permission>,
    devices: DeviceScope,
}

/// Rejects policies that would create an unusable or misleading token.
fn validate(policy: TokenPolicy) -> Result<ValidPolicy, TokenStoreError> {
    let invalid = |message: &str| Err(TokenStoreError::Invalid(message.to_string()));
    let name = policy.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_LENGTH {
        return invalid("Token name must contain 1 to 100 characters");
    }
    if policy.permissions.is_empty() {
        return invalid("Token must have at least one permission");
    }
    let devices = match policy.devices {
        DeviceScope::All => DeviceScope::All,
        DeviceScope::Only { device_ids } => {
            if device_ids.is_empty() {
                return invalid("Select at least one device or allow all devices");
            }
            if device_ids
                .iter()
                .any(|id| id.as_str().is_empty() || id.as_str().len() > MAX_DEVICE_ID_LENGTH)
            {
                return invalid("Device ids must contain 1 to 200 characters");
            }
            let unique = device_ids.into_iter().collect::<BTreeSet<AgentId>>();
            DeviceScope::Only {
                device_ids: unique.into_iter().collect(),
            }
        }
    };
    Ok(ValidPolicy {
        name,
        permissions: policy.permissions.into_iter().collect(),
        devices,
    })
}

/// Formats `redoor_at_<id>_<random>`; the id gives an O(1) lookup without trusting the secret.
fn new_secret(id: Uuid) -> Result<String, TokenStoreError> {
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|error| {
        TokenStoreError::Storage(anyhow::anyhow!("failed to read OS randomness: {error}"))
    })?;
    Ok(format!(
        "{TOKEN_PREFIX}{}_{}",
        id.simple(),
        URL_SAFE_NO_PAD.encode(random)
    ))
}

/// Hashes the whole secret; 256 random bits make a slow password hash unnecessary.
fn verifier(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

/// Extracts the embedded id, accepting only the exact canonical format.
fn parse_token_id(secret: &str) -> Option<Uuid> {
    let rest = secret.strip_prefix(TOKEN_PREFIX)?;
    let (id, random) = rest.split_once('_')?;
    if random.is_empty() || id.len() != 32 {
        return None;
    }
    let parsed = Uuid::try_parse(id).ok()?;
    (parsed.simple().to_string() == id).then_some(parsed)
}

/// Atomically replaces the file with a private copy of the table, then marks last use as saved.
async fn persist(path: &Path, tokens: &mut [StoredToken]) -> Result<(), TokenStoreError> {
    write_document(path, tokens)
        .await
        .map_err(TokenStoreError::Storage)?;
    for token in tokens.iter_mut() {
        token.persisted_last_used_at = token.last_used_at;
    }
    Ok(())
}

/// Writes a temp file with mode 0600, fsyncs it and renames it over the store.
async fn write_document(path: &Path, tokens: &[StoredToken]) -> anyhow::Result<()> {
    let document = StoreDocument {
        version: STORE_VERSION,
        tokens: tokens.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&document)?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .await
            .with_context(|| format!("creating {}", temporary.display()))?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path)
            .await
            .with_context(|| format!("replacing {}", path.display()))?;
        if let Some(directory) = path.parent() {
            tokio::fs::File::open(directory).await?.sync_all().await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;

    /// Builds a valid policy so each test changes only what it is about.
    fn policy(permissions: &[Permission]) -> TokenPolicy {
        TokenPolicy {
            name: "test token".to_string(),
            permissions: permissions.to_vec(),
            devices: DeviceScope::All,
        }
    }

    /// Reads the persisted document to observe what survives a restart.
    async fn on_disk(root: &TempDir) -> serde_json::Value {
        let bytes = tokio::fs::read(root.path().join("tokens/access-tokens.json"))
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The secret format is what secret scanners and the id lookup rely on.
    #[test]
    fn secret_format_round_trips_and_rejects_lookalikes() {
        let id = Uuid::new_v4();
        let secret = new_secret(id).unwrap();
        // The prefix identifies the credential type.
        assert!(secret.starts_with("redoor_at_"));
        // The embedded id resolves back to the token without a table scan.
        assert_eq!(parse_token_id(&secret), Some(id));
        // Other credential namespaces, hyphenated ids and missing randomness are not tokens.
        assert_eq!(
            parse_token_id(&format!("redoor_mcp_{}_x", id.simple())),
            None
        );
        assert_eq!(parse_token_id(&format!("redoor_at_{id}_x")), None);
        assert_eq!(parse_token_id(&format!("redoor_at_{}_", id.simple())), None);
        assert_eq!(
            parse_token_id(&format!(
                "redoor_at_{}_x",
                id.simple().to_string().to_uppercase()
            )),
            None
        );
    }

    /// Creation, authentication, rotation and deletion behave as one lifecycle.
    #[tokio::test]
    async fn lifecycle_rotation_keeps_id_and_deletion_rejects() {
        let root = TempDir::create();
        let store = TokenStore::load(root.path()).await.unwrap();
        let issued = store
            .create(policy(&[Permission::FilesRead]), None)
            .await
            .unwrap();
        let grant = store.authenticate(&issued.secret).await.unwrap();
        // The grant carries the stored policy.
        assert_eq!(grant.id.to_string(), issued.metadata.id);
        assert!(grant.permissions.contains(&Permission::FilesRead));
        // A malformed or wrong secret is rejected without error.
        assert!(store.authenticate("garbage").await.is_none());
        let mut tampered = issued.secret.clone();
        tampered.push('x');
        assert!(store.authenticate(&tampered).await.is_none());

        let rotated = store.rotate(grant.id).await.unwrap();
        // Rotation keeps the id so operation ownership survives.
        assert_eq!(rotated.metadata.id, issued.metadata.id);
        // Only the new secret authenticates afterwards.
        assert!(store.authenticate(&issued.secret).await.is_none());
        assert!(store.authenticate(&rotated.secret).await.is_some());

        store.delete(grant.id).await.unwrap();
        // Deletion takes effect on the very next request.
        assert!(store.authenticate(&rotated.secret).await.is_none());
        // Deleting again reports the missing token.
        assert!(matches!(
            store.delete(grant.id).await,
            Err(TokenStoreError::NotFound)
        ));
    }

    /// Expired tokens stop authenticating and cannot be revived by editing or rotation.
    #[tokio::test]
    async fn expiry_rejects_authentication_and_mutation() {
        let root = TempDir::create();
        let store = TokenStore::load(root.path()).await.unwrap();
        let expiry = Timestamp::now() + SignedDuration::from_secs(3600);
        let issued = store
            .create(policy(&[Permission::FilesRead]), Some(expiry))
            .await
            .unwrap();
        // Before expiry the token works.
        assert!(
            store
                .authenticate_at(&issued.secret, expiry - SignedDuration::from_secs(1))
                .await
                .is_some()
        );
        // At the expiry instant it is rejected.
        assert!(
            store
                .authenticate_at(&issued.secret, expiry)
                .await
                .is_none()
        );
        // A past expiry is invalid at creation.
        assert!(matches!(
            store
                .create(
                    policy(&[Permission::FilesRead]),
                    Some(Timestamp::now() - SignedDuration::from_secs(1))
                )
                .await,
            Err(TokenStoreError::Invalid(_))
        ));
    }

    /// Validation rejects policies that would be useless or ambiguous.
    #[tokio::test]
    async fn validation_rejects_bad_policies() {
        let root = TempDir::create();
        let store = TokenStore::load(root.path()).await.unwrap();
        let cases = [
            TokenPolicy {
                name: "  ".to_string(),
                ..policy(&[Permission::FilesRead])
            },
            TokenPolicy {
                name: "x".repeat(101),
                ..policy(&[Permission::FilesRead])
            },
            policy(&[]),
            TokenPolicy {
                devices: DeviceScope::Only { device_ids: vec![] },
                ..policy(&[Permission::FilesRead])
            },
            TokenPolicy {
                devices: DeviceScope::Only {
                    device_ids: vec![AgentId::unchecked("")],
                },
                ..policy(&[Permission::FilesRead])
            },
        ];
        for case in cases {
            // Every invalid policy is a client error, never a stored token.
            assert!(matches!(
                store.create(case, None).await,
                Err(TokenStoreError::Invalid(_))
            ));
        }
        // Nothing was stored by the rejected attempts.
        assert!(store.list().await.is_empty());
    }

    /// The store survives a restart and its file is private.
    #[tokio::test]
    async fn persistence_round_trip_is_private() {
        let root = TempDir::create();
        let store = TokenStore::load(root.path()).await.unwrap();
        let issued = store
            .create(
                TokenPolicy {
                    name: " padded ".to_string(),
                    permissions: vec![Permission::FilesWrite, Permission::FilesRead],
                    devices: DeviceScope::Only {
                        device_ids: vec![
                            redoor_core::test_support::test_agent_id("b"),
                            redoor_core::test_support::test_agent_id("a"),
                            redoor_core::test_support::test_agent_id("b"),
                        ],
                    },
                },
                None,
            )
            .await
            .unwrap();
        let reloaded = TokenStore::load(root.path()).await.unwrap();
        let listed = reloaded.list().await;
        // The reloaded token keeps its normalized policy.
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "padded");
        assert_eq!(
            listed[0].permissions,
            vec![Permission::FilesRead, Permission::FilesWrite]
        );
        assert_eq!(
            listed[0].devices,
            DeviceScope::Only {
                device_ids: vec![
                    redoor_core::test_support::test_agent_id("a"),
                    redoor_core::test_support::test_agent_id("b")
                ]
            }
        );
        // The secret still authenticates after restart.
        assert!(reloaded.authenticate(&issued.secret).await.is_some());
        let raw = tokio::fs::read_to_string(root.path().join("tokens/access-tokens.json"))
            .await
            .unwrap();
        // Only the verifier is stored, never the secret.
        assert!(!raw.contains(&issued.secret));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = tokio::fs::metadata(root.path().join("tokens/access-tokens.json"))
                .await
                .unwrap()
                .permissions()
                .mode();
            // Other local users cannot read the verifiers.
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// Authentication only rewrites the file when the stored last use is over a minute old.
    #[tokio::test]
    async fn last_used_persistence_is_throttled() {
        let root = TempDir::create();
        let store = TokenStore::load(root.path()).await.unwrap();
        let issued = store
            .create(policy(&[Permission::FilesRead]), None)
            .await
            .unwrap();
        let start = Timestamp::now();
        store.authenticate_at(&issued.secret, start).await.unwrap();
        // The first use is persisted at once.
        assert_eq!(
            on_disk(&root).await["tokens"][0]["last_used_at"],
            serde_json::json!(start.to_string())
        );
        let soon = start + SignedDuration::from_secs(30);
        store.authenticate_at(&issued.secret, soon).await.unwrap();
        // A use within the interval is kept in memory only.
        assert_eq!(
            on_disk(&root).await["tokens"][0]["last_used_at"],
            serde_json::json!(start.to_string())
        );
        // The in-memory value is current for listings.
        assert_eq!(store.list().await[0].last_used_at, Some(soon.to_string()));
        let later = start + SignedDuration::from_secs(61);
        store.authenticate_at(&issued.secret, later).await.unwrap();
        // Once the stored value is stale it is written again.
        assert_eq!(
            on_disk(&root).await["tokens"][0]["last_used_at"],
            serde_json::json!(later.to_string())
        );
    }
}
