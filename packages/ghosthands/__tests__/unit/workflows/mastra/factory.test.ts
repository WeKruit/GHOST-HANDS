/**
 * PRD V5.2 Section 5.4 — Step Factory Unit Tests
 *
 * Tests the three Mastra workflow steps created by buildSteps():
 * 1. check_blockers_checkpoint — Blocker detection + HITL suspend/resume
 * 2. cookbook_attempt — Deterministic cookbook replay via ExecutionEngine
 * 3. execute_handler — LLM-driven task handler fallback
 *
 * Also indirectly tests the private mapBlockerCategory helper through
 * the check_blockers_checkpoint step behavior.
 *
 * BUG-3: The check_blockers_checkpoint step does `await suspend(...)`
 * without `return`, which means if suspend does NOT throw, execution
 * falls through to `return state`. The test tagged [BUG-3] exposes this.
 *
 * All external services are mocked (Supabase, adapters, detectors, engines).
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

const mockDetectWithAdapter = vi.fn();

vi.mock('../../../../src/detection/BlockerDetector.js', () => ({
  BlockerDetector: class MockBlockerDetector {
    detectWithAdapter = mockDetectWithAdapter;
  },
}));

const mockEngineExecute = vi.fn();

vi.mock('../../../../src/engine/ExecutionEngine.js', () => ({
  ExecutionEngine: class MockExecutionEngine {
    constructor(_opts: any) {}
    execute = mockEngineExecute;
  },
}));

vi.mock('../../../../src/engine/ManualStore.js', () => ({
  ManualStore: class MockManualStore {
    constructor(_supabase: any) {}
  },
}));

vi.mock('../../../../src/engine/CookbookExecutor.js', () => ({
  CookbookExecutor: class MockCookbookExecutor {
    constructor(_opts: any) {}
  },
}));

vi.mock('../../../../src/workers/callbackNotifier.js', () => ({
  callbackNotifier: {
    notifyHumanNeeded: vi.fn().mockResolvedValue(true),
    notifyFromJob: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../../../src/monitoring/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import under test — AFTER mocks are declared
import { buildSteps } from '../../../../src/workflows/mastra/steps/factory.js';
import type { WorkflowState } from '../../../../src/workflows/mastra/types.js';
import type { RuntimeContext } from '../../../../src/workflows/mastra/types.js';
import type { AutomationJob } from '../../../../src/workers/taskHandlers/types.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    job_type: 'apply',
    target_url: 'https://jobs.example.com/apply',
    task_description: 'Apply to this job',
    input_data: {},
    user_id: 'user-1',
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    metadata: {},
    priority: 0,
    tags: [],
    ...overrides,
  };
}

function createMockSupabase() {
  const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
  const eqFn = vi.fn().mockReturnValue({ neq: neqFn });
  // For chained .eq().eq() or .eq().neq()
  eqFn.mockReturnValue({ eq: eqFn, neq: neqFn, single: vi.fn().mockResolvedValue({ data: null, error: null }) });
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
  return {
    from: vi.fn().mockReturnValue({
      update: updateFn,
      select: selectFn,
    }),
    _updateFn: updateFn,
    _eqFn: eqFn,
  };
}

function createMockAdapter() {
  return {
    type: 'mock' as const,
    act: vi.fn().mockResolvedValue({ success: true }),
    getCurrentUrl: vi.fn().mockResolvedValue('https://jobs.example.com/apply'),
    resume: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    isPaused: vi.fn().mockReturnValue(false),
    observe: vi.fn().mockResolvedValue([]),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(true),
    isConnected: vi.fn().mockReturnValue(true),
    extract: vi.fn().mockResolvedValue({}),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
  };
}

function createMockCostTracker() {
  return {
    getSnapshot: vi.fn().mockReturnValue({
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0.01,
      outputCost: 0.005,
      totalCost: 0.015,
      actionCount: 5,
      cookbookSteps: 0,
      magnitudeSteps: 5,
      imageCost: 0,
      reasoningCost: 0,
    }),
  };
}

function createMockProgress() {
  return {
    setStep: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockHandler() {
  return {
    type: 'apply',
    description: 'Apply handler',
    execute: vi.fn(),
  };
}

function createMockRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    job: makeJob(),
    handler: createMockHandler() as any,
    adapter: createMockAdapter() as any,
    costTracker: createMockCostTracker() as any,
    progress: createMockProgress() as any,
    credentials: null,
    dataPrompt: 'Apply to this job',
    resumeFilePath: null,
    supabase: createMockSupabase() as any,
    logEvent: vi.fn().mockResolvedValue(undefined),
    workerId: 'test-worker-1',
    ...overrides,
  };
}

function makeBaseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    jobId: '550e8400-e29b-41d4-a716-446655440000',
    userId: '550e8400-e29b-41d4-a716-446655440001',
    targetUrl: 'https://jobs.example.com/apply',
    platform: 'greenhouse',
    qualityPreset: 'balanced',
    budgetUsd: 0.5,
    cookbook: {
      attempted: false,
      success: false,
      manualId: null,
      steps: 0,
      error: null,
    },
    handler: {
      attempted: false,
      success: false,
      taskResult: null,
    },
    hitl: {
      blocked: false,
      blockerType: null,
      resumeNonce: null,
      checkpoint: null,
    },
    metrics: {
      costUsd: 0,
      pagesProcessed: 0,
    },
    status: 'running',
    ...overrides,
  };
}

/**
 * Build minimal execute params for calling step.execute() directly.
 * Only provides the fields that factory.ts actually uses.
 */
