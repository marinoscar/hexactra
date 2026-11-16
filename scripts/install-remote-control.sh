#!/usr/bin/env bash
#
# Install Hexactra remote browser control for the current user on Linux
# (#177). No root needed.
#
#   1. builds hexactra, hexactra-control, hexactra-agent, hexactra-native-host,
#      hexactra-mcp (release) and copies them to ~/.local/bin
#   2. builds the Chrome extension into apps/chrome-extension/dist
#   3. registers the native messaging host for Chrome and Chromium
#   4. installs and starts systemd user services for the control plane and
#      the agent (skip with --no-services)
#
# Afterwards: load apps/chrome-extension/dist in Chrome (chrome://extensions,
# Developer mode, "Load unpacked") and run `hexactra-fabric status`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
SERVICES=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-services) SERVICES=0; shift ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ "$(id -u)" -eq 0 ]]; then
    echo "Run this as your normal user (the one whose Chrome profile you want to drive)." >&2
    exit 1
fi
for tool in cargo pnpm node; do
    command -v "$tool" >/dev/null || { echo "missing $tool; see README prerequisites" >&2; exit 1; }
done

echo "==> building binaries (release)"
(cd "$REPO_ROOT" && cargo build --release \
    -p hexactra-cli -p hexactra-control -p hexactra-agent -p hexactra-native-host -p hexactra-mcp)
mkdir -p "$BIN_DIR"
for b in hexactra-fabric hexactra-control hexactra-agent hexactra-native-host hexactra-mcp; do
    install -m 0755 "$REPO_ROOT/target/release/$b" "$BIN_DIR/$b"
done
echo "    installed to $BIN_DIR"

echo "==> building the Chrome extension"
(cd "$REPO_ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter @hexactra/chrome-extension build >/dev/null)
echo "    extension: $REPO_ROOT/apps/chrome-extension/dist"

echo "==> registering the native messaging host"
bash "$REPO_ROOT/scripts/install-native-host.sh" --binary "$BIN_DIR/hexactra-native-host"

if [[ "$SERVICES" -eq 1 ]]; then
    echo "==> installing systemd user services"
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    install -m 0644 "$REPO_ROOT/deploy/systemd/user/hexactra-control.service" "$UNIT_DIR/"
    install -m 0644 "$REPO_ROOT/deploy/systemd/user/hexactra-agent.service" "$UNIT_DIR/"
    systemctl --user daemon-reload
    systemctl --user enable --now hexactra-control.service
    # The agent reads the token the control plane generates on first start.
    for _ in $(seq 1 20); do
        [[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/hexactra/api-token" ]] && break
        sleep 0.5
    done
    systemctl --user enable --now hexactra-agent.service
    echo "    services: hexactra-control, hexactra-agent (systemctl --user status ...)"
fi

cat <<EOF

Done. Next:
  1. In Chrome open chrome://extensions, turn on Developer mode, click
     "Load unpacked" and choose:
       $REPO_ROOT/apps/chrome-extension/dist
     The extension id must be ahpjoclfeibdmlnbaednepiihpamklcl.
  2. Check the connection:
       $BIN_DIR/hexactra-fabric status        # expect browser=true
  3. Try it:
       $BIN_DIR/hexactra-fabric navigate https://example.com
       $BIN_DIR/hexactra-fabric screenshot -o page.jpg
  4. Let an AI agent use it (MCP), e.g. Claude Code:
       claude mcp add hexactra -- $BIN_DIR/hexactra-mcp

API token: ${XDG_CONFIG_HOME:-$HOME/.config}/hexactra/api-token (keep it secret: it controls your signed-in browser)
Remote access and safety: docs/remote-control-quickstart.md
EOF
