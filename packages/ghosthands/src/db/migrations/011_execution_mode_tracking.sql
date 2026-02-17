-- Migration 011: Execution mode tracking
-- Sprint 3: Add columns to gh_automation_jobs for mode orchestration
--
-- execution_mode: User-requested mode ('auto', 'ai_only', 'cookbook_only')
-- browser_mode: Browser execution context ('server', 'operator')
-- final_mode: Actual mode used after engine decision ('cookbook', 'magnitude', 'hybrid')

-- UP
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'auto'
    CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only')),
  ADD COLUMN IF NOT EXISTS browser_mode TEXT DEFAULT 'server'
    CHECK (browser_mode IN ('server', 'operator')),
  ADD COLUMN IF NOT EXISTS final_mode TEXT
    CHECK (final_mode IN ('cookbook', 'magnitude', 'hybrid'));

CREATE INDEX IF NOT EXISTS idx_gh_jobs_execution_mode
  ON gh_automation_jobs(execution_mode);

-- DOWN (rollback)
-- DROP INDEX IF EXISTS idx_gh_jobs_execution_mode;
-- ALTER TABLE gh_automation_jobs
--   DROP COLUMN IF EXISTS execution_mode,
--   DROP COLUMN IF EXISTS browser_mode,
--   DROP COLUMN IF EXISTS final_mode;