function makeExecuteParams(overrides: Record<string, any> = {}) {
  return {
    inputData: makeBaseState(),
    resumeData: undefined as any,
    suspend: vi.fn().mockResolvedValue(undefined),
    runId: 'run-test-123',
    workflowId: 'gh_apply',
    mastra: {} as any,
    requestContext: new Map() as any,
    state: {} as any,
    setState: vi.fn().mockResolvedValue(undefined),
    retryCount: 0,
    tracingContext: {} as any,
    getInitData: vi.fn(),
    getStepResult: vi.fn(),
    bail: vi.fn(),
    abort: vi.fn(),
    engine: {} as any,
    abortSignal: new AbortController().signal,
    writer: {} as any,
    outputWriter: undefined,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no blocker detected
  mockDetectWithAdapter.mockResolvedValue(null);
  // Default: engine returns failure (cookbook miss)
  mockEngineExecute.mockResolvedValue({
    success: false,
    mode: 'magnitude',
    cookbookSteps: 0,
    magnitudeSteps: 0,
    error: 'cookbook_miss',
  });
});

// ===========================================================================
// 1. check_blockers_checkpoint (indirectly tests mapBlockerCategory)
// ===========================================================================

describe('check_blockers_checkpoint', () => {
  // ── mapBlockerCategory (tested indirectly) ──

  describe('mapBlockerCategory via blocker detection', () => {
    const validCategories = [
      'captcha',
      'login',
      '2fa',
      'bot_check',
      'rate_limited',
      'verification',
    ] as const;

    for (const category of validCategories) {
      test(`maps valid category "${category}" correctly`, async () => {
        const rt = createMockRuntimeContext();
        const { checkBlockers } = buildSteps(rt);

        mockDetectWithAdapter.mockResolvedValue({
          type: category,
          confidence: 0.9,
          details: `Detected ${category}`,
          source: 'dom',
        });

        const suspend = vi.fn().mockResolvedValue(undefined);
        const params = makeExecuteParams({ suspend });

        await checkBlockers.execute(params);

        // The suspend call should include the mapped blocker type matching the input category
        expect(suspend).toHaveBeenCalledWith(
          expect.objectContaining({ blockerType: category }),
        );
      });
    }

    test('maps unknown category to "verification" (default)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'some_unknown_blocker_type',
        confidence: 0.9,
        details: 'Unknown blocker',
        source: 'dom',
      });

      const suspend = vi.fn().mockResolvedValue(undefined);
      const params = makeExecuteParams({ suspend });

      await checkBlockers.execute(params);

      // Unknown categories default to 'verification'
      expect(suspend).toHaveBeenCalledWith(
        expect.objectContaining({ blockerType: 'verification' }),
      );
    });
  });

  // ── No blocker detected ──

  describe('when no blocker detected', () => {
    test('returns state unchanged when detector returns null', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue(null);

      const inputState = makeBaseState();
      const params = makeExecuteParams({ inputData: inputState });

      const result = await checkBlockers.execute(params);

      expect(result).toEqual(inputState);
      expect(params.suspend).not.toHaveBeenCalled();
    });

    test('returns state unchanged when confidence is below threshold (0.6)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.5,
        details: 'Low confidence captcha',
        source: 'dom',
      });

      const inputState = makeBaseState();
      const params = makeExecuteParams({ inputData: inputState });

      const result = await checkBlockers.execute(params);

      expect(result).toEqual(inputState);
      expect(params.suspend).not.toHaveBeenCalled();
    });

    test('returns state unchanged when confidence is exactly 0.6 (boundary)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.6,
        details: 'Boundary captcha',
        source: 'dom',
      });

      const inputState = makeBaseState();
      const params = makeExecuteParams({ inputData: inputState });

      const result = await checkBlockers.execute(params);

      // confidence 0.6 is NOT > 0.6, so no blocker
      expect(result).toEqual(inputState);
      expect(params.suspend).not.toHaveBeenCalled();
    });
  });

  // ── Blocker detected (confidence > 0.6) ──

  describe('when blocker detected (confidence > 0.6)', () => {
    test('calls suspend with blockerType and pageUrl', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.85,
        details: 'CAPTCHA detected',
        source: 'dom',
      });

      const suspend = vi.fn().mockResolvedValue(undefined);
      const params = makeExecuteParams({ suspend });

      await checkBlockers.execute(params);

      expect(suspend).toHaveBeenCalledWith({
        blockerType: 'captcha',
        pageUrl: 'https://jobs.example.com/apply',
      });
    });

    test('returns suspend sentinel (does not fall through)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'login',
        confidence: 0.9,
        details: 'Login wall detected',
        source: 'dom',
      });

      // suspend() returns a branded void sentinel that the step must `return`
      const suspendSentinel = Symbol('suspend-sentinel');
      const suspend = vi.fn().mockResolvedValue(suspendSentinel);
      const params = makeExecuteParams({ suspend });

      const result = await checkBlockers.execute(params);

      // BUG-3 is fixed: `return await suspend(...)` ensures the sentinel
      // is returned and execution does NOT fall through.
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(result).toBe(suspendSentinel);
    });

    test('pauses job in database', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.85,
        details: 'CAPTCHA',
        source: 'dom',
      });

      const params = makeExecuteParams();
      await checkBlockers.execute(params);

      // Verify supabase was called to pause the job
      expect(rt.supabase.from).toHaveBeenCalledWith('gh_automation_jobs');
    });

    test('logs blocker_detected event', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: '2fa',
        confidence: 0.95,
        details: '2FA prompt',
        source: 'dom',
      });

      const params = makeExecuteParams();
      await checkBlockers.execute(params);

      expect(rt.logEvent).toHaveBeenCalledWith(
        'blocker_detected',
        expect.objectContaining({
          jobId: '550e8400-e29b-41d4-a716-446655440000',
          blockerType: '2fa',
          confidence: 0.95,
        }),
      );
    });
  });

  // ── BUG-3: suspend fallthrough ──

  describe('[BUG-3] suspend fallthrough', () => {
    /**
     * BUG-3: The current code does `await suspend(...)` WITHOUT `return`.
     *
     * In Mastra, suspend() returns an InnerOutput sentinel (branded void).
     * The correct pattern is `return await suspend(...)` so the step's
     * execute function returns InnerOutput to signal suspension.
     *
     * Without `return`, execution falls through past the if-block and
     * hits `return state` at the end, meaning the step returns the
     * modified state object instead of the InnerOutput sentinel.
     *
     * This test mocks suspend as a non-throwing function that returns a
     * unique sentinel value (simulating InnerOutput), then verifies
     * whether the step returns the sentinel or the state.
     *
     * With the bug present: the step returns state (not the sentinel).
     * After fix: the step should return the sentinel.
     */
    test('step returns suspend sentinel via return await suspend(...)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.9,
        details: 'CAPTCHA detected',
        source: 'dom',
      });

      // Simulate Mastra's suspend: returns a unique sentinel object (InnerOutput)
      const SUSPEND_SENTINEL = Symbol.for('mastra.suspend.sentinel');
      const suspend = vi.fn().mockResolvedValue(SUSPEND_SENTINEL);

      const params = makeExecuteParams({ suspend });
      const result = await checkBlockers.execute(params);

      // suspend() was called and its return value is propagated via `return`
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(result).toBe(SUSPEND_SENTINEL);
    });

    test('step returns suspend sentinel — no fallthrough (BUG-3 fixed)', async () => {
      const rt = createMockRuntimeContext();
      const { checkBlockers } = buildSteps(rt);

      mockDetectWithAdapter.mockResolvedValue({
        type: 'captcha',
        confidence: 0.9,
        details: 'CAPTCHA detected',
        source: 'dom',
      });

      const sentinel = Symbol.for('mastra.suspend.sentinel');
      const suspend = vi.fn().mockResolvedValue(sentinel);
      const params = makeExecuteParams({ suspend });
      const result = await checkBlockers.execute(params);

      // BUG-3 is fixed: `return await suspend(...)` returns the sentinel,
      // execution does NOT fall through to `return state`.
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(result).toBe(sentinel);
    });
  });

  // ── Resume path ──

  describe('resume path (resumeData provided)', () => {
    test('processes resumeData and clears HITL state', async () => {
      const rt = createMockRuntimeContext();

      // Mock supabase to return interaction_data on select
      const singleFn = vi.fn().mockResolvedValue({
        data: { interaction_data: {} },
        error: null,
      });
      const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
      const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });
      const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const updateEqFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }), neq: neqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });
      (rt.supabase as any).from = vi.fn().mockReturnValue({
        select: selectFn,
        update: updateFn,
      });

      const { checkBlockers } = buildSteps(rt);

      // Re-detect returns no blocker after resolution
      mockDetectWithAdapter.mockResolvedValue(null);

      const inputState = makeBaseState({
        status: 'suspended',
        hitl: {
          blocked: true,
          blockerType: 'captcha',
          resumeNonce: '550e8400-e29b-41d4-a716-446655440099',
          checkpoint: 'check_blockers_checkpoint',
        },
      });

      const params = makeExecuteParams({
        inputData: inputState,
        resumeData: {
          resolutionType: 'manual',
          resumeNonce: '550e8400-e29b-41d4-a716-446655440099',
        },
      });

      // Mock setTimeout to resolve immediately (bun doesn't support vi.advanceTimersByTimeAsync)
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
        fn(...args);
        return 0 as any;
      }) as typeof setTimeout;
      const result = (await checkBlockers.execute(params)) as WorkflowState;
      globalThis.setTimeout = origSetTimeout;

      // HITL state should be cleared
      expect(result.hitl.blocked).toBe(false);
      expect(result.hitl.blockerType).toBeNull();
      expect(result.hitl.resumeNonce).toBeNull();
      expect(result.hitl.checkpoint).toBeNull();
      expect(result.status).toBe('running');
    });

    test('logs blocker_resolved event', async () => {
      const rt = createMockRuntimeContext();

      const singleFn = vi.fn().mockResolvedValue({
        data: { interaction_data: {} },
        error: null,
      });
      const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
      const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });
      const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const updateEqFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }), neq: neqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });
      (rt.supabase as any).from = vi.fn().mockReturnValue({
        select: selectFn,
        update: updateFn,
      });

      const { checkBlockers } = buildSteps(rt);
      mockDetectWithAdapter.mockResolvedValue(null);

      const params = makeExecuteParams({
        inputData: makeBaseState({ status: 'suspended' }),
        resumeData: {
          resolutionType: 'code_entry',
          resumeNonce: '550e8400-e29b-41d4-a716-446655440099',
        },
      });

      // Mock setTimeout to resolve immediately (bun doesn't support vi.advanceTimersByTimeAsync)
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
        fn(...args);
        return 0 as any;
      }) as typeof setTimeout;
      await checkBlockers.execute(params);
      globalThis.setTimeout = origSetTimeout;

      expect(rt.logEvent).toHaveBeenCalledWith(
        'blocker_resolved',
        expect.objectContaining({
          resolutionType: 'code_entry',
        }),
      );
    });

    test('resumes job status to "running" in database', async () => {
      const rt = createMockRuntimeContext();

      const singleFn = vi.fn().mockResolvedValue({
        data: { interaction_data: {} },
        error: null,
      });
      const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
      const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });
      const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const updateEqFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }), neq: neqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });
      (rt.supabase as any).from = vi.fn().mockReturnValue({
        select: selectFn,
        update: updateFn,
      });

      const { checkBlockers } = buildSteps(rt);
      mockDetectWithAdapter.mockResolvedValue(null);

      const params = makeExecuteParams({
        inputData: makeBaseState({ status: 'suspended' }),
        resumeData: {
          resolutionType: 'skip',
          resumeNonce: '550e8400-e29b-41d4-a716-446655440099',
        },
      });

      // Mock setTimeout to resolve immediately (bun doesn't support vi.advanceTimersByTimeAsync)
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
        fn(...args);
        return 0 as any;
      }) as typeof setTimeout;
      await checkBlockers.execute(params);
      globalThis.setTimeout = origSetTimeout;

      // Verify database update was called to set status to running
      expect(updateFn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running' }),
      );
    });

    test('calls adapter.resume with resolution type', async () => {
      const rt = createMockRuntimeContext();

      const singleFn = vi.fn().mockResolvedValue({
        data: { interaction_data: {} },
        error: null,
      });
      const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
      const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });
      const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
      const updateEqFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }), neq: neqFn });
      const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });
      (rt.supabase as any).from = vi.fn().mockReturnValue({
        select: selectFn,
        update: updateFn,
      });

      const { checkBlockers } = buildSteps(rt);
      mockDetectWithAdapter.mockResolvedValue(null);

      const params = makeExecuteParams({
        inputData: makeBaseState({ status: 'suspended' }),
        resumeData: {
          resolutionType: 'credentials',
          resumeNonce: '550e8400-e29b-41d4-a716-446655440099',
        },
      });

      // Mock setTimeout to resolve immediately (bun doesn't support vi.advanceTimersByTimeAsync)
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
        fn(...args);
        return 0 as any;
      }) as typeof setTimeout;
      await checkBlockers.execute(params);
      globalThis.setTimeout = origSetTimeout;

      expect(rt.adapter.resume).toHaveBeenCalledWith({
        resolutionType: 'credentials',
      });
    });
  });
});

