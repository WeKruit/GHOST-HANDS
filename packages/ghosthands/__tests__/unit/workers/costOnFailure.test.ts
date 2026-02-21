import { describe, expect, test, beforeEach } from 'vitest';
import { CostTracker, CostControlService, BudgetExceededError, ActionLimitExceededError, TASK_BUDGET } from '../../../src/workers/costControl';
import { CallbackNotifier } from '../../../src/workers/callbackNotifier';

// ---------------------------------------------------------------------------
// CostTracker — getSnapshot() edge cases for failure scenarios
// ---------------------------------------------------------------------------

describe('CostTracker getSnapshot() failure edge cases', () => {
  test('returns all zeros when no tokens have been used', () => {
    const tracker = new CostTracker({ jobId: 'zero-cost-1' });
    const snap = tracker.getSnapshot();

    expect(snap.inputTokens).toBe(0);
    expect(snap.outputTokens).toBe(0);
    expect(snap.inputCost).toBe(0);
    expect(snap.outputCost).toBe(0);
    expect(snap.totalCost).toBe(0);
    expect(snap.actionCount).toBe(0);
    expect(snap.cookbookSteps).toBe(0);
    expect(snap.magnitudeSteps).toBe(0);
    expect(snap.imageCost).toBe(0);
    expect(snap.reasoningCost).toBe(0);
  });

  test('returns accumulated values after partial execution', () => {
    const tracker = new CostTracker({ jobId: 'partial-1', qualityPreset: 'quality' });

    // Simulate 2 LLM calls before failure
    tracker.recordTokenUsage({
      inputTokens: 5000,
      outputTokens: 1000,
      inputCost: 0.005,
      outputCost: 0.002,
    });
    tracker.recordAction();
    tracker.recordTokenUsage({
      inputTokens: 3000,
      outputTokens: 800,
      inputCost: 0.003,
      outputCost: 0.001,
    });
    tracker.recordAction();

    const snap = tracker.getSnapshot();
    expect(snap.inputTokens).toBe(8000);
    expect(snap.outputTokens).toBe(1800);
    expect(snap.totalCost).toBeCloseTo(0.011, 6);
    expect(snap.actionCount).toBe(2);
  });

  test('returns consistent snapshots on repeated calls', () => {
    const tracker = new CostTracker({ jobId: 'consistent-1', qualityPreset: 'balanced' });

    tracker.recordTokenUsage({
      inputTokens: 1000,
      outputTokens: 500,
      inputCost: 0.01,
      outputCost: 0.005,
    });

    const snap1 = tracker.getSnapshot();
    const snap2 = tracker.getSnapshot();
    const snap3 = tracker.getSnapshot();

    expect(snap1).toEqual(snap2);
    expect(snap2).toEqual(snap3);
  });

  test('BudgetExceededError includes cost snapshot at time of exceeded budget', () => {
    const tracker = new CostTracker({ jobId: 'budget-err-1', qualityPreset: 'speed' });

    // Total cost ($0.06) exceeds speed budget
    const totalCost = TASK_BUDGET.speed + 0.01;
    try {
      tracker.recordTokenUsage({
        inputTokens: 50000,
        outputTokens: 20000,
        inputCost: totalCost / 2 + 0.005,
        outputCost: totalCost / 2 - 0.005,
      });
      // Should have thrown
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const budgetErr = err as BudgetExceededError;
      expect(budgetErr.costSnapshot.totalCost).toBeGreaterThan(TASK_BUDGET.speed);
      expect(budgetErr.costSnapshot.inputTokens).toBe(50000);
      expect(budgetErr.costSnapshot.outputTokens).toBe(20000);
      expect(budgetErr.jobId).toBe('budget-err-1');
    }
  });

  test('ActionLimitExceededError includes action count and limit', () => {
    const tracker = new CostTracker({ jobId: 'action-err-1', maxActions: 3 });

    tracker.recordAction(); // 1
    tracker.recordAction(); // 2
    tracker.recordAction(); // 3

    try {
      tracker.recordAction(); // 4 -- exceeds limit of 3
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ActionLimitExceededError);
      const actionErr = err as ActionLimitExceededError;
      expect(actionErr.actionCount).toBe(4);
      expect(actionErr.limit).toBe(3);
      expect(actionErr.jobId).toBe('action-err-1');
    }
  });

  test('getSnapshot() after BudgetExceededError returns the over-budget state', () => {
    const tracker = new CostTracker({ jobId: 'post-budget-1', qualityPreset: 'speed' });

    // Record some initial cost
    tracker.recordTokenUsage({
      inputTokens: 1000,
      outputTokens: 500,
      inputCost: 0.020,
      outputCost: 0.015,
    });

    // This will exceed the speed budget
    try {
      tracker.recordTokenUsage({
        inputTokens: 10000,
        outputTokens: 5000,
        inputCost: 0.015,
        outputCost: 0.010,
      });
    } catch {
      // Expected
    }

    // Snapshot should reflect the full accumulated cost (including the over-budget usage)
    const snap = tracker.getSnapshot();
    expect(snap.totalCost).toBeCloseTo(0.06, 4);
    expect(snap.inputTokens).toBe(11000);
    expect(snap.outputTokens).toBe(5500);
  });
});

