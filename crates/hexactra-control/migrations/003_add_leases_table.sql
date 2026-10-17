-- Add leases table for exclusive resource access
CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    holder_type TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for active lease lookups
CREATE INDEX IF NOT EXISTS idx_leases_resource ON leases(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at);
