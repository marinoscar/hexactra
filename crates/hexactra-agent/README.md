# Hexactra Host Agent

The host agent is a background service that runs at boot time, independent of login/display session. It provides:

- Control socket for local agent management
- Health endpoint for monitoring
- Graceful shutdown handling
- Least-privilege service account support

## Installation

### Systemd Service

The agent is installed as a systemd service:

```bash
sudo cp deploy/systemd/hexactra-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hexactra-agent
```

### Service Account

Create the service account:

```bash
sudo groupadd --system hexactra-agent
sudo useradd --system -g hexactra-agent -s /usr/sbin/nologin hexactra-agent
```

### Configuration

Copy the example configuration:

```bash
sudo mkdir -p /etc/hexactra
sudo cp config/agent.toml.example /etc/hexactra/agent.toml
```

Edit `/etc/hexactra/agent.toml` to customize settings.

## Usage

### Starting the Service

```bash
sudo systemctl start hexactra-agent
```

### Checking Status

```bash
systemctl status hexactra-agent
journalctl -u hexactra-agent -f
```

### Stopping the Service

```bash
sudo systemctl stop hexactra-agent
```

## Control Socket

The agent exposes a Unix domain socket at `/run/hexactra/agent.sock` (configurable) for local control commands.

### Socket Permissions

- Owner: `hexactra-agent` user
- Group: `hexactra-agent` group
- Permissions: `0660` (owner and group can read/write)

## Security Considerations

1. **Least Privilege**: The agent runs as a dedicated service account with minimal permissions.
2. **No New Privileges**: The systemd service uses `NoNewPrivileges=true`.
3. **Protected Filesystem**: Uses `ProtectSystem=strict` and `ProtectHome=read-only`.
4. **Private Temp**: Each instance gets its own temporary directory via `PrivateTmp=true`.

## Environment Variables

The agent respects the following environment variables:

- `HEXACTRA_CONTROL_SOCKET`: Path to control socket (default: `/run/hexactra/agent.sock`)
- `HEXACTRA_CHROME_PROFILE_PATH`: Path to Chrome profile directory
- `HEXACTRA_SERVICE_UID`: UID to drop to (optional)
- `HEXACTRA_SERVICE_GID`: GID to drop to (optional)

## CLI Commands

```bash
# Run the daemon
hexactra-agent daemon

# Show health status
hexactra-agent health

# Stop the service
hexactra-agent stop

# Show version
hexactra-agent version
```

## Logs

Logs are written to systemd journal:

```bash
journalctl -u hexactra-agent -f
```
