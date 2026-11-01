//! Edits `[[agents]]` entries in place with `toml_edit` so operator comments and formatting
//! survive programmatic changes.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, value};

use crate::config::LocalAgentConfig;
use crate::config::SshBackedAgentConfig;
use redoor_protocol::ids::AgentId;

/// Appends one SSH agent while retaining comments and formatting in unrelated settings.
pub async fn append_ssh_agent(path: &Path, config: &SshBackedAgentConfig) -> Result<()> {
    append_agent_table(path, ssh_agent_table(config)).await
}

/// Appends one local agent while retaining comments and formatting in unrelated settings.
pub async fn append_local_agent(path: &Path, config: &LocalAgentConfig) -> Result<()> {
    append_agent_table(path, local_agent_table(config)).await
}

/// Pushes one `[[agents]]` table without rewriting unrelated document formatting.
async fn append_agent_table(path: &Path, table: Table) -> Result<()> {
    let mut transaction = ConfigTransaction::begin(path).await?;
    let document = &mut transaction.document;

    match document.get_mut("agents") {
        Some(item) => item
            .as_array_of_tables_mut()
            .context("top-level 'agents' must be an array of tables")?
            .push(table),
        None => {
            let mut agents = ArrayOfTables::new();
            agents.push(table);
            document.insert("agents", Item::ArrayOfTables(agents));
        }
    }

    transaction.commit().await
}

/// Applies an in-place array edit while retaining unrelated document formatting.
///
/// The entry is found by its `id`, which never changes, so a rename in the same edit cannot
/// lose track of it.
pub async fn edit_ssh_agent(
    path: &Path,
    agent_id: &AgentId,
    replacement: Option<&SshBackedAgentConfig>,
) -> Result<()> {
    let mut transaction = ConfigTransaction::begin(path).await?;
    let agents = transaction
        .document
        .get_mut("agents")
        .and_then(Item::as_array_of_tables_mut)
        .context("top-level 'agents' must be an array of tables")?;
    let index = agents
        .iter()
        .position(|table| is_entry(table, agent_id, false))
        .with_context(|| format!("Managed SSH agent '{agent_id}' was not found"))?;
    agents.remove(index);
    if let Some(config) = replacement {
        agents.insert(index, ssh_agent_table(config));
    }
    transaction.commit().await
}

/// Applies an in-place local-agent edit while retaining unrelated document formatting.
///
/// Found by `id` like [`edit_ssh_agent`].
pub async fn edit_local_agent(
    path: &Path,
    agent_id: &AgentId,
    replacement: Option<&LocalAgentConfig>,
) -> Result<()> {
    let mut transaction = ConfigTransaction::begin(path).await?;
    let agents = transaction
        .document
        .get_mut("agents")
        .and_then(Item::as_array_of_tables_mut)
        .context("top-level 'agents' must be an array of tables")?;
    let index = agents
        .iter()
        .position(|table| is_entry(table, agent_id, true))
        .with_context(|| format!("Managed local agent '{agent_id}' was not found"))?;
    agents.remove(index);
    if let Some(config) = replacement {
        agents.insert(index, local_agent_table(config));
    }
    transaction.commit().await
}

