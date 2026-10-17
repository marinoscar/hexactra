-- Add status column to hosts table
ALTER TABLE hosts ADD COLUMN status TEXT NOT NULL DEFAULT 'connecting';
