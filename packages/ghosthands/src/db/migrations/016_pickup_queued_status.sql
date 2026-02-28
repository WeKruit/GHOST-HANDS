-- Migration 016: Fix gh_pickup_next_job to match both 'pending' and 'queued' statuses
--
-- Root cause: VALET's TaskQueueService (queue dispatch mode) creates jobs with
-- status='queued' via ghJobRepo.insertPendingJob(). The gh_pickup_next_job function
-- only matched status='pending', making these jobs invisible to legacy-mode workers.
--
-- This updates the function to match BOTH statuses so the worker's legacy poller
-- finds jobs regardless of how VALET dispatched them.
--
-- The JobPoller code also inlines this same SQL as a belt-and-suspenders fix,
-- so the worker works immediately even before this migration is applied.

CREATE OR REPLACE FUNCTION gh_pickup_next_job(p_worker_id TEXT)
RETURNS SETOF gh_automation_jobs AS $$
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status IN ('pending', 'queued')
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
