use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, value};

use crate::config::LocalAgentConfig;
use crate::ssh::SshBackedAgentConfig;

/// Appends one SSH agent while retaining comments and formatting in unrelated settings.
pub(crate) async fn append_ssh_agent(path: &Path, config: &SshBackedAgentConfig) -> Result<()> {
    append_agent_table(path, ssh_agent_table(config)).await
}

/// Appends one local agent while retaining comments and formatting in unrelated settings.
pub(crate) async fn append_local_agent(path: &Path, config: &LocalAgentConfig) -> Result<()> {
    append_agent_table(path, local_agent_table(config)).await
}

/// Pushes one `[[agents]]` table without rewriting unrelated document formatting.
async fn append_agent_table(path: &Path, table: Table) -> Result<()> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read config file '{}'", path.display()))?;
    let mut document = content
        .parse::<DocumentMut>()
        .with_context(|| format!("Failed to parse config file '{}'", path.display()))?;

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

    replace_atomically(path, document.to_string().as_bytes()).await
}

/// Applies an in-place array edit while retaining unrelated document formatting.
pub(crate) async fn edit_ssh_agent(
    path: &Path,
    agent_id: &str,
    replacement: Option<&SshBackedAgentConfig>,
) -> Result<()> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read config file '{}'", path.display()))?;
    let mut document = content
        .parse::<DocumentMut>()
        .with_context(|| format!("Failed to parse config file '{}'", path.display()))?;
    let agents = document
        .get_mut("agents")
        .and_then(Item::as_array_of_tables_mut)
        .context("top-level 'agents' must be an array of tables")?;
    let index = agents
        .iter()
        .position(|table| ssh_agent_id(table).as_deref() == Some(agent_id))
        .with_context(|| format!("Managed SSH agent '{agent_id}' was not found"))?;
    agents.remove(index);
    if let Some(config) = replacement {
        agents.insert(index, ssh_agent_table(config));
    }
    replace_atomically(path, document.to_string().as_bytes()).await
}

/// Applies an in-place local-agent edit while retaining unrelated document formatting.
pub(crate) async fn edit_local_agent(
    path: &Path,
    agent_id: &str,
    replacement: Option<&LocalAgentConfig>,
) -> Result<()> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("Failed to read config file '{}'", path.display()))?;
    let mut document = content
        .parse::<DocumentMut>()
        .with_context(|| format!("Failed to parse config file '{}'", path.display()))?;
    let agents = document
        .get_mut("agents")
        .and_then(Item::as_array_of_tables_mut)
        .context("top-level 'agents' must be an array of tables")?;
    let index = agents
        .iter()
        .position(|table| local_agent_id(table).as_deref() == Some(agent_id))
        .with_context(|| format!("Managed local agent '{agent_id}' was not found"))?;
    agents.remove(index);
    if let Some(config) = replacement {
        agents.insert(index, local_agent_table(config));
    }
    replace_atomically(path, document.to_string().as_bytes()).await
}

/// Builds the persisted table in one place so create and update stay identical.
fn ssh_agent_table(config: &SshBackedAgentConfig) -> Table {
    let mut table = Table::new();
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
    table
}

/// Writes `local = true` so parse cannot treat the row as SSH after a later edit.
fn local_agent_table(config: &LocalAgentConfig) -> Table {
    let mut table = Table::new();
    table.insert("local", value(true));
    insert_optional_string(&mut table, "name", &config.name);
    insert_optional_string(&mut table, "home", &config.home);
    insert_optional_string(&mut table, "log", &config.log);
    table
}

/// Derives the runtime identity without treating local-agent entries as editable SSH entries.
fn ssh_agent_id(table: &Table) -> Option<String> {
    if table.get("local").and_then(Item::as_bool).unwrap_or(false) {
        return None;
    }
    let target = table.get("target")?.as_str()?;
    Some(
        table
            .get("name")
            .and_then(Item::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| crate::ssh::default_agent_name(target)),
    )
}

/// Derives the runtime identity without treating SSH-backed entries as local edits.
fn local_agent_id(table: &Table) -> Option<String> {
    if !table.get("local").and_then(Item::as_bool).unwrap_or(false) {
        return None;
    }
    Some(
        table
            .get("name")
            .and_then(Item::as_str)
            .map(str::to_string)
            .unwrap_or_else(crate::config::default_local_agent_name),
    )
}

/// Omits absent values so OpenSSH and agent-side defaults remain effective.
fn insert_optional_string(table: &mut Table, key: &str, setting: &Option<String>) {
    if let Some(setting) = setting {
        table.insert(key, value(setting));
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
