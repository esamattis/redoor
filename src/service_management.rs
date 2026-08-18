//! Shares platform-independent service installation behavior.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::Path;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::Context;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::{Result, bail};
use clap::{Args, Subcommand};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::io::AsyncWriteExt;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::ServiceRole;

/// Operations shared by Redoor's supported operating-system service managers.
#[derive(Subcommand)]
pub(crate) enum ServiceCommand {
    /// Install and enable the service, remaining stopped unless requested.
    Install(InstallArgs),
    /// Stop, disable, and remove the service while preserving its config.
    Uninstall,
    /// Start the installed service.
    Start,
    /// Stop the installed service while leaving it enabled for future startup.
    Stop,
    /// Reload and restart the installed service.
    Restart,
    /// Show installation, enablement, and process state.
    Status,
    /// Enable the installed service without starting it.
    Enable,
    /// Disable automatic startup, optionally stopping the service now.
    Disable(DisableArgs),
}

/// Controls whether installation also starts the service.
#[derive(Args)]
pub(crate) struct InstallArgs {
    /// Start the service after installing and enabling it.
    #[arg(long)]
    pub(crate) start: bool,
}

/// Controls whether disabling also stops the current service process.
#[derive(Args)]
pub(crate) struct DisableArgs {
    /// Stop the service in addition to disabling automatic startup.
    #[arg(long)]
    pub(crate) now: bool,
}

/// Ensures service installation has a complete config usable without CLI overrides.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) async fn prepare_config(mode: ServiceRole, config_path: &Path) -> Result<bool> {
    if tokio::fs::try_exists(config_path)
        .await
        .with_context(|| format!("Failed to inspect config '{}'", config_path.display()))?
    {
        validate_existing_config(mode, config_path).await?;
        return Ok(false);
    }

    if mode == ServiceRole::Agent {
        let imported_path = crate::config::import_agent_config_from_stdin(config_path).await?;
        validate_existing_config(mode, &imported_path).await?;
        return Ok(false);
    }

    bail!(
        "config '{}' is missing; run `redoor server` once to create a starter config, then re-run install",
        config_path.display()
    )
}

/// Rejects configs that cannot run the selected role without extra CLI flags.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn validate_existing_config(mode: ServiceRole, config_path: &Path) -> Result<()> {
    let config = crate::config::parse_config_file(&config_path.to_string_lossy())
        .await
        .with_context(|| format!("Failed to parse config '{}'", config_path.display()))?;
    match mode {
        ServiceRole::Agent => {
            if !crate::config::standalone_agent_is_fully_configured(&config) {
                bail!(
                    "config '{}' is missing required standalone agent settings; set top-level agent_token plus [agent] server so the service can start without CLI flags",
                    config_path.display()
                );
            }
        }
        ServiceRole::Server => {
            crate::config::require_server_section(&config)?;
        }
    }
    Ok(())
}

/// Replaces a service definition in one rename so managers never read a partial file.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) async fn atomic_write(path: &Path, content: &[u8], artifact: &str) -> Result<()> {
    let file_name = path
        .file_name()
        .with_context(|| format!("{artifact} path has no file name"))?
        .to_string_lossy();
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        fastrand::u64(..)
    ));
    let write_result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .await
            .with_context(|| {
                format!(
                    "Failed to create temporary {artifact} '{}'",
                    temporary_path.display()
                )
            })?;
        file.write_all(content).await.with_context(|| {
            format!(
                "Failed to write temporary {artifact} '{}'",
                temporary_path.display()
            )
        })?;
        file.sync_all().await.with_context(|| {
            format!(
                "Failed to sync temporary {artifact} '{}'",
                temporary_path.display()
            )
        })?;
        drop(file);
        tokio::fs::rename(&temporary_path, path)
            .await
            .with_context(|| format!("Failed to install {artifact} '{}'", path.display()))
    }
    .await;
    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
    write_result
}
