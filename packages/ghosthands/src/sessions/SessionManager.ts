/**
 * Session Persistence Manager
 *
 * Manages browser session state (cookies, localStorage) per user and domain,
 * enabling session reuse across job runs to avoid repeated logins and CAPTCHAs.
 *
 * Session data is encrypted at rest using AES-256-GCM via CredentialEncryption.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { CredentialEncryption } from '../db/encryption.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionManagerConfig {
  supabase: SupabaseClient;
  encryption: CredentialEncryption;
}

export interface StoredSession {
  /** Parsed Playwright storageState JSON */
  storageState: Record<string, unknown>;
  /** Domain this session applies to */
  domain: string;
  /** When this session was last used */
  lastUsedAt: string;
}

const TABLE = 'gh_browser_sessions';

// ── Implementation ─────────────────────────────────────────────────────────

export class SessionManager {
  private supabase: SupabaseClient;
  private encryption: CredentialEncryption;

  constructor(config: SessionManagerConfig) {
    this.supabase = config.supabase;
    this.encryption = config.encryption;
  }

  /**
   * Load a stored browser session for a user + target URL.
   *
   * Returns the decrypted Playwright storageState object, or null if no
   * session exists or the session has expired.
   */
  async loadSession(
    userId: string,
    targetUrl: string,
  ): Promise<Record<string, unknown> | null> {
    const domain = SessionManager.extractDomain(targetUrl);

    const { data, error } = await this.supabase
      .from(TABLE)
      .select('session_data, expires_at')
      .eq('user_id', userId)
      .eq('domain', domain)
      .single();

    if (error || !data) {
      return null;
    }

    // Check if session has expired
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      // Clean up the expired session
      await this.supabase
        .from(TABLE)
        .delete()
        .eq('user_id', userId)
        .eq('domain', domain);
      return null;
    }

    // Decrypt session data
    let plaintext: string;
    try {
      plaintext = this.encryption.decrypt(data.session_data);
    } catch {
      // Decryption failed -- key rotated or data corrupted. Delete stale row.
      await this.supabase
        .from(TABLE)
        .delete()
        .eq('user_id', userId)
        .eq('domain', domain);
      return null;
    }

    // Update last_used_at timestamp
    await this.supabase
      .from(TABLE)
      .update({ last_used_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('domain', domain);

    return JSON.parse(plaintext);
  }

  /**
   * Save (upsert) browser session state for a user + target URL.
   *
   * The storageState JSON is encrypted before storage.
   */
  async saveSession(
    userId: string,
    targetUrl: string,
    storageState: Record<string, unknown>,
  ): Promise<void> {
    const domain = SessionManager.extractDomain(targetUrl);
    const plaintext = JSON.stringify(storageState);
    const { ciphertext, keyId } = this.encryption.encrypt(plaintext);

    const now = new Date().toISOString();

    await this.supabase
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          domain,
          session_data: ciphertext,
          encryption_key_id: String(keyId),
          last_used_at: now,
          updated_at: now,
        },
        { onConflict: 'user_id,domain' },
      );
  }

  /**
   * Delete session(s) for a user.
   *
   * If domain is provided, only that session is deleted.
   * Otherwise all sessions for the user are removed.
   */
  async clearSession(userId: string, domain?: string): Promise<void> {
    let query = this.supabase
      .from(TABLE)
      .delete()
      .eq('user_id', userId);

    if (domain) {
      query = query.eq('domain', domain);
    }

    await query;
  }

  /**
   * Delete all expired sessions across all users.
   * Intended to be called periodically (e.g. cron or worker loop).
   */
  async cleanExpiredSessions(): Promise<number> {
    const now = new Date().toISOString();

    const { data } = await this.supabase
      .from(TABLE)
      .delete()
      .lt('expires_at', now)
      .select('id');

    return data?.length ?? 0;
  }

  /**
   * Extract the hostname from a URL.
   * Exported as static for testability.
   */
  static extractDomain(url: string): string {
    return new URL(url).hostname;
  }
}
