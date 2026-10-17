#!/usr/bin/env bash
# Hexactra Release Bundle Script
# Creates a complete release bundle with all artifacts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$PROJECT_ROOT/release"

# Version from Cargo.toml
RUST_VERSION=$(grep '^version' "$PROJECT_ROOT/Cargo.toml" | head -1 | sed 's/.*= "//;s/"//')
NPM_VERSION=$(node -p "require('$PROJECT_ROOT/packages/sdk/package.json').version")

# Platform info
PLATFORM="${HOSTNAME:-unknown}"
ARCH=$(uname -m)
DATE=$(date +%Y%m%d)

echo "Creating Hexactra Release Bundle"
echo "================================="
echo "Rust version: $RUST_VERSION"
echo "JS SDK version: $NPM_VERSION"
echo "Platform: $ARCH on $PLATFORM"
echo "Date: $DATE"
echo ""

# Create release directories
mkdir -p "$RELEASE_DIR/bundle"
cd "$RELEASE_DIR/bundle"

# Copy Rust binaries
echo "Copying Rust binaries..."
cp -r "$RELEASE_DIR/bin" .
cp -r "$RELEASE_DIR/checksums" .

# Copy Chrome extension
echo "Copying Chrome extension..."
if [[ -d "$RELEASE_DIR/chrome-extension" ]]; then
    cp -r "$RELEASE_DIR/chrome-extension" .
else
    log_warn "Chrome extension not built yet. Run scripts/build-chrome-extension.sh first."
fi

# Copy JS SDK
echo "Copying JS SDK..."
if [[ -d "$RELEASE_DIR/sdk" ]]; then
    cp -r "$RELEASE_DIR/sdk" .
else
    log_warn "JS SDK not built yet. Run scripts/build-js-sdk.sh first."
fi

# Create release manifest
echo "Creating release manifest..."
cat > release-manifest.toml << EOF
version = "$RUST_VERSION"
js_sdk_version = "$NPM_VERSION"
platform = "$PLATFORM"
arch = "$ARCH"
date = "$DATE"

[rust]
binaries_dir = "bin"
checksums_dir = "checksums"

[javascript]
sdk_dir = "sdk"
chrome_extension_dir = "chrome-extension"

[artifacts]
# Rust binaries
hexactra = { path = "bin/hexactra", size = "$(stat -c%s bin/hexactra 2>/dev/null || echo 'N/A') bytes" }
hexactra-agent = { path = "bin/hexactra-agent", size = "$(stat -c%s bin/hexactra-agent 2>/dev/null || echo 'N/A') bytes" }
hexactra-native-host = { path = "bin/hexactra-native-host", size = "$(stat -c%s bin/hexactra-native-host 2>/dev/null || echo 'N/A') bytes" }
hexactra-mcp = { path = "bin/hexactra-mcp", size = "$(stat -c%s bin/hexactra-mcp 2>/dev/null || echo 'N/A') bytes" }

# Chrome extension
chrome-extension = { path = "chrome-extension", files = $(ls chrome-extension/*.js 2>/dev/null | wc -l), size = "$(du -sh chrome-extension 2>/dev/null | cut -f1)" }

# JS SDK
sdk = { path = "sdk", files = $(ls sdk/*.js 2>/dev/null | wc -l), size = "$(du -sh sdk 2>/dev/null | cut -f1)" }
EOF

# Create bundle manifest (JSON)
echo "Creating bundle manifest..."
cat > bundle-manifest.json << EOF
{
  "bundle_version": "$RUST_VERSION",
  "js_sdk_version": "$NPM_VERSION",
  "platform": "$PLATFORM",
  "arch": "$ARCH",
  "date": "$DATE",
  "artifacts": {
    "rust": {
      "binaries": [
        "bin/hexactra",
        "bin/hexactra-agent",
        "bin/hexactra-native-host",
        "bin/hexactra-mcp"
      ],
      "checksums": "checksums/"
    },
    "javascript": {
      "sdk": "sdk/",
      "chrome_extension": "chrome-extension/"
    }
  }
}
EOF

# Create README for bundle
cat > README.md << EOF
# Hexactra Release Bundle

This bundle contains all Hexactra release artifacts for version $RUST_VERSION.

## Contents

- \`bin/\` - Rust binaries (hexactra, hexactra-agent, etc.)
- \`checksums/\` - SHA256 and MD5 checksums
- \`chrome-extension/\` - Chrome extension (MV3)
- \`sdk/\` - JavaScript SDK (npm package)

## Installation

### Rust Binaries

See [Rust Installation Guide](../deploy/README.md)

### Chrome Extension

See [Chrome Extension Installation](../apps/chrome-extension/INSTALL.md)

### JavaScript SDK

\`\`\`bash
npm install @hexactra/sdk
\`\`\`

See [JS SDK Installation](../packages/sdk/INSTALL.md)

## Verification

Verify all checksums:

\`\`\`bash
cd release/bundle
sha256sum -c checksums/*.sha256
\`\`\`

## Release Notes

See [GitHub Releases](https://github.com/marinoscar/hexactra/releases) for full changelog.

## License

MIT - See LICENSE file for details.
EOF

echo ""
echo "Release bundle created in: $RELEASE_DIR/bundle"
echo ""
ls -la "$RELEASE_DIR/bundle"
