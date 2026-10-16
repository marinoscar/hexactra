-- Create profiles table
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    chrome_profile_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'initializing',
    host_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (profile_id) REFERENCES profiles(id)
);

-- Create goals table
CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    actions TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'queued',
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Create operations table
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (goal_id) REFERENCES goals(id)
);

-- Create interaction_requests table
CREATE TABLE IF NOT EXISTS interaction_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Create hosts table
CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    version TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create events table
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_profile_id ON sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_goals_session_id ON goals(session_id);
CREATE INDEX IF NOT EXISTS idx_operations_goal_id ON operations(goal_id);
CREATE INDEX IF NOT EXISTS idx_interaction_requests_session_id ON interaction_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_type, resource_id);

-- Create triggers for updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_profiles_updated_at
AFTER UPDATE ON profiles
BEGIN
    UPDATE profiles SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_sessions_updated_at
AFTER UPDATE ON sessions
BEGIN
    UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_hosts_updated_at
AFTER UPDATE ON hosts
BEGIN
    UPDATE hosts SET updated_at = datetime('now') WHERE id = NEW.id;
END;
