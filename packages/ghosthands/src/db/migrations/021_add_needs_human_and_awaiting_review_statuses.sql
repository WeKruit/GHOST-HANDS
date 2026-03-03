-- Migration 021: extend gh_automation_jobs status values
--
-- Adds:
--   - needs_human
--   - awaiting_review
--
-- Backward compatibility:
--   - rewrites legacy awaiting_user_review -> awaiting_review before applying
--     the new status check constraint.

ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_jobs_status_check;

ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_status_check;

-- Normalize legacy status values first so the new CHECK can be applied cleanly.
UPDATE gh_automation_jobs
SET status = 'awaiting_review'
WHERE status = 'awaiting_user_review';

-- Fail fast with clear output if any other unknown status remains.
DO $$
DECLARE
  invalid_statuses TEXT;
BEGIN
  SELECT string_agg(DISTINCT status, ', ' ORDER BY status)
  INTO invalid_statuses
  FROM gh_automation_jobs
  WHERE status NOT IN (
    'pending',
    'queued',
    'running',
    'paused',
    'needs_human',
    'awaiting_review',
    'completed',
    'failed',
    'cancelled',
    'expired'
  );

  IF invalid_statuses IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot apply status constraint; unexpected statuses: %', invalid_statuses;
  END IF;
END $$;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_jobs_status_check
  CHECK (status IN (
    'pending',
    'queued',
    'running',
    'paused',
    'needs_human',
    'awaiting_review',
    'completed',
    'failed',
    'cancelled',
    'expired'
  ));

-- Rollback:
-- ALTER TABLE gh_automation_jobs DROP CONSTRAINT IF EXISTS gh_jobs_status_check;
-- ALTER TABLE gh_automation_jobs ADD CONSTRAINT gh_jobs_status_check
--   CHECK (status IN (
--     'pending',
--     'queued',
--     'running',
--     'paused',
--     'completed',
--     'failed',
--     'cancelled',
--     'expired'
--   ));
