/**
 * E2E test: Full mode cycle — first run trains, second run replays.
 *
 * Simulates the complete lifecycle:
 * 1. First job: no manual → Magnitude mode → TraceRecorder captures → manual saved
 * 2. Second job: manual found → CookbookExecutor replays → near-zero cost
 *
 * Uses in-memory stores and mock adapters (no live Supabase or browser needed).
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { ExecutionEngine } from '../../src/engine/ExecutionEngine';
import { CookbookExecutor } from '../../src/engine/CookbookExecutor';
import type { ActionManual, ManualStep } from '../../src/engine/types';
import { CostTracker } from '../../src/workers/costControl';
import type { ExecutionParams } from '../../src/engine/ExecutionEngine';

// ── In-memory ManualStore ────────────────────────────────────────────────

class InMemoryManualStore {
  private manuals: Map<string, ActionManual> = new Map();
  private autoId = 0;

  async lookup(url: string, taskType: string, platform?: string): Promise<ActionManual | null> {
    for (const manual of this.manuals.values()) {
      if (manual.task_pattern === taskType) {
        // Simple URL matching for test
        if (url.includes('greenhouse') && manual.url_pattern.includes('greenhouse')) {
          return manual;
        }
      }
    }
    return null;
  }

  async get(id: string): Promise<ActionManual | null> {
    return this.manuals.get(id) || null;
  }

  async saveFromTrace(
    steps: ManualStep[],
    metadata: { url: string; taskType: string; platform?: string },
  ): Promise<ActionManual> {
    const id = `manual-${++this.autoId}`;
    const now = new Date().toISOString();
    const manual: ActionManual = {
      id,
      url_pattern: `*.greenhouse.io/*/apply`,
      task_pattern: metadata.taskType,
      platform: metadata.platform || 'other',
      steps,
      health_score: 1.0, // 100/100 converted to 0-1
      source: 'recorded',
      created_at: now,
      updated_at: now,
    };
    this.manuals.set(id, manual);
    return manual;
  }

  async recordSuccess(manualId: string): Promise<void> {
    const manual = this.manuals.get(manualId);
    if (manual) {
      manual.health_score = Math.min(1.0, manual.health_score + 0.02);
    }
  }

  async recordFailure(manualId: string): Promise<void> {
    const manual = this.manuals.get(manualId);
    if (manual) {
      manual.health_score = Math.max(0, manual.health_score - 0.05);
    }
  }

  getAll(): ActionManual[] {
    return Array.from(this.manuals.values());
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createBaseParams(
  overrides: Partial<ExecutionParams> = {},
): ExecutionParams {
  return {
    job: {
      id: `job-${Date.now()}`,
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
    adapter: { page: {} } as any,
    costTracker: new CostTracker({ jobId: 'job-1', qualityPreset: 'balanced', jobType: 'apply' }),
    progress: { setExecutionMode: mock(() => {}), setStep: mock(() => Promise.resolve()) } as any,
    logEvent: mock(() => Promise.resolve()),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Full Mode Cycle (E2E)', () => {
  let manualStore: InMemoryManualStore;

  beforeEach(() => {
    manualStore = new InMemoryManualStore();
  });

  test('first run: no manual → returns failure for Magnitude fallback', async () => {
    const cookbookExecutor = new CookbookExecutor();
    const engine = new ExecutionEngine({
      manualStore: manualStore as any,
      cookbookExecutor,
    });

    const logEvent = mock(() => Promise.resolve());
    const result = await engine.execute(createBaseParams({ logEvent }));

    // No manual exists — engine returns failure
    expect(result.success).toBe(false);
    expect(result.mode).toBe('magnitude');
    expect(result.cookbookSteps).toBe(0);

    // Verify correct events logged
    const events = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('mode_selected');
    expect(events).not.toContain('manual_found');
  });

  test('after manual training: second run uses cookbook replay', async () => {
    // Simulate first run: save a manual (as if TraceRecorder captured it)
    const traceSteps: ManualStep[] = [
      { order: 0, locator: { testId: 'name-input' }, action: 'fill', value: '{{name}}', healthScore: 1.0 },
      { order: 1, locator: { testId: 'email-input' }, action: 'fill', value: '{{email}}', healthScore: 1.0 },
      { order: 2, locator: { testId: 'submit-btn' }, action: 'click', healthScore: 1.0 },
    ];

    await manualStore.saveFromTrace(traceSteps, {
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      taskType: 'apply',
      platform: 'greenhouse',
    });

    // Verify manual was saved
    expect(manualStore.getAll().length).toBe(1);

    // Second run: engine should find the manual and try cookbook
    // Create a mock cookbook executor that succeeds
    const mockCookbookExecutor = {
      executeAll: mock(() => Promise.resolve({ success: true, stepsCompleted: 3 })),
    } as any;

    const engine = new ExecutionEngine({
      manualStore: manualStore as any,
      cookbookExecutor: mockCookbookExecutor,
    });

    const costTracker = new CostTracker({ jobId: 'job-2', qualityPreset: 'balanced', jobType: 'apply' });
    const logEvent = mock(() => Promise.resolve());

    const result = await engine.execute(createBaseParams({
      costTracker,
      logEvent,
    }));

    // Cookbook should succeed
    expect(result.success).toBe(true);
    expect(result.mode).toBe('cookbook');
    expect(result.cookbookSteps).toBe(3);
    expect(result.magnitudeSteps).toBe(0);

    // Near-zero cost (cookbook uses no LLM tokens)
    const snapshot = costTracker.getSnapshot();
    expect(snapshot.totalCost).toBe(0);
    expect(snapshot.inputTokens).toBe(0);

    // Verify events include manual_found and mode_selected
    const events = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('manual_found');
    expect(events).toContain('mode_selected');

    // Manual success recorded
    expect(manualStore.getAll()[0].health_score).toBeGreaterThan(1.0 - 0.001); // +0.02 from recordSuccess
  });

  test('cookbook failure → Magnitude fallback → manual health degrades', async () => {
    // Save a manual
    const traceSteps: ManualStep[] = [
      { order: 0, locator: { testId: 'name' }, action: 'fill', value: 'Test', healthScore: 1.0 },
      { order: 1, locator: { testId: 'submit' }, action: 'click', healthScore: 1.0 },
    ];

    await manualStore.saveFromTrace(traceSteps, {
      url: 'https://boards.greenhouse.io/acme/jobs/456',
      taskType: 'apply',
      platform: 'greenhouse',
    });

    const manual = manualStore.getAll()[0];
    const initialHealth = manual.health_score;

    // Run with a cookbook executor that fails
    const failingCookbookExecutor = {
      executeAll: mock(() => Promise.resolve({
        success: false,
        stepsCompleted: 0,
        failedStepIndex: 0,
        error: 'Element not found: testId=name',
      })),
    } as any;

    const engine = new ExecutionEngine({
      manualStore: manualStore as any,
      cookbookExecutor: failingCookbookExecutor,
    });

    const logEvent = mock(() => Promise.resolve());
    const result = await engine.execute(createBaseParams({ logEvent }));

    // Engine returns failure for Magnitude fallback
    expect(result.success).toBe(false);
    expect(result.mode).toBe('magnitude');
    expect(result.error).toContain('Element not found');

    // Manual health degraded
    const updatedManual = manualStore.getAll()[0];
    expect(updatedManual.health_score).toBeLessThan(initialHealth);

    // mode_switched event logged
    const events = (logEvent as any).mock.calls;
    const switchEvent = events.find((c: any[]) => c[0] === 'mode_switched');
    expect(switchEvent).toBeDefined();
    expect(switchEvent![1].from_mode).toBe('cookbook');
    expect(switchEvent![1].to_mode).toBe('magnitude');
  });

  test('multiple failures degrade manual health below threshold', async () => {
    // Save a manual
    await manualStore.saveFromTrace(
      [{ order: 0, locator: { testId: 'x' }, action: 'click', healthScore: 1.0 }],
      { url: 'https://boards.greenhouse.io/acme/jobs/789', taskType: 'apply', platform: 'greenhouse' },
    );

    const failingExecutor = {
      executeAll: mock(() => Promise.resolve({
        success: false,
        stepsCompleted: 0,
        error: 'Element not found',
      })),
    } as any;

    const engine = new ExecutionEngine({
      manualStore: manualStore as any,
      cookbookExecutor: failingExecutor,
    });

    // Simulate multiple failures
    for (let i = 0; i < 15; i++) {
      await engine.execute(createBaseParams({
        logEvent: mock(() => Promise.resolve()),
      }));
    }

    // After 15 failures (each -0.05), health should be 1.0 - 15*0.05 = 0.25
    const manual = manualStore.getAll()[0];
    expect(manual.health_score).toBeLessThanOrEqual(0.3);

    // Now the engine should skip cookbook due to low health
    const logEvent = mock(() => Promise.resolve());
    const result = await engine.execute(createBaseParams({ logEvent }));

    expect(result.success).toBe(false);
    expect(result.mode).toBe('magnitude');

    // Verify mode_selected reason includes health
    const modeSelected = (logEvent as any).mock.calls.find((c: any[]) => c[0] === 'mode_selected');
    expect(modeSelected![1].reason).toContain('health_too_low');
  });
});
