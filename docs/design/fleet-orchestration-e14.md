# Fleet Orchestration (E14) Design Document

**Phase:** E14 / post-v1  
**Parent epic:** #88  
**Status:** In progress

## Overview

This document describes the design for optional fleet orchestration, scheduled workflows, and high availability capabilities in Hexactra. This work evolves Hexactra from a single-host standalone system to an opt-in distributed fleet orchestration system while preserving profile affinity, human approvals, durable ownership, and no mandatory infrastructure for single-node deployments.

## Key Principles

1. **Backward Compatibility:** All new features are opt-in. Single-node deployments continue to work without any fleet infrastructure.
2. **Profile Affinity:** A profile can only be active on one host at a time. This is enforced by the system.
3. **Human Approval:** HITL (Human-in-the-Loop) workflows remain unchanged and are not bypassed by fleet scheduling.
4. **No Mandatory Infrastructure:** Fleet features are disabled by default and failure-tolerant when not configured.

## Architecture

### New Components

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

### Component Responsibilities

1. **Scheduler Service**: Determines which host should execute a task based on:
   - Host capabilities (Chrome version, OS, display availability)
   - Profile affinity (which host has the profile)
   - Resource quotas (max concurrent sessions per owner)
   - Host health (last heartbeat, connectivity)

2. **Leader/Elector**: Ensures only one scheduler instance is active in a fleet:
   - Uses distributed locks or leader election protocol
   - Fallback to local scheduling if no leader available

3. **Quota Manager**: Enforces resource limits:
   - Max concurrent sessions per owner
   - Max profiles per host
   - Rate limiting for scheduled tasks

## Database Schema Changes

### New Tables

#### `hosts_extended` (extends `hosts`)
```sql
CREATE TABLE hosts_extended (
    host_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,  -- linux, windows, macos
    display_available BOOLEAN NOT NULL DEFAULT FALSE,
    max_concurrent_sessions INTEGER NOT NULL DEFAULT 1,
    current_load INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (host_id) REFERENCES hosts(id)
);
```

#### `profile_affinity`
```sql
CREATE TABLE profile_affinity (
    profile_id TEXT PRIMARY KEY,
    assigned_host_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    assigned_by TEXT NOT NULL,  -- user or system
    FOREIGN KEY (profile_id) REFERENCES profiles(id),
    FOREIGN KEY (assigned_host_id) REFERENCES hosts(id)
);
```

#### `schedules`
```sql
CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,  -- cron format
    timezone TEXT NOT NULL DEFAULT 'UTC',
    goal_definition TEXT NOT NULL,  -- JSON serialized goal
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES viewers(id)
);
```

#### `schedule_runs`
```sql
CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    status TEXT NOT NULL,  -- queued, running, completed, failed
    host_id TEXT,
    session_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id),
    FOREIGN KEY (host_id) REFERENCES hosts(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

#### `distributed_leases`
```sql
CREATE TABLE distributed_leases (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,  -- profile, schedule, session
    resource_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,  -- host or scheduler instance
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(resource_type, resource_id)
);
```

### Indexes

```sql
CREATE INDEX idx_profile_affinity_host ON profile_affinity(assigned_host_id);
CREATE INDEX idx_schedules_owner ON schedules(owner_id, enabled);
CREATE INDEX idx_schedule_runs_status ON schedule_runs(status, started_at);
CREATE INDEX idx_distributed_leases_expires ON distributed_leases(expires_at);
```

## API Changes

### New Endpoints

#### Host Management
- `POST /api/v1/hosts/{host_id}/register-extended` - Register host with platform info
  ```json
  {
    "hostname": "host-1",
    "version": "1.0.0",
    "capabilities": [...],
    "platform": "linux",
    "display_available": true,
    "max_concurrent_sessions": 3
  }
  ```

#### Profile Affinity
- `GET /api/v1/profiles/{profile_id}/affinity` - Get current host assignment
- `POST /api/v1/profiles/{profile_id}/assign` - Manually assign profile to host
  ```json
  { "host_id": "..." }
  ```

#### Scheduling
- `GET /api/v1/schedules` - List all schedules (owner-scoped)
- `POST /api/v1/schedules` - Create a new schedule
  ```json
  {
    "name": "Daily backup",
    "cron_expression": "0 2 * * *",
    "timezone": "America/New_York",
    "goal_definition": {...}
  }
  ```
- `PATCH /api/v1/schedules/{schedule_id}` - Update schedule
- `DELETE /api/v1/schedules/{schedule_id}` - Delete schedule
- `POST /api/v1/schedules/{schedule_id}/enable` - Enable schedule
- `POST /api/v1/schedules/{schedule_id}/disable` - Disable schedule
- `POST /api/v1/schedules/{schedule_id}/run` - Trigger manual run

#### Leader/Election
- `GET /api/v1/leader` - Get current leader info
- `POST /api/v1/leader/claim` - Claim leadership (internal use)

#### Quotas
- `GET /api/v1/quotas/{owner_id}` - Get quota usage for owner
- `PUT /api/v1/quotas/{owner_id}` - Update quota limits

## Scheduling Algorithm

### Placement Decision Flow

```
Task Request
    │
    ├─► Check profile affinity
    │   └─► If assigned: use assigned host (if healthy)
    │
    ├─► Find eligible hosts
    │   ├─► Filter by platform capability
    │   ├─► Filter by display availability (if needed)
    │   ├─► Filter by healthy status
    │   └─► Exclude hosts at capacity
    │
    ├─► Score remaining hosts
    │   ├─► Current load (lower is better)
    │   ├─► Recent success rate
    │   └─► Random tiebreaker
    │
    └─► Select best host
        └─► Acquire distributed lease on profile
```

### Failure Handling

1. **Host disconnect during task**: Reassign to another eligible host
2. **Leader failure**: New leader election, resume pending tasks
3. **Schedule missed execution**: Run once on next eligible window or skip

## Implementation Phases

### Phase 1: Design & Schema (This Issue - #89)
- [x] Document database schema changes
- [x] Define new API endpoints
- [x] Design scheduling algorithm
- [x] Document failure modes and recovery

### Phase 2: Core Implementation (#90, #91)
- Implement schedule service
- Implement distributed leases
- Implement leader election

### Phase 3: Dashboard & Monitoring (#92)
- Fleet overview dashboard
- Quota visualization
- Health alerts

### Phase 4: Documentation & Examples (#93)
- Multi-host deployment guide
- Failure/recovery demo
- Monitoring examples

## Security Considerations

1. **Lease expiration**: All distributed leases must have TTLs to prevent deadlocks
2. **Owner scoping**: Users can only see/manage their own schedules and profiles
3. **Audit trail**: All scheduling decisions are logged as events
4. **No bypass**: Fleet scheduling cannot override HITL approvals

## Migration Path

1. Existing deployments: SQLite-only, no fleet features
2. Optional upgrade: Add PostgreSQL/MySQL backend for HA
3. Fleet mode: Enable distributed features via config

## Testing Strategy

1. Unit tests for scheduling algorithm
2. Integration tests for multi-host scenarios
3. Chaos tests (host failure, network partition)
4. Backward compatibility tests (single-node still works)
