# Hexactra Installation Guide

## Overview

This guide covers installing Hexactra on Linux systems with systemd or Docker. Hexactra provides a browser automation runtime with AI agent capabilities.

## Prerequisites

- Linux x86_64 (Ubuntu 24.04, Debian 12, or similar)
- Root/sudo access
- Internet connectivity
- Chrome 125+ (for browser automation)

## Installation Methods

### Method 1: Using the Installation Script

The easiest way to install Hexactra is using the provided installation script:

```bash
curl -sSL https://github.com/marinoscar/hexactra/releases/latest/download/install.sh | sudo bash
```

Or download and run locally:

```bash
wget https://github.com/marinoscar/hexactra/releases/latest/download/install.sh
chmod +x install.sh
sudo ./install.sh
```

### Method 2: Manual Installation

#### Step 1: Download Binaries

Download the release binaries from GitHub Releases:

```bash
# Create directory for binaries
sudo mkdir -p /usr/local/bin

# Download and install binaries (replace with actual URLs)
curl -L https://github.com/marinoscar/hexactra/releases/download/v0.1.0/hexactra \
  -o /usr/local/bin/hexactra
curl -L https://github.com/marinoscar/hexactra/releases/download/v0.1.0/hexactra-agent \
  -o /usr/local/bin/hexactra-agent
curl -L https://github.com/marinoscar/hexactra/releases/download/v0.1.0/hexactra-native-host \
  -o /usr/local/bin/hexactra-native-host
curl -L https://github.com/marinoscar/hexactra/releases/download/v0.1.0/hexactra-mcp \
  -o /usr/local/bin/hexactra-mcp

# Make binaries executable
sudo chmod +x /usr/local/bin/hexactra*
```

#### Step 2: Verify Checksums

```bash
cd /usr/local/bin
sha256sum -c /path/to/checksums/hexactra.sha256
sha256sum -c /path/to/checksums/hexactra-agent.sha256
sha256sum -c /path/to/checksums/hexactra-native-host.sha256
sha256sum -c /path/to/checksums/hexactra-mcp.sha256
```

#### Step 3: Create User and Directories

```bash
# Create hexactra-agent user
sudo groupadd -r hexactra-agent
sudo useradd -r -g hexactra-agent -s /bin/false -d /var/lib/hexactra hexactra-agent

# Create directories
sudo mkdir -p /etc/hexactra
sudo mkdir -p /var/lib/hexactra
sudo mkdir -p /run/hexactra
sudo mkdir -p /var/log/hexactra

# Set ownership
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra
sudo chown -R hexactra-agent:hexactra-agent /run/hexactra
sudo chown -R hexactra-agent:hexactra-agent /var/log/hexactra
```

#### Step 4: Install Systemd Service

```bash
# Copy service file
sudo cp deploy/systemd/hexactra-agent.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start service
sudo systemctl enable hexactra-agent
sudo systemctl start hexactra-agent
```

### Method 3: Docker Container

#### Using Docker Compose

```bash
# Clone the repository
git clone https://github.com/marinoscar/hexactra.git
cd hexactra

# Start with Docker Compose
docker-compose up -d
```

#### Using Docker Directly

```bash
docker run -d \
  --name hexactra-agent \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -v /var/lib/hexactra:/var/lib/hexactra \
  -v /run/hexactra:/run/hexactra \
  -p 8080:8080 \
  hexactra:latest
```

## Post-Installation Configuration

### Configure API Provider

Create the configuration file at `/etc/hexactra/config.toml`:

```toml
[api]
provider = "openai"
model = "gpt-4"
api_key = "your-api-key-here"

[agent]
log_level = "info"

[security]
secrets_store = "memory"
audit_logging = true
```

### Configure Chrome

If using browser automation, ensure Chrome is installed:

```bash
# Install Chrome (Ubuntu/Debian)
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o chrome.deb
sudo dpkg -i chrome.deb
sudo apt-get install -f

# Verify Chrome installation
google-chrome --version
```

### Configure Native Messaging Host

The Chrome extension requires a native messaging host:

```bash
# Create the native manifest directory
sudo mkdir -p /etc/opt/chrome/native-messaging-hosts

# Copy the native manifest
sudo cp deploy/native-host/com.hexactra.nativehost.json \
  /etc/opt/chrome/native-messaging-hosts/

# Set permissions
sudo chown root:root /etc/opt/chrome/native-messaging-hosts/com.hexactra.nativehost.json
sudo chmod 644 /etc/opt/chrome/native-messaging-hosts/com.hexactra.nativehost.json
```

## Verification

After installation, verify everything is working:

```bash
# Check service status
systemctl status hexactra-agent

# View logs
journalctl -u hexactra-agent -f

# Test health endpoint
curl http://localhost:8080/health

# Test CLI
hexactra --help
```

## Troubleshooting

### Service won't start

```bash
# Check service status
systemctl status hexactra-agent

# View detailed logs
journalctl -u hexactra-agent --since "1 hour ago"

# Check for configuration errors
hexactra --config /etc/hexactra/config.toml --help
```

### Chrome extension not connecting

1. Verify native host is installed and running
2. Check Chrome's native messaging hosts directory
3. Verify extension ID in manifest matches
4. Restart Chrome after changes

### Port already in use

```bash
# Find process using port 8080
lsof -i :8080

# Or change the port in config.toml
# [api]
# port = 8081
```

## Uninstallation

### Using the uninstall script (if available)

```bash
sudo ./uninstall.sh
```

### Manual uninstallation

```bash
# Stop and disable service
sudo systemctl stop hexactra-agent
sudo systemctl disable hexactra-agent

# Remove binaries
sudo rm -f /usr/local/bin/hexactra*
sudo rm -f /etc/systemd/system/hexactra-agent.service

# Reload systemd
sudo systemctl daemon-reload

# Remove data (optional)
sudo rm -rf /var/lib/hexactra
sudo rm -rf /run/hexactra
```

## Upgrading

### From tarball/zip

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Backup current binaries (optional)
sudo cp /usr/local/bin/hexactra* /var/lib/hexactra/backup/

# Install new binaries
curl -L https://github.com/marinoscar/hexactra/releases/download/v0.1.0/hexactra \
  -o /usr/local/bin/hexactra
# ... (repeat for other binaries)

# Start the service
sudo systemctl start hexactra-agent
```

### Using the upgrade script

```bash
sudo ./upgrade.sh
```

## Next Steps

- Configure your API provider in `/etc/hexactra/config.toml`
- Install and configure the Chrome extension
- Set up monitoring and logging
- Review security settings in the [Security Guide](./security.md)
