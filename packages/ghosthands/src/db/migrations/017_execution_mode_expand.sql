-- Migration 017: Expand execution_mode CHECK constraint
-- Adds 'hybrid', 'smart_apply', 'agent_apply' to allowed values.
-- Also expands final_mode to include 'smart_apply' and 'agent_apply'.

-- UP
ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_execution_mode_check
    CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply'));

ALTER TABLE gh_automation_jobs
  DROP CONSTRAINT IF EXISTS gh_automation_jobs_final_mode_check;

ALTER TABLE gh_automation_jobs
  ADD CONSTRAINT gh_automation_jobs_final_mode_check
    CHECK (final_mode IN ('cookbook', 'magnitude', 'hybrid', 'smart_apply', 'agent_apply'));

-- DOWN (rollback)
-- ALTER TABLE gh_automation_jobs
--   DROP CONSTRAINT IF EXISTS gh_automation_jobs_execution_mode_check;
-- ALTER TABLE gh_automation_jobs
--   ADD CONSTRAINT gh_automation_jobs_execution_mode_check
--     CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only'));
-- ALTER TABLE gh_automation_jobs
--   DROP CONSTRAINT IF EXISTS gh_automation_jobs_final_mode_check;
-- ALTER TABLE gh_automation_jobs
--   ADD CONSTRAINT gh_automation_jobs_final_mode_check
--     CHECK (final_mode IN ('cookbook', 'magnitude', 'hybrid'));
