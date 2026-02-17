import { SupabaseClient } from '@supabase/supabase-js';
import { CredentialEncryption } from '../db/encryption.js';

export interface SessionManagerOptions {
  supabase: SupabaseClient;
  encryption: CredentialEncryption;
}

/**
 * Manages encrypted browser sessions (Playwright storageState) in the
 * gh_browser_sessions table. Allows workers to reuse authenticated
 * sessions across job runs, avoiding repeated logins and 2FA.
 */
export class SessionManager {
  private supabase: SupabaseClient;
  private encryption: CredentialEncryption;

  constructor(opts: SessionManagerOptions) {
    this.supabase = opts.supabase;
    this.encryption = opts.encryption;
  }

  /**
   * Save (upsert) a browser session for a given user and domain.
   * The storageState is encrypted at rest using AES-256-GCM.
   */
  async saveSession(
    userId: string,
    domain: string,
    storageState: Record<string, unknown>,
  ): Promise<void> {
    const plaintext = JSON.stringify(storageState);
    const { ciphertext, keyId } = this.encryption.encrypt(plaintext);

    const { error } = await this.supabase
      .from('gh_browser_sessions')
      .upsert(
        {
          user_id: userId,
          domain: this.normalizeDomain(domain),
          session_data: ciphertext,
          encryption_key_id: keyId,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,domain' },
      );

    if (error) {
      throw new Error(`SessionManager.saveSession failed: ${error.message}`);
    }
  }

  /**
   * Load a stored browser session for a given user and domain.
   * Returns the decrypted Playwright storageState, or null if not found.
   */
  async loadSession(
    userId: string,
    domain: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase
      .from('gh_browser_sessions')
      .select('session_data, expires_at')
      .eq('user_id', userId)
      .eq('domain', this.normalizeDomain(domain))
      .maybeSingle();

    if (error) {
      console.warn(`[SessionManager] loadSession query failed: ${error.message}`);
      return null;
    }

    if (!data) return null;

    // Check expiry
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      console.log(`[SessionManager] Session expired for ${domain}, deleting`);
      await this.deleteSession(userId, domain);
      return null;
    }

    try {
      const plaintext = this.encryption.decrypt(data.session_data);
      const state = JSON.parse(plaintext);

      // Touch last_used_at
      await this.supabase
        .from('gh_browser_sessions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('domain', this.normalizeDomain(domain));

      return state;
    } catch (err) {
      console.warn(`[SessionManager] Failed to decrypt session for ${domain}:`, err);
      return null;
    }
  }

  /**
   * Delete a stored session.
   */
  async deleteSession(userId: string, domain: string): Promise<void> {
    await this.supabase
      .from('gh_browser_sessions')
      .delete()
      .eq('user_id', userId)
      .eq('domain', this.normalizeDomain(domain));
  }

  /**
   * Normalize domain to a consistent format (lowercase, no protocol).
   */
  private normalizeDomain(domain: string): string {
    try {
      const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
      return url.hostname.toLowerCase();
    } catch {
      return domain.toLowerCase();
    }
  }
}
