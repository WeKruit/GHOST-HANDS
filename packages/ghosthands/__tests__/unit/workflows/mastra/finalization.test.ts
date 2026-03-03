/**
 * PRD V5.2 Section 14 — Finalization Helpers Unit Tests
 *
 * Tests the shared finalization logic that both the legacy JobExecutor path
 * and the Mastra workflow path use for post-execution lifecycle:
 * - finalizeCookbookSuccess: cookbook replay completion
 * - finalizeHandlerResult: handler execution completion + awaiting review
 *
 * All external services are mocked (Supabase, adapters, cost trackers, etc).
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

import {
  finalizeCookbookSuccess,
  finalizeHandlerResult,
} from '../../../../src/workers/finalization.js';

import type { AutomationJob, TaskResult } from '../../../../src/workers/taskHandlers/types.js';
import type { ExecutionResult } from '../../../../src/engine/ExecutionEngine.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../src/workers/callbackNotifier.js', () => ({
  callbackNotifier: {
    notifyFromJob: vi.fn().mockResolvedValue(true),
    notifyHumanNeeded: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../../../src/workers/costControl.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    CostControlService: class MockCostControlService {
      recordJobCost = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// Import after mocking so the mocked modules are used
import { callbackNotifier } from '../../../../src/workers/callbackNotifier.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createMockSupabase() {
  const eqFn = vi.fn().mockResolvedValue({ data: null, error: null });
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
  const singleFn = vi.fn().mockResolvedValue({ data: null, error: null });
  const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
  const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });
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
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    getBrowserSession: vi.fn().mockResolvedValue(null),
    page: {
      context: vi.fn().mockReturnValue({
        storageState: vi.fn().mockResolvedValue({}),
      }),
    },
    type: 'mock' as const,
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

function makeEngineResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    mode: 'cookbook',
    cookbookSteps: 10,
    magnitudeSteps: 0,
    manualId: 'manual-abc',
    ...overrides,
  };
}

function makeTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: true,
    data: { submitted: true, success_message: 'Application submitted' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// finalizeCookbookSuccess
// ---------------------------------------------------------------------------

describe('finalizeCookbookSuccess', () => {
  test('updates job status to "completed" via Supabase', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeCookbookSuccess({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      engineResult: makeEngineResult(),
    });

    // supabase.from should be called at least twice (metadata update + status update)
    expect(supabase.from).toHaveBeenCalledWith('gh_automation_jobs');

    // The second .update() call should contain status: 'completed'
    const updateCalls = supabase._updateFn.mock.calls;
    const statusUpdate = updateCalls.find(
      (call: any[]) => call[0]?.status === 'completed',
    );
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate[0].status).toBe('completed');
  });

  test('calls uploadScreenshot', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/final.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeCookbookSuccess({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      engineResult: makeEngineResult(),
    });

    // adapter.screenshot is called by captureAndUpload
    expect(adapter.screenshot).toHaveBeenCalled();
    // uploadScreenshot receives the job ID, name, and buffer
    expect(uploadScreenshot).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'final',
      expect.any(Buffer),
    );
  });

  test('fires callback via callbackNotifier when callback_url exists', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeCookbookSuccess({
      job: makeJob({ callback_url: 'https://valet.example.com/callback' }),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      engineResult: makeEngineResult(),
    });

    expect(callbackNotifier.notifyFromJob).toHaveBeenCalled();
    const callArg = (callbackNotifier.notifyFromJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(callArg.callback_url).toBe('https://valet.example.com/callback');
    expect(callArg.status).toBe('completed');
  });

  test('does NOT fire callback when callback_url is null', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeCookbookSuccess({
      job: makeJob({ callback_url: null }),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      engineResult: makeEngineResult(),
    });

    expect(callbackNotifier.notifyFromJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// finalizeHandlerResult
// ---------------------------------------------------------------------------

describe('finalizeHandlerResult', () => {
  test('returns { awaitingReview: true } when taskResult.awaitingUserReview is true', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    const result = await finalizeHandlerResult({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      taskResult: makeTaskResult({ awaitingUserReview: true }),
      finalMode: 'magnitude',
      engineResult: makeEngineResult({ mode: 'magnitude', cookbookSteps: 0, magnitudeSteps: 5 }),
    });

    expect(result).toEqual({ awaitingReview: true });
  });

  test('returns { awaitingReview: false } for normal completion', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    const result = await finalizeHandlerResult({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      taskResult: makeTaskResult({ awaitingUserReview: false }),
      finalMode: 'magnitude',
      engineResult: makeEngineResult({ mode: 'magnitude', cookbookSteps: 0, magnitudeSteps: 5 }),
    });

    expect(result).toEqual({ awaitingReview: false });
  });

  test('updates DB status to "awaiting_review" for review result', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeHandlerResult({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      taskResult: makeTaskResult({ awaitingUserReview: true }),
      finalMode: 'magnitude',
      engineResult: makeEngineResult({ mode: 'magnitude', cookbookSteps: 0, magnitudeSteps: 5 }),
    });

    // Find the update call that sets status to 'awaiting_review'
    const updateCalls = supabase._updateFn.mock.calls;
    const reviewUpdate = updateCalls.find(
      (call: any[]) => call[0]?.status === 'awaiting_review',
    );
    expect(reviewUpdate).toBeDefined();
    expect(reviewUpdate[0].status).toBe('awaiting_review');
  });

  test('updates DB status to "completed" for normal completion', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    await finalizeHandlerResult({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      taskResult: makeTaskResult({ awaitingUserReview: false }),
      finalMode: 'magnitude',
      engineResult: makeEngineResult({ mode: 'magnitude', cookbookSteps: 0, magnitudeSteps: 5 }),
    });

    // Find the update call that sets status to 'completed'
    const updateCalls = supabase._updateFn.mock.calls;
    const completedUpdate = updateCalls.find(
      (call: any[]) => call[0]?.status === 'completed',
    );
    expect(completedUpdate).toBeDefined();
    expect(completedUpdate[0].status).toBe('completed');
  });

  test('does NOT block indefinitely (returns immediately)', async () => {
    const supabase = createMockSupabase();
    const adapter = createMockAdapter();
    const costTracker = createMockCostTracker();
    const progress = createMockProgress();
    const uploadScreenshot = vi.fn().mockResolvedValue('https://cdn.example.com/screenshot.png');
    const logEvent = vi.fn().mockResolvedValue(undefined);

    // Use a tight timeout to prove the function returns promptly
    const TIMEOUT_MS = 5000;
    const startTime = Date.now();

    const resultPromise = finalizeHandlerResult({
      job: makeJob(),
      adapter: adapter as any,
      costTracker: costTracker as any,
      progress: progress as any,
      sessionManager: null,
      workerId: 'worker-1',
      supabase: supabase as any,
      logEvent,
      uploadScreenshot,
      taskResult: makeTaskResult({ awaitingUserReview: true }),
      finalMode: 'magnitude',
      engineResult: makeEngineResult({ mode: 'magnitude', cookbookSteps: 0, magnitudeSteps: 5 }),
    });

    // Race the function against a timeout
    const result = await Promise.race([
      resultPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), TIMEOUT_MS)),
    ]);

    const elapsed = Date.now() - startTime;

    // The function should return well within the timeout, not block
    expect(result).not.toBe('timeout');
    expect(result).toEqual({ awaitingReview: true });
    expect(elapsed).toBeLessThan(TIMEOUT_MS);
  });
});
