import { describe, expect, test, beforeEach } from 'vitest';
import { CostTracker, BudgetExceededError, TASK_BUDGET } from '../../../src/workers/costControl';
import { ProgressTracker } from '../../../src/workers/progressTracker';

// ---------------------------------------------------------------------------
// CostTracker — mode tracking
// ---------------------------------------------------------------------------

describe('CostTracker mode tracking', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker({ jobId: 'test-job-1' });
  });

  test('getSnapshot() includes cookbookSteps=0, magnitudeSteps=0 by default', () => {
    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(0);
    expect(snap.magnitudeSteps).toBe(0);
    expect(snap.mode).toBeUndefined();
  });

  test('recordModeStep("cookbook") increments cookbookSteps', () => {
    tracker.recordModeStep('cookbook');
    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(1);
    expect(snap.magnitudeSteps).toBe(0);
  });

  test('recordModeStep("magnitude") increments magnitudeSteps', () => {
    tracker.recordModeStep('magnitude');
    const snap = tracker.getSnapshot();
    expect(snap.magnitudeSteps).toBe(1);
    expect(snap.cookbookSteps).toBe(0);
  });

  test('setMode sets mode field in snapshot', () => {
    tracker.setMode('cookbook');
    expect(tracker.getSnapshot().mode).toBe('cookbook');

    tracker.setMode('magnitude');
    expect(tracker.getSnapshot().mode).toBe('magnitude');

    tracker.setMode('hybrid');
    expect(tracker.getSnapshot().mode).toBe('hybrid');
  });

  test('multiple recordModeStep calls accumulate correctly', () => {
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('cookbook');
    tracker.recordModeStep('magnitude');
    tracker.recordModeStep('magnitude');

    const snap = tracker.getSnapshot();
    expect(snap.cookbookSteps).toBe(3);
    expect(snap.magnitudeSteps).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — cost calculation from token usage
// ---------------------------------------------------------------------------

describe('CostTracker cost calculation', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker({ jobId: 'cost-test-1', qualityPreset: 'quality' });
  });

  test('recordTokenUsage with explicit costs uses those costs', () => {
    tracker.recordTokenUsage({
      inputTokens: 1000,
      outputTokens: 500,
      inputCost: 0.005,
      outputCost: 0.01,
    });

    const snap = tracker.getSnapshot();
    expect(snap.inputTokens).toBe(1000);
    expect(snap.outputTokens).toBe(500);
    expect(snap.inputCost).toBe(0.005);
    expect(snap.outputCost).toBe(0.01);
    expect(snap.totalCost).toBe(0.015);
  });

  test('recordTokenUsage with zero costs still records tokens', () => {
    tracker.recordTokenUsage({
      inputTokens: 5000,
      outputTokens: 2000,
      inputCost: 0,
      outputCost: 0,
    });

    const snap = tracker.getSnapshot();
    expect(snap.inputTokens).toBe(5000);
    expect(snap.outputTokens).toBe(2000);
    // Without adapter-level cost calculation, costs remain 0
    expect(snap.inputCost).toBe(0);
    expect(snap.outputCost).toBe(0);
    expect(snap.totalCost).toBe(0);
  });

  test('recordTokenUsage without cost fields defaults to 0', () => {
    tracker.recordTokenUsage({
      inputTokens: 1000,
      outputTokens: 500,
    });

    const snap = tracker.getSnapshot();
    expect(snap.inputCost).toBe(0);
    expect(snap.outputCost).toBe(0);
  });

  test('multiple recordTokenUsage calls accumulate correctly', () => {
    // Simulate qwen-72b pricing: $0.25/$0.75 per M tokens
    const inputPricePerToken = 0.25 / 1_000_000;
    const outputPricePerToken = 0.75 / 1_000_000;

    tracker.recordTokenUsage({
      inputTokens: 10000,
      outputTokens: 3000,
      inputCost: 10000 * inputPricePerToken,
      outputCost: 3000 * outputPricePerToken,
    });

    tracker.recordTokenUsage({
      inputTokens: 5000,
      outputTokens: 2000,
      inputCost: 5000 * inputPricePerToken,
      outputCost: 2000 * outputPricePerToken,
    });

    const snap = tracker.getSnapshot();
    expect(snap.inputTokens).toBe(15000);
    expect(snap.outputTokens).toBe(5000);

    const expectedInputCost = 15000 * inputPricePerToken;
    const expectedOutputCost = 5000 * outputPricePerToken;
    expect(snap.inputCost).toBeCloseTo(expectedInputCost, 10);
    expect(snap.outputCost).toBeCloseTo(expectedOutputCost, 10);
    expect(snap.totalCost).toBeCloseTo(expectedInputCost + expectedOutputCost, 10);
  });

  test('throws BudgetExceededError when cost exceeds task budget', () => {
    // Simulate a large usage that exceeds the quality preset budget
    const overBudgetCost = TASK_BUDGET.quality + 0.05;
    expect(() => {
      tracker.recordTokenUsage({
        inputTokens: 100_000,
        outputTokens: 50_000,
        inputCost: overBudgetCost / 2,
        outputCost: overBudgetCost / 2,
      });
    }).toThrow(BudgetExceededError);
  });

  test('cost calculation matches models.config.json pricing for qwen-72b', () => {
    // qwen-72b: input=$0.25/M, output=$0.75/M
    const inputTokens = 50_000;
    const outputTokens = 10_000;
    const inputCost = inputTokens * (0.25 / 1_000_000); // $0.0125
    const outputCost = outputTokens * (0.75 / 1_000_000); // $0.0075

    tracker.recordTokenUsage({ inputTokens, outputTokens, inputCost, outputCost });

    const snap = tracker.getSnapshot();
    expect(snap.totalCost).toBeCloseTo(0.02, 4);
  });

  test('cost calculation matches models.config.json pricing for claude-sonnet', () => {
    // claude-sonnet: input=$3.00/M, output=$15.00/M
    const inputTokens = 50_000;
    const outputTokens = 10_000;
    const inputCost = inputTokens * (3.00 / 1_000_000); // $0.15
    const outputCost = outputTokens * (15.00 / 1_000_000); // $0.15

    tracker.recordTokenUsage({ inputTokens, outputTokens, inputCost, outputCost });

    const snap = tracker.getSnapshot();
    expect(snap.totalCost).toBeCloseTo(0.30, 4);
  });

  test('cost calculation matches models.config.json pricing for deepseek-chat', () => {
    // deepseek-chat: input=$0.27/M, output=$1.10/M
    const inputTokens = 100_000;
    const outputTokens = 20_000;
    const inputCost = inputTokens * (0.27 / 1_000_000); // $0.027
    const outputCost = outputTokens * (1.10 / 1_000_000); // $0.022

    tracker.recordTokenUsage({ inputTokens, outputTokens, inputCost, outputCost });

    const snap = tracker.getSnapshot();
    expect(snap.totalCost).toBeCloseTo(0.049, 4);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — end-to-end cost pipeline simulation
// ---------------------------------------------------------------------------

describe('CostTracker end-to-end cost pipeline', () => {
  test('simulates Magnitude token event -> CostTracker -> non-zero cost in snapshot', () => {
    // This test simulates the full pipeline:
    // 1. Magnitude emits tokensUsed with token counts but no costs
    // 2. MagnitudeAdapter calculates costs from model pricing
    // 3. CostTracker accumulates the calculated costs
    // 4. Final snapshot has non-zero totalCost

    const tracker = new CostTracker({ jobId: 'pipeline-test', qualityPreset: 'quality' });

    // Simulate what MagnitudeAdapter now does: calculate cost from pricing
    // Using qwen-72b pricing: $0.25/$0.75 per M tokens
    const modelCost = { input: 0.25, output: 0.75 };

    // Simulate 3 LLM calls (typical for a job application)
    const llmCalls = [
      { inputTokens: 15000, outputTokens: 3000 },
      { inputTokens: 12000, outputTokens: 5000 },
      { inputTokens: 8000, outputTokens: 2000 },
    ];

    for (const call of llmCalls) {
      // This is what MagnitudeAdapter now computes before emitting
      const inputCost = call.inputTokens * (modelCost.input / 1_000_000);
      const outputCost = call.outputTokens * (modelCost.output / 1_000_000);

      tracker.recordTokenUsage({
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        inputCost,
        outputCost,
      });
    }

    const snap = tracker.getSnapshot();
    expect(snap.inputTokens).toBe(35000);
    expect(snap.outputTokens).toBe(10000);
    expect(snap.totalCost).toBeGreaterThan(0);

    // Verify exact cost: (35000 * 0.25 + 10000 * 0.75) / 1_000_000
    const expectedTotal = (35000 * 0.25 + 10000 * 0.75) / 1_000_000;
    expect(snap.totalCost).toBeCloseTo(expectedTotal, 10);

    // This would be sent to VALET as llm_cost_cents
    const costCents = Math.round(snap.totalCost * 100);
    expect(costCents).toBeGreaterThan(0);
  });

  test('VALET callback receives non-zero cost', () => {
    // Verify that the cost format VALET expects is non-zero
    const tracker = new CostTracker({ jobId: 'valet-test', qualityPreset: 'balanced' });

    // Simulate adapter-calculated costs (qwen-72b)
    tracker.recordTokenUsage({
      inputTokens: 20000,
      outputTokens: 5000,
      inputCost: 20000 * (0.25 / 1_000_000),
      outputCost: 5000 * (0.75 / 1_000_000),
    });

    const snap = tracker.getSnapshot();

    // Build VALET callback payload (same as callbackNotifier.notifyFromJob)
    const llmCostCents = Math.round(snap.totalCost * 100);
    const costPayload = {
      total_cost_usd: llmCostCents / 100,
      action_count: snap.actionCount,
      total_tokens: snap.inputTokens + snap.outputTokens,
    };

    expect(costPayload.total_cost_usd).toBeGreaterThan(0);
    expect(costPayload.total_tokens).toBe(25000);
  });
});

// ---------------------------------------------------------------------------
// CostTracker — dual-model cost tracking
// ---------------------------------------------------------------------------

describe('CostTracker dual-model cost tracking', () => {
  test('imageCost and reasoningCost default to 0', () => {
    const tracker = new CostTracker({ jobId: 'dual-1' });
    const snap = tracker.getSnapshot();
    expect(snap.imageCost).toBe(0);
    expect(snap.reasoningCost).toBe(0);
  });

  test('recordTokenUsage with role="image" tracks imageCost', () => {
    const tracker = new CostTracker({ jobId: 'dual-2', qualityPreset: 'quality' });

    // qwen-7b image model: $0.05/$0.15 per M tokens
    tracker.recordTokenUsage({
      inputTokens: 20000,
      outputTokens: 5000,
      inputCost: 20000 * (0.05 / 1_000_000),
      outputCost: 5000 * (0.15 / 1_000_000),
      role: 'image',
    });

    const snap = tracker.getSnapshot();
    const expectedImageCost = 20000 * (0.05 / 1_000_000) + 5000 * (0.15 / 1_000_000);
    expect(snap.imageCost).toBeCloseTo(expectedImageCost, 10);
    expect(snap.reasoningCost).toBe(0);
    expect(snap.totalCost).toBeCloseTo(expectedImageCost, 10);
  });

  test('recordTokenUsage with role="reasoning" tracks reasoningCost', () => {
    const tracker = new CostTracker({ jobId: 'dual-3', qualityPreset: 'quality' });

    // deepseek-chat reasoning: $0.27/$1.10 per M tokens
    tracker.recordTokenUsage({
      inputTokens: 30000,
      outputTokens: 8000,
      inputCost: 30000 * (0.27 / 1_000_000),
      outputCost: 8000 * (1.10 / 1_000_000),
      role: 'reasoning',
    });

    const snap = tracker.getSnapshot();
    const expectedReasoningCost = 30000 * (0.27 / 1_000_000) + 8000 * (1.10 / 1_000_000);
    expect(snap.reasoningCost).toBeCloseTo(expectedReasoningCost, 10);
    expect(snap.imageCost).toBe(0);
  });

  test('mixed image + reasoning calls accumulate separately', () => {
    const tracker = new CostTracker({ jobId: 'dual-4', qualityPreset: 'quality' });

    // Image calls (qwen-7b: $0.05/$0.15)
    tracker.recordTokenUsage({
      inputTokens: 15000,
      outputTokens: 3000,
      inputCost: 15000 * (0.05 / 1_000_000),
      outputCost: 3000 * (0.15 / 1_000_000),
      role: 'image',
    });
    tracker.recordTokenUsage({
      inputTokens: 12000,
      outputTokens: 2000,
      inputCost: 12000 * (0.05 / 1_000_000),
      outputCost: 2000 * (0.15 / 1_000_000),
      role: 'image',
    });

    // Reasoning calls (deepseek-chat: $0.27/$1.10)
    tracker.recordTokenUsage({
      inputTokens: 10000,
      outputTokens: 4000,
      inputCost: 10000 * (0.27 / 1_000_000),
      outputCost: 4000 * (1.10 / 1_000_000),
      role: 'reasoning',
    });

    const snap = tracker.getSnapshot();

    const expectedImageCost =
      (15000 + 12000) * (0.05 / 1_000_000) + (3000 + 2000) * (0.15 / 1_000_000);
    const expectedReasoningCost =
      10000 * (0.27 / 1_000_000) + 4000 * (1.10 / 1_000_000);

    expect(snap.imageCost).toBeCloseTo(expectedImageCost, 10);
    expect(snap.reasoningCost).toBeCloseTo(expectedReasoningCost, 10);
    expect(snap.totalCost).toBeCloseTo(expectedImageCost + expectedReasoningCost, 10);
    expect(snap.inputTokens).toBe(37000);
    expect(snap.outputTokens).toBe(9000);
  });

  test('without role, cost goes to reasoningCost by default', () => {
    const tracker = new CostTracker({ jobId: 'dual-5', qualityPreset: 'quality' });

    tracker.recordTokenUsage({
      inputTokens: 5000,
      outputTokens: 1000,
      inputCost: 0.001,
      outputCost: 0.002,
    });

    const snap = tracker.getSnapshot();
    expect(snap.reasoningCost).toBeCloseTo(0.003, 10);
    expect(snap.imageCost).toBe(0);
  });

  test('dual-model provides significant cost savings over single premium model', () => {
    // Compare costs for the same workload using different models
    // Use high maxActions budget to avoid BudgetExceededError (cost comparison only)

    // Single-model scenario: gpt-4o for everything (2 calls)
    // gpt-4o: $2.50/$10.00 per M tokens
    const singleCost =
      2 * (15000 * (2.50 / 1_000_000) + 3000 * (10.00 / 1_000_000));

    // Dual-model scenario: qwen-7b for vision, deepseek-chat for reasoning (2 calls each)
    const imageCost =
      2 * (15000 * (0.05 / 1_000_000) + 3000 * (0.15 / 1_000_000));
    const reasoningCost =
      2 * (15000 * (0.27 / 1_000_000) + 3000 * (1.10 / 1_000_000));
    const dualCost = imageCost + reasoningCost;

    // Dual-model should be significantly cheaper (>90% savings)
    expect(dualCost).toBeLessThan(singleCost * 0.15);

    // Verify via CostTracker
    const tracker = new CostTracker({ jobId: 'savings', qualityPreset: 'quality' });
    tracker.recordTokenUsage({
      inputTokens: 30000,
      outputTokens: 6000,
      inputCost: imageCost,
      outputCost: 0,
      role: 'image',
    });
    tracker.recordTokenUsage({
      inputTokens: 30000,
      outputTokens: 6000,
      inputCost: reasoningCost,
      outputCost: 0,
      role: 'reasoning',
    });

    const snap = tracker.getSnapshot();
    expect(snap.imageCost).toBeCloseTo(imageCost, 10);
    expect(snap.reasoningCost).toBeCloseTo(reasoningCost, 10);
    expect(snap.totalCost).toBeCloseTo(dualCost, 10);
  });
});

// ---------------------------------------------------------------------------
// ProgressTracker — mode tracking
// ---------------------------------------------------------------------------

const mockSupabase = {
  from: () => ({
    insert: () => Promise.resolve({ error: null }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }),
} as any;

describe('ProgressTracker mode tracking', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker({
      jobId: 'test-job-2',
      supabase: mockSupabase,
      workerId: 'worker-1',
    });
  });

  test('getSnapshot() does not include execution_mode by default', () => {
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBeUndefined();
    expect(snap.manual_id).toBeUndefined();
  });

  test('setExecutionMode sets mode and manualId in snapshot', () => {
    tracker.setExecutionMode('cookbook', 'manual-abc-123');
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBe('cookbook');
    expect(snap.manual_id).toBe('manual-abc-123');
  });

  test('setExecutionMode without manualId only sets mode', () => {
    tracker.setExecutionMode('magnitude');
    const snap = tracker.getSnapshot();
    expect(snap.execution_mode).toBe('magnitude');
    expect(snap.manual_id).toBeUndefined();
  });
});
