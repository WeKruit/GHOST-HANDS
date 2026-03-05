import type { SupabaseClient } from '@supabase/supabase-js';
import { CredentialEncryption } from '../../db/encryption.js';

export interface StoredGmailConnection {
  userId: string;
  provider: string;
  emailAddress: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
  tokenScope?: string;
  tokenType?: string;
  connectedAt?: string;
  lastUsedAt?: string;
}

interface GMailConnectionRow {
  user_id: string;
  provider: string;
  email_address: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  access_token_expires_at: string | null;
  token_scope: string | null;
  token_type: string | null;
  connected_at: string | null;
  last_used_at: string | null;
}

export class GmailConnectionStore {
  private readonly supabase: SupabaseClient;
  private readonly encryption: CredentialEncryption;

  constructor(options: {
    supabase: SupabaseClient;
    encryption: CredentialEncryption;
  }) {
    this.supabase = options.supabase;
    this.encryption = options.encryption;
  }

  async getConnection(userId: string): Promise<StoredGmailConnection | null> {
    const { data, error } = await this.supabase
      .from('gh_user_email_connections')
      .select([
        'user_id',
        'provider',
        'email_address',
        'encrypted_refresh_token',
        'encrypted_access_token',
        'access_token_expires_at',
        'token_scope',
        'token_type',
        'connected_at',
        'last_used_at',
      ].join(','))
      .eq('user_id', userId)
      .eq('provider', 'google')
      .is('revoked_at', null)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load Gmail connection: ${error.message}`);
    }
    if (!data) return null;

    const row = data as unknown as GMailConnectionRow;
    const refreshToken = this.encryption.decrypt(row.encrypted_refresh_token);
    const accessToken = row.encrypted_access_token
      ? this.encryption.decrypt(row.encrypted_access_token)
      : undefined;

    return {
      userId: row.user_id,
      provider: row.provider,
      emailAddress: row.email_address,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: row.access_token_expires_at || undefined,
      tokenScope: row.token_scope || undefined,
      tokenType: row.token_type || undefined,
      connectedAt: row.connected_at || undefined,
      lastUsedAt: row.last_used_at || undefined,
    };
  }

  async upsertConnection(input: {
    userId: string;
    emailAddress: string;
    refreshToken: string;
    accessToken?: string;
    accessTokenExpiresAt?: string;
    tokenScope?: string;
    tokenType?: string;
  }): Promise<void> {
    const encryptedRefresh = this.encryption.encrypt(input.refreshToken);
    const encryptedAccess = input.accessToken
      ? this.encryption.encrypt(input.accessToken)
      : null;

    const payload = {
      user_id: input.userId,
      provider: 'google',
      email_address: input.emailAddress,
      encrypted_refresh_token: encryptedRefresh.ciphertext,
      encrypted_access_token: encryptedAccess?.ciphertext ?? null,
      access_token_expires_at: input.accessTokenExpiresAt ?? null,
      token_scope: input.tokenScope ?? null,
      token_type: input.tokenType ?? null,
      encryption_key_id: String(this.encryption.currentKeyId),
      connected_at: new Date().toISOString(),
      revoked_at: null,
    };

    const { error } = await this.supabase
      .from('gh_user_email_connections')
      .upsert(payload, { onConflict: 'user_id,provider' });

    if (error) {
      throw new Error(`Failed to save Gmail connection: ${error.message}`);
    }
  }

  async updateAccessToken(input: {
    userId: string;
    accessToken: string;
    accessTokenExpiresAt?: string;
    tokenScope?: string;
    tokenType?: string;
  }): Promise<void> {
    const encryptedAccess = this.encryption.encrypt(input.accessToken);
    const { error } = await this.supabase
      .from('gh_user_email_connections')
      .update({
        encrypted_access_token: encryptedAccess.ciphertext,
        access_token_expires_at: input.accessTokenExpiresAt ?? null,
        token_scope: input.tokenScope ?? null,
        token_type: input.tokenType ?? null,
        last_used_at: new Date().toISOString(),
      })
      .eq('user_id', input.userId)
      .eq('provider', 'google')
      .is('revoked_at', null);

    if (error) {
      throw new Error(`Failed to update Gmail access token: ${error.message}`);
    }
  }

  async markUsed(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('gh_user_email_connections')
      .update({ last_used_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', 'google')
      .is('revoked_at', null);

    if (error) {
      throw new Error(`Failed to mark Gmail connection as used: ${error.message}`);
    }
  }

  async revokeConnection(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('gh_user_email_connections')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', 'google')
      .is('revoked_at', null);

    if (error) {
      throw new Error(`Failed to revoke Gmail connection: ${error.message}`);
    }
  }
}

export function createEmailTokenEncryptionFromEnv(): CredentialEncryption {
  const primaryKeyHex = process.env.GH_EMAIL_TOKEN_ENCRYPTION_KEY || process.env.GH_CREDENTIAL_KEY;
  const keyIdRaw = process.env.GH_EMAIL_TOKEN_ENCRYPTION_KEY_ID || process.env.GH_CREDENTIAL_KEY_ID || '1';

  if (!primaryKeyHex) {
    throw new Error(
      'Missing GH_EMAIL_TOKEN_ENCRYPTION_KEY (or GH_CREDENTIAL_KEY fallback).',
    );
  }

  const parsedKeyId = Number.parseInt(keyIdRaw, 10);
  if (!Number.isFinite(parsedKeyId) || parsedKeyId <= 0) {
    throw new Error('GH_EMAIL_TOKEN_ENCRYPTION_KEY_ID must be a positive integer.');
  }

  return new CredentialEncryption({
    primaryKeyHex,
    primaryKeyId: parsedKeyId,
  });
}
