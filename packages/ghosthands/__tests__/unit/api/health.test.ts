/**
 * API-001: GET /health endpoint tests
 *
 * Verifies the health check endpoint returns correct status, service info,
 * and timestamp.
 */

import { describe, test, expect } from 'vitest';
import { Hono } from 'hono';
import { health } from '../../../src/api/routes/health';

describe('GET /health (API-001)', () => {
  const app = new Hono();
  app.route('/health', health);

  test('returns 200 with status ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('includes service name and version', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.service).toBe('ghosthands');
    expect(body.version).toBeDefined();
  });

  test('includes ISO timestamp', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.timestamp).toBeDefined();
    expect(() => new Date(body.timestamp)).not.toThrow();
    // Verify it's a valid ISO string (not "Invalid Date")
    const parsed = new Date(body.timestamp);
    expect(parsed.toISOString()).toBe(body.timestamp);
  });

  test('version is semver format', async () => {
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
