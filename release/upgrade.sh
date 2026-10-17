#!/usr/bin/env bash
# Hexactra Upgrade Script
# Upgrades Hexactra to a new version

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_MANIFEST="$SCRIPT_DIR/manifest/release-manifest.toml"

if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root"
    exit 1
fi

# Parse version from manifest
VERSION=$(grep '^version' "$RELEASE_MANIFEST" | head -1 | sed 's/.*= "//;s/"//')

echo "Upgrading Hexactra to v$VERSION..."

systemctl stop hexactra-agent

# Backup current binaries
mkdir -p /var/lib/hexactra/backup
cp /usr/local/bin/hexactra /var/lib/hexactra/backup/ 2>/dev/null || true
cp /usr/local/bin/hexactra-agent /var/lib/hexactra/backup/ 2>/dev/null || true
cp /usr/local/bin/hexactra-native-host /var/lib/hexactra/backup/ 2>/dev/null || true
cp /usr/local/bin/hexactra-mcp /var/lib/hexactra/backup/ 2>/dev/null || true

# Install new binaries
cp "$SCRIPT_DIR/bin/hexactra" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-agent" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-native-host" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-mcp" /usr/local/bin/

chmod +x /usr/local/bin/hexactra
chmod +x /usr/local/bin/hexactra-agent
chmod +x /usr/local/bin/hexactra-native-host
chmod +x /usr/local/bin/hexactra-mcp

systemctl start hexactra-agent

echo "Hexactra upgraded to v$VERSION!"
