/**
 * API-002: Auth Middleware tests
 *
 * Verifies the authMiddleware handles:
 * - Service-to-service auth via X-GH-Service-Key
 * - Missing credentials rejection
 * - Invalid key rejection
 * - Server misconfiguration (missing GH_SERVICE_SECRET)
 * - Bearer token path (graceful handling without Supabase)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../../src/api/middleware/auth';

describe('Auth Middleware (API-002)', () => {
  let app: Hono;
  const TEST_SECRET = 'test-secret-key-12345';
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.GH_SERVICE_SECRET;
    process.env.GH_SERVICE_SECRET = TEST_SECRET;

    app = new Hono();
    app.use('/api/*', authMiddleware);
    app.get('/api/test', (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.GH_SERVICE_SECRET = originalSecret;
    } else {
      delete process.env.GH_SERVICE_SECRET;
    }
  });

  test('rejects request with no auth headers -> 401', async () => {
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toBe('Missing authentication credentials');
  });

  test('rejects invalid X-GH-Service-Key -> 401', async () => {
    const res = await app.request('/api/test', {
      headers: { 'X-GH-Service-Key': 'wrong-key' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toBe('Invalid service key');
  });

  test('accepts valid X-GH-Service-Key -> 200', async () => {
    const res = await app.request('/api/test', {
      headers: { 'X-GH-Service-Key': TEST_SECRET },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('rejects invalid Bearer token -> 401 or 500', async () => {
    // Without Supabase configured, Bearer path returns 500 (server_config_error)
    // With Supabase configured but bad JWT, returns 401
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer fake-jwt-token' },
    });
    expect([401, 500]).toContain(res.status);
  });

  test('returns 500 when GH_SERVICE_SECRET not configured', async () => {
    delete process.env.GH_SERVICE_SECRET;

    const res = await app.request('/api/test', {
      headers: { 'X-GH-Service-Key': 'any-key' },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('server_config_error');
  });

  test('service key auth is case-sensitive', async () => {
    const res = await app.request('/api/test', {
      headers: { 'X-GH-Service-Key': TEST_SECRET.toUpperCase() },
    });
    // If the secret isn't all-uppercase already, this should fail
    if (TEST_SECRET !== TEST_SECRET.toUpperCase()) {
      expect(res.status).toBe(401);
    }
  });

  test('empty service key is rejected', async () => {
    const res = await app.request('/api/test', {
      headers: { 'X-GH-Service-Key': '' },
    });
    // Empty string is falsy, so middleware falls through to "no auth" path
    expect(res.status).toBe(401);
  });
});
