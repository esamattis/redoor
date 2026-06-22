#!/usr/bin/env bash
#
# Installs the latest redoor release from GitHub into ~/.local/bin/redoor.
#
# Usage:
#   ./install.sh             # install latest release
#   ./install.sh v0.1.0      # install a specific tag
#
set -euo pipefail

REPO="esamattis/redoor"
# Allow override via env so users can install elsewhere and so the script
# can be tested without touching the real ~/.local/bin.
INSTALL_DIR="${REDOOR_INSTALL_DIR:-${HOME}/.local/bin}"
BINARY_NAME="redoor"

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
    # Parse with cut rather than sed so the regex works on both BSD and GNU
    # sed (BSD sed does not support \s in ERE). Field 4 of a "tag_name":
    # "v0.0.3", line split on " is the tag value.
    if ! tag=$(curl -fsSL "$api_url" | grep -m1 '"tag_name"' | tr -d ' ,' | cut -d'"' -f4); then
        err "failed to fetch latest release from $api_url"
        return 1
    fi

    if [[ -z "$tag" ]]; then
        err "could not parse tag_name from latest release response"
        return 1
    fi
    echo "$tag"
}

# Map the host OS/arch to the archive name produced by .github/workflows/release.yml.
# Only the three targets built in CI are supported; everything else errors out
# with a clear message rather than a confusing download failure.
archive_name_for() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Darwin)
            case "$arch" in
                arm64|aarch64) echo "redoor-aarch64-macos.tar.gz" ;;
                *) err "no macOS release asset for arch '$arch' (only Apple Silicon is built)"; return 1 ;;
            esac
            ;;
        Linux)
            case "$arch" in
                x86_64)      echo "redoor-x86_64-linux.tar.gz" ;;
                aarch64|arm64) echo "redoor-aarch64-linux.tar.gz" ;;
                *) err "no Linux release asset for arch '$arch' (only x86_64 and aarch64 are built)"; return 1 ;;
            esac
            ;;
        *) err "unsupported OS '$os' (only Darwin and Linux are built)"; return 1 ;;
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

    # Use the GitHub releases download URL which 302-redirects to the asset
    # on a specific tag. curl -L follows the redirect.
    local download_url="https://github.com/${REPO}/releases/download/${tag}/${archive}"

    info "installing redoor ${tag} for $(uname -s)/$(uname -m)"
    info "downloading ${download_url}"

    TMP_DIR="$(mktemp -d)"
    # Always clean up the temp directory, even on failure, so we don't
    # leave tarballs and extracted binaries lying around in /tmp.
    trap 'rm -rf "$TMP_DIR"' EXIT

    local archive_path="${TMP_DIR}/${archive}"
    if ! curl -fsSL "$download_url" -o "$archive_path"; then
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
