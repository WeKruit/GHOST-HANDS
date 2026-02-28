/**
 * SectionOrchestrator unit tests.
 *
 * Tests the orchestration logic: layer selection, escalation,
 * action planning, and page detection.
 */

import { describe, it, expect } from 'bun:test';
import { SectionOrchestrator } from '../../../../src/engine/v3/SectionOrchestrator';
import { LayerHand } from '../../../../src/engine/v3/LayerHand';
import type {
  LayerContext,
  V3ObservationResult,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  AnalysisResult,
  LayerError,
  FormField,
  ButtonInfo,
  EscalationPolicy,
} from '../../../../src/engine/v3/types';

// ── Mock Layer ──────────────────────────────────────────────────────────

class MockLayer extends LayerHand {
  readonly id: 'dom' | 'stagehand' | 'magnitude';
  readonly displayName: string;
  readonly costPerAction: number;
  readonly requiresLLM: boolean;

  public observeCalls = 0;
  public processCalls = 0;
  public executeCalls = 0;
  public reviewCalls = 0;
  public executeResults: ExecutionResult[] = [];
  public reviewResults: ReviewResult[] = [];

  constructor(id: 'dom' | 'stagehand' | 'magnitude', cost = 0) {
    super();
    this.id = id;
    this.displayName = `Mock ${id}`;
    this.costPerAction = cost;
    this.requiresLLM = id !== 'dom';
  }

  async observe(_ctx: LayerContext): Promise<V3ObservationResult> {
    this.observeCalls++;
    return {
      fields: [],
      buttons: [],
      url: 'https://example.com/apply',
      platform: 'unknown',
      pageType: 'unknown',
      fingerprint: 'test',
      blockers: [],
      timestamp: Date.now(),
      observedBy: this.id,
      costIncurred: 0,
    };
  }

  async process(_obs: V3ObservationResult, _ctx: LayerContext): Promise<FieldMatch[]> {
    this.processCalls++;
    return [];
  }

  async execute(actions: PlannedAction[], _ctx: LayerContext): Promise<ExecutionResult[]> {
    this.executeCalls++;
    return this.executeResults.length > 0
      ? this.executeResults
      : actions.map((a) => ({
          success: true,
          layer: this.id,
          field: a.field,
          valueApplied: a.value,
          costIncurred: this.costPerAction,
          durationMs: 10,
        }));
  }

  async review(actions: PlannedAction[], _results: ExecutionResult[], _ctx: LayerContext): Promise<ReviewResult[]> {
    this.reviewCalls++;
    return this.reviewResults.length > 0
      ? this.reviewResults
      : actions.map((a) => ({
          verified: true,
          field: a.field,
          expected: a.value,
          actual: a.value,
          reviewedBy: this.id,
        }));
  }

