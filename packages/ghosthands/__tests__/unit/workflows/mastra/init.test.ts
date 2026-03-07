import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any source imports
// ---------------------------------------------------------------------------

vi.mock('@mastra/core', () => {
  const Mastra = vi.fn().mockImplementation(() => ({ _isMastra: true }));
  return { Mastra };
});

vi.mock('@mastra/pg', () => {
  const PostgresStore = vi.fn().mockImplementation(() => ({ _isStore: true }));
  return { PostgresStore };
});

vi.mock('../../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { getMastra, resetMastra } from '../../../../src/workflows/mastra/init.js';
import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';

// ---------------------------------------------------------------------------
// PRD V5.2 Section 14.1: Unit Tests — Mastra singleton initialization
// ---------------------------------------------------------------------------

describe('getMastra / resetMastra', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Clear singleton between tests
    resetMastra();

    // Reset env vars to a clean state
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DIRECT_URL;
    delete process.env.AWS_ASG_NAME;
    delete process.env.EC2_INSTANCE_ID;
    delete process.env.NODE_ENV;

    // Reset mock call counts
    (Mastra as unknown as ReturnType<typeof vi.fn>).mockClear();
    (PostgresStore as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...ORIGINAL_ENV };
  });

  // ─── Test 1a ─────────────────────────────────────────────────────────

  test('returns null in desktop mode when DB connection strings are missing', () => {
    // Neither env var is set (both deleted in beforeEach), no hosted env vars
    const result = getMastra();
    expect(result).toBeNull();
  });

  // ─── Test 1b ─────────────────────────────────────────────────────────

  test('throws P0 error on hosted worker when DB connection strings are missing', () => {
    process.env.AWS_ASG_NAME = 'ghosthands-worker-asg';
    expect(() => getMastra()).toThrowError(/P0.*HOSTED WORKER MISSING DATABASE CONNECTION/);
  });

  test('throws P0 error when EC2_INSTANCE_ID is set but no DB URL', () => {
    process.env.EC2_INSTANCE_ID = 'i-0de0d236d543467f0';
    expect(() => getMastra()).toThrowError(/P0/);
  });

  test('returns null when NODE_ENV=production but no hosted env vars', () => {
    // NODE_ENV alone does NOT indicate a hosted worker — only AWS_ASG_NAME
    // or EC2_INSTANCE_ID do. Desktop Electron builds can set NODE_ENV=production.
    process.env.NODE_ENV = 'production';
    const result = getMastra();
    expect(result).toBeNull();
  });

  // ─── Test 2 ──────────────────────────────────────────────────────────

  test('returns a Mastra instance when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/testdb';

    const mastra = getMastra();

    expect(mastra).toBeDefined();
    expect(mastra).toHaveProperty('_isMastra', true);
    expect(Mastra).toHaveBeenCalledOnce();
    expect(PostgresStore).toHaveBeenCalledWith({
      id: 'ghosthands',
      connectionString: 'postgresql://localhost:5432/testdb',
    });
  });

  // ─── Test 3 ──────────────────────────────────────────────────────────

  test('returns the same instance on second call (singleton behavior)', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/testdb';

    const first = getMastra();
    const second = getMastra();

    expect(first).toBe(second);
    expect(Mastra).toHaveBeenCalledOnce();
  });

  // ─── Test 4 ──────────────────────────────────────────────────────────

  test('resetMastra() clears the singleton so next getMastra() creates new', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/testdb';

    const first = getMastra();
    resetMastra();
    const second = getMastra();

    // Both are Mastra-shaped objects but distinct instances
    expect(first).not.toBe(second);
    expect(Mastra).toHaveBeenCalledTimes(2);
  });

  // ─── Test 5 ──────────────────────────────────────────────────────────

  test('uses SUPABASE_DIRECT_URL as fallback when DATABASE_URL is absent', () => {
    // Only SUPABASE_DIRECT_URL set, DATABASE_URL is absent
    process.env.SUPABASE_DIRECT_URL = 'postgresql://supabase:5432/fallbackdb';

    const mastra = getMastra();

    expect(mastra).toBeDefined();
    expect(mastra).toHaveProperty('_isMastra', true);
    expect(PostgresStore).toHaveBeenCalledWith({
      id: 'ghosthands',
      connectionString: 'postgresql://supabase:5432/fallbackdb',
    });
  });
});
