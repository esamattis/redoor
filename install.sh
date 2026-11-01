#!/usr/bin/env bash
#
# Installs the latest redoor release from GitHub into ~/.local/bin/redoor
# (or /usr/local/bin/redoor when run as root).
#
# Usage:
#   ./install.sh             # install latest release
#   ./install.sh v0.1.0      # install a specific tag
#
# `redoor upgrade` embeds and runs this same script.
#
set -euo pipefail

REPO="esamattis/redoor"
# Root defaults to /usr/local/bin so the binary lands on the system PATH
# and matches systemd unit ExecStart. Unprivileged installs stay in
# ~/.local/bin so we never write outside the user's home. REDOOR_INSTALL_DIR
# overrides either default so the script can be tested without touching
# the real location.
if [[ "${EUID}" -eq 0 ]]; then
    DEFAULT_INSTALL_DIR="/usr/local/bin"
else
    DEFAULT_INSTALL_DIR="${HOME}/.local/bin"
fi
INSTALL_DIR="${REDOOR_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
BINARY_NAME="redoor"
# Release assets live under <base>/<tag>/<archive>. REDOOR_RELEASE_BASE_URL points it at a
# local mirror (curl also accepts file:// URLs) so `redoor upgrade` can be tested offline.
RELEASE_BASE_URL="${REDOOR_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download}"

# A stalled connection would otherwise hang the install forever, and with it the server's
# update request and the release cache that agent upgrades and SSH provisioning wait on.
# Downloads give up when they fall below 1 KiB/s for a minute rather than after a fixed
# time, so a large binary still finishes over a slow but working link.
CURL_TIMEOUTS=(--connect-timeout 20 --speed-limit 1024 --speed-time 60)

# Declared at the top level so the EXIT trap (which runs in the global scope,
# not inside main) can see it. Without this, set -u would error inside the
# trap when it tries to reference the temp directory.
TMP_DIR=""

# Print to stderr with a prefix so install progress is distinguishable from
# command output of the installed binary later on.
err() {
    echo "install: error: $*" >&2
}

info() {
    echo "install: $*"
}

# Resolve which release tag to install. The caller can pass an explicit tag
# as the first argument; otherwise query the GitHub API for the latest.
resolve_tag() {
    local requested="${1:-}"
    if [[ -n "$requested" ]]; then
        echo "$requested"
        return
    fi

    local api_url="https://api.github.com/repos/${REPO}/releases/latest"
    local tag
    # Read the entire response even after finding the tag: exiting early can
    # break curl's output pipe and fail the install under pipefail. Splitting
    # on quotes works with both BSD and GNU awk without requiring a JSON tool.
    if ! tag=$(curl -fsSL "${CURL_TIMEOUTS[@]}" --max-time 60 "$api_url" | awk -F'"' '/"tag_name"/ && !found { print $4; found = 1 }'); then
        err "failed to fetch latest release from $api_url"
        return 1
    fi

    if [[ -z "$tag" ]]; then
        err "could not parse tag_name from latest release response"
        return 1
    fi
    echo "$tag"
}

# Detect Android before the Linux mapping because Termux reports `uname -s` as Linux.
is_android() {
    [[ "${OSTYPE:-}" == linux-android* || -n "${TERMUX_VERSION:-}" || -n "${ANDROID_ROOT:-}" ]]
}

# Names the host OS the way release assets do; Android first because Termux reports Linux.
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)
            if is_android; then
                echo "android"
            else
                echo "linux"
            fi
            ;;
        *) err "unsupported OS '$(uname -s)' (only Darwin and Linux are built)"; return 1 ;;
    esac
}

# Names the host CPU architecture the way release assets do.
detect_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64|arm64) echo "aarch64" ;;
        *) err "unsupported architecture '$(uname -m)' (only x86_64 and aarch64 are built)"; return 1 ;;
    esac
}

# Map the target OS/arch to the archive name produced by .github/workflows/release.yml.
# The host is the default target. REDOOR_TARGET_OS and REDOOR_TARGET_ARCH pick another one,
# which the redoor server uses to fetch binaries for agents on other devices. Only targets
# built in CI are supported; everything else errors out with a clear message rather than a
# confusing download failure.
archive_name_for() {
    local os="${REDOOR_TARGET_OS:-}"
    local arch="${REDOOR_TARGET_ARCH:-}"
    if [[ -z "$os" ]]; then
        os="$(detect_os)" || return 1
    fi
    if [[ -z "$arch" ]]; then
        arch="$(detect_arch)" || return 1
    fi

    case "${os}/${arch}" in
        linux/x86_64|linux/aarch64|macos/aarch64|android/aarch64)
            echo "redoor-${arch}-${os}.tar.gz"
            ;;
        *)
            err "no release asset for ${os}/${arch} (built: linux/x86_64, linux/aarch64, macos/aarch64, android/aarch64)"
            return 1
            ;;
    esac
}

# Check that required tools are present before doing any network work.
require_tools() {
    local missing=()
    for tool in curl tar uname; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            missing+=("$tool")
        fi
    done
    if [[ "${#missing[@]}" -gt 0 ]]; then
        err "missing required tools: ${missing[*]}"
        return 1
    fi
}

main() {
    require_tools

    local requested_tag="${1:-}"
    local tag archive
    tag="$(resolve_tag "$requested_tag")" || exit 1
    archive="$(archive_name_for)" || exit 1

    # The GitHub releases download URL 302-redirects to the asset on a specific
    # tag. curl -L follows the redirect.
    local download_url="${RELEASE_BASE_URL}/${tag}/${archive}"

    info "installing redoor ${tag} (${archive})"
    info "downloading ${download_url}"

    TMP_DIR="$(mktemp -d)"
    # Always clean up the temp directory, even on failure, so we don't
    # leave tarballs and extracted binaries lying around in /tmp.
    trap 'rm -rf "$TMP_DIR"' EXIT

    local archive_path="${TMP_DIR}/${archive}"
    if ! curl -fsSL "${CURL_TIMEOUTS[@]}" "$download_url" -o "$archive_path"; then
        err "download failed for ${download_url}"
        exit 1
    fi

    info "extracting archive"
    if ! tar -xzf "$archive_path" -C "$TMP_DIR"; then
        err "extraction failed"
        exit 1
    fi

    if [[ ! -f "${TMP_DIR}/${BINARY_NAME}" ]]; then
        err "archive did not contain a '${BINARY_NAME}' binary"
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"

    # Move into place with a temporary name first and then atomically rename,
    # so a concurrent redoor process isn't left with a half-written binary.
    local staging="${INSTALL_DIR}/${BINARY_NAME}.new"
    mv "${TMP_DIR}/${BINARY_NAME}" "$staging"
    chmod 0755 "$staging"
    mv "$staging" "${INSTALL_DIR}/${BINARY_NAME}"

    info "installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

    # Warn the user if the install dir isn't on their PATH, since otherwise
    # the install will appear to have silently failed.
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) ;;
        *)
            echo
            info "warning: ${INSTALL_DIR} is not on your PATH"
            info "add it with:  export PATH=\"${INSTALL_DIR}:\$PATH\""
            ;;
    esac

    info "done"
}

main "$@"