  async analyze(_obs: V3ObservationResult, _history: V3ObservationResult[], _ctx: LayerContext): Promise<AnalysisResult> {
    return { discoveredFields: [], suggestedValues: [], costIncurred: 0 };
  }

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    return {
      category: this.classifyError(error),
      message: String(error),
      layer: this.id,
      recoverable: true,
      shouldEscalate: this.id !== 'magnitude',
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCtx(): LayerContext {
  return {
    page: {
      url: () => 'https://example.com/apply',
      evaluate: () => Promise.resolve([]),
      waitForTimeout: () => Promise.resolve(),
      waitForLoadState: () => Promise.resolve(),
    } as any,
    userProfile: { firstName: 'John', lastName: 'Doe', email: 'john@example.com' },
    jobId: 'test-job',
    budgetRemaining: 1.0,
    totalCost: 0,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('SectionOrchestrator', () => {
  describe('constructor', () => {
    it('creates with default escalation policy', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);
      expect(orch).toBeDefined();
    });

    it('accepts custom escalation policy', () => {
      const dom = new MockLayer('dom');
      const policy: EscalationPolicy = {
        maxAttemptsPerLayer: 3,
        layerOrder: ['dom', 'magnitude'],
        fastEscalationErrors: ['element_not_found'],
      };
      const orch = new SectionOrchestrator([dom], policy);
      expect(orch).toBeDefined();
    });
  });

  describe('planActions', () => {
    it('assigns DOM layer for high-confidence matches', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'f1',
        selector: '#name',
        fieldType: 'text',
        label: 'First Name',
        required: true,
        visible: true,
        disabled: false,
      };

      const matches: FieldMatch[] = [{
        field,
        userDataKey: 'firstName',
        value: 'John',
        confidence: 0.95,
        matchMethod: 'automation_id',
      }];

      // Access private method
      const actions = (orch as any).planActions(matches);
      expect(actions).toHaveLength(1);
      expect(actions[0].layer).toBe('dom');
    });

    it('assigns Stagehand for medium-confidence matches', () => {
      const dom = new MockLayer('dom');
      const sh = new MockLayer('stagehand', 0.0005);
      const orch = new SectionOrchestrator([dom, sh]);

      const field: FormField = {
        id: 'f1',
        selector: '#name',
        fieldType: 'text',
        label: 'First Name',
        required: true,
        visible: true,
        disabled: false,
      };

      const matches: FieldMatch[] = [{
        field,
        userDataKey: 'firstName',
        value: 'John',
        confidence: 0.7,
        matchMethod: 'label_fuzzy',
      }];

      const actions = (orch as any).planActions(matches);
      expect(actions[0].layer).toBe('stagehand');
    });

    it('assigns Magnitude for low-confidence matches', () => {
      const dom = new MockLayer('dom');
      const mag = new MockLayer('magnitude', 0.005);
      const orch = new SectionOrchestrator([dom, mag]);

      const field: FormField = {
        id: 'f1',
        selector: '#name',
        fieldType: 'text',
        label: 'First Name',
        required: true,
        visible: true,
        disabled: false,
      };

      const matches: FieldMatch[] = [{
        field,
        userDataKey: 'firstName',
        value: 'John',
        confidence: 0.4,
        matchMethod: 'default',
      }];

      const actions = (orch as any).planActions(matches);
      // Falls back to whatever is available — magnitude since no stagehand
      expect(actions[0].layer).toBe('magnitude');
    });
  });

  describe('inferActionType', () => {
    it('maps field types to action types', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      expect((orch as any).inferActionType({ fieldType: 'text' })).toBe('fill');
      expect((orch as any).inferActionType({ fieldType: 'select' })).toBe('select');
      expect((orch as any).inferActionType({ fieldType: 'searchable_select' })).toBe('select');
      expect((orch as any).inferActionType({ fieldType: 'checkbox' })).toBe('check');
      expect((orch as any).inferActionType({ fieldType: 'radio' })).toBe('click');
      expect((orch as any).inferActionType({ fieldType: 'file' })).toBe('upload');
      expect((orch as any).inferActionType({ fieldType: 'email' })).toBe('fill');
    });
  });

  describe('detectLastPage', () => {
    it('returns true when only submit button exists', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#submit', text: 'Submit Application' },
        ],
        url: 'https://example.com',
        platform: 'unknown',
        pageType: 'unknown',
        fingerprint: 'test',
        blockers: [],
        timestamp: Date.now(),
        observedBy: 'dom',
        costIncurred: 0,
      };

      expect((orch as any).detectLastPage(obs)).toBe(true);
    });

    it('returns false when next button exists', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#submit', text: 'Submit' },
          { selector: '#next', text: 'Next' },
        ],
        url: 'https://example.com',
        platform: 'unknown',
        pageType: 'unknown',
        fingerprint: 'test',
        blockers: [],
        timestamp: Date.now(),
        observedBy: 'dom',
        costIncurred: 0,
      };

      expect((orch as any).detectLastPage(obs)).toBe(false);
    });
  });
});
