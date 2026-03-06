import { describe, expect, test } from 'bun:test';
import {
  createGoogleOAuthStateToken,
  verifyGoogleOAuthStateToken,
} from '../../workers/emailVerification/oauthState.js';

describe('Google OAuth state token', () => {
  test('round-trips payload with valid signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createGoogleOAuthStateToken({
      userId: '11111111-1111-1111-1111-111111111111',
      iat: now,
      exp: now + 300,
      returnTo: 'https://example.com/settings',
    }, 'test-secret');

    const payload = verifyGoogleOAuthStateToken(token, 'test-secret');
    expect(payload.userId).toBe('11111111-1111-1111-1111-111111111111');
    expect(payload.returnTo).toBe('https://example.com/settings');
  });

  test('rejects invalid signature', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createGoogleOAuthStateToken({
      userId: 'u1',
      iat: now,
      exp: now + 300,
    }, 'secret-a');

    expect(() => verifyGoogleOAuthStateToken(token, 'secret-b')).toThrow('Invalid OAuth state signature');
  });

  test('rejects expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = createGoogleOAuthStateToken({
      userId: 'u1',
      iat: now - 60,
      exp: now - 10,
    }, 'test-secret');

    expect(() => verifyGoogleOAuthStateToken(token, 'test-secret')).toThrow('OAuth state token expired');
  });
});
