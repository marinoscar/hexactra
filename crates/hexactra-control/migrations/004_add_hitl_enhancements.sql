-- Add HITL enhancements: kind, expiry, owner, origin fields
-- Migration: 004_add_hitl_enhancements.sql

-- Add new columns to interaction_requests table
ALTER TABLE interaction_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'secret_text';
ALTER TABLE interaction_requests ADD COLUMN expires_at TEXT NOT NULL DEFAULT (datetime('now', '+15 minutes'));
ALTER TABLE interaction_requests ADD COLUMN owner_id TEXT;
ALTER TABLE interaction_requests ADD COLUMN origin_session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE interaction_requests ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Update the default expiry trigger to use a configurable TTL
-- We'll handle expiry logic in application code for flexibility

-- Create index for expired requests cleanup
CREATE INDEX IF NOT EXISTS idx_interaction_requests_expiry ON interaction_requests(expires_at);

-- Create index for owner-based lookups
CREATE INDEX IF NOT EXISTS idx_interaction_requests_owner ON interaction_requests(owner_id);

-- Create index for origin session lookups
CREATE INDEX IF NOT EXISTS idx_interaction_requests_origin ON interaction_requests(origin_session_id);
