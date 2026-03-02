-- Migration 020: RLS and retention for Mastra-managed tables
-- Ensures service-role-only access and sets up 7-day retention cleanup.

-- UP

-- 1. Callback dedupe retention: delete records older than 7 days
--    Run via pg_cron or application-level scheduled task.
--    Example pg_cron setup (run daily at 3am UTC):
--
--    SELECT cron.schedule(
--      'gh_callback_dedupe_cleanup',
--      '0 3 * * *',
--      $$DELETE FROM gh_callback_dedupe WHERE created_at < NOW() - INTERVAL '7 days'$$
--    );

-- 2. RLS for Mastra-managed tables (service-role-only access).
--    Mastra tables are auto-created by @mastra/pg on first use.
--    These statements are idempotent — safe to re-run if tables already exist.
--    NOTE: Run AFTER first Mastra workflow execution so tables exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mastra_workflow_snapshot') THEN
    ALTER TABLE mastra_workflow_snapshot ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'mastra_snapshot_service_all') THEN
      CREATE POLICY mastra_snapshot_service_all
        ON mastra_workflow_snapshot
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- 3. Add metadata column index for mastra_run_id lookups
--    CONCURRENTLY avoids blocking writes to gh_automation_jobs during index build.
--    NOTE: CONCURRENTLY cannot run inside a transaction block — run this
--    migration outside of a multi-statement transaction if needed.
CREATE INDEX IF NOT EXISTS idx_gh_jobs_mastra_run_id
  ON gh_automation_jobs ((metadata->>'mastra_run_id'))
  WHERE metadata->>'mastra_run_id' IS NOT NULL;

-- 4. Add index for resume discriminator queries
CREATE INDEX IF NOT EXISTS idx_gh_jobs_mastra_resume
  ON gh_automation_jobs (execution_mode, status)
  WHERE execution_mode = 'mastra'
    AND status IN ('pending', 'queued');

-- DOWN (rollback)
-- DROP INDEX IF EXISTS idx_gh_jobs_mastra_resume;
-- DROP INDEX IF EXISTS idx_gh_jobs_mastra_run_id;
-- DROP POLICY IF EXISTS mastra_snapshot_service_all ON mastra_workflow_snapshot;
-- ALTER TABLE mastra_workflow_snapshot DISABLE ROW LEVEL SECURITY;
