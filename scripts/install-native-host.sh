#!/usr/bin/env bash
#
# Register the Hexactra native messaging host with Chrome / Chromium for the
# current user (#176).
#
# Usage:
#   scripts/install-native-host.sh [--binary PATH] [--user-data-dir DIR]... [--extension-id ID]
#
#   --binary         hexactra-native-host binary (default: target/release, then
#                    target/debug, then PATH)
#   --user-data-dir  also install into a custom Chrome user data directory
#                    (repeatable; used by tests that launch Chromium with
#                    --user-data-dir)
#   --extension-id   allowed extension id (default: the id pinned by the
#                    "key" in apps/chrome-extension/manifest/manifest.json)
#   --allow-root     permit running as root (containers and CI only)
#
# Installs <dir>/NativeMessagingHosts/com.hexactra.nativehost.json into:
#   ~/.config/google-chrome, ~/.config/google-chrome-beta, ~/.config/chromium
# Installing for a browser that is not present is harmless.

set -euo pipefail

HOST_NAME="com.hexactra.nativehost"
EXTENSION_ID="afamapffbfhaafbjnneoachpknjpmiof"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY=""
EXTRA_DIRS=()
ALLOW_ROOT=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --binary) BINARY="$2"; shift 2 ;;
        --user-data-dir) EXTRA_DIRS+=("$2"); shift 2 ;;
        --extension-id) EXTENSION_ID="$2"; shift 2 ;;
        --allow-root) ALLOW_ROOT=1; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ "$(id -u)" -eq 0 && "$ALLOW_ROOT" -eq 0 ]]; then
    echo "Run this as the user whose Chrome profile Hexactra will drive, not as root." >&2
    exit 1
fi

if [[ -z "$BINARY" ]]; then
    for candidate in \
        "$REPO_ROOT/target/release/hexactra-native-host" \
        "$REPO_ROOT/target/debug/hexactra-native-host" \
        "$(command -v hexactra-native-host || true)"; do
        if [[ -n "$candidate" && -x "$candidate" ]]; then BINARY="$candidate"; break; fi
    done
fi
if [[ -z "$BINARY" || ! -x "$BINARY" ]]; then
    echo "hexactra-native-host binary not found. Build it with:" >&2
    echo "  cargo build --release -p hexactra-native-host" >&2
    exit 1
fi
BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "invalid extension id: $EXTENSION_ID" >&2
    exit 1
fi

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
TARGETS=(
    "$CONFIG_HOME/google-chrome"
    "$CONFIG_HOME/google-chrome-beta"
    "$CONFIG_HOME/chromium"
)
TARGETS+=("${EXTRA_DIRS[@]+"${EXTRA_DIRS[@]}"}")

for base in "${TARGETS[@]}"; do
    dir="$base/NativeMessagingHosts"
    mkdir -p "$dir"
    cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Hexactra remote control bridge",
  "path": "$BINARY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
    chmod 0644 "$dir/$HOST_NAME.json"
    echo "installed $dir/$HOST_NAME.json"
done

echo "native host: $BINARY"
echo "allowed extension: $EXTENSION_ID"
