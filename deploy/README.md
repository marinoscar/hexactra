# Hexactra Release Manifest

This directory contains release artifacts for Hexactra.

## Files

- `bin/` - Compiled binaries (hexactra, hexactra-agent, hexactra-native-host, hexactra-mcp)
- `checksums/` - SHA256 and MD5 checksums for each binary
- `manifest/` - Release manifest with version, platform, and binary metadata
- `install.sh` - Installation script for Linux systems
- `rollback.sh` - Rollback script to restore previous version
- `upgrade.sh` - Upgrade script for new versions
- `build-image.sh` - Script to build OCI/Docker image

## Release Manifest Format

The release manifest (`manifest/release-manifest.toml`) contains:

```toml
version = "0.1.0"
platform = "linux"
arch = "x86_64"
date = "20251017"

[binaries]
hexactra = { path = "bin/hexactra", sha256 = "...", md5 = "..." }
hexactra-agent = { path = "bin/hexactra-agent", sha256 = "...", md5 = "..." }
hexactra-native-host = { path = "bin/hexactra-native-host", sha256 = "...", md5 = "..." }
hexactra-mcp = { path = "bin/hexactra-mcp", sha256 = "...", md5 = "..." }
```

## Installation

### Prerequisites

- Linux x86_64 (Ubuntu 24.04 or similar)
- Root/sudo access
- Internet connectivity (for dependencies)

### Quick Install

```bash
# Download and run the installation script
curl -sSL https://github.com/marinoscar/hexactra/releases/latest/download/install.sh | sudo bash

# Or download and run locally
wget https://github.com/marinoscar/hexactra/releases/latest/download/install.sh
chmod +x install.sh
sudo ./install.sh
```

### Manual Install

```bash
# Copy binaries to /usr/local/bin
sudo cp bin/* /usr/local/bin/
sudo chmod +x /usr/local/bin/hexactra*
sudo chmod +x /usr/local/bin/hexactra-native-host

# Install systemd service
sudo cp deploy/systemd/hexactra-agent.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload
sudo systemctl enable hexactra-agent
sudo systemctl start hexactra-agent
```

## Upgrade

```bash
# Run the upgrade script (must be run as root)
sudo ./upgrade.sh
```

## Rollback

```bash
# Run the rollback script (must be run as root)
sudo ./rollback.sh
```

## Verification

After installation, verify the binaries:

```bash
# Check version
hexactra --version

# Check service status
systemctl status hexactra-agent

# View logs
journalctl -u hexactra-agent -f
```

## OCI/Docker Image

To build and run the OCI image:

```bash
# Build the image
./build-image.sh

# Or with custom tag
HEXACTRA_IMAGE_TAG=hexactra:v1.0.0 ./build-image.sh

# Run the container
docker run -d \
  --name hexactra-agent \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -v /var/lib/hexactra:/var/lib/hexactra \
  -v /run/hexactra:/run/hexactra \
  hexactra:latest
```

## Compatibility Matrix

| Component | Version | Notes |
|-----------|---------|-------|
| Rust binaries | 0.1.0 | Linux x86_64 |
| Chrome extension | 0.1.0 | MV3, Chrome 125+ |
| Protocol | 1.0 | Native messaging protocol |

## Release Process

1. Build release binaries: `cargo build --release`
2. Run release script: `./scripts/release.sh`
3. Verify checksums: `sha256sum -c checksums/*.sha256`
4. Test installation: `sudo ./install.sh`
5. Verify functionality
6. Tag and publish to GitHub Releases

## Security

- Binaries are not signed (platform limitation)
- Checksums provided for integrity verification
- No secrets embedded in binaries
- Runtime permissions minimized via systemd hardening
