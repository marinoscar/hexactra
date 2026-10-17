# Hexactra Operations Guide

## Overview

This guide covers operational aspects of running Hexactra in production, including monitoring, logging, backup/restore, and日常 operations.

## System Architecture

Hexactra consists of several components:

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane (Rust)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Identity │  │  Sessions│  │   Goals  │  │   HITL   │   │
│  │  Manager │  │ Manager  │  │ Manager  │  │ Broker   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Host Agent (Rust)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ Chrome   │  │  Worker  │  │ Native   │                 │
│  │ Manager  │  │ Session  │  │ Messaging│                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Chrome Extension (MV3)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ Side     │  │ Content  │  │ Background│                │
│  │ Panel    │  │ Scripts  │  │ Service  │                │
│  └──────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

## Daily Operations

### Starting the Service

```bash
# Start the service
sudo systemctl start hexactra-agent

# Or if using Docker
docker-compose up -d
```

### Stopping the Service

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Or if using Docker
docker-compose down
```

### Restarting the Service

```bash
# Restart the service
sudo systemctl restart hexactra-agent

# Or if using Docker
docker-compose restart
```

### Checking Status

```bash
# Check service status
systemctl status hexactra-agent

# View logs
journalctl -u hexactra-agent -f

# Check health endpoint
curl http://localhost:8080/health
```

## Monitoring

### Health Check Endpoint

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "components": {
    "control_plane": "ok",
    "agent": "ok",
    "worker": "ok"
  }
}
```

### Metrics

Hexactra exposes Prometheus-compatible metrics at `/metrics`:

```bash
curl http://localhost:8080/metrics
```

### Logging

Logs are stored in `/var/log/hexactra/`:

```bash
# View logs
journalctl -u hexactra-agent -f

# Or check log files directly
tail -f /var/log/hexactra/hexactra.log
```

## Backup and Restore

### Backup

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Create backup
sudo tar -czf /backup/hexactra-$(date +%Y%m%d).tar.gz \
  /etc/hexactra \
  /var/lib/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

### Restore

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore from backup
sudo tar -xzf /backup/hexactra-20241017.tar.gz -C /

# Set proper ownership
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra
sudo chown -R hexactra-agent:hexactra-agent /etc/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

## Troubleshooting

### Common Issues

#### Service won't start

```bash
# Check for configuration errors
hexactra --config /etc/hexactra/config.toml validate

# View detailed logs
journalctl -u hexactra-agent --since "1 hour ago" | less
```

#### High memory usage

```bash
# Check memory usage
ps aux | grep hexactra

# View logs for memory-related errors
journalctl -u hexactra-agent | grep -i memory
```

#### Chrome not launching

```bash
# Verify Chrome is installed
which google-chrome
google-chrome --version

# Test Chrome manually
DISPLAY=:99 google-chrome --no-sandbox --disable-dev-shm-usage about:blank
```

### Logs and Diagnostics

```bash
# View all logs
journalctl -u hexactra-agent

# View recent errors
journalctl -u hexactra-agent -p err

# View debug logs (if enabled)
journalctl -u hexactra-agent -o verbose
```

## Performance Tuning

### Adjusting Resource Limits

Edit `/etc/systemd/system/hexactra-agent.service`:

```ini
[Service]
MemoryLimit=2G
CPUQuota=200%
```

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart hexactra-agent
```

### Chrome Configuration

Edit `/etc/hexactra/config.toml`:

```toml
[chrome]
max_memory_mb = 2048
max_cpu_percent = 200
max_open_files = 1024
```

## Maintenance

### Updating Configuration

```bash
# Edit configuration
sudo nano /etc/hexactra/config.toml

# Validate configuration
hexactra --config /etc/hexactra/config.toml validate

# Restart service
sudo systemctl restart hexactra-agent
```

### Clearing Cache

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Clear cache
sudo rm -rf /var/lib/hexactra/cache/*

# Restart the service
sudo systemctl start hexactra-agent
```

## Security Operations

### Rotating API Keys

1. Generate new API key from your provider
2. Update `/etc/hexactra/config.toml`
3. Restart the service
4. Update any clients using the old key

### Auditing

```bash
# View audit logs
journalctl -u hexactra-agent | grep -i audit

# Or check the audit file directly
tail -f /var/lib/hexactra/audit.log
```

## Scaling

### Horizontal Scaling

For multiple hosts:

1. Deploy Hexactra on each host
2. Configure load balancer in front of control plane
3. Use shared database for session state

### Vertical Scaling

Increase resources for the service:

```bash
# Edit systemd service
sudo systemctl edit hexactra-agent

# Add resource limits
[Service]
MemoryLimit=4G
CPUQuota=400%
```

## Next Steps

- Review the [Security Guide](./security.md) for security best practices
- Set up monitoring with Prometheus/Grafana
- Configure alerting for critical events
- Review the [Recovery Guide](./recovery.md) for disaster recovery procedures
