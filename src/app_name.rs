//! Resolves the application namespace used for persistent paths and service names.

use std::{path::PathBuf, sync::OnceLock};

use anyhow::{Context, Result};

/// Environment variable that lets independent Redoor installations avoid sharing state.
pub(crate) const APP_NAME_ENV: &str = "REDOOR_APP_NAME";

/// Stable namespace retained when no installation-specific name is configured.
const DEFAULT_APP_NAME: &str = "redoor";

/// Clap initializes this once so every subsystem observes the same namespace.
static APP_NAME: OnceLock<String> = OnceLock::new();

/// Stores the root CLI value before command dispatch begins.
pub(crate) fn initialize(app_name: String) {
    APP_NAME
        .set(app_name)
        .expect("application name must only be initialized once");
}

/// Parses and validates a root `--app-name` value for Clap.
pub(crate) fn parse_app_name(name: &str) -> Result<String, String> {
    validate_app_name(name).map(|()| name.to_string())
}

/// Returns the validated namespace selected for this process.
///
/// A conservative character set keeps the value safe as one path component and
/// as part of a service name, including when installation runs with root privileges.
pub(crate) fn app_name() -> Result<String> {
    if let Some(name) = APP_NAME.get() {
        return Ok(name.clone());
    }
    let name = match std::env::var_os(APP_NAME_ENV) {
        Some(name) => name
            .into_string()
            .map_err(|_| anyhow::anyhow!("{APP_NAME_ENV} must contain valid UTF-8"))?,
        None => DEFAULT_APP_NAME.to_string(),
    };
    parse_app_name(&name).map_err(anyhow::Error::msg)
}

/// Returns the per-application data directory under the current account's home.
pub(crate) fn user_data_directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set; cannot locate the application data directory")?;
    Ok(home.join(".local/share").join(app_name()?))
}

/// Returns the per-application cache directory using the XDG cache root when set.
/// Keeping disposable downloads out of the data directory lets cache cleanup tools
/// reclaim them without removing persistent configuration or application state.
pub(crate) fn user_cache_directory() -> Result<PathBuf> {
    let cache_root = match std::env::var_os("XDG_CACHE_HOME").filter(|value| !value.is_empty()) {
        Some(cache_root) => PathBuf::from(cache_root),
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set; cannot locate the application cache directory")?
            .join(".cache"),
    };
    anyhow::ensure!(
        cache_root.is_absolute(),
        "XDG_CACHE_HOME must be an absolute path"
    );
    Ok(cache_root.join(app_name()?))
}

/// Rejects names that could escape their intended path or systemd namespace.
fn validate_app_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character));
    if !valid {
        return Err(format!(
            "{APP_NAME_ENV} must contain only ASCII letters, numbers, '.', '_' or '-', and must not be '.' or '..'"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_app_name;

    /// Ensures installation names remain safe for both paths and systemd unit names.
    #[test]
    fn validates_application_names() {
        for valid in ["redoor", "redoor-dev", "redoor_v2", "redoor.2", "2-redoor"] {
            assert!(
                validate_app_name(valid).is_ok(),
                "a safe application namespace should be accepted: {valid}"
            );
        }
        for invalid in ["", ".", "..", "../redoor", "redoor/dev", "redoor dev", "å"] {
            assert!(
                validate_app_name(invalid).is_err(),
                "an unsafe application namespace should be rejected: {invalid}"
            );
        }
    }
}
