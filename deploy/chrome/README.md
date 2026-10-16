# Chrome Runtime Configuration for Hexactra

This directory contains deployment scripts and configuration for Chrome runtime in Hexactra.

## Files

- `install-chrome.sh` - Install Chrome and dependencies on Ubuntu/Debian
- `test-chrome.sh` - Test Chrome runtime in virtual display
- `chrome-config.toml.example` - Example Chrome configuration

## Prerequisites

- Ubuntu 24.04 or Debian-based Linux
- Root/sudo access
- Internet connectivity

## Installation

Run the installation script:

```bash
sudo bash deploy/chrome/install-chrome.sh
```

This will:
1. Install Xvfb for virtual display
2. Download and install Google Chrome
3. Create the `hexactra-agent` service user
4. Set up Chrome profile directories
5. Configure Xvfb systemd service

## Configuration

Copy the example configuration:

```bash
sudo cp chrome-config.toml.example /etc/hexactra/chrome-config.toml
```

Edit `/etc/hexactra/chrome-config.toml` to customize settings.

## Usage

### Starting Xvfb

```bash
sudo systemctl start xvfb
sudo systemctl enable xvfb
```

### Verifying Installation

```bash
# Check Xvfb is running
systemctl status xvfb

# Test Chrome in virtual display
DISPLAY=:99 google-chrome --version
```

### Using with Hexactra Agent

The agent will automatically use the configured Chrome runtime when started:

```bash
sudo systemctl start hexactra-agent
```

## Troubleshooting

### Xvfb not starting

Check logs:
```bash
journalctl -u xvfb -f
```

### Chrome not launching

Verify Chrome is installed:
```bash
which google-chrome
google-chrome --version
```

Test manually with virtual display:
```bash
DISPLAY=:99 google-chrome --no-sandbox --disable-dev-shm-usage about:blank
```

### Permission errors

Ensure proper ownership:
```bash
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra/chrome-profiles
```

## Resource Limits

Default Chrome resource limits:
- Memory: 2048 MB
- CPU cores: 2
- Open files: 1024

Adjust in the agent configuration if needed.
