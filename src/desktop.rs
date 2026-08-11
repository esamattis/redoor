//! Graphical-desktop detection and best-effort URL/path launching.
//!
//! Shared by the agent (notifications, native open) and the server (first-run
//! browser open) so headless and SSH sessions never probe desktop helpers.

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::process::Command;

/// Desktop family used to choose launchers and notification fallbacks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DesktopEnvironment {
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
pub(crate) fn detect_desktop_environment() -> Option<DesktopEnvironment> {
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
pub(crate) fn detect_linux_desktop(
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

/// Returns the platform URL/path launcher when a graphical desktop is available.
fn desktop_open_program(desktop_environment: DesktopEnvironment) -> &'static str {
    match desktop_environment {
        #[cfg(target_os = "linux")]
        DesktopEnvironment::Gnome | DesktopEnvironment::Kde | DesktopEnvironment::Other => {
            "xdg-open"
        }
        #[cfg(target_os = "macos")]
        DesktopEnvironment::MacOs => "open",
    }
}

/// Opens a URL or filesystem path with the platform launcher for the detected desktop.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) async fn open_with_desktop(target: &str) -> Result<(), String> {
    let Some(desktop_environment) = detect_desktop_environment() else {
        return Err("No graphical desktop is available".to_string());
    };
    let program = desktop_open_program(desktop_environment);
    let status = Command::new(program)
        .arg(target)
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

/// Reports opening as unavailable where no desktop launcher is supported.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) async fn open_with_desktop(_target: &str) -> Result<(), String> {
    Err("No graphical desktop is available".to_string())
}

/// First-run browser hint shown above the login form via the URL fragment.
pub(crate) fn first_run_login_message() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "Log in with PAM (your Linux account credentials)"
    }
    #[cfg(target_os = "macos")]
    {
        "Log in with username redoor and password changeme"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        "Sign in with the credentials from your config.toml"
    }
}

/// Builds the first-run login URL opened after starter config creation.
pub(crate) fn first_run_login_url(bind: &str, port: u16) -> String {
    // Prefer loopback in the browser even when the process listens on all interfaces.
    let host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind
    };
    let message = percent_encode_component(first_run_login_message());
    format!("http://{host}:{port}/login#message={message}")
}

/// Percent-encodes a single URI component so login hints survive the URL fragment.
fn percent_encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
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

    /// First-run URLs keep the login hint in the fragment for the SPA to render.
    #[test]
    fn first_run_login_url_uses_loopback_and_fragment_message() {
        let url = first_run_login_url("0.0.0.0", 3000);
        assert!(
            url.starts_with("http://127.0.0.1:3000/login#message="),
            "all-interfaces bind must open loopback: {url}"
        );
        assert!(
            url.contains("PAM") || url.contains("Linux"),
            "Linux first-run URL should mention PAM login: {url}"
        );
    }
}