// ===========================================================================
// 2. cookbook_attempt
// ===========================================================================

describe('cookbook_attempt', () => {
  test('sets cookbook.attempted = true', async () => {
    const rt = createMockRuntimeContext();
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: false,
      mode: 'magnitude',
      cookbookSteps: 0,
      magnitudeSteps: 0,
      error: 'cookbook_miss',
    });

    const params = makeExecuteParams();
    const result = (await cookbookAttempt.execute(params)) as WorkflowState;

    expect(result.cookbook.attempted).toBe(true);
  });

  test('sets cookbook.success = true when engine succeeds', async () => {
    const rt = createMockRuntimeContext();
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: true,
      mode: 'cookbook',
      cookbookSteps: 12,
      magnitudeSteps: 0,
      manualId: 'manual-abc-123',
    });

    const params = makeExecuteParams();
    const result = (await cookbookAttempt.execute(params)) as WorkflowState;

    expect(result.cookbook.success).toBe(true);
    expect(result.cookbook.manualId).toBe('manual-abc-123');
    expect(result.cookbook.steps).toBe(12);
    expect(result.cookbook.error).toBeNull();
    expect(result.status).toBe('completed');
  });

  test('sets cookbook.success = false on engine failure', async () => {
    const rt = createMockRuntimeContext();
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: false,
      mode: 'magnitude',
      cookbookSteps: 0,
      magnitudeSteps: 0,
      error: 'cookbook_miss',
    });

    const params = makeExecuteParams();
    const result = (await cookbookAttempt.execute(params)) as WorkflowState;

    expect(result.cookbook.success).toBe(false);
    expect(result.cookbook.error).toBe('cookbook_miss');
    // Status should NOT be set to 'completed' on failure — it stays as input
    expect(result.status).toBe('running');
  });

  test('updates metrics.costUsd from cost tracker', async () => {
    const costTracker = createMockCostTracker();
    costTracker.getSnapshot.mockReturnValue({
      inputTokens: 200,
      outputTokens: 100,
      inputCost: 0.02,
      outputCost: 0.01,
      totalCost: 0.035,
      actionCount: 10,
      cookbookSteps: 5,
      magnitudeSteps: 5,
      imageCost: 0.005,
      reasoningCost: 0,
    });

    const rt = createMockRuntimeContext({ costTracker: costTracker as any });
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: true,
      mode: 'cookbook',
      cookbookSteps: 5,
      magnitudeSteps: 0,
      manualId: 'manual-xyz',
    });

    const params = makeExecuteParams();
    const result = (await cookbookAttempt.execute(params)) as WorkflowState;

    expect(result.metrics.costUsd).toBe(0.035);
  });

  test('passes correct params to engine.execute', async () => {
    const rt = createMockRuntimeContext();
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: false,
      mode: 'magnitude',
      cookbookSteps: 0,
      magnitudeSteps: 0,
    });

    const params = makeExecuteParams();
    await cookbookAttempt.execute(params);

    expect(mockEngineExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        logEvent: rt.logEvent,
        resumeFilePath: rt.resumeFilePath,
      }),
    );
  });

  test('preserves pagesProcessed from input state metrics', async () => {
    const rt = createMockRuntimeContext();
    const { cookbookAttempt } = buildSteps(rt);

    mockEngineExecute.mockResolvedValue({
      success: false,
      mode: 'magnitude',
      cookbookSteps: 0,
      magnitudeSteps: 0,
      error: 'miss',
    });

    const inputState = makeBaseState({
      metrics: { costUsd: 0, pagesProcessed: 7 },
    });
    const params = makeExecuteParams({ inputData: inputState });
    const result = (await cookbookAttempt.execute(params)) as WorkflowState;

    // pagesProcessed should be preserved from input via spread
    expect(result.metrics.pagesProcessed).toBe(7);
  });
});

