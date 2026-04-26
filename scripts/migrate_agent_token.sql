-- Migration: Add agent_token column to users table
-- This token is injected into OpenClaw pods so they can call back to Wrexer's /api/agent/deploy

ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_token UUID DEFAULT gen_random_uuid();

-- Backfill any existing users that have a NULL token
UPDATE users SET agent_token = gen_random_uuid() WHERE agent_token IS NULL;
