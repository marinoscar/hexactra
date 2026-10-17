#!/usr/bin/env bash
# Hexactra Linux Installation Script
# Installs Hexactra binaries, systemd service, and dependencies

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="${HEXACTRA_RELEASE_DIR:-$SCRIPT_DIR}"

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
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root. Please use sudo."
        exit 1
    fi
}

# Detect Linux distribution
detect_distro() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        echo "$ID"
    else
        log_error "Unable to detect Linux distribution"
        exit 1
    fi
}

# Install dependencies based on distribution
install_dependencies() {
    local distro="$1"
    
    log_info "Installing dependencies for $distro..."
    
    case "$distro" in
        ubuntu|debian)
            apt-get update -qq
            apt-get install -y -qq \
                curl \
                wget \
                ca-certificates \
                gnupg \
                lsb-release \
                systemd \
                sqlite3 \
                pkg-config \
                libssl-dev \
                libsqlite3-dev
            ;;
        fedora|rhel|centos)
            dnf install -y \
                curl \
                wget \
                ca-certificates \
                gnupg2 \
                which \
                systemd \
                sqlite \
                pkg-config \
                openssl-devel \
                sqlite-devel
            ;;
        arch|manjaro)
            pacman -Syu --noconfirm \
                curl \
                wget \
                ca-certificates \
                gnupg \
                which \
                systemd \
                sqlite \
                pkgconf \
                openssl \
                sqlite
            ;;
        *)
            log_warn "Unknown distribution: $distro. Skipping dependency installation."
            ;;
    esac
}

# Create hexactra-agent user and groups
create_user() {
    log_info "Creating hexactra-agent user and group..."
    
    if ! getent group hexactra-agent >/dev/null 2>&1; then
        groupadd -r hexactra-agent
        log_info "Created group: hexactra-agent"
    else
        log_info "Group hexactra-agent already exists"
    fi
    
    if ! id -u hexactra-agent >/dev/null 2>&1; then
        useradd -r -g hexactra-agent -s /bin/false -d /var/lib/hexactra hexactra-agent
        log_info "Created user: hexactra-agent"
    else
        log_info "User hexactra-agent already exists"
    fi
}

# Create necessary directories
create_directories() {
    log_info "Creating directory structure..."
    
    local dirs=(
        "/usr/local/bin"
        "/etc/hexactra"
        "/var/lib/hexactra"
        "/run/hexactra"
        "/var/log/hexactra"
        "/tmp/hexactra"
        "/usr/share/hexactra"
    )
    
    for dir in "${dirs[@]}"; do
        mkdir -p "$dir"
    done
    
    # Set ownership
    chown -R hexactra-agent:hexactra-agent /var/lib/hexactra
    chown -R hexactra-agent:hexactra-agent /run/hexactra
    chown -R hexactra-agent:hexactra-agent /var/log/hexactra
    chown -R hexactra-agent:hexactra-agent /usr/share/hexactra
    
    # Set permissions
    chmod 755 /tmp/hexactra
    chmod 700 /var/lib/hexactra
    chmod 700 /run/hexactra
}

# Install binaries
install_binaries() {
    local release_dir="$1"
    
    log_info "Installing binaries..."
    
    local binaries=(
        "hexactra"
        "hexactra-agent"
        "hexactra-native-host"
        "hexactra-mcp"
    )
    
    for binary in "${binaries[@]}"; do
        if [[ -f "$release_dir/bin/$binary" ]]; then
            cp "$release_dir/bin/$binary" "/usr/local/bin/"
            chmod +x "/usr/local/bin/$binary"
            log_info "Installed: $binary"
        else
            log_warn "Binary not found: $binary (skipping)"
        fi
    done
}

# Install systemd service
install_service() {
    log_info "Installing systemd service..."
    
    local service_file="$SCRIPT_DIR/deploy/systemd/hexactra-agent.service"
    
    if [[ -f "$service_file" ]]; then
        cp "$service_file" /etc/systemd/system/
        log_info "Service file installed: /etc/systemd/system/hexactra-agent.service"
    else
        log_error "Service file not found: $service_file"
        exit 1
    fi
}

# Configure systemd
configure_systemd() {
    log_info "Configuring systemd..."
    
    # Reload systemd daemon
    systemctl daemon-reload
    
    # Enable the service
    systemctl enable hexactra-agent
    
    log_info "Systemd configured and service enabled"
}

# Start the service
start_service() {
    log_info "Starting hexactra-agent service..."
    
    # Restart the service
    systemctl restart hexactra-agent
    
    # Wait for service to start
    sleep 2
    
    # Check service status
    if systemctl is-active --quiet hexactra-agent; then
        log_info "Service started successfully"
    else
        log_warn "Service may not be running. Check logs with: journalctl -u hexactra-agent -f"
    fi
}

# Print success message
print_success() {
    echo ""
    log_info "=============================================="
    log_info "Hexactra installed successfully!"
    log_info "=============================================="
    echo ""
    echo "Installed components:"
    echo "  - /usr/local/bin/hexactra (CLI)"
    echo "  - /usr/local/bin/hexactra-agent (Daemon)"
    echo "  - /usr/local/bin/hexactra-native-host (Native messaging host)"
    echo "  - /usr/local/bin/hexactra-mcp (MCP server)"
    echo ""
    echo "Service status:"
    echo "  systemctl status hexactra-agent"
    echo ""
    echo "View logs:"
    echo "  journalctl -u hexactra-agent -f"
    echo ""
    echo "Configuration:"
    echo "  /etc/hexactra/config.toml"
    echo ""
}

# Main installation function
main() {
    log_info "Hexactra Installation Script"
    log_info "============================="
    echo ""
    
    check_root
    
    local distro
    distro=$(detect_distro)
    log_info "Detected distribution: $distro"
    
    # Install dependencies
    install_dependencies "$distro"
    
    # Create user and directories
    create_user
    create_directories
    
    # Install binaries (from release directory or build from source)
    if [[ -d "$RELEASE_DIR/bin" ]]; then
        install_binaries "$RELEASE_DIR"
    else
        log_info "Release binaries not found. Building from source..."
        cd "$SCRIPT_DIR/.."
        cargo build --release
        install_binaries "$SCRIPT_DIR/../target/release"
    fi
    
    # Install service
    install_service
    
    # Configure systemd
    configure_systemd
    
    # Start service
    start_service
    
    # Print success message
    print_success
}

# Run main function
main "$@"
