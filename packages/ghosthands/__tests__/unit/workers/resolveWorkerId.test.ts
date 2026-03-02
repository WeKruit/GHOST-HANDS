/**
 * WEK-147 Gate B: resolveWorkerId() unit tests
 *
 * Tests the worker ID resolution priority chain:
 *   CLI arg > GH_WORKER_ID env > IMDS > generated fallback
 *
 * Mocks discoverImdsInstanceId (from asg-lifecycle) and process.argv/env.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be declared before imports) ──────────────────────────

const mockDiscoverImds = vi.fn<() => Promise<string | null>>();

vi.mock('../../../src/workers/asg-lifecycle.js', () => ({
  fetchEc2InstanceId: vi.fn().mockResolvedValue('i-mock'),
  fetchEc2Ip: vi.fn().mockResolvedValue('1.2.3.4'),
  completeLifecycleAction: vi.fn(),
  discoverImdsInstanceId: (...args: unknown[]) => mockDiscoverImds(...(args as [])),
}));

vi.mock('../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveWorkerId } from '../../../src/workers/resolveWorkerId.js';

// ── Test suite ───────────────────────────────────────────────────────

describe('resolveWorkerId', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    // Deep-copy env and argv so each test is isolated
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
    // Default: IMDS unavailable
    mockDiscoverImds.mockResolvedValue(null);
    // Clear any worker ID env vars that may be set in the test runner
    delete process.env.GH_WORKER_ID;
    delete process.env.FLY_REGION;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  // ── Priority 1: CLI arg ──────────────────────────────────────────

  test('returns CLI arg value when --worker-id=VALUE is present', async () => {
    process.argv.push('--worker-id=my-worker');

    const result = await resolveWorkerId();

    expect(result).toBe('my-worker');
    // IMDS should NOT be called — CLI takes priority
    expect(mockDiscoverImds).not.toHaveBeenCalled();
  });

  test('throws when --worker-id= is present but empty', async () => {
    process.argv.push('--worker-id=');

    await expect(resolveWorkerId()).rejects.toThrow(
      '--worker-id requires a value',
    );
    expect(mockDiscoverImds).not.toHaveBeenCalled();
  });

  test('CLI arg takes priority over GH_WORKER_ID env', async () => {
    process.argv.push('--worker-id=cli-wins');
    process.env.GH_WORKER_ID = 'env-loses';
    mockDiscoverImds.mockResolvedValue('i-0abc123def456');

    const result = await resolveWorkerId();

    expect(result).toBe('cli-wins');
    expect(mockDiscoverImds).not.toHaveBeenCalled();
  });

  // ── Priority 2: GH_WORKER_ID env ────────────────────────────────

  test('returns GH_WORKER_ID when set (no CLI arg)', async () => {
    process.env.GH_WORKER_ID = 'env-worker-42';

    const result = await resolveWorkerId();

    expect(result).toBe('env-worker-42');
    expect(mockDiscoverImds).not.toHaveBeenCalled();
  });

  test('GH_WORKER_ID takes priority over IMDS', async () => {
    process.env.GH_WORKER_ID = 'env-wins';
    mockDiscoverImds.mockResolvedValue('i-0abc123def456');

    const result = await resolveWorkerId();

    expect(result).toBe('env-wins');
    expect(mockDiscoverImds).not.toHaveBeenCalled();
  });

  // ── Priority 3: IMDS ────────────────────────────────────────────

  test('returns IMDS instance ID when no CLI arg or env var', async () => {
    mockDiscoverImds.mockResolvedValue('i-0abc123def456');

    const result = await resolveWorkerId();

    expect(result).toBe('i-0abc123def456');
    expect(mockDiscoverImds).toHaveBeenCalledOnce();
  });

  // ── Priority 4: Generated fallback ──────────────────────────────

  test('returns generated fallback when IMDS is unavailable (IMDS-unavailable contract)', async () => {
    // This test explicitly covers the IMDS-unavailable production scenario:
    //   - No CLI arg, no GH_WORKER_ID, IMDS returns null
    //   - Worker gets a generated ID matching pattern /^worker-.+-\d+$/
    //   - Worker self-registers with this temporary ID
    //   - Targeted routing must use this generated ID (not an instance ID)
    mockDiscoverImds.mockResolvedValue(null);

    const result = await resolveWorkerId();

    expect(result).toMatch(/^worker-.+-\d+$/);
    expect(result).toMatch(/^worker-local-\d+$/); // No FLY_REGION or NODE_ENV set → "local"
    expect(mockDiscoverImds).toHaveBeenCalledOnce();
  });

  test('generated fallback uses FLY_REGION when set', async () => {
    process.env.FLY_REGION = 'iad';

    const result = await resolveWorkerId();

    expect(result).toMatch(/^worker-iad-\d+$/);
  });

  test('generated fallback uses NODE_ENV when FLY_REGION is not set', async () => {
    process.env.NODE_ENV = 'production';

    const result = await resolveWorkerId();

    expect(result).toMatch(/^worker-production-\d+$/);
  });

  test('FLY_REGION takes priority over NODE_ENV in generated fallback', async () => {
    process.env.FLY_REGION = 'iad';
    process.env.NODE_ENV = 'production';

    const result = await resolveWorkerId();

    expect(result).toMatch(/^worker-iad-\d+$/);
  });

  test('generated fallback includes a recent timestamp', async () => {
    const before = Date.now();
    const result = await resolveWorkerId();
    const after = Date.now();

    const timestampStr = result.split('-').pop()!;
    const timestamp = Number(timestampStr);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  // ── Full priority chain verification ────────────────────────────

  test('full priority: CLI > env > IMDS > generated', async () => {
    // Start with everything available
    process.argv.push('--worker-id=cli');
    process.env.GH_WORKER_ID = 'env';
    mockDiscoverImds.mockResolvedValue('i-0abc123def456');

    // CLI wins
    expect(await resolveWorkerId()).toBe('cli');

    // Remove CLI → env wins
    process.argv = process.argv.filter((a) => !a.startsWith('--worker-id='));
    expect(await resolveWorkerId()).toBe('env');

    // Remove env → IMDS wins
    delete process.env.GH_WORKER_ID;
    expect(await resolveWorkerId()).toBe('i-0abc123def456');

    // IMDS fails → generated fallback
    mockDiscoverImds.mockResolvedValue(null);
    const fallback = await resolveWorkerId();
    expect(fallback).toMatch(/^worker-.+-\d+$/);
  });
});
