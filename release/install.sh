#!/usr/bin/env bash
# Hexactra Installation Script
# Installs Hexactra binaries and systemd service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_MANIFEST="$SCRIPT_DIR/manifest/release-manifest.toml"

# Parse version from manifest
VERSION=$(grep '^version' "$RELEASE_MANIFEST" | head -1 | sed 's/.*= "//;s/"//')

echo "Installing Hexactra v$VERSION..."

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root"
    exit 1
fi

# Create hexactra-agent user if not exists
if ! id -u hexactra-agent >/dev/null 2>&1; then
    useradd -r -s /bin/false hexactra-agent
fi

# Create directories
mkdir -p /usr/local/bin
mkdir -p /etc/hexactra
mkdir -p /var/lib/hexactra
mkdir -p /run/hexactra
mkdir -p /var/log/hexactra

# Set ownership
chown -R hexactra-agent:hexactra-agent /var/lib/hexactra
chown -R hexactra-agent:hexactra-agent /run/hexactra
chown -R hexactra-agent:hexactra-agent /var/log/hexactra

# Install binaries
cp "$SCRIPT_DIR/bin/hexactra" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-agent" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-native-host" /usr/local/bin/
cp "$SCRIPT_DIR/bin/hexactra-mcp" /usr/local/bin/

chmod +x /usr/local/bin/hexactra
chmod +x /usr/local/bin/hexactra-agent
chmod +x /usr/local/bin/hexactra-native-host
chmod +x /usr/local/bin/hexactra-mcp

# Install systemd service
cp "$SCRIPT_DIR/../deploy/systemd/hexactra-agent.service" /etc/systemd/system/

# Reload systemd
systemctl daemon-reload

# Enable and start service
systemctl enable hexactra-agent
systemctl restart hexactra-agent

echo "Hexactra v$VERSION installed successfully!"
echo ""
echo "To check status: systemctl status hexactra-agent"
echo "To view logs: journalctl -u hexactra-agent -f"
