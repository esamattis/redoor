//! Imports an existing server configuration for standalone agent use.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Prompts for a server config and writes it only after stdin reaches EOF.
///
/// Waiting for EOF before creating the destination ensures Ctrl+C cancels without
/// leaving an empty or partial `config.toml` behind.
pub(crate) async fn import_agent_config_from_stdin(path: &Path) -> Result<PathBuf> {
    let absolute_path = absolute_path(path)?;
    let mut stdin = tokio::io::stdin();
    let mut stderr = tokio::io::stderr();
    import_agent_config(&absolute_path, &mut stdin, &mut stderr).await?;
    Ok(absolute_path)
}

/// Resolves a missing destination for diagnostics and stable writes after prompting.
fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(std::env::current_dir()
        .context("Failed to resolve the current directory for the config path")?
        .join(path))
}

/// Performs the import against injectable streams so EOF and file behavior stay testable.
async fn import_agent_config<R, W>(path: &Path, input: &mut R, output: &mut W) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let prompt = format!(
        "Config file does not exist: {}
Copy config.toml from the Redoor server home, paste it below, then press Ctrl+D to confirm or Ctrl+C to cancel.
",
        path.display()
    );
    output
        .write_all(prompt.as_bytes())
        .await
        .context("Failed to write the config import prompt")?;
    output
        .flush()
        .await
        .context("Failed to flush the config import prompt")?;

    let mut content = Vec::new();
    input
        .read_to_end(&mut content)
        .await
        .context("Failed to read config.toml from stdin")?;

    let parent = path
        .parent()
        .with_context(|| format!("Config path '{}' has no parent", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("Failed to create config directory '{}'", parent.display()))?;

    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .await
        .with_context(|| format!("Failed to create config file '{}'", path.display()))?;
    file.write_all(&content)
        .await
        .with_context(|| format!("Failed to write config file '{}'", path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed to sync config file '{}'", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    use super::*;

    /// Simulates stdin ending with an error before EOF so cancellation cannot commit a file.
    struct InterruptedInput;

    impl AsyncRead for InterruptedInput {
        /// Reports an interrupted read without yielding bytes, matching an aborted import.
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "import cancelled",
            )))
        }
    }

    /// Verifies the pasted TOML is preserved exactly and the prompt identifies the absolute destination.
    #[tokio::test]
    async fn imports_pasted_config_after_eof() {
        let directory = std::env::temp_dir().join(format!(
            "redoor-import-config-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("nested/config.toml");
        let content = br#"agent_token = "shared-token"

[agent]
ws_address = "wss://example.test/ws"
"#;
        let mut input = std::io::Cursor::new(content);
        let mut output = Vec::new();

        import_agent_config(&path, &mut input, &mut output)
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            content,
            "the imported config must be written byte-for-byte"
        );
        let prompt = String::from_utf8(output).unwrap();
        assert!(
            prompt.contains(path.to_string_lossy().as_ref()),
            "the prompt must show the absolute config destination"
        );
        assert!(
            prompt.contains("Ctrl+D") && prompt.contains("Ctrl+C"),
            "the prompt must explain how to confirm or cancel the import"
        );
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(
                &tokio::fs::metadata(&path).await.unwrap().permissions()
            ) & 0o777,
            0o600,
            "the imported config contains secrets and must be owner-readable only"
        );

        tokio::fs::remove_dir_all(directory).await.ok();
    }

    /// Verifies imports never overwrite a config that appears before the final create.
    #[tokio::test]
    async fn refuses_to_overwrite_an_existing_config() {
        let path = std::env::temp_dir().join(format!(
            "redoor-import-existing-config-test-{}.toml",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::write(&path, "existing").await.unwrap();
        let mut input = std::io::Cursor::new(b"replacement");
        let mut output = Vec::new();

        let result = import_agent_config(&path, &mut input, &mut output).await;

        assert!(result.is_err(), "an existing config must reject the import");
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "existing",
            "a raced or existing config must remain unchanged"
        );
        tokio::fs::remove_file(path).await.ok();
    }

    /// Verifies interrupted stdin leaves no destination because only EOF confirms the paste.
    #[tokio::test]
    async fn interrupted_input_does_not_create_a_config() {
        let directory = std::env::temp_dir().join(format!(
            "redoor-import-cancelled-config-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("config.toml");
        let mut input = InterruptedInput;
        let mut output = Vec::new();

        let result = import_agent_config(&path, &mut input, &mut output).await;

        assert!(result.is_err(), "interrupted input must cancel the import");
        assert!(
            !tokio::fs::try_exists(&path).await.unwrap(),
            "cancellation before EOF must not leave a config file"
        );
    }
}
