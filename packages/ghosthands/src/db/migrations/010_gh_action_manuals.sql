-- ============================================================================
-- Migration 010: Add platform, source, and last_used columns to gh_action_manuals
-- ============================================================================
-- The base table was created in supabase-migration.sql (root).
-- This migration adds columns needed by ManualStore and the cookbook engine.
-- ============================================================================

-- Add platform column (e.g. 'workday', 'greenhouse', 'lever')
ALTER TABLE gh_action_manuals
  ADD COLUMN IF NOT EXISTS platform TEXT;

-- Add source column ('recorded', 'actionbook', 'template')
ALTER TABLE gh_action_manuals
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'recorded';

-- Add last_used timestamp for tracking cookbook freshness
ALTER TABLE gh_action_manuals
  ADD COLUMN IF NOT EXISTS last_used TIMESTAMPTZ;

-- Index for platform-based lookups
CREATE INDEX IF NOT EXISTS idx_gh_manuals_platform
  ON gh_action_manuals(platform);

-- Compound index: url + task + platform for the full lookup query
CREATE INDEX IF NOT EXISTS idx_gh_manuals_lookup
  ON gh_action_manuals(url_pattern, task_pattern, platform);
