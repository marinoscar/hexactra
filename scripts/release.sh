#!/usr/bin/env bash
# Hexactra Release Script
# Produces release artifacts: binaries, checksums, and manifest

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$PROJECT_ROOT/target"
RELEASE_DIR="$PROJECT_ROOT/release"

# Version from Cargo.toml
VERSION=$(grep '^version' "$PROJECT_ROOT/Cargo.toml" | head -1 | sed 's/.*= "//;s/"//')

# Platform info
PLATFORM="${HOSTNAME:-unknown}"
ARCH=$(uname -m)
DATE=$(date +%Y%m%d)

echo "Building Hexactra v$VERSION for $ARCH on $PLATFORM"
echo "Release directory: $RELEASE_DIR"

# Create release directory
mkdir -p "$RELEASE_DIR/bin"
mkdir -p "$RELEASE_DIR/checksums"
mkdir -p "$RELEASE_DIR/manifest"

# Build release binaries
echo "Building release binaries..."
cd "$PROJECT_ROOT"

# Build all binaries
cargo build --release

# Copy binaries to release directory
cp "$TARGET_DIR/release/hexactra" "$RELEASE_DIR/bin/"
cp "$TARGET_DIR/release/hexactra-agent" "$RELEASE_DIR/bin/"
cp "$TARGET_DIR/release/hexactra-native-host" "$RELEASE_DIR/bin/"
cp "$TARGET_DIR/release/hexactra-mcp" "$RELEASE_DIR/bin/"

# Generate checksums
echo "Generating checksums..."
cd "$RELEASE_DIR/bin"

for binary in hexactra hexactra-agent hexactra-native-host hexactra-mcp; do
    sha256sum "$binary" > "../checksums/${binary}.sha256"
    md5sum "$binary" > "../checksums/${binary}.md5"
done

# Generate release manifest
echo "Generating release manifest..."

# Read checksums
HEXACTRA_SHA256=$(cat "$RELEASE_DIR/checksums/hexactra.sha256" | awk '{print $1}')
HEXACTRA_MD5=$(cat "$RELEASE_DIR/checksums/hexactra.md5" | awk '{print $1}')
HEXACTRA_AGENT_SHA256=$(cat "$RELEASE_DIR/checksums/hexactra-agent.sha256" | awk '{print $1}')
HEXACTRA_AGENT_MD5=$(cat "$RELEASE_DIR/checksums/hexactra-agent.md5" | awk '{print $1}')
HEXACTRA_NATIVE_HOST_SHA256=$(cat "$RELEASE_DIR/checksums/hexactra-native-host.sha256" | awk '{print $1}')
HEXACTRA_NATIVE_HOST_MD5=$(cat "$RELEASE_DIR/checksums/hexactra-native-host.md5" | awk '{print $1}')
HEXACTRA_MCP_SHA256=$(cat "$RELEASE_DIR/checksums/hexactra-mcp.sha256" | awk '{print $1}')
HEXACTRA_MCP_MD5=$(cat "$RELEASE_DIR/checksums/hexactra-mcp.md5" | awk '{print $1}')

cat > "$RELEASE_DIR/manifest/release-manifest.toml" << EOF
version = "$VERSION"
platform = "$PLATFORM"
arch = "$ARCH"
date = "$DATE"

[binaries]
hexactra = { path = "bin/hexactra", sha256 = "$HEXACTRA_SHA256", md5 = "$HEXACTRA_MD5" }
hexactra-agent = { path = "bin/hexactra-agent", sha256 = "$HEXACTRA_AGENT_SHA256", md5 = "$HEXACTRA_AGENT_MD5" }
hexactra-native-host = { path = "bin/hexactra-native-host", sha256 = "$HEXACTRA_NATIVE_HOST_SHA256", md5 = "$HEXACTRA_NATIVE_HOST_MD5" }
hexactra-mcp = { path = "bin/hexactra-mcp", sha256 = "$HEXACTRA_MCP_SHA256", md5 = "$HEXACTRA_MCP_MD5" }
EOF

# Create installation script
echo "Creating installation script..."
cat > "$RELEASE_DIR/install.sh" << 'EOF'
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
EOF

chmod +x "$RELEASE_DIR/install.sh"

# Create rollback script
cat > "$RELEASE_DIR/rollback.sh" << 'EOF'
#!/usr/bin/env bash
# Hexactra Rollback Script
# Restores previous version of Hexactra

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root"
    exit 1
fi

echo "Rolling back Hexactra..."

systemctl stop hexactra-agent

# Remove current binaries
rm -f /usr/local/bin/hexactra
rm -f /usr/local/bin/hexactra-agent
rm -f /usr/local/bin/hexactra-native-host
rm -f /usr/local/bin/hexactra-mcp

# Restore from backup if exists
if [[ -d /var/lib/hexactra/backup ]]; then
    cp /var/lib/hexactra/backup/* /usr/local/bin/
fi

systemctl start hexactra-agent

echo "Rollback complete!"
EOF

chmod +x "$RELEASE_DIR/rollback.sh"

# Create upgrade script
cat > "$RELEASE_DIR/upgrade.sh" << 'EOF'
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
EOF

chmod +x "$RELEASE_DIR/upgrade.sh"

# Create OCI image build script
cat > "$RELEASE_DIR/build-image.sh" << 'EOF'
#!/usr/bin/env bash
# Build OCI image for Hexactra

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG="${HEXACTRA_IMAGE_TAG:-hexactra:latest}"

echo "Building OCI image: $TAG"

# Build the image
docker build -t "$TAG" "$PROJECT_ROOT"

echo "OCI image built: $TAG"
EOF

chmod +x "$RELEASE_DIR/build-image.sh"

echo ""
echo "Release artifacts created in: $RELEASE_DIR"
echo ""
echo "Contents:"
ls -la "$RELEASE_DIR"
echo ""
echo "Binaries:"
ls -la "$RELEASE_DIR/bin"
echo ""
echo "Checksums:"
ls -la "$RELEASE_DIR/checksums"
echo ""
echo "Manifest:"
cat "$RELEASE_DIR/manifest/release-manifest.toml"
