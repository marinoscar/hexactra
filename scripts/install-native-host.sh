#!/bin/bash
#
# Install the Hexactra Native Messaging Host
#
# This script installs the native messaging host binary and registers it
# with Chrome. It handles both system-wide and user-level installations.
#

set -e

# Configuration
NATIVE_HOST_NAME="hexactra_native_host"
NATIVE_HOST_BIN="hexactra-native-host"
CONTROL_SOCKET="/tmp/hexactra-control.sock"
MANIFEST_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    log_warn "Running as root. This will install system-wide."
    MANIFEST_DIR="/etc/google-chrome/NativeMessagingHosts"
fi

# Find the native host binary
find_binary() {
    # Check common locations
    local candidates=(
        "/usr/local/bin/${NATIVE_HOST_BIN}"
        "/usr/bin/${NATIVE_HOST_BIN}"
        "$HOME/.local/bin/${NATIVE_HOST_BIN}"
        "./target/release/${NATIVE_HOST_BIN}"
        "./target/debug/${NATIVE_HOST_BIN}"
    )

    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    log_error "Native host binary not found. Please build first: cargo build --release"
    exit 1
}

# Create manifest directory
create_manifest_dir() {
    if [ ! -d "$MANIFEST_DIR" ]; then
        log_info "Creating manifest directory: $MANIFEST_DIR"
        mkdir -p "$MANIFEST_DIR"
    fi
}

# Generate the manifest JSON
generate_manifest() {
    local binary_path="$1"
    
    cat << EOF
{
    "name": "com.hexactra.nativehost",
    "description": "Hexactra Native Messaging Host",
    "path": "${binary_path}",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://YOUR_EXTENSION_ID_HERE/"
    ]
}
EOF
}

# Install the native messaging host
install() {
    log_info "Installing Hexactra Native Messaging Host..."
    
    # Find the binary
    local binary_path
    binary_path=$(find_binary)
    log_info "Found binary at: $binary_path"
    
    # Create manifest directory
    create_manifest_dir
    
    # Generate and install manifest
    local manifest_path="${MANIFEST_DIR}/com.hexactra.nativehost.json"
    log_info "Installing manifest to: $manifest_path"
    
    generate_manifest "$binary_path" > "$manifest_path"
    
    # Set permissions
    chmod 644 "$manifest_path"
    
    log_info "Installation complete!"
    echo ""
    log_info "Next steps:"
    echo "1. Update the 'allowed_origins' in $manifest_path"
    echo "   with your Chrome extension's ID"
    echo "2. Restart Chrome"
    echo "3. Load your extension in chrome://extensions/"
}

# Uninstall the native messaging host
uninstall() {
    log_info "Uninstalling Hexactra Native Messaging Host..."
    
    local manifest_path="${MANIFEST_DIR}/com.hexactra.nativehost.json"
    
    if [ -f "$manifest_path" ]; then
        rm "$manifest_path"
        log_info "Manifest removed: $manifest_path"
    else
        log_warn "Manifest not found: $manifest_path"
    fi
    
    # Check for binary in common locations and warn
    local binary_locations=(
        "/usr/local/bin/${NATIVE_HOST_BIN}"
        "/usr/bin/${NATIVE_HOST_BIN}"
        "$HOME/.local/bin/${NATIVE_HOST_BIN}"
    )
    
    log_info "To remove the binary, run:"
    for loc in "${binary_locations[@]}"; do
        if [ -x "$loc" ]; then
            echo "  sudo rm $loc"
        fi
    done
}

# Show usage
usage() {
    echo "Usage: $0 [install|uninstall]"
    echo ""
    echo "Commands:"
    echo "  install   Install the native messaging host"
    echo "  uninstall Remove the native messaging host"
    echo ""
    echo "Options:"
    echo "  -h, --help  Show this help message"
}

# Main
case "${1:-install}" in
    install)
        install
        ;;
    uninstall)
        uninstall
        ;;
    -h|--help|help)
        usage
        exit 0
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac
