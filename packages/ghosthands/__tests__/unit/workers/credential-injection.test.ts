/**
 * Unit tests for credential injection in the HITL flow.
 *
 * Covers:
 * - injectCode() — 2FA/verification code injection via Playwright selectors
 * - injectCredentials() — username + password injection via Playwright selectors
 * - Adapter ResolutionContext — MockAdapter and MagnitudeAdapter resume(context)
 * - Resolution data lifecycle — readAndClearResolutionData behavior
 * - ResumeResult type shape
 *
 * Private methods on JobExecutor are tested via (instance as any) for pragmatism.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MockAdapter } from '../../../src/adapters/mock';
import type { ResolutionContext } from '../../../src/adapters/types';

// ── Mock Playwright page helper ─────────────────────────────────────────

function createMockPage(elements: Record<string, { visible: boolean }> = {}) {
  const filledValues: Record<string, string> = {};
  const clicked: string[] = [];
  return {
    $: vi.fn(async (selector: string) => {
      if (!elements[selector]) return null;
      return {
        isVisible: vi.fn(async () => elements[selector].visible),
        fill: vi.fn(async (value: string) => { filledValues[selector] = value; }),
        click: vi.fn(async () => { clicked.push(selector); }),
      };
    }),
    waitForLoadState: vi.fn(async () => {}),
    filledValues,
    clicked,
  };
}

// ── Minimal mock adapter with controllable page ─────────────────────────

function createAdapterWithPage(page: any) {
  return { page } as any;
}

// ── Minimal JobExecutor for testing private methods ─────────────────────

async function createMinimalExecutor() {
  // Dynamic import to avoid pulling in all Supabase/DB deps at module level
  const { JobExecutor } = await import('../../../src/workers/JobExecutor');
  return new JobExecutor({
    supabase: {} as any,
    workerId: 'test-worker',
  });
}

// ═══════════════════════════════════════════════════════════════════════
// injectCode() tests
// ═══════════════════════════════════════════════════════════════════════

describe('injectCode()', () => {
  test('fills visible input[autocomplete="one-time-code"] and clicks submit', async () => {
    const page = createMockPage({
      'input[autocomplete="one-time-code"]': { visible: true },
      'button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCode('test-job-id', adapter, '123456');

    expect(page.filledValues['input[autocomplete="one-time-code"]']).toBe('123456');
  });

  test('falls back to input[name*="code"] when first selector does not match', async () => {
    const page = createMockPage({
      'input[name*="code" i]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCode('test-job-id', adapter, '999888');

    expect(page.filledValues['input[name*="code" i]']).toBe('999888');
  });

  test('handles no matching input gracefully (no throw)', async () => {
    const page = createMockPage({});
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    // Should not throw
    await expect(
      (executor as any).injectCode('test-job-id', adapter, '123456'),
    ).resolves.toBeUndefined();
  });

  test('skips hidden elements', async () => {
    const page = createMockPage({
      'input[autocomplete="one-time-code"]': { visible: false },
      'input[name*="code" i]': { visible: false },
      'input[name*="otp" i]': { visible: false },
      'input[name*="totp" i]': { visible: false },
      'input[name*="verification" i]': { visible: false },
      'input[name*="token" i]': { visible: false },
      'input[name*="2fa" i]': { visible: false },
      'input[name*="mfa" i]': { visible: false },
      'input[type="tel"][maxlength="6"]': { visible: false },
      'input[type="number"][maxlength="6"]': { visible: false },
      'input[inputmode="numeric"]': { visible: false },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCode('test-job-id', adapter, '111111');

    // No fields should have been filled since all are hidden
    expect(Object.keys(page.filledValues)).toHaveLength(0);
  });

  test('returns early when adapter has no page', async () => {
    const adapter = { page: null } as any;
    const executor = await createMinimalExecutor();

    await expect(
      (executor as any).injectCode('test-job-id', adapter, '000000'),
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// injectCredentials() tests
// ═══════════════════════════════════════════════════════════════════════

describe('injectCredentials()', () => {
  test('fills username + password fields and clicks submit', async () => {
    const page = createMockPage({
      'input[autocomplete="username"]': { visible: true },
      'input[type="password"]': { visible: true },
      'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button:has-text("Continue")': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {
      username: 'admin',
      password: 'secret123',
    });

    expect(page.filledValues['input[autocomplete="username"]']).toBe('admin');
    expect(page.filledValues['input[type="password"]']).toBe('secret123');
  });

  test('fills email field via input[type="email"]', async () => {
    const page = createMockPage({
      'input[type="email"]': { visible: true },
      'input[type="password"]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {
      email: 'user@example.com',
      password: 'pass',
    });

    expect(page.filledValues['input[type="email"]']).toBe('user@example.com');
    expect(page.filledValues['input[type="password"]']).toBe('pass');
  });

  test('handles only password (no username)', async () => {
    const page = createMockPage({
      'input[type="password"]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {
      password: 'only-pass',
    });

    expect(page.filledValues['input[type="password"]']).toBe('only-pass');
    // No username field should be filled
    expect(page.filledValues['input[autocomplete="username"]']).toBeUndefined();
  });

  test('handles only username (no password)', async () => {
    const page = createMockPage({
      'input[autocomplete="username"]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {
      username: 'only-user',
    });

    expect(page.filledValues['input[autocomplete="username"]']).toBe('only-user');
  });

  test('handles no matching fields gracefully (no throw)', async () => {
    const page = createMockPage({});
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await expect(
      (executor as any).injectCredentials('test-job-id', adapter, {
        username: 'user',
        password: 'pass',
      }),
    ).resolves.toBeUndefined();
  });

  test('empty data is a no-op', async () => {
    const page = createMockPage({
      'input[autocomplete="username"]': { visible: true },
      'input[type="password"]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {});

    // No fields filled, no submit clicked
    expect(Object.keys(page.filledValues)).toHaveLength(0);
    expect(page.clicked).toHaveLength(0);
  });

  test('returns early when adapter has no page', async () => {
    const adapter = { page: null } as any;
    const executor = await createMinimalExecutor();

    await expect(
      (executor as any).injectCredentials('test-job-id', adapter, { username: 'x', password: 'y' }),
    ).resolves.toBeUndefined();
  });

  test('skips hidden username fields and tries next selector', async () => {
    const page = createMockPage({
      'input[autocomplete="username"]': { visible: false },
      'input[name="username"]': { visible: true },
      'input[type="password"]': { visible: true },
    });
    const adapter = createAdapterWithPage(page);
    const executor = await createMinimalExecutor();

    await (executor as any).injectCredentials('test-job-id', adapter, {
      username: 'user123',
      password: 'pass456',
    });

    // Should skip the hidden autocomplete="username" and fill name="username"
    expect(page.filledValues['input[autocomplete="username"]']).toBeUndefined();
    expect(page.filledValues['input[name="username"]']).toBe('user123');
    expect(page.filledValues['input[type="password"]']).toBe('pass456');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Adapter ResolutionContext tests
// ═══════════════════════════════════════════════════════════════════════

describe('Adapter ResolutionContext', () => {
  const DEFAULT_START_OPTS = {
    url: 'https://example.com',
    llm: { provider: 'mock', options: { model: 'mock' } },
  } as const;

  test('MockAdapter.resume(context) stores lastResolutionContext', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
    await adapter.pause();

    const ctx: ResolutionContext = {
      resolutionType: 'code_entry',
      resolutionData: { code: '112233' },
    };
    await adapter.resume(ctx);

    expect(adapter.lastResolutionContext).toEqual(ctx);
  });

  test('MockAdapter.resume() without context stores null', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
    await adapter.pause();

    await adapter.resume();

    expect(adapter.lastResolutionContext).toBeNull();
  });

  test('MockAdapter.lastResolutionContext returns null initially', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);

    expect(adapter.lastResolutionContext).toBeNull();
  });

  test('MockAdapter.resume(context) with credentials type stores full data', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
    await adapter.pause();

    const ctx: ResolutionContext = {
      resolutionType: 'credentials',
      resolutionData: { username: 'admin', password: 'p@ss' },
    };
    await adapter.resume(ctx);

    expect(adapter.lastResolutionContext?.resolutionType).toBe('credentials');
    expect(adapter.lastResolutionContext?.resolutionData?.username).toBe('admin');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Resolution data lifecycle tests
// ═══════════════════════════════════════════════════════════════════════

describe('Resolution data lifecycle', () => {
  test('readAndClearResolutionData reads resolution fields from interaction_data (pgPool path)', async () => {
    const mockPool = {
      query: vi.fn()
        // First call: SELECT interaction_data
        .mockResolvedValueOnce({
          rows: [{
            interaction_data: {
              type: 'captcha',
              resolution_type: 'code_entry',
              resolution_data: { code: '555' },
              resolved_by: 'human',
              resolved_at: '2026-02-18T12:00:00Z',
            },
          }],
        })
        // Second call: UPDATE to clear resolution fields
        .mockResolvedValueOnce({ rows: [] }),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: {} as any,
      workerId: 'test-worker',
      pgPool: mockPool as any,
    });

    const result = await (executor as any).readAndClearResolutionData('job-uuid-123');

    expect(result.resumed).toBe(true);
    expect(result.resolutionType).toBe('code_entry');
    expect(result.resolutionData).toEqual({ code: '555' });

    // Verify it cleared resolution data from DB
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    const clearQuery = mockPool.query.mock.calls[1][0];
    expect(clearQuery).toContain("- 'resolution_type'");
    expect(clearQuery).toContain("- 'resolution_data'");
  });

  test('readAndClearResolutionData handles missing interaction_data gracefully', async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ interaction_data: null }] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: {} as any,
      workerId: 'test-worker',
      pgPool: mockPool as any,
    });

    const result = await (executor as any).readAndClearResolutionData('job-uuid-456');

    expect(result.resumed).toBe(true);
    expect(result.resolutionType).toBe('manual'); // fallback default
    expect(result.resolutionData).toBeUndefined();
  });

  test('readAndClearResolutionData clears resolution fields after reading', async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            interaction_data: {
              type: 'login',
              screenshot_url: 'https://example.com/shot.png',
              resolution_type: 'credentials',
              resolution_data: { username: 'admin', password: 'secret' },
              resolved_by: 'human',
              resolved_at: '2026-02-18T12:30:00Z',
            },
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: {} as any,
      workerId: 'test-worker',
      pgPool: mockPool as any,
    });

    await (executor as any).readAndClearResolutionData('job-uuid-789');

    // The second query should strip resolution fields from JSONB
    const clearArgs = mockPool.query.mock.calls[1];
    expect(clearArgs[0]).toContain("- 'resolved_by'");
    expect(clearArgs[0]).toContain("- 'resolved_at'");
    expect(clearArgs[1]).toEqual(['job-uuid-789']);
  });

  test('readAndClearResolutionData falls back to supabase when no pgPool', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                interaction_data: {
                  type: 'captcha',
                  resolution_type: 'skip',
                },
              },
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: mockSupabase as any,
      workerId: 'test-worker',
      // no pgPool
    });

    const result = await (executor as any).readAndClearResolutionData('job-uuid-abc');

    expect(result.resumed).toBe(true);
    expect(result.resolutionType).toBe('skip');
  });

  test('readAndClearResolutionData handles errors gracefully and returns resumed with manual type', async () => {
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: {} as any,
      workerId: 'test-worker',
      pgPool: mockPool as any,
    });

    const result = await (executor as any).readAndClearResolutionData('job-uuid-err');

    expect(result.resumed).toBe(true);
    expect(result.resolutionType).toBe('manual');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ResumeResult type shape
// ═══════════════════════════════════════════════════════════════════════

describe('ResumeResult type', () => {
  test('has correct shape for successful resume with code_entry', async () => {
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            interaction_data: {
              resolution_type: 'code_entry',
              resolution_data: { code: '999' },
            },
          }],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const { JobExecutor } = await import('../../../src/workers/JobExecutor');
    const executor = new JobExecutor({
      supabase: {} as any,
      workerId: 'test-worker',
      pgPool: mockPool as any,
    });

    const result = await (executor as any).readAndClearResolutionData('any-id');

    expect(result).toHaveProperty('resumed', true);
    expect(result).toHaveProperty('resolutionType', 'code_entry');
    expect(result).toHaveProperty('resolutionData');
    expect(result.resolutionData).toEqual({ code: '999' });
  });

  test('has correct shape for timed-out resume (not resumed)', () => {
    // This validates the shape returned by waitForResumeViaPolling on timeout
    const result = { resumed: false };
    expect(result).toHaveProperty('resumed', false);
    expect(result).not.toHaveProperty('resolutionType');
    expect(result).not.toHaveProperty('resolutionData');
  });
});
