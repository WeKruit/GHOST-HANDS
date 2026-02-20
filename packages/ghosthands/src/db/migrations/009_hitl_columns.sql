-- Migration 009: Add HITL (Human-in-the-Loop) columns to gh_automation_jobs
-- interaction_type: type of blocker that triggered the pause
-- interaction_data: details about the blocker (screenshot_url, page_url, etc.)
-- paused_at: when the job was paused for human intervention

ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS interaction_type TEXT,
  ADD COLUMN IF NOT EXISTS interaction_data JSONB,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Partial index for finding paused jobs efficiently
CREATE INDEX IF NOT EXISTS idx_gh_jobs_paused
  ON gh_automation_jobs(status)
  WHERE status = 'paused';
