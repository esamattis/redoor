//! OpenSSH askpass helper invoked as a re-exec of this binary.
//!
//! OpenSSH will not read a password from argv or the SSH stdin we already use
//! for agent tokens and uploads. `SSH_ASKPASS` runs a separate program instead.
//! Detecting that role through env vars lets the same `redoor` executable answer
//! the prompt before clap treats the prompt text as a subcommand.

use std::io::{Write, stdout};

/// Presence of this variable means OpenSSH re-executed this binary as askpass.
pub(crate) const ENV: &str = "REDOOR_ASKPASS";

/// Carries the configured password to the askpass re-exec without putting it on argv.
pub(crate) const PASSWORD_ENV: &str = "REDOOR_ASKPASS_PASSWORD";

/// Prints the stored password only for password prompts, then exits.
///
/// Host-key "yes/no" confirmations also go through `SSH_ASKPASS`. Answering
/// those with the stored password would fail authentication and leak intent.
pub(crate) fn run() {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let password = std::env::var(PASSWORD_ENV).ok();
    match password_response(&prompt, password.as_deref()) {
        Some(response) => {
            let mut out = stdout().lock();
            if out.write_all(response.as_bytes()).is_err() || out.flush().is_err() {
                std::process::exit(1);
            }
        }
        None => std::process::exit(1),
    }
}

/// Returns the password plus newline when the prompt is asking for a password.
fn password_response(prompt: &str, password: Option<&str>) -> Option<String> {
    if !prompt.to_ascii_lowercase().contains("password") {
        return None;
    }
    let password = password.filter(|value| !value.is_empty())?;
    Some(format!("{password}\n"))
}

#[cfg(test)]
mod tests {
    /// OpenSSH host-key confirmations must not receive the stored password.
    #[test]
    fn host_key_prompt_is_rejected() {
        assert_eq!(
            super::password_response(
                "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
                Some("secret"),
            ),
            None
        );
    }

    /// Keyboard-interactive and OpenSSH password prompts share this substring.
    #[test]
    fn password_prompt_returns_configured_secret() {
        assert_eq!(
            super::password_response("redoor-password@host's password: ", Some("secret")),
            Some("secret\n".to_string())
        );
    }

    /// A missing or empty secret cannot authenticate, so askpass must fail closed.
    #[test]
    fn missing_password_is_rejected() {
        assert_eq!(super::password_response("Password:", None), None);
        assert_eq!(super::password_response("Password:", Some("")), None);
    }
}
