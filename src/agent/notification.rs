#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::process::Command;

use crate::desktop::DesktopEnvironment;

/// Attempts native notification commands in desktop-appropriate order without surfacing failures.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) async fn show_agent_started(
    desktop_environment: DesktopEnvironment,
    agent_name: &str,
) -> bool {
    let message = format!(
        "Agent '{agent_name}' connected successfully. The connected Redoor server can now control this computer."
    );
    match desktop_environment {
        #[cfg(target_os = "macos")]
        DesktopEnvironment::MacOs => show_macos_notification(&message).await,
        #[cfg(target_os = "linux")]
        DesktopEnvironment::Gnome => {
            show_notify_send(&message).await
                || show_gnome_notification(&message).await
                || show_kde_notification(&message).await
        }
        #[cfg(target_os = "linux")]
        DesktopEnvironment::Kde => {
            show_notify_send(&message).await
                || show_kde_notification(&message).await
                || show_gnome_notification(&message).await
        }
        #[cfg(target_os = "linux")]
        DesktopEnvironment::Other => {
            show_notify_send(&message).await
                || show_gnome_notification(&message).await
                || show_kde_notification(&message).await
        }
    }
}

/// Keeps startup notifications disabled on platforms without a supported desktop launcher.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) async fn show_agent_started(
    _desktop_environment: DesktopEnvironment,
    _agent_name: &str,
) -> bool {
    false
}

/// Uses the freedesktop client shared by GNOME, KDE, and many smaller Linux desktops.
#[cfg(target_os = "linux")]
async fn show_notify_send(message: &str) -> bool {
    command_succeeded(
        "notify-send",
        &[
            "--app-name=Redoor",
            "--icon=network-transmit-receive",
            "Redoor agent started",
            message,
        ],
    )
    .await
}

/// Uses GNOME's session-bus client when the libnotify command is unavailable.
#[cfg(target_os = "linux")]
async fn show_gnome_notification(message: &str) -> bool {
    command_succeeded(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.freedesktop.Notifications",
            "--object-path",
            "/org/freedesktop/Notifications",
            "--method",
            "org.freedesktop.Notifications.Notify",
            "Redoor",
            "0",
            "",
            "Redoor agent started",
            message,
            "[]",
            "{}",
            "5000",
        ],
    )
    .await
}

/// Uses KDE's dialog utility as a fallback when freedesktop helpers are unavailable.
#[cfg(target_os = "linux")]
async fn show_kde_notification(message: &str) -> bool {
    command_succeeded(
        "kdialog",
        &["--title", "Redoor", "--passivepopup", message, "10"],
    )
    .await
}

/// Uses AppleScript arguments so agent names never need script-string escaping.
#[cfg(target_os = "macos")]
async fn show_macos_notification(message: &str) -> bool {
    command_succeeded(
        "osascript",
        &[
            "-e",
            "on run argv",
            "-e",
            "display notification (item 1 of argv) with title \"Redoor agent started\"",
            "-e",
            "end run",
            message,
        ],
    )
    .await
}

/// Runs one finite notification helper with all output suppressed for best-effort startup behavior.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn command_succeeded(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}
