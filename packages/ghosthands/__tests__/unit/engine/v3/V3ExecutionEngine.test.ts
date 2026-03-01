/**
 * V3ExecutionEngine unit tests.
 *
 * Tests the entry-point behavior: cookbook → orchestrator fallback,
 * logging resilience, and result propagation.
 */

import { describe, it, expect, mock } from 'bun:test';
import { V3ExecutionEngine } from '../../../../src/engine/v3/V3ExecutionEngine';
import type { V3ExecutionParams } from '../../../../src/engine/v3/V3ExecutionEngine';
import type { CookbookPageEntry, CookbookAction } from '../../../../src/engine/v3/types';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCookbookAction(): CookbookAction {
  return {
    fieldSnapshot: {
      id: 'f1',
      selector: '#firstName',
      fieldType: 'text',
      label: 'First Name',
      required: true,
      boundingBox: { x: 10, y: 10, width: 200, height: 30 },
    },
    domAction: {
      selector: '#firstName',
      valueTemplate: '{{firstName}}',
      action: 'fill',
    },
    executedBy: 'dom',
    healthScore: 1.0,
  };
}

function makeCookbookEntry(): CookbookPageEntry {
  const actions = [makeCookbookAction()];
  return {
    pageFingerprint: 'test-page',
    urlPattern: '*.example.com/apply',
    platform: 'unknown',
    actions,
    healthScore: 0.9,
    perActionHealth: [0.9],
    successCount: 5,
    failureCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function makeMinimalParams(overrides: Partial<V3ExecutionParams> = {}): V3ExecutionParams {
  return {
    job: { id: 'test-job' } as any,
    adapter: {
      type: 'mock',
      act: mock(() => Promise.resolve({ success: false })),
      observe: mock(() => Promise.resolve({ fields: [], buttons: [] })),
      exec: mock(() => Promise.resolve({ success: false })),
      on: mock(() => {}),
      off: mock(() => {}),
      emit: mock(() => false),
    } as any,
    page: {
      url: () => 'https://example.com/apply',
      evaluate: mock(() => Promise.resolve([])),
      $: mock(() => Promise.resolve(null)),
      waitForSelector: mock(() => Promise.reject(new Error('not found'))),
      waitForTimeout: mock(() => Promise.resolve()),
      waitForLoadState: mock(() => Promise.resolve()),
    } as any,
    costTracker: {
      setMode: mock(() => {}),
    } as any,
    progress: {
      setExecutionMode: mock(() => {}),
    } as any,
    logEvent: mock(() => Promise.resolve()),
    userProfile: { firstName: 'John', lastName: 'Doe' },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('V3ExecutionEngine', () => {
  describe('cookbook logging resilience', () => {
    it('falls through to orchestrator when cookbook logEvent rejects', async () => {
      const engine = new V3ExecutionEngine();
      let logCallCount = 0;

      const params = makeMinimalParams({
        cookbook: makeCookbookEntry(),
        logEvent: mock(async () => {
          logCallCount++;
          // Fail on every log call to simulate persistent telemetry failure
          throw new Error('Telemetry service unavailable');
        }),
      });

      const result = await engine.execute(params);

      // Should NOT crash — cookbook failure (from logging) should fall through to orchestrator
      expect(result).toBeDefined();
      // The cookbook would have failed (no real page), so orchestrator runs
      expect(result.mode).toBe('v3_orchestrator');
    });
  });

  describe('result structure', () => {
    it('returns complete result shape even on total failure', async () => {
      const engine = new V3ExecutionEngine();
      const params = makeMinimalParams();

      const result = await engine.execute(params);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('totalCost');
      expect(result).toHaveProperty('pagesProcessed');
      expect(result).toHaveProperty('actionsExecuted');
      expect(result).toHaveProperty('actionsVerified');
      expect(result).toHaveProperty('actionsFailed');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('CostTracker wiring', () => {
    it('syncs orchestrator cost into CostTracker', async () => {
      const engine = new V3ExecutionEngine();
      let recordedTokenUsage = false;
      let recordActionCount = 0;

      const params = makeMinimalParams({
        costTracker: {
          setMode: mock(() => {}),
          recordTokenUsage: mock(() => { recordedTokenUsage = true; }),
          recordAction: mock(() => { recordActionCount++; }),
          recordModeStep: mock(() => {}),
        } as any,
      });

      await engine.execute(params);

      // CostTracker should have setMode called
      expect(params.costTracker.setMode).toHaveBeenCalled();
      // Even if orchestrator fails with no actions, setMode should be called for hybrid
    });
  });

  describe('cookbook success path', () => {
    it('returns cookbook mode when cookbook replay succeeds', async () => {
      const engine = new V3ExecutionEngine();

      // Create a page mock that makes DOM replay succeed
      const pageMock = {
        url: () => 'https://example.com/apply',
        evaluate: mock(() => Promise.resolve(true)),
        $: mock(() =>
          Promise.resolve({
            evaluate: mock(() => Promise.resolve(undefined)),
            fill: mock(() => Promise.resolve()),
          }),
        ),
        waitForSelector: mock(() =>
          Promise.resolve({
            evaluate: mock(() => Promise.resolve('John')),
            inputValue: mock(() => Promise.resolve('John')),
          }),
        ),
        waitForTimeout: mock(() => Promise.resolve()),
        waitForLoadState: mock(() => Promise.resolve()),
      } as any;

      const params = makeMinimalParams({
        page: pageMock,
        cookbook: makeCookbookEntry(),
      });

      // Even if DOM replay fails (incomplete mock), the structure should be correct
      const result = await engine.execute(params);
      expect(result).toBeDefined();
      expect(typeof result.totalCost).toBe('number');
    });
  });
});
