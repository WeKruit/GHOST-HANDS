-- Migration 013: Worker affinity routing
--
-- Adds worker_affinity column to gh_automation_jobs to control how strictly
-- jobs are routed to their target worker.
--
-- Affinity modes:
--   'preferred' (default) — prefer target_worker_id, fall back to any available
--   'strict'              — only the target worker can pick up the job
--   'any'                 — any worker can pick it up (ignores target_worker_id)
--
-- Backward compatible: existing jobs get 'preferred' and behave as before.

-- 1. Add worker_affinity column
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS worker_affinity TEXT DEFAULT 'preferred'
  CHECK (worker_affinity IN ('strict', 'preferred', 'any'));

-- 2. Update the pickup function to respect worker_affinity
CREATE OR REPLACE FUNCTION gh_pickup_next_job(p_worker_id TEXT)
RETURNS SETOF gh_automation_jobs AS $$
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      AND (
        -- 'any': no worker filter at all
        worker_affinity = 'any'
        -- 'preferred': target matches OR no target set
        OR (worker_affinity = 'preferred'
            AND (target_worker_id IS NULL OR target_worker_id = p_worker_id))
        -- 'strict': target must match exactly
        OR (worker_affinity = 'strict' AND target_worker_id = p_worker_id)
      )
    ORDER BY
      -- Prefer jobs targeted at this worker (affinity bonus)
      CASE WHEN target_worker_id = p_worker_id THEN 0 ELSE 1 END ASC,
      priority ASC,
      created_at ASC
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