// ===========================================================================
// 3. execute_handler
// ===========================================================================

describe('execute_handler', () => {
  test('maps handler result to state.handler', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: true,
      data: { submitted: true, confirmation: 'APP-123' },
      screenshotUrl: 'https://cdn.example.com/shot.png',
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.handler.attempted).toBe(true);
    expect(result.handler.success).toBe(true);
    expect(result.handler.taskResult).toEqual({
      success: true,
      data: { submitted: true, confirmation: 'APP-123' },
      error: undefined,
      screenshotUrl: 'https://cdn.example.com/shot.png',
      keepBrowserOpen: undefined,
      awaitingUserReview: undefined,
    });
  });

  test('sets status to "awaiting_review" when awaitingUserReview=true', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: true,
      data: { review_page: true },
      awaitingUserReview: true,
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.status).toBe('awaiting_review');
  });

  test('sets status to "awaiting_review" when keepBrowserOpen=true', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: true,
      data: {},
      keepBrowserOpen: true,
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.status).toBe('awaiting_review');
  });

  test('sets status to "completed" when result.success=true and no review', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: true,
      data: { submitted: true },
      awaitingUserReview: false,
      keepBrowserOpen: false,
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.status).toBe('completed');
  });

  test('sets status to "failed" when result.success=false and no review', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: false,
      error: 'Form submission failed: network timeout',
      awaitingUserReview: false,
      keepBrowserOpen: false,
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.status).toBe('failed');
    expect(result.handler.success).toBe(false);
    expect(result.handler.taskResult?.error).toBe('Form submission failed: network timeout');
  });

  test('sets status to "failed" when success=false and review flags are undefined', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: false,
      error: 'Timeout',
    });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    // awaitingUserReview=undefined and keepBrowserOpen=undefined are falsy,
    // so awaitingReview = false, and success=false => status='failed'
    expect(result.status).toBe('failed');
  });

  test('updates metrics.costUsd from cost tracker', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({
      success: true,
      data: {},
    });

    const costTracker = createMockCostTracker();
    costTracker.getSnapshot.mockReturnValue({
      inputTokens: 500,
      outputTokens: 200,
      inputCost: 0.05,
      outputCost: 0.02,
      totalCost: 0.08,
      actionCount: 15,
      cookbookSteps: 0,
      magnitudeSteps: 15,
      imageCost: 0.01,
      reasoningCost: 0,
    });

    const rt = createMockRuntimeContext({
      handler: handler as any,
      costTracker: costTracker as any,
    });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.metrics.costUsd).toBe(0.08);
  });

  test('passes correct TaskContext to handler.execute', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({ success: true, data: {} });

    const rt = createMockRuntimeContext({
      handler: handler as any,
      credentials: { email: 'test@example.com' },
      dataPrompt: 'Fill out the application form',
      resumeFilePath: '/tmp/resume.pdf',
    });
    const { executeHandler } = buildSteps(rt);

    const params = makeExecuteParams();
    await executeHandler.execute(params);

    expect(handler.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        credentials: { email: 'test@example.com' },
        dataPrompt: 'Fill out the application form',
        resumeFilePath: '/tmp/resume.pdf',
      }),
    );
  });

  test('preserves pagesProcessed from input state metrics', async () => {
    const handler = createMockHandler();
    handler.execute.mockResolvedValue({ success: true, data: {} });

    const rt = createMockRuntimeContext({ handler: handler as any });
    const { executeHandler } = buildSteps(rt);

    const inputState = makeBaseState({
      metrics: { costUsd: 0.01, pagesProcessed: 5 },
    });
    const params = makeExecuteParams({ inputData: inputState });
    const result = (await executeHandler.execute(params)) as WorkflowState;

    expect(result.metrics.pagesProcessed).toBe(5);
  });
});
