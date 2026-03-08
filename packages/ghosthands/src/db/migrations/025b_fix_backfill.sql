-- Migration 025b: Re-run backfill with corrected logic and source priority
-- Fixes from PR review feedback:
-- 1. Prioritizes result_data.cost (atomic with status update, always final)
--    over gh_job_events (best-effort, can be stale on retries)
-- 2. Uses DISTINCT ON to pick latest cost_recorded event per job
-- 3. COALESCEs each token field individually before summing

-- Primary: result_data.cost is the authoritative source (set atomically
-- in the same .update() call as status, always reflects final attempt)
UPDATE gh_automation_jobs
SET
  llm_cost_cents = COALESCE(ROUND((result_data->'cost'->>'total_cost_usd')::NUMERIC * 100)::INTEGER, 0),
  action_count   = COALESCE((result_data->'cost'->>'action_count')::INTEGER, 0),
  total_tokens   = COALESCE((result_data->'cost'->>'input_tokens')::INTEGER, 0)
               + COALESCE((result_data->'cost'->>'output_tokens')::INTEGER, 0)
WHERE result_data->'cost' IS NOT NULL
  AND status IN ('completed', 'failed', 'awaiting_review');

-- Fallback: gh_job_events for jobs without result_data.cost
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
  AND j.llm_cost_cents = 0
  AND j.result_data->'cost' IS NULL
  AND j.status IN ('completed', 'failed', 'awaiting_review');
