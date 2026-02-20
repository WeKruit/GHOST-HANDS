import { describe, expect, test, vi, beforeEach } from 'vitest';
import { ExecutionEngine } from '../../../src/engine/ExecutionEngine';
import type { ActionManual } from '../../../src/engine/types';
import type { ExecutionParams } from '../../../src/engine/ExecutionEngine';

// ── Test constants ──────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const MANUAL_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeManual(overrides: Partial<ActionManual> = {}): ActionManual {
  return {
    id: MANUAL_ID,
    url_pattern: '*.greenhouse.io/*/apply',
    task_pattern: 'apply',
    platform: 'greenhouse',
    steps: [
      { order: 0, locator: { testId: 'name' }, action: 'fill', value: '{{name}}', healthScore: 1.0 },
      { order: 1, locator: { testId: 'submit' }, action: 'click', healthScore: 1.0 },
    ],
    health_score: 0.8,
    source: 'recorded',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// ── Mock factories ──────────────────────────────────────────────────────

function createMockManualStore(manual: ActionManual | null = null) {
  return {
    lookup: vi.fn(() => Promise.resolve(manual)),
    recordSuccess: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() => Promise.resolve()),
  };
}

function createMockCookbookExecutor(success = true, stepsCompleted = 2, error?: string) {
  return {
    executeAll: vi.fn(() =>
      Promise.resolve({
        success,
        stepsCompleted,
        ...(error ? { error, failedStepIndex: stepsCompleted } : {}),
      }),
    ),
  };
}

function createMockAdapter() {
  return {
    page: {} as any,
  } as any;
}

function createMockCostTracker() {
  return {
    setMode: vi.fn(() => {}),
    recordModeStep: vi.fn(() => {}),
    getSnapshot: vi.fn(() => ({})),
  } as any;
}

function createMockProgress() {
  return {
    setExecutionMode: vi.fn(() => {}),
    setStep: vi.fn(() => Promise.resolve()),
  } as any;
}

function createMockLogEvent() {
  return vi.fn((_eventType: string, _metadata: Record<string, any>) => Promise.resolve());
}

