-- ─── GhostHands Job Pickup Function ───────────────────────────────────────
-- Creates atomic job pickup function using FOR UPDATE SKIP LOCKED
-- Multiple workers can safely call this concurrently without contention.

CREATE OR REPLACE FUNCTION gh_pickup_next_job(p_worker_id TEXT)
RETURNS SETOF gh_automation_jobs AS $$
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status = 'pending'
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
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

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION gh_pickup_next_job(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gh_pickup_next_job(TEXT) TO postgres;
