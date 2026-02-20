/**
 * Integration tests for mode switching in the ExecutionEngine.
 *
 * Tests the interaction between ExecutionEngine, ManualStore, CookbookExecutor,
 * CostTracker, and ProgressTracker — verifying mode decisions, event logging,
 * fallback paths, and cost tracking.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { ExecutionEngine, type ExecutionResult, type ExecutionParams } from '../../../src/engine/ExecutionEngine';
import type { ActionManual, ManualStep } from '../../../src/engine/types';
import { CostTracker } from '../../../src/workers/costControl';

// ── Test data ────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

function makeManualSteps(count: number): ManualStep[] {
  return Array.from({ length: count }, (_, i) => ({
    order: i,
    locator: { testId: `field-${i}` },
    action: 'click' as const,
    healthScore: 1.0,
  }));
}

function makeManual(overrides: Partial<ActionManual> = {}): ActionManual {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    url_pattern: '*.greenhouse.io/*/apply',
    task_pattern: 'apply',
    platform: 'greenhouse',
    steps: makeManualSteps(5),
    health_score: 0.85,
    source: 'recorded',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function createMockManualStore(manual: ActionManual | null) {
  return {
    lookup: mock(() => Promise.resolve(manual)),
    recordSuccess: mock(() => Promise.resolve()),
    recordFailure: mock(() => Promise.resolve()),
  } as any;
}

// ── Cookbook executor that can succeed or fail at a specific step ────────

function createMockCookbookExecutor(config: {
  success: boolean;
  stepsCompleted: number;
  error?: string;
} = { success: true, stepsCompleted: 5 }) {
  return {
    executeAll: mock(() => Promise.resolve({
      success: config.success,
      stepsCompleted: config.stepsCompleted,
      ...(config.error ? { error: config.error, failedStepIndex: config.stepsCompleted } : {}),
    })),
  } as any;
}

function createMockAdapter() {
  return { page: {} } as any;
}

function createBaseParams(overrides: Partial<ExecutionParams> = {}): ExecutionParams {
  return {
    job: {
      id: 'job-test-1',
      job_type: 'apply',
      target_url: 'https://boards.greenhouse.io/acme/jobs/123',
      task_description: 'Apply to job',
      input_data: { user_data: { name: 'Test', email: 'test@example.com' } },
      user_id: 'user-1',
      timeout_seconds: 300,
      max_retries: 3,
      retry_count: 0,
      metadata: {},
      priority: 1,
      tags: [],
    },
    adapter: createMockAdapter(),
    costTracker: new CostTracker({ jobId: 'job-test-1', qualityPreset: 'balanced', jobType: 'apply' }),
    progress: {
      setExecutionMode: mock(() => {}),
      setStep: mock(() => Promise.resolve()),
    } as any,
    logEvent: mock(() => Promise.resolve()),
    ...overrides,
  };
}

// ── Mode switching tests ──────────────────────────────────────────────

