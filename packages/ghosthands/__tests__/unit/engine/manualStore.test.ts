import { describe, expect, test, beforeEach, vi } from 'vitest';
import { ManualStore } from '../../../src/engine/ManualStore';
import type { ManualStep } from '../../../src/engine/types';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<ManualStep> = {}): ManualStep {
  return {
    order: 0,
    locator: { css: 'input#test' },
    action: 'fill',
    description: 'Test step',
    healthScore: 1.0,
    ...overrides,
  };
}

function makeManualRow(overrides: Record<string, any> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    url_pattern: '*.workday.com/*/apply/*',
    task_pattern: 'apply',
    platform: 'workday',
    steps: [makeStep()],
    health_score: 85,
    success_count: 10,
    failure_count: 1,
    source: 'recorded',
    created_at: '2026-02-16T00:00:00Z',
    updated_at: '2026-02-16T00:00:00Z',
    last_used: null,
    ...overrides,
  };
}

/**
 * Minimal mock for Supabase query builder chain.
 */
function createMockSupabase(resultData: any = null, error: any = null) {
  function createQueryChain(_table: string) {
    const chain: any = {
      _result: { data: resultData, error },
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      gte: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      single: () => chain,
      maybeSingle: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      then: (resolve: (v: any) => void) => resolve(chain._result),
    };
    return chain;
  }

  const client = {
    from: vi.fn((table: string) => createQueryChain(table)),
  };

  return { client: client as any };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ManualStore', () => {
  let store: ManualStore;
  let mockSupa: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mockSupa = createMockSupabase();
    store = new ManualStore({ supabase: mockSupa.client });
  });

  describe('constructor', () => {
    test('accepts a config with supabase client', () => {
      expect(store).toBeInstanceOf(ManualStore);
    });

    test('accepts a SupabaseClient directly', () => {
      const s = new ManualStore(mockSupa.client);
      expect(s).toBeInstanceOf(ManualStore);
    });
  });

  describe('lookup', () => {
    test('queries gh_action_manuals table', async () => {
      const row = makeManualRow({ url_pattern: '*.workday.com/*/apply/*' });
      mockSupa = createMockSupabase([row]);
      store = new ManualStore({ supabase: mockSupa.client });

      await store.lookup('https://acme.workday.com/en-US/apply/123', 'apply', 'workday');

      expect(mockSupa.client.from).toHaveBeenCalledWith('gh_action_manuals');
    });

    test('returns ActionManual on match', async () => {
      const row = makeManualRow({ url_pattern: '*.workday.com/*/apply/*' });
      mockSupa = createMockSupabase([row]);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.lookup('https://acme.workday.com/en-US/apply/123', 'apply', 'workday');

      expect(result).not.toBeNull();
      expect(result!.id).toBe(row.id);
      expect(result!.url_pattern).toBe(row.url_pattern);
      expect(result!.source).toBe('recorded');
      // health_score converts from DB 0-100 to domain 0-1
      expect(result!.health_score).toBeCloseTo(0.85, 2);
    });

    test('returns null when no match', async () => {
      mockSupa = createMockSupabase([]);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.lookup('https://unknown-site.com/page', 'apply');
      expect(result).toBeNull();
    });

    test('returns null on query error', async () => {
      mockSupa = createMockSupabase(null, { message: 'DB error' });
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.lookup('https://test.com', 'apply');
      expect(result).toBeNull();
    });

    test('lookup without platform still works', async () => {
      const row = makeManualRow({ platform: null, url_pattern: '*.test.com/*' });
      mockSupa = createMockSupabase([row]);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.lookup('https://acme.test.com/page', 'apply');
      expect(result).not.toBeNull();
    });
  });

  describe('get', () => {
    test('retrieves manual by id', async () => {
      const row = makeManualRow();
      mockSupa = createMockSupabase(row);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.get(row.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(row.id);
    });

    test('returns null when not found', async () => {
      mockSupa = createMockSupabase(null, { message: 'not found' });
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.get('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('saveFromTrace', () => {
    test('inserts a new manual via gh_action_manuals', async () => {
      const row = makeManualRow({ health_score: 100, source: 'recorded' });
      mockSupa = createMockSupabase(row);
      store = new ManualStore({ supabase: mockSupa.client });

      const steps: ManualStep[] = [
        makeStep({ order: 0, description: 'Click login' }),
        makeStep({ order: 1, description: 'Type username' }),
      ];

      const result = await store.saveFromTrace(steps, {
        url: 'https://acme.workday.com/en-US/apply/123',
        taskType: 'apply',
        platform: 'workday',
      });

      expect(mockSupa.client.from).toHaveBeenCalledWith('gh_action_manuals');
      expect(result).not.toBeNull();
    });

    test('recorded manuals have health_score 1.0 in domain model (100 in DB)', async () => {
      const row = makeManualRow({ health_score: 100, source: 'recorded' });
      mockSupa = createMockSupabase(row);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.saveFromTrace([makeStep()], {
        url: 'https://example.com/page',
        taskType: 'test',
        platform: 'test',
      });

      expect(result.health_score).toBeCloseTo(1.0, 2);
    });

    test('throws on insert error', async () => {
      mockSupa = createMockSupabase(null, { message: 'duplicate key' });
      store = new ManualStore({ supabase: mockSupa.client });

      await expect(
        store.saveFromTrace([makeStep()], {
          url: 'https://example.com/apply',
          taskType: 'apply',
        }),
      ).rejects.toThrow('ManualStore.insert failed');
    });
  });

  describe('saveFromActionBook', () => {
    test('inserts with source=actionbook and health_score 0.8 in domain', async () => {
      const row = makeManualRow({ health_score: 80, source: 'actionbook' });
      mockSupa = createMockSupabase(row);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.saveFromActionBook(
        [makeStep()],
        { urlPattern: '*.airbnb.com/*', taskType: 'search', platform: 'airbnb' },
      );

      expect(result.source).toBe('actionbook');
      expect(result.health_score).toBeCloseTo(0.8, 2);
    });

    test('accepts url instead of urlPattern', async () => {
      const row = makeManualRow({ health_score: 80, source: 'actionbook' });
      mockSupa = createMockSupabase(row);
      store = new ManualStore({ supabase: mockSupa.client });

      const result = await store.saveFromActionBook(
        [makeStep()],
        { url: 'https://boards.greenhouse.io/company/jobs/123', taskType: 'apply' },
      );

      expect(result).not.toBeNull();
      expect(mockSupa.client.from).toHaveBeenCalledWith('gh_action_manuals');
    });
  });

  describe('recordSuccess', () => {
    test('calls from() to fetch and then update the manual', async () => {
      const row = makeManualRow({ health_score: 80, success_count: 5, failure_count: 1 });

      let callCount = 0;
      const client = {
        from: vi.fn((_table: string) => {
          callCount++;
          const chain: any = {
            _result: callCount === 1
              ? { data: row, error: null }        // select (getRow)
              : { data: null, error: null },       // update
            select: () => chain,
            eq: () => chain,
            single: () => chain,
            maybeSingle: () => chain,
            update: () => chain,
            then: (resolve: (v: any) => void) => resolve(chain._result),
          };
          return chain;
        }),
      };
      store = new ManualStore({ supabase: client as any });

      await store.recordSuccess(row.id);
      expect(client.from).toHaveBeenCalled();
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    test('does nothing if manual not found', async () => {
      mockSupa = createMockSupabase(null, { message: 'not found' });
      store = new ManualStore({ supabase: mockSupa.client });

      // Should not throw
      await store.recordSuccess('nonexistent-id');
    });
  });

  describe('recordFailure', () => {
    test('calls from() to fetch and then update the manual', async () => {
      const row = makeManualRow({ health_score: 80, failure_count: 2, success_count: 10 });

      let callCount = 0;
      const client = {
        from: vi.fn((_table: string) => {
          callCount++;
          const chain: any = {
            _result: callCount === 1
              ? { data: row, error: null }
              : { data: null, error: null },
            select: () => chain,
            eq: () => chain,
            single: () => chain,
            maybeSingle: () => chain,
            update: () => chain,
            then: (resolve: (v: any) => void) => resolve(chain._result),
          };
          return chain;
        }),
      };
      store = new ManualStore({ supabase: client as any });

      await store.recordFailure(row.id);
      expect(client.from).toHaveBeenCalled();
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    test('does nothing if manual not found', async () => {
      mockSupa = createMockSupabase(null, { message: 'not found' });
      store = new ManualStore({ supabase: mockSupa.client });

      await store.recordFailure('nonexistent-id');
    });
  });

  describe('health score math (ManualStore.computeHealth)', () => {
    test('success: adds 2, caps at 100', () => {
      expect(ManualStore.computeHealth(80, 0, 'success')).toBe(82);
      expect(ManualStore.computeHealth(99, 0, 'success')).toBe(100);
      expect(ManualStore.computeHealth(100, 0, 'success')).toBe(100);
    });

    test('failure with <=5 total failures (newFailureCount <= threshold): subtracts 5', () => {
      expect(ManualStore.computeHealth(80, 0, 'failure')).toBe(75); // newFC=1 <= 5 -> -5
      expect(ManualStore.computeHealth(80, 3, 'failure')).toBe(75); // newFC=4 <= 5 -> -5
      expect(ManualStore.computeHealth(80, 4, 'failure')).toBe(75); // newFC=5 <= 5 -> -5
    });

    test('failure with >5 total failures (newFailureCount > threshold): subtracts 15', () => {
      expect(ManualStore.computeHealth(80, 5, 'failure')).toBe(65); // newFC=6 > 5 -> -15
      expect(ManualStore.computeHealth(80, 10, 'failure')).toBe(65); // newFC=11 > 5 -> -15
    });

    test('failure floors at 0', () => {
      expect(ManualStore.computeHealth(3, 0, 'failure')).toBe(0);
      expect(ManualStore.computeHealth(10, 5, 'failure')).toBe(0);
      expect(ManualStore.computeHealth(0, 0, 'failure')).toBe(0);
    });

    test('full lifecycle: degradation and recovery', () => {
      let health = 100;
      let failures = 0;

      // 5 failures at normal penalty (-5 each)
      for (let i = 0; i < 5; i++) {
        health = ManualStore.computeHealth(health, failures, 'failure');
        failures++;
      }
      expect(health).toBe(75); // 100 - (5*5)

      // 1 more failure at severe penalty (-15)
      health = ManualStore.computeHealth(health, failures, 'failure');
      failures++;
      expect(health).toBe(60); // 75 - 15

      // 10 successes (+2 each)
      for (let i = 0; i < 10; i++) {
        health = ManualStore.computeHealth(health, failures, 'success');
      }
      expect(health).toBe(80); // 60 + 20
    });
  });

  describe('computeHealthAfterSuccess (convenience)', () => {
    test('adds 2, caps at 100', () => {
      expect(ManualStore.computeHealthAfterSuccess(80)).toBe(82);
      expect(ManualStore.computeHealthAfterSuccess(99)).toBe(100);
      expect(ManualStore.computeHealthAfterSuccess(100)).toBe(100);
    });
  });

  describe('computeHealthAfterFailure (convenience)', () => {
    test('subtracts 5 when under threshold', () => {
      expect(ManualStore.computeHealthAfterFailure(80, 0)).toBe(75);
      expect(ManualStore.computeHealthAfterFailure(80, 4)).toBe(75);
    });

    test('subtracts 15 at 5+ failures', () => {
      expect(ManualStore.computeHealthAfterFailure(80, 5)).toBe(65);
      expect(ManualStore.computeHealthAfterFailure(80, 10)).toBe(65);
    });

    test('floors at 0', () => {
      expect(ManualStore.computeHealthAfterFailure(3, 0)).toBe(0);
      expect(ManualStore.computeHealthAfterFailure(10, 5)).toBe(0);
      expect(ManualStore.computeHealthAfterFailure(0, 0)).toBe(0);
    });
  });

  describe('rowToManual', () => {
    test('converts DB row health_score (0-100) to domain (0-1)', () => {
      const row = makeManualRow({ health_score: 70 });
      const manual = ManualStore.rowToManual(row);
      expect(manual.health_score).toBeCloseTo(0.7, 2);
    });

    test('preserves core fields', () => {
      const row = makeManualRow();
      const manual = ManualStore.rowToManual(row);
      expect(manual.id).toBe(row.id);
      expect(manual.url_pattern).toBe(row.url_pattern);
      expect(manual.task_pattern).toBe(row.task_pattern);
      expect(manual.platform).toBe(row.platform);
      expect(manual.steps).toEqual(row.steps);
      expect(manual.source).toBe(row.source);
    });

    test('defaults null platform to "other"', () => {
      const row = makeManualRow({ platform: null });
      const manual = ManualStore.rowToManual(row);
      expect(manual.platform).toBe('other');
    });

    test('defaults null source to "recorded"', () => {
      const row = makeManualRow({ source: null });
      const manual = ManualStore.rowToManual(row);
      expect(manual.source).toBe('recorded');
    });
  });

  describe('urlMatchesPattern', () => {
    test('matches wildcard subdomain', () => {
      expect(ManualStore.urlMatchesPattern(
        'https://acme.workday.com/en-US/apply/123',
        '*.workday.com/*/apply/*',
      )).toBe(true);
    });

    test('does not match different domain', () => {
      expect(ManualStore.urlMatchesPattern(
        'https://greenhouse.io/jobs/123',
        '*.workday.com/*/apply/*',
      )).toBe(false);
    });

    test('matches exact host', () => {
      expect(ManualStore.urlMatchesPattern(
        'https://careers.google.com/jobs/results',
        'careers.google.com/jobs/results',
      )).toBe(true);
    });

    test('trailing slash normalization', () => {
      expect(ManualStore.urlMatchesPattern(
        'https://example.com/apply/',
        'example.com/apply',
      )).toBe(true);
    });
  });

  describe('urlToPattern', () => {
    test('wildcards subdomain and dynamic segments', () => {
      const pattern = ManualStore.urlToPattern(
        'https://acme.myworkdayjobs.com/en-US/careers/job/NYC/apply',
      );
      expect(pattern).toContain('*.myworkdayjobs.com');
      expect(pattern).toContain('*');
    });

    test('preserves static path segments', () => {
      const pattern = ManualStore.urlToPattern(
        'https://careers.google.com/jobs/results',
      );
      expect(pattern).toContain('jobs');
      expect(pattern).toContain('results');
    });

    test('wildcards numeric path segments', () => {
      const pattern = ManualStore.urlToPattern('https://boards.greenhouse.io/jobs/12345');
      expect(pattern).toBe('*.greenhouse.io/jobs/*');
    });

    test('wildcards UUID path segments', () => {
      const pattern = ManualStore.urlToPattern(
        'https://jobs.lever.co/company/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      );
      expect(pattern).toBe('*.lever.co/company/*');
    });
  });

  describe('table name compliance', () => {
    test('uses gh_action_manuals table (gh_ prefix)', async () => {
      const row = makeManualRow();
      mockSupa = createMockSupabase([row]);
      store = new ManualStore({ supabase: mockSupa.client });

      await store.lookup('https://acme.workday.com/apply/1', 'apply');

      expect(mockSupa.client.from).toHaveBeenCalledWith('gh_action_manuals');
    });
  });
});
