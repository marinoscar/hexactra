-- Fleet Orchestration (E14) Database Schema Extensions
-- This migration adds tables for multi-host scheduling, profile affinity,
-- and distributed leases while maintaining backward compatibility with SQLite.

-- Extend hosts table with fleet-specific fields
ALTER TABLE hosts ADD COLUMN platform TEXT DEFAULT 'linux';
ALTER TABLE hosts ADD COLUMN display_available BOOLEAN DEFAULT 0;
ALTER TABLE hosts ADD COLUMN max_concurrent_sessions INTEGER DEFAULT 1;
ALTER TABLE hosts ADD COLUMN current_load INTEGER DEFAULT 0;

-- Create profile affinity table for tracking which host owns a profile
CREATE TABLE IF NOT EXISTS profile_affinity (
    profile_id TEXT PRIMARY KEY,
    assigned_host_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_by TEXT NOT NULL DEFAULT 'system',
    FOREIGN KEY (profile_id) REFERENCES profiles(id),
    FOREIGN KEY (assigned_host_id) REFERENCES hosts(id)
);

-- Create schedules table for automated task scheduling
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    goal_definition TEXT NOT NULL,
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES viewers(id)
);

-- Create schedule_runs table for tracking individual schedule executions
CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    host_id TEXT,
    session_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id),
    FOREIGN KEY (host_id) REFERENCES hosts(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Create distributed leases table for coordinating across hosts
CREATE TABLE IF NOT EXISTS distributed_leases (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(resource_type, resource_id)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_profile_affinity_host ON profile_affinity(assigned_host_id);
CREATE INDEX IF NOT EXISTS idx_schedules_owner_enabled ON schedules(owner_id, enabled);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_distributed_leases_expires ON distributed_leases(expires_at);

-- Update existing triggers to handle new columns
DROP TRIGGER IF EXISTS update_hosts_updated_at;
CREATE TRIGGER update_hosts_updated_at
AFTER UPDATE ON hosts
BEGIN
    UPDATE hosts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS update_schedules_updated_at;
CREATE TRIGGER update_schedules_updated_at
AFTER UPDATE ON schedules
BEGIN
    UPDATE schedules SET updated_at = datetime('now') WHERE id = NEW.id;
END;
