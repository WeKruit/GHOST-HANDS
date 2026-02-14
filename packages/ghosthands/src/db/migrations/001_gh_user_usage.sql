-- ============================================================================
-- GhostHands - User Usage Tracking Table
-- ============================================================================
--
-- Tracks per-user monthly LLM cost and token usage for budget enforcement.
-- Uses the same "gh_" prefix convention as other GhostHands tables.
--
-- Run in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- ============================================================================

-- ============================================================================
-- Create gh_user_usage table
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_user_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User reference
    user_id UUID NOT NULL,

    -- Subscription tier at time of recording
    tier TEXT NOT NULL DEFAULT 'free'
        CHECK (tier IN ('free', 'starter', 'pro', 'premium', 'enterprise')),

    -- Billing period boundaries (calendar month in UTC)
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,

    -- Aggregated cost (USD)
    total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,

    -- Aggregated token counts
    total_input_tokens BIGINT NOT NULL DEFAULT 0,
    total_output_tokens BIGINT NOT NULL DEFAULT 0,

    -- Number of jobs executed in this period
    job_count INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One row per user per billing period
    CONSTRAINT uq_gh_user_usage_user_period UNIQUE (user_id, period_start)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Primary lookup: user + current period
CREATE INDEX IF NOT EXISTS idx_gh_user_usage_user_period
    ON gh_user_usage (user_id, period_start DESC);

-- Admin reporting: all usage for a period
CREATE INDEX IF NOT EXISTS idx_gh_user_usage_period
    ON gh_user_usage (period_start);

-- Tier-based analytics
CREATE INDEX IF NOT EXISTS idx_gh_user_usage_tier
    ON gh_user_usage (tier, period_start);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE gh_user_usage ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (worker process uses this)
CREATE POLICY "Service role full access on gh_user_usage"
    ON gh_user_usage
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can only read their own usage
CREATE POLICY "Users can read own usage"
    ON gh_user_usage
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================================
-- Auto-update updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION gh_update_user_usage_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gh_user_usage_updated_at
    BEFORE UPDATE ON gh_user_usage
    FOR EACH ROW
    EXECUTE FUNCTION gh_update_user_usage_timestamp();
