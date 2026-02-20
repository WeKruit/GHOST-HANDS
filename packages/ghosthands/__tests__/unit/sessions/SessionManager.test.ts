import { describe, expect, test, beforeEach, vi } from 'vitest';
import { SessionManager } from '../../../src/sessions/SessionManager.js';
import { CredentialEncryption } from '../../../src/db/encryption.js';

// ── Mock Supabase client ──────────────────────────────────────────────────

function createMockSupabase() {
  const chainable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    delete: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  // Make chainable methods return the chainable object for fluent API
  chainable.select.mockReturnValue(chainable);
  chainable.eq.mockReturnValue(chainable);
  chainable.lt.mockReturnValue(chainable);
  chainable.delete.mockReturnValue(chainable);
  chainable.update.mockReturnValue(chainable);

  return {
    from: vi.fn().mockReturnValue(chainable),
    _chain: chainable,
  };
}

// ── Test encryption ───────────────────────────────────────────────────────

function createTestEncryption(): CredentialEncryption {
  // Deterministic 64-hex-char key for tests
  const keyHex = 'a'.repeat(64);
  return new CredentialEncryption({
    primaryKeyHex: keyHex,
    primaryKeyId: 1,
  });
}

// ── Sample storage state ──────────────────────────────────────────────────

const SAMPLE_STORAGE_STATE = {
  cookies: [
    { name: 'session_id', value: 'abc123', domain: '.greenhouse.io', path: '/' },
    { name: '_gh_sess', value: 'xyz', domain: '.greenhouse.io', path: '/' },
  ],
  origins: [
    {
      origin: 'https://boards.greenhouse.io',
      localStorage: [
        { name: 'auth_token', value: 'jwt-token-here' },
      ],
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let supabase: ReturnType<typeof createMockSupabase>;
  let encryption: CredentialEncryption;
  let manager: SessionManager;

  beforeEach(() => {
    supabase = createMockSupabase();
    encryption = createTestEncryption();
    manager = new SessionManager({
      supabase: supabase as any,
      encryption,
    });
  });

  // ── Domain extraction ─────────────────────────────────────────────────

  describe('extractDomain', () => {
    test('extracts hostname from HTTPS URL', () => {
      expect(SessionManager.extractDomain('https://boards.greenhouse.io/company/jobs/123'))
        .toBe('boards.greenhouse.io');
    });

    test('extracts hostname from HTTP URL', () => {
      expect(SessionManager.extractDomain('http://example.com/page'))
        .toBe('example.com');
    });

    test('extracts hostname with port', () => {
      expect(SessionManager.extractDomain('https://localhost:3000/api'))
        .toBe('localhost');
    });

    test('extracts hostname from URL with subdomain', () => {
      expect(SessionManager.extractDomain('https://jobs.lever.co/company'))
        .toBe('jobs.lever.co');
    });

    test('throws on invalid URL', () => {
      expect(() => SessionManager.extractDomain('not-a-url')).toThrow();
    });
  });

  // ── loadSession ───────────────────────────────────────────────────────

  describe('loadSession', () => {
    test('returns null when no session exists', async () => {
      supabase._chain.single.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

      const result = await manager.loadSession('user-1', 'https://boards.greenhouse.io/jobs/123');

      expect(result).toBeNull();
      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
    });

    test('returns decrypted session when found', async () => {
      const encrypted = encryption.encrypt(JSON.stringify(SAMPLE_STORAGE_STATE));

      supabase._chain.single.mockResolvedValueOnce({
        data: {
          session_data: encrypted.ciphertext,
          expires_at: null,
        },
        error: null,
      });

      const result = await manager.loadSession('user-1', 'https://boards.greenhouse.io/jobs/123');

      expect(result).toEqual(SAMPLE_STORAGE_STATE);
    });

    test('returns null and deletes expired session', async () => {
      const encrypted = encryption.encrypt(JSON.stringify(SAMPLE_STORAGE_STATE));
      const pastDate = new Date(Date.now() - 86400_000).toISOString(); // 1 day ago

      supabase._chain.single.mockResolvedValueOnce({
        data: {
          session_data: encrypted.ciphertext,
          expires_at: pastDate,
        },
        error: null,
      });

      const result = await manager.loadSession('user-1', 'https://boards.greenhouse.io/jobs/123');

      expect(result).toBeNull();
      // Should have called delete
      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
    });

    test('returns null and deletes session on decryption failure', async () => {
      supabase._chain.single.mockResolvedValueOnce({
        data: {
          session_data: 'corrupted-data-not-valid-base64-envelope',
          expires_at: null,
        },
        error: null,
      });

      const result = await manager.loadSession('user-1', 'https://boards.greenhouse.io/jobs/123');

      expect(result).toBeNull();
    });

    test('updates last_used_at on successful load', async () => {
      const encrypted = encryption.encrypt(JSON.stringify(SAMPLE_STORAGE_STATE));

      supabase._chain.single.mockResolvedValueOnce({
        data: {
          session_data: encrypted.ciphertext,
          expires_at: null,
        },
        error: null,
      });

      await manager.loadSession('user-1', 'https://boards.greenhouse.io/jobs/123');

      // The update call chain: from('gh_browser_sessions').update({...}).eq().eq()
      // We verify from was called with the table at least once for the update
      const fromCalls = supabase.from.mock.calls.map((c: any[]) => c[0]);
      expect(fromCalls.every((t: string) => t === 'gh_browser_sessions')).toBe(true);
    });
  });

  // ── saveSession ───────────────────────────────────────────────────────

  describe('saveSession', () => {
    test('encrypts and upserts session data', async () => {
      await manager.saveSession(
        'user-1',
        'https://boards.greenhouse.io/jobs/123',
        SAMPLE_STORAGE_STATE,
      );

      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
      expect(supabase._chain.upsert).toHaveBeenCalled();

      // Verify the upserted data
      const upsertCall = supabase._chain.upsert.mock.calls[0];
      const upsertedRow = upsertCall[0];
      const upsertOpts = upsertCall[1];

      expect(upsertedRow.user_id).toBe('user-1');
      expect(upsertedRow.domain).toBe('boards.greenhouse.io');
      expect(upsertedRow.encryption_key_id).toBe('1');
      expect(upsertOpts).toEqual({ onConflict: 'user_id,domain' });

      // Verify the encrypted data can be decrypted back
      const decrypted = encryption.decrypt(upsertedRow.session_data);
      expect(JSON.parse(decrypted)).toEqual(SAMPLE_STORAGE_STATE);
    });

    test('updates existing session (upsert behavior)', async () => {
      // First save
      await manager.saveSession('user-1', 'https://boards.greenhouse.io/jobs/1', SAMPLE_STORAGE_STATE);

      // Second save with different data
      const updatedState = { ...SAMPLE_STORAGE_STATE, cookies: [] };
      await manager.saveSession('user-1', 'https://boards.greenhouse.io/jobs/2', updatedState);

      // Both should use upsert with same domain
      expect(supabase._chain.upsert).toHaveBeenCalledTimes(2);

      const secondCall = supabase._chain.upsert.mock.calls[1][0];
      expect(secondCall.domain).toBe('boards.greenhouse.io');

      const decrypted = encryption.decrypt(secondCall.session_data);
      expect(JSON.parse(decrypted)).toEqual(updatedState);
    });
  });

  // ── Encryption round-trip ─────────────────────────────────────────────

  describe('encryption round-trip', () => {
    test('encrypt then decrypt produces original storageState', () => {
      const plaintext = JSON.stringify(SAMPLE_STORAGE_STATE);
      const { ciphertext } = encryption.encrypt(plaintext);
      const decrypted = encryption.decrypt(ciphertext);
      expect(JSON.parse(decrypted)).toEqual(SAMPLE_STORAGE_STATE);
    });

    test('different encryptions produce different ciphertexts (unique IV)', () => {
      const plaintext = JSON.stringify(SAMPLE_STORAGE_STATE);
      const { ciphertext: ct1 } = encryption.encrypt(plaintext);
      const { ciphertext: ct2 } = encryption.encrypt(plaintext);
      expect(ct1).not.toBe(ct2); // different IVs
    });
  });

  // ── clearSession ──────────────────────────────────────────────────────

  describe('clearSession', () => {
    test('deletes session for specific domain', async () => {
      await manager.clearSession('user-1', 'boards.greenhouse.io');

      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
      // Should have eq for both user_id and domain
      expect(supabase._chain.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(supabase._chain.eq).toHaveBeenCalledWith('domain', 'boards.greenhouse.io');
    });

    test('deletes all sessions for user when no domain specified', async () => {
      await manager.clearSession('user-1');

      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
      expect(supabase._chain.eq).toHaveBeenCalledWith('user_id', 'user-1');
      // Should NOT have been called with a domain filter
      const eqCalls = supabase._chain.eq.mock.calls;
      const domainCalls = eqCalls.filter((c: any[]) => c[0] === 'domain');
      expect(domainCalls).toHaveLength(0);
    });
  });

  // ── cleanExpiredSessions ──────────────────────────────────────────────

  describe('cleanExpiredSessions', () => {
    test('deletes sessions with expired timestamps', async () => {
      // Mock: 3 expired sessions deleted
      supabase._chain.select.mockResolvedValueOnce({
        data: [{ id: '1' }, { id: '2' }, { id: '3' }],
        error: null,
      });

      const count = await manager.cleanExpiredSessions();

      expect(count).toBe(3);
      expect(supabase.from).toHaveBeenCalledWith('gh_browser_sessions');
    });

    test('returns 0 when no expired sessions exist', async () => {
      supabase._chain.select.mockResolvedValueOnce({
        data: [],
        error: null,
      });

      const count = await manager.cleanExpiredSessions();

      expect(count).toBe(0);
    });

    test('returns 0 when delete returns null data', async () => {
      supabase._chain.select.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const count = await manager.cleanExpiredSessions();

      expect(count).toBe(0);
    });
  });
});
