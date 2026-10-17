# Hexactra Recovery Guide

## Overview

This guide covers disaster recovery procedures for Hexactra, including backup strategies, restore procedures, and rollback instructions.

## Backup Strategies

### What to Backup

1. **Configuration**: `/etc/hexactra/config.toml`
2. **Profiles**: `/var/lib/hexactra/profiles/`
3. **Sessions**: Database state
4. **Logs**: Audit logs for compliance

### Backup Frequency

- **Configuration**: After any changes
- **Profiles**: Daily
- **Sessions**: Per session (automatic)
- **Logs**: Continuous (via journal)

## Manual Backup

### Configuration Backup

```bash
sudo cp /etc/hexactra/config.toml /backup/config-$(date +%Y%m%d).toml
```

### Profile Backup

```bash
sudo tar -czf /backup/profiles-$(date +%Y%m%d).tar.gz \
  /var/lib/hexactra/profiles/
```

### Full System Backup

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Create backup
sudo tar -czf /backup/hexactra-$(date +%Y%m%d-%H%M%S).tar.gz \
  /etc/hexactra \
  /var/lib/hexactra \
  /var/log/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

## Restore Procedures

### Configuration Restore

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore configuration
sudo cp /backup/config-20241017.toml /etc/hexactra/config.toml

# Validate configuration
hexactra --config /etc/hexactra/config.toml validate

# Restart the service
sudo systemctl start hexactra-agent
```

### Profile Restore

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore profiles
sudo tar -xzf /backup/profiles-20241017.tar.gz -C /

# Set ownership
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

### Full System Restore

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore from backup
sudo tar -xzf /backup/hexactra-20241017-120000.tar.gz -C /

# Set ownership
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra
sudo chown -R hexactra-agent:hexactra-agent /etc/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

## Rollback Instructions

### Rolling Back a Bad Upgrade

1. **Stop the new version**:
   ```bash
   sudo systemctl stop hexactra-agent
   ```

2. **Restore previous binaries**:
   ```bash
   # If using backup
   sudo cp /var/lib/hexactra/backup/hexactra-* /usr/local/bin/
   
   # Or reinstall previous version
   curl -L https://github.com/marinoscar/hexactra/releases/download/v0.0.9/hexactra \
     -o /usr/local/bin/hexactra
   ```

3. **Start the previous version**:
   ```bash
   sudo systemctl start hexactra-agent
   ```

4. **Investigate the issue**:
   ```bash
   journalctl -u hexactra-agent --since "1 hour ago"
   ```

### Database Rollback

If using SQLite:

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore database from backup
sudo cp /backup/hexactra.db /var/lib/hexactra/hexactra.db

# Set ownership
sudo chown hexactra-agent:hexactra-agent /var/lib/hexactra/hexactra.db

# Restart the service
sudo systemctl start hexactra-agent
```

## Recovery Scenarios

### Scenario 1: Service Unresponsive

```bash
# Check service status
systemctl status hexactra-agent

# View logs
journalctl -u hexactra-agent -n 100

# Restart the service
sudo systemctl restart hexactra-agent

# If still unresponsive, check for resource issues
free -h
df -h
```

### Scenario 2: Configuration Error

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore previous configuration
sudo cp /backup/config-20241017.toml /etc/hexactra/config.toml

# Validate configuration
hexactra --config /etc/hexactra/config.toml validate

# Restart the service
sudo systemctl start hexactra-agent
```

### Scenario 3: Data Corruption

```bash
# Stop the service
sudo systemctl stop hexactra-agent

# Restore from backup
sudo tar -xzf /backup/hexactra-20241017.tar.gz -C /

# Set ownership
sudo chown -R hexactra-agent:hexactra-agent /var/lib/hexactra

# Restart the service
sudo systemctl start hexactra-agent
```

## Testing Recovery

### Regular Backup Testing

```bash
# Test backup restoration (in test environment)
sudo systemctl stop hexactra-agent
sudo tar -xzf /backup/hexactra-test.tar.gz -C /test-restore/
sudo systemctl start hexactra-agent
```

### Recovery Drills

Schedule regular recovery drills:

```bash
# Monthly recovery drill
# 1. Restore from backup to test environment
# 2. Verify all functionality
# 3. Document any issues
# 4. Update procedures if needed
```

## Disaster Recovery Plan

### Step 1: Assessment

1. Identify the scope of the disaster
2. Determine affected systems
3. Assess data loss

### Step 2: Stabilization

1. Stop all services
2. Preserve current state (if possible)
3. Begin backup restoration

### Step 3: Recovery

1. Restore from latest backup
2. Verify functionality
3. Resume operations

### Step 4: Post-Incident

1. Document the incident
2. Update procedures if needed
3. Schedule follow-up review

## Next Steps

- Review the [Operations Guide](./operations.md) for operational procedures
- Set up automated backups
- Test recovery procedures regularly
- Train team on disaster recovery