function createParams(overrides: Partial<ExecutionParams> = {}): ExecutionParams {
  return {
    job: {
      id: 'job-1',
      job_type: 'apply',
      target_url: 'https://boards.greenhouse.io/acme/apply',
      task_description: 'Apply to job',
      input_data: { user_data: { name: 'Alice' } },
      user_id: 'user-1',
      timeout_seconds: 300,
      max_retries: 3,
      retry_count: 0,
      metadata: {},
      priority: 1,
      tags: [],
    },
    adapter: createMockAdapter(),
    costTracker: createMockCostTracker(),
    progress: createMockProgress(),
    logEvent: createMockLogEvent(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;
  let manualStore: ReturnType<typeof createMockManualStore>;
  let cookbookExecutor: ReturnType<typeof createMockCookbookExecutor>;

  describe('cookbook success path', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(true, 2);
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('manual found with good health executes cookbook and returns success', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('cookbook');
      expect(result.manualId).toBe(MANUAL_ID);
      expect(result.cookbookSteps).toBe(2);
      expect(result.magnitudeSteps).toBe(0);
    });

    test('records success on manual store after cookbook succeeds', async () => {
      const params = createParams();
      await engine.execute(params);

      expect(manualStore.recordSuccess).toHaveBeenCalledTimes(1);
      expect(manualStore.recordSuccess).toHaveBeenCalledWith(MANUAL_ID);
    });

    test('passes user_data from job input_data to cookbook executor', async () => {
      const params = createParams();
      await engine.execute(params);

      expect(cookbookExecutor.executeAll).toHaveBeenCalledTimes(1);
      const callArgs = (cookbookExecutor.executeAll as any).mock.calls[0];
      expect(callArgs[2]).toEqual({ name: 'Alice' });
    });
  });

  describe('no manual found', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(null);
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('returns failure with mode=magnitude when no manual found', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.manualId).toBeUndefined();
      expect(result.cookbookSteps).toBe(0);
    });

    test('does not call cookbook executor when no manual found', async () => {
      const params = createParams();
      await engine.execute(params);

      expect(cookbookExecutor.executeAll).not.toHaveBeenCalled();
    });

    test('logs mode_selected as magnitude with reason', async () => {
      const logEvent = createMockLogEvent();
      const params = createParams({ logEvent });
      await engine.execute(params);

      expect(logEvent).toHaveBeenCalledWith('mode_selected', {
        mode: 'magnitude',
        reason: 'no_manual_found',
      });
    });
  });

  describe('manual with low health', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(makeManual({ health_score: 0.2 }));
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('skips cookbook when health <= 0.3 and returns magnitude mode', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.manualId).toBe(MANUAL_ID);
    });

    test('does not call cookbook executor when health is low', async () => {
      const params = createParams();
      await engine.execute(params);

      expect(cookbookExecutor.executeAll).not.toHaveBeenCalled();
    });

    test('logs manual_found then mode_selected with health reason', async () => {
      const logEvent = createMockLogEvent();
      const params = createParams({ logEvent });
      await engine.execute(params);

      // manual_found is always logged when manual exists
      expect(logEvent).toHaveBeenCalledWith('manual_found', {
        manual_id: MANUAL_ID,
        health_score: 0.2,
        url_pattern: '*.greenhouse.io/*/apply',
      });

      // mode_selected with health reason
      expect(logEvent).toHaveBeenCalledWith('mode_selected', {
        mode: 'magnitude',
        manual_id: MANUAL_ID,
        reason: 'health_too_low: 0.2',
      });
    });
  });

  describe('manual at exact health threshold (0.3)', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(makeManual({ health_score: 0.3 }));
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('skips cookbook at exactly 0.3 health (threshold is <=)', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(cookbookExecutor.executeAll).not.toHaveBeenCalled();
    });
  });

  describe('cookbook execution failure', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(false, 1, 'Element not found for step 1');
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('returns failure with mode=magnitude when cookbook fails', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.manualId).toBe(MANUAL_ID);
      expect(result.error).toBe('Element not found for step 1');
      expect(result.cookbookSteps).toBe(1);
    });

    test('calls recordFailure on manual store after cookbook failure', async () => {
      const params = createParams();
      await engine.execute(params);

      expect(manualStore.recordFailure).toHaveBeenCalledTimes(1);
      expect(manualStore.recordFailure).toHaveBeenCalledWith(MANUAL_ID);
    });

    test('logs mode_switched event on cookbook failure', async () => {
      const logEvent = createMockLogEvent();
      const params = createParams({ logEvent });
      await engine.execute(params);

      expect(logEvent).toHaveBeenCalledWith('mode_switched', {
        from_mode: 'cookbook',
        to_mode: 'magnitude',
        reason: 'Element not found for step 1',
      });
    });
  });

  describe('cookbook throws unexpected error', () => {
    beforeEach(() => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = {
        executeAll: vi.fn(() => Promise.reject(new Error('CDP connection lost'))),
      };
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });
    });

    test('handles thrown errors gracefully and returns magnitude mode', async () => {
      const params = createParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.error).toBe('CDP connection lost');
      expect(result.cookbookSteps).toBe(0);
    });

    test('records failure and logs mode_switched on thrown error', async () => {
      const logEvent = createMockLogEvent();
      const params = createParams({ logEvent });
      await engine.execute(params);

      expect(manualStore.recordFailure).toHaveBeenCalledWith(MANUAL_ID);
      expect(logEvent).toHaveBeenCalledWith('mode_switched', {
        from_mode: 'cookbook',
        to_mode: 'magnitude',
        reason: 'cookbook_error: CDP connection lost',
      });
    });
  });

  describe('event logging', () => {
    test('logs mode_selected for every execution path', async () => {
      // Path 1: no manual
      const store1 = createMockManualStore(null);
      const eng1 = new ExecutionEngine({
        manualStore: store1 as any,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });
      const log1 = createMockLogEvent();
      await eng1.execute(createParams({ logEvent: log1 }));
      const modeSelectedCalls1 = (log1 as any).mock.calls.filter(
        (c: any[]) => c[0] === 'mode_selected',
      );
      expect(modeSelectedCalls1.length).toBe(1);

      // Path 2: manual found, cookbook success
      const store2 = createMockManualStore(makeManual());
      const eng2 = new ExecutionEngine({
        manualStore: store2 as any,
        cookbookExecutor: createMockCookbookExecutor(true) as any,
      });
      const log2 = createMockLogEvent();
      await eng2.execute(createParams({ logEvent: log2 }));
      const modeSelectedCalls2 = (log2 as any).mock.calls.filter(
        (c: any[]) => c[0] === 'mode_selected',
      );
      expect(modeSelectedCalls2.length).toBe(1);

      // Path 3: manual found, low health
      const store3 = createMockManualStore(makeManual({ health_score: 0.1 }));
      const eng3 = new ExecutionEngine({
        manualStore: store3 as any,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });
      const log3 = createMockLogEvent();
      await eng3.execute(createParams({ logEvent: log3 }));
      const modeSelectedCalls3 = (log3 as any).mock.calls.filter(
        (c: any[]) => c[0] === 'mode_selected',
      );
      expect(modeSelectedCalls3.length).toBe(1);
    });

    test('logs manual_found only when manual exists', async () => {
      // No manual — should not log manual_found
      const store1 = createMockManualStore(null);
      const eng1 = new ExecutionEngine({
        manualStore: store1 as any,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });
      const log1 = createMockLogEvent();
      await eng1.execute(createParams({ logEvent: log1 }));
      const manualFoundCalls1 = (log1 as any).mock.calls.filter(
        (c: any[]) => c[0] === 'manual_found',
      );
      expect(manualFoundCalls1.length).toBe(0);

      // With manual — should log manual_found
      const store2 = createMockManualStore(makeManual());
      const eng2 = new ExecutionEngine({
        manualStore: store2 as any,
        cookbookExecutor: createMockCookbookExecutor(true) as any,
      });
      const log2 = createMockLogEvent();
      await eng2.execute(createParams({ logEvent: log2 }));
      const manualFoundCalls2 = (log2 as any).mock.calls.filter(
        (c: any[]) => c[0] === 'manual_found',
      );
      expect(manualFoundCalls2.length).toBe(1);
    });
  });

  describe('cost tracker and progress tracker integration', () => {
    test('calls costTracker.setMode when available', async () => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(true);
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      const costTracker = createMockCostTracker();
      const params = createParams({ costTracker });
      await engine.execute(params);

      expect(costTracker.setMode).toHaveBeenCalledWith('cookbook');
    });

    test('calls progress.setExecutionMode when available', async () => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(true);
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      const progress = createMockProgress();
      const params = createParams({ progress });
      await engine.execute(params);

      expect(progress.setExecutionMode).toHaveBeenCalledWith('cookbook');
    });

    test('does not throw when costTracker or progress lack mode methods', async () => {
      manualStore = createMockManualStore(null);
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      // Minimal tracker without setMode/setExecutionMode
      const params = createParams({
        costTracker: { getSnapshot: vi.fn(() => ({})) } as any,
        progress: { setStep: vi.fn(() => Promise.resolve()) } as any,
      });

      // Should not throw
      const result = await engine.execute(params);
      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
    });
  });

  describe('user data extraction', () => {
    test('extracts user_data from job.input_data', async () => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(true);
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      const params = createParams({
        job: {
          ...createParams().job,
          input_data: { user_data: { email: 'test@example.com', phone: '555-0100' } },
        },
      });
      await engine.execute(params);

      const callArgs = (cookbookExecutor.executeAll as any).mock.calls[0];
      expect(callArgs[2]).toEqual({ email: 'test@example.com', phone: '555-0100' });
    });

    test('defaults to empty object when user_data is missing', async () => {
      manualStore = createMockManualStore(makeManual());
      cookbookExecutor = createMockCookbookExecutor(true);
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      const params = createParams({
        job: {
          ...createParams().job,
          input_data: {},
        },
      });
      await engine.execute(params);

      const callArgs = (cookbookExecutor.executeAll as any).mock.calls[0];
      expect(callArgs[2]).toEqual({});
    });
  });

  describe('platform detection', () => {
    test('passes detected platform to manual store lookup', async () => {
      manualStore = createMockManualStore(null);
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      // Greenhouse URL
      const params = createParams({
        job: {
          ...createParams().job,
          target_url: 'https://boards.greenhouse.io/acme/jobs/123',
        },
      });
      await engine.execute(params);

      expect(manualStore.lookup).toHaveBeenCalledWith(
        'https://boards.greenhouse.io/acme/jobs/123',
        'apply',
        'greenhouse',
      );
    });

    test('passes "other" platform for unknown URLs', async () => {
      manualStore = createMockManualStore(null);
      cookbookExecutor = createMockCookbookExecutor();
      engine = new ExecutionEngine({
        manualStore: manualStore as any,
        cookbookExecutor: cookbookExecutor as any,
      });

      const params = createParams({
        job: {
          ...createParams().job,
          target_url: 'https://custom-ats.example.com/apply',
        },
      });
      await engine.execute(params);

      expect(manualStore.lookup).toHaveBeenCalledWith(
        'https://custom-ats.example.com/apply',
        'apply',
        'other',
      );
    });
  });
});
