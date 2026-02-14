-- ============================================================================
-- GhostHands VALET Integration - Database Migration
-- ============================================================================
--
-- IMPORTANT: Run this AFTER the base migration (supabase-migration.sql)
-- which creates the gh_action_manuals table.
--
-- This migration adds:
--   1. gh_automation_jobs   - Job queue for VALET -> GhostHands commands
--   2. gh_job_events        - Audit log for every job state transition
--   3. gh_user_credentials  - Encrypted per-user platform credentials
--   4. Triggers             - NOTIFY, updated_at, status change logging
--   5. Supabase Realtime    - Live updates for gh_automation_jobs
--
-- Run in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- Database: The same database used by VALET
-- ============================================================================

-- ============================================================================
-- 1. Automation Jobs Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_automation_jobs (
    -- Identity
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) UNIQUE,

    -- Ownership
    user_id         UUID NOT NULL,
    created_by      VARCHAR(100) NOT NULL DEFAULT 'valet',

    -- Job specification
    job_type        VARCHAR(50) NOT NULL,
    target_url      TEXT NOT NULL,
    task_description TEXT NOT NULL,
    input_data      JSONB NOT NULL DEFAULT '{}',

    -- Scheduling
    priority        INTEGER NOT NULL DEFAULT 5,
    scheduled_at    TIMESTAMPTZ,
    max_retries     INTEGER NOT NULL DEFAULT 3,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,

    -- Status tracking
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    status_message  TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    last_heartbeat  TIMESTAMPTZ,

    -- Execution context
    worker_id       VARCHAR(100),
    manual_id       UUID REFERENCES gh_action_manuals(id),
    engine_type     VARCHAR(20),

    -- Results
    result_data     JSONB,
    result_summary  TEXT,
    error_code      VARCHAR(50),
    error_details   JSONB,

    -- Artifacts
    screenshot_urls JSONB DEFAULT '[]',
    artifact_urls   JSONB DEFAULT '[]',

    -- Metadata
    metadata        JSONB DEFAULT '{}',
    tags            JSONB DEFAULT '[]',

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Validate status values
ALTER TABLE gh_automation_jobs
    ADD CONSTRAINT gh_jobs_status_check
    CHECK (status IN ('pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'expired'));

-- Validate priority range
ALTER TABLE gh_automation_jobs
    ADD CONSTRAINT gh_jobs_priority_check
    CHECK (priority BETWEEN 1 AND 10);

-- Validate job_type
ALTER TABLE gh_automation_jobs
    ADD CONSTRAINT gh_jobs_type_check
    CHECK (job_type IN ('apply', 'scrape', 'fill_form', 'custom'));

-- ============================================================================
-- 2. Automation Jobs Indexes
-- ============================================================================

-- Primary query: find next job to process
CREATE INDEX IF NOT EXISTS idx_gh_jobs_status_priority
    ON gh_automation_jobs(status, priority ASC, created_at ASC)
    WHERE status IN ('pending', 'queued');

-- User's job history
CREATE INDEX IF NOT EXISTS idx_gh_jobs_user_status
    ON gh_automation_jobs(user_id, status, created_at DESC);

-- Heartbeat monitoring (find stuck running jobs)
CREATE INDEX IF NOT EXISTS idx_gh_jobs_heartbeat
    ON gh_automation_jobs(last_heartbeat)
    WHERE status = 'running';

-- Scheduled jobs
CREATE INDEX IF NOT EXISTS idx_gh_jobs_scheduled
    ON gh_automation_jobs(scheduled_at)
    WHERE status = 'pending' AND scheduled_at IS NOT NULL;

-- Manual lookup (which manual was used)
CREATE INDEX IF NOT EXISTS idx_gh_jobs_manual
    ON gh_automation_jobs(manual_id)
    WHERE manual_id IS NOT NULL;

-- ============================================================================
-- 3. Job Events Log
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_job_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
    event_type  VARCHAR(50) NOT NULL,
    from_status VARCHAR(20),
    to_status   VARCHAR(20),
    message     TEXT,
    metadata    JSONB DEFAULT '{}',
    actor       VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gh_job_events_job
    ON gh_job_events(job_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_gh_job_events_type
    ON gh_job_events(job_id, event_type);

-- ============================================================================
-- 4. User Credentials (Encrypted)
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_user_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL,
    platform          VARCHAR(50) NOT NULL,
    credential_type   VARCHAR(30) NOT NULL,
    encrypted_data    BYTEA NOT NULL,
    encryption_key_id VARCHAR(100) NOT NULL,
    expires_at        TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ,
    last_verified_at  TIMESTAMPTZ,
    is_valid          BOOLEAN DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, platform, credential_type)
);

CREATE INDEX IF NOT EXISTS idx_gh_creds_user_platform
    ON gh_user_credentials(user_id, platform)
    WHERE is_valid = true;

-- ============================================================================
-- 5. Row Level Security
-- ============================================================================

-- Jobs: users see own jobs, service role sees all
ALTER TABLE gh_automation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own jobs"
    ON gh_automation_jobs FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "Users can create own jobs"
    ON gh_automation_jobs FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Service role full access to jobs"
    ON gh_automation_jobs FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- Events: users see events for own jobs
ALTER TABLE gh_job_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view events for own jobs"
    ON gh_job_events FOR SELECT
    TO authenticated
    USING (job_id IN (
        SELECT id FROM gh_automation_jobs WHERE user_id = auth.uid()
    ));

CREATE POLICY "Service role full access to events"
    ON gh_job_events FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- Credentials: service role only (never exposed to client)
ALTER TABLE gh_user_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only for credentials"
    ON gh_user_credentials FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- ============================================================================
-- 6. Triggers
-- ============================================================================

-- Reuse the update_updated_at_column() function from base migration
-- (CREATE OR REPLACE is safe if it already exists)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- updated_at for jobs
DROP TRIGGER IF EXISTS update_gh_automation_jobs_updated_at ON gh_automation_jobs;
CREATE TRIGGER update_gh_automation_jobs_updated_at
    BEFORE UPDATE ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- updated_at for credentials
DROP TRIGGER IF EXISTS update_gh_user_credentials_updated_at ON gh_user_credentials;
CREATE TRIGGER update_gh_user_credentials_updated_at
    BEFORE UPDATE ON gh_user_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- NOTIFY on new job insert (for real-time worker pickup)
CREATE OR REPLACE FUNCTION gh_notify_new_job()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('gh_job_created', json_build_object(
        'id', NEW.id,
        'job_type', NEW.job_type,
        'priority', NEW.priority,
        'user_id', NEW.user_id
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gh_automation_jobs_notify ON gh_automation_jobs;
CREATE TRIGGER gh_automation_jobs_notify
    AFTER INSERT ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION gh_notify_new_job();

-- Automatic status change logging
CREATE OR REPLACE FUNCTION gh_log_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO gh_job_events (job_id, event_type, from_status, to_status, message, actor)
        VALUES (
            NEW.id,
            'status_change',
            OLD.status,
            NEW.status,
            'Status changed from ' || OLD.status || ' to ' || NEW.status,
            COALESCE(NEW.worker_id, 'system')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gh_automation_jobs_log_status ON gh_automation_jobs;
CREATE TRIGGER gh_automation_jobs_log_status
    AFTER UPDATE OF status ON gh_automation_jobs
    FOR EACH ROW
    EXECUTE FUNCTION gh_log_status_change();

-- ============================================================================
-- 7. Supabase Realtime
-- ============================================================================

-- Enable realtime updates so VALET frontend can subscribe to job changes
ALTER PUBLICATION supabase_realtime ADD TABLE gh_automation_jobs;

-- ============================================================================
-- 8. Verification
-- ============================================================================

-- Verify all tables
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'gh_%'
ORDER BY tablename;

-- Verify indexes
SELECT indexname FROM pg_indexes
WHERE tablename LIKE 'gh_%'
ORDER BY indexname;

-- Verify triggers
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_name LIKE 'gh_%' OR trigger_name LIKE 'update_gh_%'
ORDER BY trigger_name;

-- Check for conflicts with VALET tables
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT LIKE 'gh_%'
  AND tablename IN ('automation_jobs', 'job_events', 'user_credentials');
-- Should return 0 rows

-- ============================================================================
-- Success
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE 'VALET-GhostHands integration migration complete!';
    RAISE NOTICE '';
    RAISE NOTICE '  Tables created:';
    RAISE NOTICE '    - gh_automation_jobs  (job queue)';
    RAISE NOTICE '    - gh_job_events       (audit log)';
    RAISE NOTICE '    - gh_user_credentials (encrypted credentials)';
    RAISE NOTICE '';
    RAISE NOTICE '  Features enabled:';
    RAISE NOTICE '    - Row Level Security on all tables';
    RAISE NOTICE '    - Postgres NOTIFY for real-time job pickup';
    RAISE NOTICE '    - Automatic status change logging';
    RAISE NOTICE '    - Supabase Realtime on gh_automation_jobs';
    RAISE NOTICE '    - updated_at auto-refresh triggers';
    RAISE NOTICE '';
    RAISE NOTICE '  API endpoints to implement:';
    RAISE NOTICE '    POST   /api/v1/gh/jobs          - Create job';
    RAISE NOTICE '    GET    /api/v1/gh/jobs/:id       - Get job';
    RAISE NOTICE '    GET    /api/v1/gh/jobs/:id/status - Get status';
    RAISE NOTICE '    POST   /api/v1/gh/jobs/:id/cancel - Cancel job';
    RAISE NOTICE '    GET    /api/v1/gh/jobs           - List jobs';
    RAISE NOTICE '    GET    /api/v1/gh/jobs/:id/events - Get events';
    RAISE NOTICE '    POST   /api/v1/gh/jobs/:id/retry  - Retry job';
    RAISE NOTICE '    POST   /api/v1/gh/jobs/batch      - Bulk create';
END $$;