/// Why [`set_server_password`] refused to write.
#[derive(Debug, thiserror::Error)]
pub enum ServerPasswordEditError {
    /// The file no longer has a password login for this user, for example after a hand edit
    /// that removed or renamed it. Writing the password anyway would leave a config that
    /// means something different from what the user confirmed.
    #[error("The config file no longer has a password login named '{0}'")]
    CredentialsChanged(String),
    /// Reading, parsing, locking or replacing the file failed.
    #[error(transparent)]
    Io(#[from] anyhow::Error),
}

/// The line the non-Linux starter config writes about its demo login. It would be false after
/// a password change, so the change removes it.
const BOOTSTRAP_PASSWORD_COMMENT: &str =
    "# Browser login uses username redoor and password changeme.
";

/// Replaces the password of the login `name` with `password_hash`, a PHC string, keeping the
/// rest of the file and the value's own comments as they are.
///
/// The login is the `[server] username`/`password` shorthand when its username is `name`,
/// otherwise the `[[server.users]]` entry with that name. The write is refused when neither
/// exists with a string password, so a file whose login was removed by hand meanwhile is
/// never half-updated.
pub async fn set_server_password(
    path: &Path,
    name: &str,
    password_hash: &str,
) -> std::result::Result<(), ServerPasswordEditError> {
    let mut transaction = ConfigTransaction::begin(path).await?;
    let changed = || ServerPasswordEditError::CredentialsChanged(name.to_string());
    let server = transaction
        .document
        .get_mut("server")
        .and_then(Item::as_table_like_mut)
        .ok_or_else(changed)?;
    let password = if server.get("username").and_then(Item::as_str) == Some(name) {
        server.get_mut("password").and_then(Item::as_value_mut)
    } else {
        user_entry_password(server.get_mut("users"), name)
    }
    .filter(|value| value.is_str())
    .ok_or_else(changed)?;
    // Keeps a trailing comment such as `# rotated yearly` on the line.
    let decor = password.decor().clone();
    *password = toml_edit::Value::from(password_hash);
    *password.decor_mut() = decor;
    remove_bootstrap_password_comment(&mut transaction.document);
    transaction.commit().await?;
    Ok(())
}

/// The `password` value of the `[[server.users]]` entry named `name`, written either as an
/// array of tables or as an inline array of inline tables.
fn user_entry_password<'a>(
    users: Option<&'a mut Item>,
    name: &str,
) -> Option<&'a mut toml_edit::Value> {
    let is_named =
        |entry: &dyn toml_edit::TableLike| entry.get("name").and_then(Item::as_str) == Some(name);
    match users? {
        Item::ArrayOfTables(tables) => tables
            .iter_mut()
            .find(|table| is_named(*table))?
            .get_mut("password")?
            .as_value_mut(),
        Item::Value(toml_edit::Value::Array(array)) => array
            .iter_mut()
            .filter_map(toml_edit::Value::as_inline_table_mut)
            .find(|table| is_named(*table))?
            .get_mut("password"),
        _ => None,
    }
}

/// Drops [`BOOTSTRAP_PASSWORD_COMMENT`] from the comments above the first key, where the
/// starter config puts it.
fn remove_bootstrap_password_comment(document: &mut DocumentMut) {
    let Some((mut key, _)) = document.iter_mut().next() else {
        return;
    };
    let decor = key.leaf_decor_mut();
    let Some(prefix) = decor.prefix().and_then(|prefix| prefix.as_str()) else {
        return;
    };
    if prefix.contains(BOOTSTRAP_PASSWORD_COMMENT) {
        let cleaned = prefix.replacen(BOOTSTRAP_PASSWORD_COMMENT, "", 1);
        decor.set_prefix(cleaned);
    }
}

/// Builds the persisted table in one place so create and update stay identical.
fn ssh_agent_table(config: &SshBackedAgentConfig) -> Table {
    let mut table = Table::new();
    insert_id(&mut table, "id", config.id.as_ref());
    table.insert("target", value(&config.target));
    insert_optional_string(&mut table, "username", &config.username);
    if let Some(ssh_port) = config.ssh_port {
        table.insert("ssh_port", value(i64::from(ssh_port)));
    }
    insert_optional_string(&mut table, "name", &config.name);
    insert_optional_string(&mut table, "remote_bin", &config.remote_bin);
    insert_optional_string(&mut table, "home", &config.home);
    insert_optional_string(&mut table, "log", &config.log);
    insert_optional_string(&mut table, "password", &config.password);
    // Omitted when false, so devices without a managed key keep their entry unchanged.
    if config.managed_ssh_key {
        table.insert("managed_ssh_key", value(true));
    }
    table
}

/// Writes `local = true` so parse cannot treat the row as SSH after a later edit.
fn local_agent_table(config: &LocalAgentConfig) -> Table {
    let mut table = Table::new();
    insert_id(&mut table, "id", config.id.as_ref());
    table.insert("local", value(true));
    insert_optional_string(&mut table, "name", &config.name);
    insert_optional_string(&mut table, "home", &config.home);
    insert_optional_string(&mut table, "log", &config.log);
    table
}

/// Whether a table is the entry with this id and kind, so an SSH edit can never replace a
/// local entry that somehow shares the id, or the other way around.
fn is_entry(table: &Table, agent_id: &AgentId, local: bool) -> bool {
    let is_local = table.get("local").and_then(Item::as_bool).unwrap_or(false);
    is_local == local && table.get("id").and_then(Item::as_str) == Some(agent_id.as_str())
}

