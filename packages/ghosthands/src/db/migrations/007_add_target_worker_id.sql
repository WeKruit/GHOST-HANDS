-- Migration 007: Add target_worker_id for job-to-worker routing
--
-- Allows job submitters (e.g. VALET) to route a job to a specific worker.
-- When target_worker_id is NULL (default), any worker can pick it up.
-- When set, ONLY the matching worker will claim the job.
--
-- Backward compatible: existing jobs have NULL and behave as before.

-- 1. Add the column
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS target_worker_id TEXT DEFAULT NULL;

-- 2. Index for efficient filtered pickup
CREATE INDEX IF NOT EXISTS idx_gh_jobs_target_worker
  ON gh_automation_jobs (target_worker_id)
  WHERE target_worker_id IS NOT NULL;

-- 3. Update the pickup function to respect target_worker_id
CREATE OR REPLACE FUNCTION gh_pickup_next_job(p_worker_id TEXT)
RETURNS SETOF gh_automation_jobs AS $$
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      AND (target_worker_id IS NULL OR target_worker_id = p_worker_id)
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE gh_automation_jobs
  SET status = 'queued',
      worker_id = p_worker_id,
      last_heartbeat = NOW(),
      updated_at = NOW()
  FROM next_job
  WHERE gh_automation_jobs.id = next_job.id
  RETURNING gh_automation_jobs.*;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION gh_pickup_next_job(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gh_pickup_next_job(TEXT) TO postgres;
