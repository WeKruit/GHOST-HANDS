-- ============================================================================
-- GhostHands - Atomic Usage Increment Function
-- ============================================================================
--
-- Fixes a race condition in recordJobCost(): the old code would SELECT the
-- current totals, add to them in JS, then UPDATE back. If two workers
-- finished at the same time, one update could be lost (classic lost update).
--
-- This RPC function performs an atomic increment using SQL arithmetic
-- (SET cost = cost + $amount), eliminating the race window entirely.
--
-- The function also handles the "no row yet" case via INSERT ... ON CONFLICT
-- (upsert), so the caller does not need a separate existence check.
--
-- Run in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- ============================================================================

CREATE OR REPLACE FUNCTION gh_increment_user_usage(
    p_user_id     UUID,
    p_tier        TEXT,
    p_period_start TIMESTAMPTZ,
    p_period_end   TIMESTAMPTZ,
    p_cost_usd    DOUBLE PRECISION,
    p_input_tokens BIGINT,
    p_output_tokens BIGINT,
    p_job_count   INTEGER DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO gh_user_usage (
        user_id,
        tier,
        period_start,
        period_end,
        total_cost_usd,
        total_input_tokens,
        total_output_tokens,
        job_count
    ) VALUES (
        p_user_id,
        p_tier,
        p_period_start,
        p_period_end,
        p_cost_usd,
        p_input_tokens,
        p_output_tokens,
        p_job_count
    )
    ON CONFLICT (user_id, period_start)
    DO UPDATE SET
        total_cost_usd     = gh_user_usage.total_cost_usd     + EXCLUDED.total_cost_usd,
        total_input_tokens = gh_user_usage.total_input_tokens  + EXCLUDED.total_input_tokens,
        total_output_tokens= gh_user_usage.total_output_tokens + EXCLUDED.total_output_tokens,
        job_count          = gh_user_usage.job_count           + EXCLUDED.job_count,
        updated_at         = NOW();
END;
$$;
