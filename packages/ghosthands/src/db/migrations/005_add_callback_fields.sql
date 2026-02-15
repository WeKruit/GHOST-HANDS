-- Migration 005: Add VALET callback fields to gh_automation_jobs
-- callback_url: URL to POST results to when job completes/fails
-- valet_task_id: VALET's task ID for correlation

ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS callback_url TEXT,
  ADD COLUMN IF NOT EXISTS valet_task_id TEXT;

-- Index for VALET task correlation lookups
CREATE INDEX IF NOT EXISTS idx_gh_jobs_valet_task_id
  ON gh_automation_jobs(valet_task_id)
  WHERE valet_task_id IS NOT NULL;