// ---------------------------------------------------------------------------
// CallbackNotifier — cost always present in payload
// ---------------------------------------------------------------------------

describe('CallbackNotifier always includes cost in payload', () => {
  let capturedPayloads: any[];
  let notifier: CallbackNotifier;

  beforeEach(() => {
    capturedPayloads = [];
    // Replace sendWithRetry to capture payloads instead of making HTTP requests
    notifier = new CallbackNotifier();
    (notifier as any).sendWithRetry = async (_url: string, payload: any) => {
      capturedPayloads.push(payload);
      return true;
    };
  });

  test('failed callback includes cost even when llm_cost_cents is 0', async () => {
    await notifier.notifyFromJob({
      id: 'job-1',
      valet_task_id: 'valet-1',
      callback_url: 'https://example.com/callback',
      status: 'failed',
      worker_id: 'worker-1',
      error_code: 'budget_exceeded',
      error_details: { message: 'Budget exceeded' },
      llm_cost_cents: 0,
      action_count: 0,
      total_tokens: 0,
    });

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0];
    expect(payload.status).toBe('failed');
    expect(payload.cost).toBeDefined();
    expect(payload.cost.total_cost_usd).toBe(0);
    expect(payload.cost.action_count).toBe(0);
    expect(payload.cost.total_tokens).toBe(0);
  });

  test('failed callback includes cost when llm_cost_cents is null (legacy)', async () => {
    await notifier.notifyFromJob({
      id: 'job-2',
      valet_task_id: 'valet-2',
      callback_url: 'https://example.com/callback',
      status: 'failed',
      worker_id: 'worker-1',
      error_code: 'internal_error',
      error_details: { message: 'Something broke' },
      // llm_cost_cents not set (undefined/null)
    });

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0];
    expect(payload.status).toBe('failed');
    expect(payload.cost).toBeDefined();
    expect(payload.cost.total_cost_usd).toBe(0);
    expect(payload.cost.action_count).toBe(0);
    expect(payload.cost.total_tokens).toBe(0);
  });

  test('failed callback includes cost with partial execution data', async () => {
    await notifier.notifyFromJob({
      id: 'job-3',
      valet_task_id: 'valet-3',
      callback_url: 'https://example.com/callback',
      status: 'failed',
      worker_id: 'worker-1',
      error_code: 'timeout',
      error_details: { message: 'Job execution timeout' },
      llm_cost_cents: 5,
      action_count: 12,
      total_tokens: 25000,
    });

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0];
    expect(payload.status).toBe('failed');
    expect(payload.cost).toBeDefined();
    expect(payload.cost.total_cost_usd).toBe(0.05);
    expect(payload.cost.action_count).toBe(12);
    expect(payload.cost.total_tokens).toBe(25000);
  });

  test('completed callback includes cost data', async () => {
    await notifier.notifyFromJob({
      id: 'job-4',
      valet_task_id: 'valet-4',
      callback_url: 'https://example.com/callback',
      status: 'completed',
      worker_id: 'worker-1',
      result_data: { success_message: 'Done' },
      result_summary: 'Application submitted',
      screenshot_urls: ['https://screenshots.example.com/1.png'],
      llm_cost_cents: 10,
      action_count: 25,
      total_tokens: 50000,
    });

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0];
    expect(payload.status).toBe('completed');
    expect(payload.cost).toBeDefined();
    expect(payload.cost.total_cost_usd).toBe(0.1);
    expect(payload.cost.action_count).toBe(25);
    expect(payload.cost.total_tokens).toBe(50000);
  });

  test('no callback sent when callback_url is missing', async () => {
    const result = await notifier.notifyFromJob({
      id: 'job-5',
      status: 'failed',
      error_code: 'internal_error',
      error_details: { message: 'No callback URL' },
    });

    expect(result).toBe(false);
    expect(capturedPayloads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cost recording integration — simulating exit paths
// ---------------------------------------------------------------------------

describe('Cost recording on all exit paths', () => {
  test('zero-cost failure: preflight failure includes zero cost in callback payload', () => {
    // Simulate what the JobExecutor does on preflight failure
    const costTracker = new CostTracker({ jobId: 'preflight-fail-1' });
    const snapshot = costTracker.getSnapshot();

    // Build the callback payload as JobExecutor does
    const callbackData = {
      id: 'preflight-fail-1',
      status: 'failed',
      error_code: 'budget_exceeded',
      error_details: { message: 'Insufficient monthly budget' },
      llm_cost_cents: Math.round(snapshot.totalCost * 100),
      action_count: snapshot.actionCount,
      total_tokens: snapshot.inputTokens + snapshot.outputTokens,
    };

    expect(callbackData.llm_cost_cents).toBe(0);
    expect(callbackData.action_count).toBe(0);
    expect(callbackData.total_tokens).toBe(0);
  });

  test('partial cost on timeout: captures accumulated tokens and cost', () => {
    const costTracker = new CostTracker({ jobId: 'timeout-1', qualityPreset: 'quality' });

    // Simulate partial work before timeout
    costTracker.recordTokenUsage({
      inputTokens: 10000,
      outputTokens: 3000,
      inputCost: 0.01,
      outputCost: 0.005,
    });
    costTracker.recordAction();
    costTracker.recordAction();
    costTracker.recordAction();

    // Job times out — capture snapshot
    const snapshot = costTracker.getSnapshot();

    expect(snapshot.totalCost).toBeCloseTo(0.015, 6);
    expect(snapshot.actionCount).toBe(3);
    expect(snapshot.inputTokens).toBe(10000);
    expect(snapshot.outputTokens).toBe(3000);

    // Verify callback payload format
    const callbackCost = {
      total_cost_usd: Math.round(snapshot.totalCost * 100) / 100,
      action_count: snapshot.actionCount,
      total_tokens: snapshot.inputTokens + snapshot.outputTokens,
    };

    expect(callbackCost.total_cost_usd).toBe(0.02); // Rounded
    expect(callbackCost.action_count).toBe(3);
    expect(callbackCost.total_tokens).toBe(13000);
  });

  test('budget exceeded: includes the cost that triggered the limit', () => {
    const tracker = new CostTracker({ jobId: 'budget-exceed-1', qualityPreset: 'speed' });

    // First call within budget
    tracker.recordTokenUsage({
      inputTokens: 5000,
      outputTokens: 1000,
      inputCost: 0.020,
      outputCost: 0.010,
    });
    tracker.recordAction();

    // Second call exceeds budget ($0.030 + $0.025 = $0.055 > $0.05)
    let budgetSnapshot: any = null;
    try {
      tracker.recordTokenUsage({
        inputTokens: 8000,
        outputTokens: 3000,
        inputCost: 0.015,
        outputCost: 0.010,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetSnapshot = err.costSnapshot;
      }
    }

    expect(budgetSnapshot).not.toBeNull();
    expect(budgetSnapshot.totalCost).toBeCloseTo(0.055, 4);
    expect(budgetSnapshot.inputTokens).toBe(13000);
    expect(budgetSnapshot.outputTokens).toBe(4000);

    // getSnapshot() after the error should match
    const postErrorSnapshot = tracker.getSnapshot();
    expect(postErrorSnapshot.totalCost).toBeCloseTo(budgetSnapshot.totalCost, 6);
  });

  test('browser crash: captures cost accumulated before crash point', () => {
    const tracker = new CostTracker({ jobId: 'crash-1', qualityPreset: 'quality' });

    // Simulate 5 successful actions, then crash
    for (let i = 0; i < 5; i++) {
      tracker.recordTokenUsage({
        inputTokens: 2000,
        outputTokens: 500,
        inputCost: 0.002,
        outputCost: 0.001,
      });
      tracker.recordAction();
      tracker.recordModeStep('magnitude');
    }

    // Browser crashes here — capture cost
    const snapshot = tracker.getSnapshot();

    expect(snapshot.actionCount).toBe(5);
    expect(snapshot.magnitudeSteps).toBe(5);
    expect(snapshot.totalCost).toBeCloseTo(0.015, 6);
    expect(snapshot.inputTokens).toBe(10000);
    expect(snapshot.outputTokens).toBe(2500);
  });

  test('validation failure: zero cost snapshot is valid', () => {
    const tracker = new CostTracker({ jobId: 'validation-fail-1' });
    const snapshot = tracker.getSnapshot();

    // Build the exact payload format used by JobExecutor for validation failure
    const dbUpdate = {
      status: 'failed',
      error_code: 'validation_error',
      llm_cost_cents: Math.round(snapshot.totalCost * 100),
      action_count: snapshot.actionCount,
      total_tokens: snapshot.inputTokens + snapshot.outputTokens,
    };

    expect(dbUpdate.llm_cost_cents).toBe(0);
    expect(dbUpdate.action_count).toBe(0);
    expect(dbUpdate.total_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CostControlService.recordJobCost — zero cost recording
// ---------------------------------------------------------------------------

describe('CostControlService recordJobCost with atomic RPC', () => {
  test('recordJobCost accepts zero-cost snapshot and calls RPC with correct params', async () => {
    // Build a mock Supabase client that tracks RPC and insert calls
    const insertCalls: any[] = [];
    const rpcCalls: any[] = [];

    const mockSupabase = {
      rpc: (fnName: string, params: any) => {
        rpcCalls.push({ fnName, params });
        return Promise.resolve({ error: null });
      },
      from: (table: string) => {
        if (table === 'gh_job_events') {
          return {
            insert: (data: any) => {
              insertCalls.push({ table, data });
              return Promise.resolve({ error: null });
            },
          };
        }
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { subscription_tier: 'starter' } }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }),
        };
      },
    } as any;

    const service = new CostControlService(mockSupabase);

    // Record zero cost
    const zeroCostSnapshot = {
      inputTokens: 0,
      outputTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      actionCount: 0,
      cookbookSteps: 0,
      magnitudeSteps: 0,
      imageCost: 0,
      reasoningCost: 0,
    };

    // Should not throw
    await service.recordJobCost('user-1', 'job-1', zeroCostSnapshot);

    // Should have called the atomic RPC function
    expect(rpcCalls.length).toBe(1);
    expect(rpcCalls[0].fnName).toBe('gh_increment_user_usage');
    expect(rpcCalls[0].params.p_user_id).toBe('user-1');
    expect(rpcCalls[0].params.p_cost_usd).toBe(0);
    expect(rpcCalls[0].params.p_input_tokens).toBe(0);
    expect(rpcCalls[0].params.p_output_tokens).toBe(0);
    expect(rpcCalls[0].params.p_job_count).toBe(1);

    // Should have inserted a cost event
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].table).toBe('gh_job_events');
    expect(insertCalls[0].data.event_type).toBe('cost_recorded');
    expect(insertCalls[0].data.metadata.total_cost).toBe(0);
  });

  test('recordJobCost passes correct delta values to atomic RPC', async () => {
    const rpcCalls: any[] = [];

    const mockSupabase = {
      rpc: (fnName: string, params: any) => {
        rpcCalls.push({ fnName, params });
        return Promise.resolve({ error: null });
      },
      from: (table: string) => {
        if (table === 'gh_job_events') {
          return {
            insert: () => Promise.resolve({ error: null }),
          };
        }
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { subscription_tier: 'pro' } }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }),
        };
      },
    } as any;

    const service = new CostControlService(mockSupabase);

    const partialCost = {
      inputTokens: 5000,
      outputTokens: 1500,
      inputCost: 0.005,
      outputCost: 0.003,
      totalCost: 0.008,
      actionCount: 3,
      cookbookSteps: 0,
      magnitudeSteps: 3,
      imageCost: 0,
      reasoningCost: 0.008,
    };

    await service.recordJobCost('user-2', 'job-2', partialCost);

    // RPC should receive the *delta* values (not pre-computed totals)
    // This is the key difference: the old code would send total_cost_usd = 1.008
    // (existing 1.0 + 0.008), but the new atomic RPC sends just the delta (0.008)
    // and lets Postgres do the addition server-side.
    expect(rpcCalls.length).toBe(1);
    expect(rpcCalls[0].fnName).toBe('gh_increment_user_usage');
    expect(rpcCalls[0].params.p_cost_usd).toBeCloseTo(0.008, 4);
    expect(rpcCalls[0].params.p_input_tokens).toBe(5000);
    expect(rpcCalls[0].params.p_output_tokens).toBe(1500);
    expect(rpcCalls[0].params.p_job_count).toBe(1);
  });

  test('recordJobCost throws when RPC returns an error', async () => {
    const mockSupabase = {
      rpc: () => Promise.resolve({
        error: { message: 'connection refused' },
      }),
      from: (table: string) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { subscription_tier: 'free' } }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }),
        };
      },
    } as any;

    const service = new CostControlService(mockSupabase);

    const costSnapshot = {
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0.001,
      outputCost: 0.001,
      totalCost: 0.002,
      actionCount: 1,
      cookbookSteps: 0,
      magnitudeSteps: 1,
      imageCost: 0,
      reasoningCost: 0.002,
    };

    await expect(
      service.recordJobCost('user-3', 'job-3', costSnapshot),
    ).rejects.toThrow('Failed to record job cost: connection refused');
  });
});
