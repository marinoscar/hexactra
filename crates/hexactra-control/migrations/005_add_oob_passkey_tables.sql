-- Add OOB confirmation and passkey tables
-- Migration: 005_add_oob_passkey_tables.sql

-- Create OOB channels table for push notification verification
CREATE TABLE IF NOT EXISTS oob_channels (
    channel_id TEXT PRIMARY KEY,
    verification_code TEXT NOT NULL,
    request_id TEXT NOT NULL REFERENCES interaction_requests(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create index for OOB channel lookups
CREATE INDEX IF NOT EXISTS idx_oob_channels_verification ON oob_channels(verification_code);

-- Create passkey challenges table for WebAuthn authentication
CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES interaction_requests(id) ON DELETE CASCADE,
    rp_entity_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    attestation_types TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create index for passkey challenge lookups
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_request ON passkey_challenges(request_id);
