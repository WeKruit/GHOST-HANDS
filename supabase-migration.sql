-- ============================================================================
-- GhostHands ManualConnector - Supabase Table Schema
-- ============================================================================
--
-- IMPORTANT: This migration is designed to run in the SAME Supabase database
-- as VALET without conflicts. All GhostHands tables use the "gh_" prefix.
--
-- Naming Convention:
--   - VALET tables: No prefix (users, tasks, resumes, etc.)
--   - GhostHands tables: "gh_" prefix (gh_action_manuals, etc.)
--
-- Run this in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- Database: The same database used by VALET
-- ============================================================================

-- Check current database (should match VALET database)
SELECT current_database() AS database_name;

-- ============================================================================
-- Create GhostHands action_manuals table (with gh_ prefix)
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_action_manuals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_pattern TEXT NOT NULL,
    task_pattern TEXT NOT NULL,
    steps JSONB NOT NULL,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    health_score REAL DEFAULT 100.0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_verified TIMESTAMPTZ,

    -- Metadata for tracking
    created_by UUID,  -- Optional: link to VALET users table
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes for performance
-- ============================================================================

-- Index for URL pattern lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_gh_manuals_url_pattern
    ON gh_action_manuals(url_pattern);

-- Index for task pattern searches
CREATE INDEX IF NOT EXISTS idx_gh_manuals_task_pattern
    ON gh_action_manuals(task_pattern);

-- Index for health score ordering (used in manual selection)
CREATE INDEX IF NOT EXISTS idx_gh_manuals_health_score
    ON gh_action_manuals(health_score DESC);

-- Compound index for the most common query pattern
CREATE INDEX IF NOT EXISTS idx_gh_manuals_url_task
    ON gh_action_manuals(url_pattern, task_pattern);

-- Index for created_at (useful for analytics)
CREATE INDEX IF NOT EXISTS idx_gh_manuals_created_at
    ON gh_action_manuals(created_at DESC);

-- ============================================================================
-- Enable Row Level Security (RLS) - Optional but recommended
-- ============================================================================

-- Enable RLS on the table
ALTER TABLE gh_action_manuals ENABLE ROW LEVEL SECURITY;

-- Policy: Allow all operations for authenticated users
-- (Adjust based on your security requirements)
CREATE POLICY "Allow all for authenticated users"
    ON gh_action_manuals
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Policy: Allow read-only for service role (for ManualConnector)
CREATE POLICY "Allow all for service role"
    ON gh_action_manuals
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- Verification Queries
-- ============================================================================

-- Verify table creation
SELECT
    tablename,
    schemaname
FROM pg_tables
WHERE tablename = 'gh_action_manuals';

-- Verify table structure
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'gh_action_manuals'
ORDER BY ordinal_position;

-- Verify indexes
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'gh_action_manuals'
ORDER BY indexname;

-- Check for conflicts with VALET tables (should return 0 rows)
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'gh_%'
  AND tablename != 'gh_action_manuals';

-- ============================================================================
-- Optional: Add triggers for updated_at
-- ============================================================================

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS update_gh_action_manuals_updated_at ON gh_action_manuals;
CREATE TRIGGER update_gh_action_manuals_updated_at
    BEFORE UPDATE ON gh_action_manuals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Success Message
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ GhostHands migration complete!';
    RAISE NOTICE '   Table created: gh_action_manuals';
    RAISE NOTICE '   Indexes created: 5';
    RAISE NOTICE '   RLS enabled: Yes';
    RAISE NOTICE '   Conflicts with VALET: None';
    RAISE NOTICE '';
    RAISE NOTICE '   Next steps:';
    RAISE NOTICE '   1. Verify table in Supabase Table Editor';
    RAISE NOTICE '   2. Test ManualConnector with: bun test test/connectors/manual.test.ts';
    RAISE NOTICE '   3. Run integration test (Task #7)';
END $$;
