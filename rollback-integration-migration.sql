-- ============================================================================
-- GhostHands VALET Integration - ROLLBACK Script
-- ============================================================================
--
-- This script reverses the supabase-migration-integration.sql migration.
-- It removes: gh_automation_jobs, gh_job_events, gh_user_credentials
-- It preserves: gh_action_manuals (from the base migration)
--
-- Run in: Supabase SQL Editor or via psql with DIRECT connection (port 5432)
-- ============================================================================

-- ============================================================================
-- 1. Remove Supabase Realtime subscription
-- ============================================================================

ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS gh_automation_jobs;

-- ============================================================================
-- 2. Drop triggers (must come before dropping functions that they reference)
-- ============================================================================

DROP TRIGGER IF EXISTS gh_automation_jobs_log_status ON gh_automation_jobs;
DROP TRIGGER IF EXISTS gh_automation_jobs_notify ON gh_automation_jobs;
DROP TRIGGER IF EXISTS update_gh_automation_jobs_updated_at ON gh_automation_jobs;
DROP TRIGGER IF EXISTS update_gh_user_credentials_updated_at ON gh_user_credentials;

-- ============================================================================
-- 3. Drop functions created by the integration migration
-- ============================================================================

DROP FUNCTION IF EXISTS gh_log_status_change();
DROP FUNCTION IF EXISTS gh_notify_new_job();
-- Note: update_updated_at_column() is shared with the base migration,
-- so we leave it in place.

-- ============================================================================
-- 4. Drop RLS policies
-- ============================================================================

-- gh_automation_jobs policies
DROP POLICY IF EXISTS "Users can view own jobs" ON gh_automation_jobs;
DROP POLICY IF EXISTS "Users can create own jobs" ON gh_automation_jobs;
DROP POLICY IF EXISTS "Service role full access to jobs" ON gh_automation_jobs;

-- gh_job_events policies
DROP POLICY IF EXISTS "Users can view events for own jobs" ON gh_job_events;
DROP POLICY IF EXISTS "Service role full access to events" ON gh_job_events;

-- gh_user_credentials policies
DROP POLICY IF EXISTS "Service role only for credentials" ON gh_user_credentials;

-- ============================================================================
-- 5. Drop tables (order matters due to foreign key constraints)
-- ============================================================================

-- gh_job_events references gh_automation_jobs, so drop it first
DROP TABLE IF EXISTS gh_job_events CASCADE;

-- gh_automation_jobs references gh_action_manuals, so drop it before manuals
DROP TABLE IF EXISTS gh_automation_jobs CASCADE;

-- gh_user_credentials has no foreign key dependencies on other gh_ tables
DROP TABLE IF EXISTS gh_user_credentials CASCADE;

-- ============================================================================
-- 6. Verification
-- ============================================================================

-- Should only show gh_action_manuals (from base migration)
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'gh_%'
ORDER BY tablename;

-- Should show only base migration triggers
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_name LIKE 'gh_%' OR trigger_name LIKE 'update_gh_%'
ORDER BY trigger_name;

-- ============================================================================
-- Done
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Integration migration rollback complete.';
    RAISE NOTICE 'Removed: gh_automation_jobs, gh_job_events, gh_user_credentials';
    RAISE NOTICE 'Preserved: gh_action_manuals (base migration)';
END $$;