/// Writes the id first so it stays at the top of the entry where operators look for it.
fn insert_id(table: &mut Table, key: &str, id: Option<&AgentId>) {
    if let Some(id) = id {
        table.insert(key, value(id.as_str()));
    }
}

/// Omits absent values so OpenSSH and agent-side defaults remain effective.
fn insert_optional_string(table: &mut Table, key: &str, setting: &Option<String>) {
    if let Some(setting) = setting {
        table.insert(key, value(setting));
    }
}

/// Which entries [`assign_missing_device_ids`] gives ids to; each process only assigns the
/// ids it owns, so a read-only file fails only the process that needs the write.
pub enum DeviceIdScope<'a> {
    /// Every `[[agents]]` entry, owned by the server.
    ManagedAgents,
    /// The `agent_id` of one `[[relays]]` entry, owned by the relay process with this ID.
    Relay(&'a str),
}

/// One entry that has no id yet, with the id generated for it.
struct MissingId {
    /// Human-readable entry label used in the read-only error.
    label: String,
    /// Key the id is stored under (`id` or `agent_id`).
    key: &'static str,
    /// Freshly generated id written into the entry.
    id: AgentId,
}

/// Gives every entry in `scope` that has no id a fresh one and writes it into the file.
///
/// Users write entries by hand and should not have to invent ids, but an id kept only in
/// memory would change on every start and silently break token scopes. So the id is written
/// back with the same formatting-preserving rewrite agent edits use, and when the file cannot
/// be written, startup fails with ready-to-paste lines instead. Returns how many ids were
/// assigned.
///
/// The common case of a file whose entries all have ids is checked without the config lock,
/// so a read-only deployment never needs to create the lock file.
pub async fn assign_missing_device_ids(path: &Path, scope: DeviceIdScope<'_>) -> Result<usize> {
    let mut snapshot = read_document(path).await?;
    let unlocked_missing = insert_missing_ids(&mut snapshot, &scope);
    if unlocked_missing.is_empty() {
        return Ok(0);
    }
    let mut transaction = match ConfigTransaction::begin(path).await {
        Ok(transaction) => transaction,
        Err(error) => bail!(
            "{}",
            read_only_message(path, &format!("{error:#}"), &unlocked_missing)
        ),
    };
    // Generated again under the lock: another process may have assigned ids meanwhile, and
    // writing back the unlocked snapshot would erase them.
    let missing = insert_missing_ids(&mut transaction.document, &scope);
    if missing.is_empty() {
        return Ok(0);
    }
    // The atomic replace writes a sibling and renames it, which would also succeed for a
    // read-only file in a writable directory; opening it for writing first respects the
    // operator's choice to make the file read-only.
    let writable = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map(drop)
        .with_context(|| {
            format!(
                "Failed to open config file '{}' for writing",
                path.display()
            )
        });
    let written = match writable {
        Ok(()) => transaction.commit().await,
        Err(error) => Err(error),
    };
    if let Err(error) = written {
        bail!(
            "{}",
            read_only_message(path, &format!("{error:#}"), &missing)
        );
    }
    Ok(missing.len())
}

/// Adds generated ids to the entries in scope that lack one and reports what was added.
fn insert_missing_ids(document: &mut DocumentMut, scope: &DeviceIdScope<'_>) -> Vec<MissingId> {
    let (section, key) = match scope {
        DeviceIdScope::ManagedAgents => ("agents", "id"),
        DeviceIdScope::Relay(_) => ("relays", "agent_id"),
    };
    let Some(tables) = document
        .get_mut(section)
        .and_then(Item::as_array_of_tables_mut)
    else {
        return Vec::new();
    };
    let mut missing = Vec::new();
    for (index, table) in tables.iter_mut().enumerate() {
        if let DeviceIdScope::Relay(relay_id) = scope
            && table.get("id").and_then(Item::as_str) != Some(*relay_id)
        {
            continue;
        }
        if table.contains_key(key) {
            continue;
        }
        let id = AgentId::generate();
        let label = entry_label(section, index, table);
        table.insert(key, value(id.as_str()));
        // `insert` appends; moving the id first keeps it where operators look for it.
        table.sort_values_by(|left, _, right, _| (right.get() == key).cmp(&(left.get() == key)));
        missing.push(MissingId { label, key, id });
    }
    missing
}

