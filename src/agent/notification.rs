#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::process::Command;

/// Desktop family used to choose notification fallbacks without coupling startup to a toolkit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DesktopEnvironment {
    #[cfg(target_os = "linux")]
    Gnome,
    #[cfg(target_os = "linux")]
    Kde,
    #[cfg(target_os = "linux")]
    Other,
    #[cfg(target_os = "macos")]
    MacOs,
}

/// Detects whether this process was started with access to a supported graphical desktop.
pub(super) fn detect_desktop_environment() -> Option<DesktopEnvironment> {
    #[cfg(target_os = "linux")]
    {
        let display = std::env::var_os("DISPLAY");
        let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
        let desktop = std::env::var_os("XDG_CURRENT_DESKTOP");
        let session = std::env::var_os("DESKTOP_SESSION");
        detect_linux_desktop(
            display.as_deref(),
            wayland_display.as_deref(),
            desktop.as_deref(),
            session.as_deref(),
        )
    }

    #[cfg(target_os = "macos")]
    {
        Some(DesktopEnvironment::MacOs)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// Classifies a Linux graphical session while excluding headless service and SSH environments.
#[cfg(target_os = "linux")]
fn detect_linux_desktop(
    display: Option<&std::ffi::OsStr>,
    wayland_display: Option<&std::ffi::OsStr>,
    desktop: Option<&std::ffi::OsStr>,
    session: Option<&std::ffi::OsStr>,
) -> Option<DesktopEnvironment> {
    if !has_non_empty_value(display) && !has_non_empty_value(wayland_display) {
        return None;
    }

    let desktop_name = desktop
        .into_iter()
        .chain(session)
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join(":")
        .to_ascii_lowercase();
    if desktop_name.contains("gnome") {
        Some(DesktopEnvironment::Gnome)
    } else if desktop_name.contains("kde") || desktop_name.contains("plasma") {
        Some(DesktopEnvironment::Kde)
    } else {
        Some(DesktopEnvironment::Other)
    }
}

/// Treats unset and explicitly empty display variables the same for GUI detection.
#[cfg(target_os = "linux")]
fn has_non_empty_value(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

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

/// Opens an existing filesystem path with the platform launcher for the detected desktop.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) async fn open_path(path: &str) -> Result<(), String> {
    let Some(desktop_environment) = detect_desktop_environment() else {
        return Err("Agent does not have access to a graphical desktop".to_string());
    };
    let program = match desktop_environment {
        #[cfg(target_os = "linux")]
        DesktopEnvironment::Gnome | DesktopEnvironment::Kde | DesktopEnvironment::Other => {
            "xdg-open"
        }
        #[cfg(target_os = "macos")]
        DesktopEnvironment::MacOs => "open",
    };
    let status = Command::new(program)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| format!("Failed to start {program}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with status {status}"))
    }
}

/// Reports native path opening as unavailable where no desktop launcher is supported.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) async fn open_path(_path: &str) -> Result<(), String> {
    Err("Agent does not have access to a graphical desktop".to_string())
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    /// Headless agents must not waste time probing notification commands.
    #[test]
    fn linux_detection_rejects_headless_sessions() {
        // Desktop metadata alone does not prove that a graphical display is reachable.
        assert_eq!(
            detect_linux_desktop(None, None, Some(OsStr::new("GNOME")), None),
            None
        );
    }

    /// GNOME sessions are recognized from the standard desktop metadata.
    #[test]
    fn linux_detection_recognizes_gnome() {
        // A Wayland display is sufficient even when the legacy X11 variable is absent.
        assert_eq!(
            detect_linux_desktop(
                None,
                Some(OsStr::new("wayland-0")),
                Some(OsStr::new("ubuntu:GNOME")),
                None,
            ),
            Some(DesktopEnvironment::Gnome)
        );
    }

    /// Plasma session names select KDE-specific fallbacks.
    #[test]
    fn linux_detection_recognizes_kde_plasma() {
        // Session metadata is the fallback when XDG_CURRENT_DESKTOP is unavailable.
        assert_eq!(
            detect_linux_desktop(
                Some(OsStr::new(":0")),
                None,
                None,
                Some(OsStr::new("plasmawayland")),
            ),
            Some(DesktopEnvironment::Kde)
        );
    }
}
