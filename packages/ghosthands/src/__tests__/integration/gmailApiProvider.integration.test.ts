import { afterEach, describe, expect, test } from 'bun:test';
import { GmailApiProvider } from '../../workers/emailVerification/gmailApiProvider.js';
import type { GmailConnectionStore, StoredGmailConnection } from '../../workers/emailVerification/tokenStore.js';

class FakeConnectionStore implements Pick<GmailConnectionStore, 'getConnection' | 'updateAccessToken' | 'markUsed'> {
  markUsedCount = 0;
  updatedAccessToken: string | null = null;

  constructor(private readonly connection: StoredGmailConnection | null) {}

  async getConnection(): Promise<StoredGmailConnection | null> {
    return this.connection;
  }

  async updateAccessToken(input: { accessToken: string }): Promise<void> {
    this.updatedAccessToken = input.accessToken;
  }

  async markUsed(): Promise<void> {
    this.markUsedCount += 1;
  }
}

describe('GmailApiProvider integration', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('extracts verification link from Gmail API message', async () => {
    const store = new FakeConnectionStore({
      userId: 'u1',
      provider: 'google',
      emailAddress: 'user@example.com',
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      accessTokenExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    });

    const base64Body = Buffer
      .from('Please verify using https://example.com/verify?token=abc123', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/gmail/v1/users/me/messages?')) {
        return Response.json({
          messages: [{ id: 'msg-1' }],
        });
      }
      if (target.includes('/gmail/v1/users/me/messages/msg-1')) {
        return Response.json({
          id: 'msg-1',
          snippet: 'Verify your account',
          internalDate: String(Date.now()),
          payload: {
            headers: [
              { name: 'Subject', value: 'Please verify' },
              { name: 'From', value: 'noreply@example.com' },
            ],
            mimeType: 'text/plain',
            body: { data: base64Body },
          },
        });
      }
      throw new Error(`Unexpected URL: ${target}`);
    }) as typeof fetch;

    const provider = new GmailApiProvider({
      userId: 'u1',
      tokenStore: store as unknown as GmailConnectionStore,
      oauthConfig: {
        clientId: 'cid',
        clientSecret: 'secret',
      },
    });

    const signal = await provider.findLatestVerificationSignal({
      loginEmail: 'user@example.com',
      lookbackMinutes: 15,
    });

    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('link');
    expect(signal?.link).toContain('https://example.com/verify');
    expect(store.markUsedCount).toBe(1);
  });

  test('extracts numeric OTP and ignores keyword-only tokens like "code"', async () => {
    const store = new FakeConnectionStore({
      userId: 'u1',
      provider: 'google',
      emailAddress: 'user@example.com',
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      accessTokenExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    });

    const base64Body = Buffer
      .from(
        [
          'Google sign-in verification code',
          'Enter verification code on the page to continue.',
          'Your verification code is: 123456',
        ].join('\n'),
        'utf8',
      )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/gmail/v1/users/me/messages?')) {
        return Response.json({
          messages: [{ id: 'msg-otp-1' }],
        });
      }
      if (target.includes('/gmail/v1/users/me/messages/msg-otp-1')) {
        return Response.json({
          id: 'msg-otp-1',
          snippet: 'Google sign-in verification code',
          internalDate: String(Date.now()),
          payload: {
            headers: [
              { name: 'Subject', value: 'Google sign-in verification code' },
              { name: 'From', value: 'accounts@example.com' },
            ],
            mimeType: 'text/plain',
            body: { data: base64Body },
          },
        });
      }
      throw new Error(`Unexpected URL: ${target}`);
    }) as typeof fetch;

    const provider = new GmailApiProvider({
      userId: 'u1',
      tokenStore: store as unknown as GmailConnectionStore,
      oauthConfig: {
        clientId: 'cid',
        clientSecret: 'secret',
      },
    });

    const signal = await provider.findLatestVerificationSignal({
      loginEmail: 'user@example.com',
      lookbackMinutes: 15,
    });

    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('otp');
    expect(signal?.code).toBe('123456');
  });
});