/// Labels an entry by position and the fields that identify it to a human.
fn entry_label(section: &str, index: usize, table: &Table) -> String {
    let field = |key: &str| table.get(key).and_then(Item::as_str).map(str::to_string);
    let details = [
        field("id").map(|id| format!("id '{id}'")),
        field("name").map(|name| format!("name '{name}'")),
        field("target").map(|target| format!("target '{target}'")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if details.is_empty() {
        format!("[[{section}]] entry #{index}")
    } else {
        format!("[[{section}]] entry #{index} ({})", details.join(", "))
    }
}

/// Builds the error for a config that cannot be written, with one ready-to-paste line per
/// entry so operators of read-only mounts can fix the file themselves.
fn read_only_message(path: &Path, error: &str, missing: &[MissingId]) -> String {
    let entries = missing
        .iter()
        .map(|entry| {
            format!(
                "  {}:
    {} = \"{}\"",
                entry.label, entry.key, entry.id
            )
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    format!(
        "Config file '{}' has entries without a device id, and the generated ids could not be written back: {error}
Add these lines to the entries and start again:
{entries}",
        path.display()
    )
}

/// Reads and parses the config with `toml_edit` so edits keep the operator's formatting.
async fn read_document(path: &Path) -> Result<DocumentMut> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read config file '{}'", path.display()))?;
    content
        .parse::<DocumentMut>()
        .with_context(|| format!("Failed to parse config file '{}'", path.display()))
}

/// One read-modify-write of the config file under an exclusive cross-process lock.
///
/// The server's edit routes, server startup and every relay process rewrite the same file.
/// Each replaces the whole file, so without a lock held from read to replace, a writer
/// working from an older read would silently drop another's change, such as a device id
/// that is already in use.
struct ConfigTransaction {
    /// Config file being rewritten.
    path: PathBuf,
    /// Document read after the lock was taken; edits are applied to it.
    document: DocumentMut,
    /// Advisory `flock` on the sibling lock file; closing the descriptor releases it.
    _lock: std::fs::File,
}

impl ConfigTransaction {
    /// Waits for the config lock, then reads the current document.
    async fn begin(path: &Path) -> Result<Self> {
        let lock = Self::lock(path).await?;
        let document = read_document(path).await?;
        Ok(Self {
            path: path.to_path_buf(),
            document,
            _lock: lock,
        })
    }

    /// Takes an exclusive `flock` on `.<file>.lock` next to the config.
    ///
    /// A separate file is locked because the config itself is replaced by rename, which
    /// would leave a lock on the old inode. The lock file is never deleted, since removing
    /// it would let two processes lock different inodes. `flock` blocks, so it runs on the
    /// blocking pool; config edits are rare and short.
    async fn lock(path: &Path) -> Result<std::fs::File> {
        let parent = path
            .parent()
            .with_context(|| format!("Config path '{}' has no parent", path.display()))?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .with_context(|| format!("Config path '{}' has no UTF-8 file name", path.display()))?;
        let lock_path = parent.join(format!(".{file_name}.lock"));
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options
            .open(&lock_path)
            .await
            .with_context(|| format!("Failed to open config lock '{}'", lock_path.display()))?
            .into_std()
            .await;
        tokio::task::spawn_blocking(move || {
            use std::os::fd::AsRawFd;
            // SAFETY: `file` owns a valid descriptor for the duration of this blocking call.
            nix::errno::Errno::result(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) })
                .map(|_| file)
        })
        .await
        .context("Config lock task failed")?
        .with_context(|| format!("Failed to lock config lock '{}'", lock_path.display()))
    }

    /// Replaces the config with the edited document, still under the lock.
    async fn commit(self) -> Result<()> {
        replace_atomically(&self.path, self.document.to_string().as_bytes()).await
    }
}

/// Replaces the config only after the complete candidate is durable on the same filesystem.
async fn replace_atomically(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Config path '{}' has no parent", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .with_context(|| format!("Config path '{}' has no UTF-8 file name", path.display()))?;
    let temp_path = temporary_path(parent, file_name);
    let metadata = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("Failed to inspect config file '{}'", path.display()))?;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        options.mode(metadata.permissions().mode());
    }
    let mut file = options.open(&temp_path).await.with_context(|| {
        format!(
            "Failed to create temporary config '{}'",
            temp_path.display()
        )
    })?;
    if let Err(error) = async {
        file.write_all(content).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temp_path, path).await?;
        Ok::<(), std::io::Error>(())
    }
    .await
    {
        let _ = tokio::fs::remove_file(&temp_path).await;
        bail!(
            "Failed to replace config file '{}': {error}",
            path.display()
        );
    }
    Ok(())
}

