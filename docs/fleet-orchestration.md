# Fleet Orchestration Guide

This guide covers Hexactra's fleet orchestration capabilities for multi-host deployment.

## Overview

Fleet orchestration enables Hexactra to operate across multiple hosts with:
- **Capability-based scheduling**: Match tasks to hosts with appropriate capabilities
- **Profile affinity**: Ensure profiles run on designated hosts
- **Distributed leadership**: Safe leader election for coordinated scheduling
- **Dashboard monitoring**: Real-time fleet visibility and health

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Control Plane (Rust/Axum)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Scheduler   │  │ Leader/Elector│  │ Quota Manager│             │
│  │  Service     │  │ (Raft/etcd)  │  │ Service      │             │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐  ┌──────────▼────────┐  ┌────────▼────────┐
│   Host Agent  │  │   Host Agent      │  │   Host Agent    │
│   (Linux)     │  │   (Linux)         │  │   (Windows)     │
└───────────────┘  └───────────────────┘  └─────────────────┘
```

## Getting Started

### Single-Host Deployment (No Fleet)

For standalone deployments, no fleet configuration is needed. Hexactra works out of the box with SQLite.

### Multi-Host Deployment

To enable fleet orchestration:

1. **Configure shared database**:
   ```bash
   # Use PostgreSQL or MySQL for HA
   DATABASE_URL=postgresql://user:pass@host:5432/hexactra
   ```

2. **Register hosts**:
   ```bash
   curl -X POST http://localhost:8080/api/v1/hosts/register \
     -H "Content-Type: application/json" \
     -d '{
       "hostname": "host-1",
       "version": "1.0.0",
       "capabilities": ["chrome", "display"],
       "platform": "linux"
     }'
   ```

3. **Assign profile affinity**:
   ```bash
   curl -X POST http://localhost:8080/api/v1/fleet/profile-assign/{profile_id} \
     -H "Content-Type: application/json" \
     -d '{"host_id": "{host_id}"}'
   ```

## Dashboard API

### Get Dashboard Summary

```bash
curl http://localhost:8080/api/v1/fleet/dashboard/summary
```

Response:
```json
{
  "total_hosts": 3,
  "active_hosts": 2,
  "total_profiles": 5,
  "active_schedules": 3,
  "pending_hitl_requests": 1,
  "scheduled_runs_today": 12
}
```

### Get Hosts Health

```bash
curl http://localhost:8080/api/v1/fleet/hosts/health
```

### Get Health Metrics (OTel)

```bash
curl http://localhost:8080/api/v1/fleet/health/metrics
```

## Scheduling

### Create a Schedule

```bash
curl -X POST http://localhost:8080/api/v1/fleet/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily backup",
    "cron_expression": "0 2 * * *",
    "timezone": "UTC",
    "goal_definition": {...}
  }'
```

### Schedule Control

```bash
# Pause a schedule
curl -X POST http://localhost:8080/api/v1/fleet/schedules/{id}/pause

# Resume a schedule
curl -X POST http://localhost:8080/api/v1/fleet/schedules/{id}/resume

# Enable a schedule
curl -X POST http://localhost:8080/api/v1/fleet/schedules/{id}/enable

# Disable a schedule
curl -X POST http://localhost:8080/api/v1/fleet/schedules/{id}/disable

# Trigger manual run
curl -X POST http://localhost:8080/api/v1/fleet/schedules/{id}/run
```

## Leader Election

Fleet orchestration uses database-based leader election:

- **Automatic failover**: If leader fails, another node assumes leadership
- **Idempotent claims**: Multiple claim attempts are safe
- **Lock expiration**: Automatic lease renewal prevents stale leadership

### Leader State

```bash
curl http://localhost:8080/api/v1/fleet/leader/info
```

## Monitoring

### Health Metrics

The health metrics endpoint provides data for OTel integration:

```json
{
  "timestamp": "2026-10-17T10:30:00Z",
  "uptime_seconds": 86400,
  "active_sessions": 5,
  "pending_operations": 2
}
```

### Dashboard Visualization

Use the dashboard endpoints to build monitoring dashboards:

1. **Fleet Overview**: Total hosts, active hosts, profiles
2. **Work Queue**: Pending HITL requests, scheduled runs
3. **Health Alerts**: Host disconnections, high load

## High Availability

### Database Requirements

For HA deployments:
- PostgreSQL 14+ or MySQL 8+
- Connection pooling (pgbouncer/MySQL connection pooler)
- Regular backups

### Leader Failover

The system handles leader failover automatically:

1. Leader heartbeats every 10 seconds
2. If heartbeat expires (30 seconds), another node claims leadership
3. Pending tasks are reassigned to healthy hosts

## Troubleshooting

### Host Not Connecting

1. Check host agent logs
2. Verify network connectivity to control plane
3. Ensure capabilities match requirements

### Schedule Not Running

1. Verify schedule is enabled
2. Check cron expression format
3. Review schedule run history in database

### Leader Election Issues

1. Check distributed_leases table for stale locks
2. Verify database connectivity
3. Review leader election logs

## Migration Path

### From Single-Host to Fleet

1. **Backup existing data**:
   ```bash
   pg_dump hexactra > backup.sql
   ```

2. **Set up shared database**:
   - Configure PostgreSQL/MySQL
   - Import backup

3. **Deploy control plane**:
   - Point to shared database
   - Register additional hosts

4. **Test**: Verify all functionality works before going live

## Security Considerations

1. **Lease expiration**: All distributed locks have TTLs
2. **Owner scoping**: Users only see their own resources
3. **Audit trail**: All scheduling decisions are logged
4. **No bypass**: Fleet cannot override HITL approvals
