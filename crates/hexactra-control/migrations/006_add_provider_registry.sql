-- Add provider_registry table for pluggable providers
-- Migration: 006_add_provider_registry.sql

-- Create provider_registry table to store registered provider configurations
CREATE TABLE IF NOT EXISTS provider_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL, -- human_interaction, credential, notification
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, -- 0 = disabled, 1 = enabled
    health_status TEXT NOT NULL DEFAULT 'not_configured',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create index for provider type lookups
CREATE INDEX IF NOT EXISTS idx_provider_registry_type ON provider_registry(provider_type);

-- Create index for enabled providers
CREATE INDEX IF NOT EXISTS idx_provider_registry_enabled ON provider_registry(enabled);

-- Create triggers for updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_provider_registry_updated_at
AFTER UPDATE ON provider_registry
BEGIN
    UPDATE provider_registry SET updated_at = datetime('now') WHERE id = NEW.id;
END;