describe('Mode Switching Integration', () => {

  describe('manual found → cookbook executes → near-zero cost', () => {
    test('cookbook success results in near-zero LLM cost', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({ success: true, stepsCompleted: 5 });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const params = createBaseParams();
      const result = await engine.execute(params);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('cookbook');
      expect(result.cookbookSteps).toBe(5);
      expect(result.magnitudeSteps).toBe(0);

      // Verify near-zero LLM cost — cookbook doesn't use tokens
      const snapshot = params.costTracker.getSnapshot();
      expect(snapshot.totalCost).toBe(0);
      expect(snapshot.inputTokens).toBe(0);
      expect(snapshot.outputTokens).toBe(0);
    });

    test('records manual success after cookbook completes', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({ success: true, stepsCompleted: 5 });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      await engine.execute(createBaseParams());

      expect(manualStore.recordSuccess).toHaveBeenCalledWith(manual.id);
      expect(manualStore.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('no manual → Magnitude runs → trace recordable', () => {
    test('returns failure for Magnitude fallback when no manual exists', async () => {
      const manualStore = createMockManualStore(null);
      const cookbookExecutor = createMockCookbookExecutor();
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const result = await engine.execute(createBaseParams());

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.manualId).toBeUndefined();
      expect(cookbookExecutor.executeAll).not.toHaveBeenCalled();
    });

    test('logs mode_selected with no_manual_found reason', async () => {
      const manualStore = createMockManualStore(null);
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor: createMockCookbookExecutor() as any });

      const logEvent = mock(() => Promise.resolve());
      await engine.execute(createBaseParams({ logEvent }));

      const modeSelectedCalls = (logEvent as any).mock.calls.filter(
        (c: any[]) => c[0] === 'mode_selected',
      );
      expect(modeSelectedCalls.length).toBe(1);
      expect(modeSelectedCalls[0][1].mode).toBe('magnitude');
      expect(modeSelectedCalls[0][1].reason).toBe('no_manual_found');
    });
  });

  describe('cookbook fails → fallback to Magnitude → job completes', () => {
    test('returns failure with cookbook steps when cookbook fails mid-execution', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({
        success: false,
        stepsCompleted: 3,
        error: 'Element not found for step 3: submit button',
      });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const result = await engine.execute(createBaseParams());

      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(result.manualId).toBe(manual.id);
      expect(result.cookbookSteps).toBe(3);
      expect(result.error).toContain('Element not found');
    });

    test('records failure on the manual after cookbook fails', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({
        success: false,
        stepsCompleted: 2,
        error: 'Timeout waiting for element',
      });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      await engine.execute(createBaseParams());

      expect(manualStore.recordFailure).toHaveBeenCalledWith(manual.id);
      expect(manualStore.recordSuccess).not.toHaveBeenCalled();
    });
  });

  describe('cost tracking across modes', () => {
    test('CostTracker mode is set to cookbook on cookbook path', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({ success: true, stepsCompleted: 5 });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const costTracker = new CostTracker({ jobId: 'job-1', qualityPreset: 'balanced', jobType: 'apply' });
      await engine.execute(createBaseParams({ costTracker }));

      const snapshot = costTracker.getSnapshot();
      expect(snapshot.mode).toBe('cookbook');
    });

    test('CostTracker mode switches to magnitude after cookbook failure', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({
        success: false,
        stepsCompleted: 2,
        error: 'step failed',
      });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const costTracker = new CostTracker({ jobId: 'job-1', qualityPreset: 'balanced', jobType: 'apply' });
      await engine.execute(createBaseParams({ costTracker }));

      const snapshot = costTracker.getSnapshot();
      expect(snapshot.mode).toBe('magnitude');
    });

    test('cookbook execution uses zero tokens', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({ success: true, stepsCompleted: 5 });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const costTracker = new CostTracker({ jobId: 'job-1', qualityPreset: 'balanced', jobType: 'apply' });
      await engine.execute(createBaseParams({ costTracker }));

      const snapshot = costTracker.getSnapshot();
      expect(snapshot.inputTokens).toBe(0);
      expect(snapshot.outputTokens).toBe(0);
      expect(snapshot.totalCost).toBe(0);
    });
  });

  describe('event logging (mode_selected, mode_switched, manual_found)', () => {
    test('logs manual_found → mode_selected → success sequence', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor({ success: true, stepsCompleted: 5 }) as any,
      });

      const logEvent = mock(() => Promise.resolve());
      await engine.execute(createBaseParams({ logEvent }));

      const calls = (logEvent as any).mock.calls;
      const eventTypes = calls.map((c: any[]) => c[0]);

      expect(eventTypes).toContain('manual_found');
      expect(eventTypes).toContain('mode_selected');

      // Verify manual_found has correct data
      const manualFoundCall = calls.find((c: any[]) => c[0] === 'manual_found');
      expect(manualFoundCall![1].manual_id).toBe(manual.id);
      expect(manualFoundCall![1].health_score).toBe(0.85);
    });

    test('logs mode_switched event on cookbook failure', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor({
          success: false,
          stepsCompleted: 1,
          error: 'selector_failed',
        }) as any,
      });

      const logEvent = mock(() => Promise.resolve());
      await engine.execute(createBaseParams({ logEvent }));

      const calls = (logEvent as any).mock.calls;
      const switchCall = calls.find((c: any[]) => c[0] === 'mode_switched');
      expect(switchCall).toBeDefined();
      expect(switchCall![1].from_mode).toBe('cookbook');
      expect(switchCall![1].to_mode).toBe('magnitude');
    });

    test('does not log mode_switched on cookbook success', async () => {
      const manual = makeManual();
      const manualStore = createMockManualStore(manual);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor({ success: true, stepsCompleted: 5 }) as any,
      });

      const logEvent = mock(() => Promise.resolve());
      await engine.execute(createBaseParams({ logEvent }));

      const calls = (logEvent as any).mock.calls;
      const switchCall = calls.find((c: any[]) => c[0] === 'mode_switched');
      expect(switchCall).toBeUndefined();
    });

    test('logs correct event sequence for no-manual path', async () => {
      const manualStore = createMockManualStore(null);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });

      const logEvent = mock(() => Promise.resolve());
      await engine.execute(createBaseParams({ logEvent }));

      const calls = (logEvent as any).mock.calls;
      const eventTypes = calls.map((c: any[]) => c[0]);

      // No manual_found, only mode_selected
      expect(eventTypes).not.toContain('manual_found');
      expect(eventTypes).toContain('mode_selected');
      expect(eventTypes).not.toContain('mode_switched');
    });
  });

  describe('health threshold boundary cases', () => {
    test('health=0.31 allows cookbook execution', async () => {
      const manual = makeManual({ health_score: 0.31 });
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor({ success: true, stepsCompleted: 5 });
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const result = await engine.execute(createBaseParams());
      expect(result.success).toBe(true);
      expect(result.mode).toBe('cookbook');
      expect(cookbookExecutor.executeAll).toHaveBeenCalled();
    });

    test('health=0.30 skips cookbook', async () => {
      const manual = makeManual({ health_score: 0.30 });
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor();
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const result = await engine.execute(createBaseParams());
      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
      expect(cookbookExecutor.executeAll).not.toHaveBeenCalled();
    });

    test('health=0.0 skips cookbook', async () => {
      const manual = makeManual({ health_score: 0.0 });
      const manualStore = createMockManualStore(manual);
      const cookbookExecutor = createMockCookbookExecutor();
      const engine = new ExecutionEngine({ manualStore, cookbookExecutor });

      const result = await engine.execute(createBaseParams());
      expect(result.success).toBe(false);
      expect(result.mode).toBe('magnitude');
    });
  });

  describe('platform detection integration', () => {
    test('detects greenhouse platform from target URL', async () => {
      const manualStore = createMockManualStore(null);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });

      await engine.execute(createBaseParams({
        job: {
          ...createBaseParams().job,
          target_url: 'https://boards.greenhouse.io/acme/jobs/123',
        },
      }));

      expect(manualStore.lookup).toHaveBeenCalledWith(
        'https://boards.greenhouse.io/acme/jobs/123',
        'apply',
        'greenhouse',
      );
    });

    test('detects workday platform from target URL', async () => {
      const manualStore = createMockManualStore(null);
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor: createMockCookbookExecutor() as any,
      });

      await engine.execute(createBaseParams({
        job: {
          ...createBaseParams().job,
          target_url: 'https://acme.myworkdayjobs.com/en-US/careers/job/123/apply',
        },
      }));

      expect(manualStore.lookup).toHaveBeenCalledWith(
        'https://acme.myworkdayjobs.com/en-US/careers/job/123/apply',
        'apply',
        'workday',
      );
    });
  });
});
