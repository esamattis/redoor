//! `redoor remote status` and `redoor remote logout`: both act on the token in use through
//! `/api/v1/tokens/current`, the one token route a token may call.

use anyhow::{Context, Result};
use redoor_protocol::api::tokens::AccessTokenResponse;
use reqwest::Method;

use super::{
    client::RemoteClient,
    credentials::{CredentialStore, LOGIN_REQUIRED},
    login::device_summary,
};

/// Prints the server, the token and what it may do, so people and AI agents can learn their
/// permissions before trying a command.
pub(crate) async fn status(store: CredentialStore, json: bool) -> Result<()> {
    let client = RemoteClient::load(&store).await?;
    let token: AccessTokenResponse = client.get_json("api/v1/tokens/current").await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&token)?);
        return Ok(());
    }
    let permissions = token
        .permissions
        .iter()
        .map(|permission| permission.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    println!("Server:      {}", client.server());
    if client.insecure_tls() {
        println!("Certificate: not verified (--insecure-tls)");
    }
    println!(
        "Token:       {} ({})",
        token.name.escape_debug(),
        token.id.escape_debug()
    );
    println!("Permissions: {permissions}");
    println!("Devices:     {}", device_summary(&token.devices));
    println!(
        "Expires:     {}",
        token.expires_at.as_deref().unwrap_or("never")
    );
    println!(
        "Last used:   {}",
        token.last_used_at.as_deref().unwrap_or("never")
    );
    Ok(())
}

/// Revokes the saved token on the server, then forgets it locally even if the server is
/// unreachable, so logging out never leaves a usable token on disk.
pub(crate) async fn logout(store: CredentialStore) -> Result<()> {
    let Some(credentials) = store.load().await? else {
        eprintln!("Not logged in");
        return Ok(());
    };
    let revoked = async {
        let client = RemoteClient::from_credentials(credentials)?;
        client
            .send(
                client
                    .request(Method::DELETE, "api/v1/tokens/current")?
                    .timeout(std::time::Duration::from_secs(30)),
            )
            .await
            .map(|_| ())
    }
    .await;
    store.remove().await?;
    match revoked {
        // An already revoked or expired token is as logged out as it gets.
        Err(error) if error.to_string() == LOGIN_REQUIRED => Ok(()),
        result => result
            .context("Local credentials removed; the server did not confirm revoking the token"),
    }?;
    eprintln!("Logged out");
    Ok(())
}
