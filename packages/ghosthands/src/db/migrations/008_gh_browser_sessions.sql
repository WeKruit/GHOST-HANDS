-- ============================================================================
-- GhostHands - Browser Session Persistence
-- ============================================================================
--
-- Stores encrypted browser session state (cookies, localStorage) per user
-- and domain, enabling session reuse across job runs to avoid repeated
-- logins and CAPTCHAs.
--
-- Session data is encrypted with AES-256-GCM via CredentialEncryption.
-- The encryption_key_id tracks which key version was used.
--
-- Run in: Supabase SQL Editor (requires DIRECT connection, not pooler)
-- ============================================================================

-- ============================================================================
-- Create gh_browser_sessions table
-- ============================================================================

CREATE TABLE IF NOT EXISTS gh_browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User reference
    user_id UUID NOT NULL,

    -- Domain this session applies to (extracted from target URL)
    domain TEXT NOT NULL,

    -- Encrypted JSON from Playwright's context.storageState()
    session_data TEXT NOT NULL,

    -- Tracks which encryption key version was used
    encryption_key_id TEXT NOT NULL,

    -- Optional expiry (e.g. for short-lived session cookies)
    expires_at TIMESTAMPTZ,

    -- Timestamps
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One session per user per domain
    CONSTRAINT uq_gh_browser_sessions_user_domain UNIQUE (user_id, domain)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Primary lookup: user + domain
CREATE INDEX IF NOT EXISTS idx_gh_browser_sessions_lookup
    ON gh_browser_sessions (user_id, domain);

-- Expiry cleanup: find expired sessions efficiently
CREATE INDEX IF NOT EXISTS idx_gh_browser_sessions_expiry
    ON gh_browser_sessions (expires_at)
    WHERE expires_at IS NOT NULL;

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE gh_browser_sessions ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (worker process uses this)
CREATE POLICY "Service role full access on gh_browser_sessions"
    ON gh_browser_sessions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can only read their own sessions
CREATE POLICY "Users can read own sessions"
    ON gh_browser_sessions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Authenticated users can delete their own sessions (e.g. "log out everywhere")
CREATE POLICY "Users can delete own sessions"
    ON gh_browser_sessions
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- ============================================================================
-- Auto-update updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION gh_update_browser_sessions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gh_browser_sessions_updated_at
    BEFORE UPDATE ON gh_browser_sessions
    FOR EACH ROW
    EXECUTE FUNCTION gh_update_browser_sessions_timestamp();
