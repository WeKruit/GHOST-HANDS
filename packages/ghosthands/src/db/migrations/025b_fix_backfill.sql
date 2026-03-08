-- Migration 025b: Re-run backfill with corrected logic
-- Fixes two issues from original 025 backfill:
-- 1. Uses DISTINCT ON to pick latest cost_recorded event per job
--    (avoids non-deterministic row when multiple events exist)
-- 2. COALESCEs each token field individually before summing
--    (avoids NULL + INTEGER = NULL when one field is missing)

UPDATE gh_automation_jobs j
SET
  llm_cost_cents = COALESCE(ROUND((e.metadata->>'total_cost')::NUMERIC * 100)::INTEGER, 0),
  action_count   = COALESCE((e.metadata->>'action_count')::INTEGER, 0),
  total_tokens   = COALESCE((e.metadata->>'input_tokens')::INTEGER, 0)
               + COALESCE((e.metadata->>'output_tokens')::INTEGER, 0)
FROM (
  SELECT DISTINCT ON (job_id) *
  FROM gh_job_events
  WHERE event_type = 'cost_recorded'
  ORDER BY job_id, created_at DESC
) e
WHERE e.job_id = j.id
  AND j.status IN ('completed', 'failed', 'awaiting_review');

UPDATE gh_automation_jobs
SET
  total_tokens = COALESCE((result_data->'cost'->>'input_tokens')::INTEGER, 0)
             + COALESCE((result_data->'cost'->>'output_tokens')::INTEGER, 0)
WHERE total_tokens = 0
  AND result_data->'cost' IS NOT NULL
  AND status IN ('completed', 'failed', 'awaiting_review');