/// Uses an unpredictable sibling name so concurrent processes cannot clobber a candidate.
fn temporary_path(parent: &Path, file_name: &str) -> PathBuf {
    parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// Writes `content` to a config file in a fresh directory.
    async fn config_file(content: &str) -> (TempDir, PathBuf) {
        let directory = TempDir::create();
        let path = directory.path().join("config.toml");
        tokio::fs::write(&path, content).await.unwrap();
        (directory, path)
    }

    /// Hand-written entries get ids written back without disturbing the operator's comments
    /// and formatting, and the ids stay the same on the next start.
    #[tokio::test]
    async fn assigns_missing_ids_and_keeps_formatting() {
        let original = r#"# top comment
agent_token = "t"

[[agents]]
# the pi in the closet
target = "pi"   # trailing comment

[[agents]]
id = "dev_abcdefghijklmnopqrst"
local = true
"#;
        let (_directory, path) = config_file(original).await;
        let assigned = assign_missing_device_ids(&path, DeviceIdScope::ManagedAgents)
            .await
            .unwrap();
        // Only the entry without an id gets one.
        assert_eq!(assigned, 1);
        let written = tokio::fs::read_to_string(&path).await.unwrap();
        // Comments and the existing id survive the rewrite.
        for kept in [
            "# top comment",
            "# the pi in the closet",
            r#"target = "pi"   # trailing comment"#,
            r#"id = "dev_abcdefghijklmnopqrst""#,
        ] {
            assert!(written.contains(kept), "{kept} missing from: {written}");
        }
        let config = crate::config::parse_config_file(&path).await.unwrap();
        let first_id = config.agents[0].id().cloned().expect("id was written back");
        // A second start finds every id present and leaves the file alone.
        assert_eq!(
            assign_missing_device_ids(&path, DeviceIdScope::ManagedAgents)
                .await
                .unwrap(),
            0
        );
        let config = crate::config::parse_config_file(&path).await.unwrap();
        assert_eq!(config.agents[0].id(), Some(&first_id));
    }

    /// The relay scope only touches its own entry, so a relay never rewrites entries owned by
    /// the server or other relays.
    #[tokio::test]
    async fn relay_scope_assigns_only_its_own_entry() {
        let (_directory, path) = config_file(
            r#"agent_token = "t"
[[agents]]
target = "pi"
[[relays]]
id = "one"
target = "a"
server = "http://redoor.example.com"
[[relays]]
id = "two"
target = "b"
server = "http://redoor.example.com"
"#,
        )
        .await;
        assign_missing_device_ids(&path, DeviceIdScope::Relay("two"))
            .await
            .unwrap();
        let config = crate::config::parse_config_file(&path).await.unwrap();
        // Only relay "two" got an agent_id.
        assert!(config.agents[0].id().is_none());
        assert!(config.relays[0].agent.id.is_none());
        assert!(config.relays[1].agent.id.is_some());
    }

    /// Two relays starting at the same time both keep their ids: each rewrite happens under
    /// the config lock and starts from the other's result instead of an older read.
    #[tokio::test]
    async fn concurrent_relay_assignments_keep_both_ids() {
        // Several rounds, because an unlocked read-modify-write only loses an id when the
        // two rewrites interleave.
        for _ in 0..20 {
            let (_directory, path) = config_file(
                r#"agent_token = "t"
[[relays]]
id = "one"
target = "a"
server = "http://redoor.example.com"
[[relays]]
id = "two"
target = "b"
server = "http://redoor.example.com"
"#,
            )
            .await;
            let (one, two) = tokio::join!(
                assign_missing_device_ids(&path, DeviceIdScope::Relay("one")),
                assign_missing_device_ids(&path, DeviceIdScope::Relay("two")),
            );
            one.unwrap();
            two.unwrap();
            let config = crate::config::parse_config_file(&path).await.unwrap();
            // Neither write erased the other's id.
            assert!(config.relays.iter().all(|relay| relay.agent.id.is_some()));
        }
    }

    /// A config that cannot be written fails with ready-to-paste lines instead of keeping ids
    /// only in memory, which would change them on every start.
    #[cfg(unix)]
    #[tokio::test]
    async fn read_only_config_prints_ready_to_paste_ids() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, path) = config_file(
            r#"agent_token = "t"
[[agents]]
name = "pi"
target = "pi.local"
"#,
        )
        .await;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444))
            .await
            .unwrap();
        // Root ignores file permissions, so the scenario cannot be produced there.
        if tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .is_ok()
        {
            return;
        }
        let error = assign_missing_device_ids(&path, DeviceIdScope::ManagedAgents)
            .await
            .expect_err("a read-only config cannot take the ids");
        let message = format!("{error:#}");
        // The entry is named and a complete `id = "dev_..."` line is printed for it.
        assert!(
            message.contains("[[agents]] entry #0 (name 'pi', target 'pi.local')"),
            "{message}"
        );
        assert!(message.contains(r#"id = "dev_"#), "{message}");
        // The file itself is untouched.
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(!content.contains("dev_"), "{content}");
    }

    /// A password change swaps only the value, keeping comments, the line's own comment and
    /// the rest of the file, and drops the starter config's now false demo-password note.
    #[tokio::test]
    async fn sets_the_server_password_in_place() {
        let original = r#"# Redoor configuration
# Browser login uses username redoor and password changeme.
agent_token = "t"

[server]
# who may log in
username = "redoor"
password = "changeme" # demo
port = 7666
"#;
        let (_directory, path) = config_file(original).await;
        set_server_password(
            &path,
            "redoor",
            "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
        )
        .await
        .expect("the password must be written");
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        // Only the value changes; the trailing comment and neighbouring keys stay.
        assert!(
            content.contains(r#"password = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" # demo"#),
            "{content}"
        );
        assert!(content.contains("# who may log in"), "{content}");
        assert!(content.contains("port = 7666"), "{content}");
        // The starter note would name a password that no longer works.
        assert!(!content.contains("password changeme"), "{content}");
        assert!(content.starts_with("# Redoor configuration"), "{content}");
    }

    /// A `[[server.users]]` entry gets its own password changed and no other entry's.
    #[tokio::test]
    async fn sets_a_listed_users_password_in_place() {
        let original = r#"agent_token = "t"

[[server.users]]
name = "alice"
password = "alice-password" # first

[[server.users]]
name = "bob"
password = "bob-password"
"#;
        let (_directory, path) = config_file(original).await;
        set_server_password(&path, "bob", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")
            .await
            .expect("the password must be written");
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        // Only bob's value changes.
        assert!(
            content.contains(r#"password = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA""#),
            "{content}"
        );
        // Alice's password and its comment are untouched.
        assert!(
            content.contains(r#"password = "alice-password" # first"#),
            "{content}"
        );
        assert!(!content.contains("bob-password"), "{content}");
    }

    /// A file whose credentials were edited by hand since startup is left alone, because
    /// writing only the password could produce credentials nobody confirmed.
    #[tokio::test]
    async fn refuses_to_set_the_password_when_credentials_changed() {
        let cases = [
            r#"agent_token = "t"
[server]
username = "other"
password = "x"
"#,
            r#"agent_token = "t"
[server]
port = 7666
"#,
            r#"agent_token = "t"
"#,
            r#"agent_token = "t"
[[server.users]]
name = "other"
password = "x"
"#,
        ];
        for original in cases {
            let (_directory, path) = config_file(original).await;
            let error = set_server_password(&path, "redoor", "$argon2id$hash")
                .await
                .expect_err("a changed file must not be written");
            // The caller tells the user to restart instead of reporting an I/O failure.
            assert!(
                matches!(error, ServerPasswordEditError::CredentialsChanged(_)),
                "{error:?}"
            );
            // Nothing was written.
            assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), original);
        }
    }
}
