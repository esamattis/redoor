//! TEMPORARY MIGRATION: moves the shared account files of the former single named account
//! from `<data_dir>/users/<name>/` to the data directory root.
//!
//! Redoor once kept everything under the login name, as groundwork for several accounts.
//! Now there is one shared account whose vault and SSH keys live directly in the data
//! directory, while each login name keeps its own UI state and editor buffers in
//! `users/<name>/`. So only `vault.json` and `ssh/` move; the old directory stays as that
//! user's personal directory. Remove this module once every installation has started a
//! version that runs it (see `plans/login-methods.md`); ask first.

use std::path::{Path, PathBuf};

use anyhow::Context;
use redoor_core::log;
use redoor_protocol::wire::log::Level;

/// Directory of the per-user directories.
const USERS_DIR: &str = "users";
/// The entries of a legacy account directory that belong to the shared account.
const SHARED_ENTRIES: [&str; 2] = ["vault.json", "ssh"];

/// Moves the shared entries of the one legacy account directory to the data directory root.
///
/// Each entry moves with one atomic rename, and an entry whose destination already exists
/// is left where it is with a warning, so a crash midway simply resumes on the next start.
/// With shared files in more than one user directory it refuses to start rather than guess
/// which one holds the vault.
pub(crate) async fn move_account_directory(data_dir: &Path) -> anyhow::Result<()> {
    let users = data_dir.join(USERS_DIR);
    let legacy = legacy_account_directories(&users).await?;
    let account = match legacy.as_slice() {
        [] => return Ok(()),
        [account] => account,
        _ => {
            let names: Vec<String> = legacy
                .iter()
                .map(|account| account.display().to_string())
                .collect();
            anyhow::bail!(
                "several user directories hold a vault or SSH keys ({}); redoor now keeps one shared vault.json and ssh directory in '{}'. Move the ones to keep there by hand and remove the others",
                names.join(", "),
                data_dir.display()
            );
        }
    };
    for name in SHARED_ENTRIES {
        let source = account.join(name);
        if tokio::fs::symlink_metadata(&source).await.is_err() {
            continue;
        }
        let destination = data_dir.join(name);
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            log!(
                Level::Warning,
                "Not moving '{}': '{}' already exists; the old one is left in place",
                source.display(),
                destination.display()
            );
            continue;
        }
        tokio::fs::rename(&source, &destination)
            .await
            .with_context(|| {
                format!(
                    "Failed to move '{}' to '{}'",
                    source.display(),
                    destination.display()
                )
            })?;
        log!(
            Level::Info,
            "Moved '{}' to '{}'",
            source.display(),
            destination.display()
        );
    }
    Ok(())
}

/// The user directories that still hold a shared entry. A directory whose shared entry was
/// left behind because the destination already existed counts too, so the warning repeats
/// on every start until an operator looks at it.
async fn legacy_account_directories(users: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut entries = match tokio::fs::read_dir(users).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("Failed to read '{}'", users.display()));
        }
    };
    let mut accounts = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let path = entry.path();
        for name in SHARED_ENTRIES {
            if tokio::fs::symlink_metadata(path.join(name)).await.is_ok() {
                accounts.push(path);
                break;
            }
        }
    }
    accounts.sort();
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use redoor_core::test_support::TempDir;

    /// Writes `content` to `path`, creating its parents.
    async fn write(path: &Path, content: &str) {
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, content).await.unwrap();
    }

    /// The vault and SSH keys move to the root, and the user's own state stays in place.
    #[tokio::test]
    async fn single_account_moves_shared_files_to_the_root() {
        let home = TempDir::create();
        let data = home.path();
        write(&data.join("users/esamatti/vault.json"), "vault").await;
        write(&data.join("users/esamatti/ssh/dev_x/known_hosts"), "pin").await;
        write(&data.join("users/esamatti/state.json"), "state").await;
        write(&data.join("users/esamatti/editor-buffers/a.json"), "buffer").await;

        move_account_directory(data).await.unwrap();
        // The shared files are at the root now, nested directories included.
        assert_eq!(
            tokio::fs::read_to_string(data.join("vault.json"))
                .await
                .unwrap(),
            "vault"
        );
        assert_eq!(
            tokio::fs::read_to_string(data.join("ssh/dev_x/known_hosts"))
                .await
                .unwrap(),
            "pin"
        );
        // The user's personal files stay theirs.
        assert!(data.join("users/esamatti/state.json").exists());
        assert!(data.join("users/esamatti/editor-buffers/a.json").exists());
        assert!(!data.join("users/esamatti/vault.json").exists());
        // A second start finds nothing to do.
        move_account_directory(data).await.unwrap();
    }

    /// A start interrupted after moving the vault finishes with the SSH keys, and an entry
    /// whose destination exists stays where it is instead of overwriting the root's.
    #[tokio::test]
    async fn partial_move_resumes_and_keeps_existing_destinations() {
        let home = TempDir::create();
        let data = home.path();
        // vault.json already moved by the interrupted start; ssh not yet.
        write(&data.join("vault.json"), "moved vault").await;
        write(&data.join("users/esamatti/ssh/dev_x/known_hosts"), "pin").await;

        move_account_directory(data).await.unwrap();
        // The remaining entry moved.
        assert!(data.join("ssh/dev_x/known_hosts").exists());
        // The already moved file is untouched.
        assert_eq!(
            tokio::fs::read_to_string(data.join("vault.json"))
                .await
                .unwrap(),
            "moved vault"
        );

        write(&data.join("users/esamatti/vault.json"), "conflicting vault").await;
        move_account_directory(data).await.unwrap();
        // An existing destination keeps its content, and the conflicting file is not lost.
        assert_eq!(
            tokio::fs::read_to_string(data.join("vault.json"))
                .await
                .unwrap(),
            "moved vault"
        );
        assert!(data.join("users/esamatti/vault.json").exists());
    }

    /// Shared files in several user directories stop the start with both named, nothing
    /// moves, and user directories holding only personal files do not count.
    #[tokio::test]
    async fn several_accounts_refuse_to_start() {
        let home = TempDir::create();
        let data = home.path();
        write(&data.join("users/alice/vault.json"), "a").await;
        write(&data.join("users/bob/ssh/dev_x/known_hosts"), "b").await;
        write(&data.join("users/carol/state.json"), "c").await;

        let error = move_account_directory(data).await.unwrap_err().to_string();
        // Both directories are named so the operator can choose; carol has nothing shared.
        assert!(
            error.contains("users/alice")
                && error.contains("users/bob")
                && !error.contains("carol"),
            "{error}"
        );
        // Nothing was moved.
        assert!(!data.join("vault.json").exists());
    }
}
