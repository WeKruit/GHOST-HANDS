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

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    return {
      category: this.classifyError(error),
      message: String(error),
      layer: this.id,
      recoverable: true,
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
      $: () => Promise.resolve(null),
      waitForSelector: () => Promise.reject(new Error('not found')),
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

    it('falls back to DOM for low-confidence when only DOM layer available', () => {
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
        confidence: 0.4,
        matchMethod: 'default',
      }];

      const actions = (orch as any).planActions(matches);
      // With only DOM available, low-confidence should still assign DOM (not missing stagehand)
      expect(actions[0].layer).toBe('dom');
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

    it('returns false for "Apply" / "Apply Now" buttons (entry page, not terminal)', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#apply', text: 'Apply Now' },
        ],
        url: 'https://example.com/job/123',
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

    it('returns true for "Review and Submit" button', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#submit', text: 'Review and Submit' },
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
  });

  describe('run() — budget exhaustion', () => {
    it('stops and reports error when budget is exhausted', async () => {
      const dom = new MockLayer('dom', 0);
      const orch = new SectionOrchestrator([dom]);

      const ctx = makeCtx();
      ctx.budgetRemaining = 0; // Already exhausted

      const result = await orch.run(ctx);

      // Should stop without marking success
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Budget exhausted'))).toBe(true);
    });
  });

  describe('run() — blocker termination', () => {
    it('stops and reports error when blockers detected', async () => {
      const dom = new MockLayer('dom');
      // Override observe to return blockers
      dom.observe = async () => ({
        fields: [],
        buttons: [],
        url: 'https://example.com/apply',
        platform: 'unknown',
        pageType: 'unknown',
        fingerprint: 'test',
        blockers: [{ category: 'captcha' as const, confidence: 0.95, description: 'reCAPTCHA detected' }],
        timestamp: Date.now(),
        observedBy: 'dom' as const,
        costIncurred: 0,
      });

      const orch = new SectionOrchestrator([dom]);
      const ctx = makeCtx();

      const result = await orch.run(ctx);

      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Blocked'))).toBe(true);
    });
  });

  describe('run() — entry page with Apply button', () => {
    it('does not report success when Apply button found but no fields processed', async () => {
      const dom = new MockLayer('dom');
      // Page with Apply button, no form fields, no Next button
      dom.observe = async () => ({
        fields: [],
        buttons: [{ selector: '#apply', text: 'Apply Now' }],
        url: 'https://example.com/jobs/123',
        platform: 'unknown',
        pageType: 'unknown',
        fingerprint: 'page-1',
        blockers: [],
        timestamp: Date.now(),
        observedBy: 'dom' as const,
        costIncurred: 0,
      });

      const orch = new SectionOrchestrator([dom]);
      const ctx = makeCtx();

      const result = await orch.run(ctx);

      // "Apply Now" should NOT be treated as terminal submit
      // No fields processed + no navigation = stuck, not success
      expect(result.actionsExecuted).toBe(0);
      expect(result.success).toBe(false);
    });
  });

  describe('detectLastPage — disabled buttons', () => {
    it('ignores disabled submit buttons', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#submit', text: 'Submit Application', disabled: true },
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

      // Disabled submit should NOT count as terminal page
      expect((orch as any).detectLastPage(obs)).toBe(false);
    });

    it('ignores disabled next buttons (does not block terminal detection)', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const obs: V3ObservationResult = {
        fields: [],
        buttons: [
          { selector: '#next', text: 'Next', disabled: true },
          { selector: '#submit', text: 'Submit', disabled: false },
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

      // Disabled Next should not prevent terminal detection; enabled Submit counts
      expect((orch as any).detectLastPage(obs)).toBe(true);
    });
  });

  describe('run() — review-only submit page', () => {
    it('reports success on submit-only page when prior pages had verified fills', async () => {
      const dom = new MockLayer('dom');
      let observeCallCount = 0;

      // Page 1: has fields, page 2: submit-only review page
      dom.observe = async () => {
        observeCallCount++;
        if (observeCallCount <= 2) {
          // Page 1 — form with a field
          return {
            fields: [{
              id: 'f1',
              selector: '#name',
              fieldType: 'text' as const,
              label: 'First Name',
              required: true,
              visible: true,
              disabled: false,
            }],
            buttons: [{ selector: '#next', text: 'Next' }],
            url: 'https://example.com/apply/page1',
            platform: 'unknown',
            pageType: 'unknown',
            fingerprint: 'page-1',
            blockers: [],
            timestamp: Date.now(),
            observedBy: 'dom' as const,
            costIncurred: 0,
          };
        }
        // Page 2 — review page, no fields, only Submit
        return {
          fields: [],
          buttons: [{ selector: '#submit', text: 'Submit Application' }],
          url: 'https://example.com/apply/review',
          platform: 'unknown',
          pageType: 'unknown',
          fingerprint: 'page-2',
          blockers: [],
          timestamp: Date.now(),
          observedBy: 'dom' as const,
          costIncurred: 0,
        };
      };

      // Process returns a match for page 1 fields
      dom.process = async (obs) => {
        if (obs.fields.length === 0) return [];
        return obs.fields.map((f) => ({
          field: f,
          userDataKey: 'firstName',
          value: 'John',
          confidence: 0.95,
          matchMethod: 'automation_id' as const,
        }));
      };

      const orch = new SectionOrchestrator([dom]);
      const ctx = makeCtx();

      // Track evaluate calls that receive submitPatternSources (array of regex strings).
      // First such call is the click (return true = clicked successfully).
      // Second such call is the polling verify (return false = button gone = success).
      let submitEvalCalls = 0;
      ctx.page.evaluate = (async (fn: unknown, arg: unknown) => {
        if (Array.isArray(arg) && typeof arg[0] === 'string' && arg[0].includes('submit')) {
          submitEvalCalls++;
          if (submitEvalCalls === 1) return true;  // Click succeeded
          return false; // Button gone → submit succeeded
        }
        return true; // All other evaluate calls (fingerprint, visibility, verify, etc.)
      }) as any;

      // URL changes after navigateNext to simulate page 2
      let urlCallCount = 0;
      ctx.page.url = () => {
        urlCallCount++;
        return urlCallCount > 5
          ? 'https://example.com/apply/review'
          : 'https://example.com/apply/page1';
      };

      const result = await orch.run(ctx);

      // Page 2 is terminal (Submit Application, no Next)
      // Prior page had verified fills → should be success
      expect(result.actionsVerified).toBeGreaterThan(0);
      expect(result.success).toBe(true);
    });
  });

  describe('fieldFingerprint', () => {
    it('uses id-based selectors as-is', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'f1', selector: '#firstName', fieldType: 'text',
        label: 'First Name', required: true, visible: true, disabled: false,
      };
      expect((orch as any).fieldFingerprint(field)).toBe('#firstName');
    });

    it('uses data-automation-id selectors as-is', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'f1', selector: '[data-automation-id="legalNameSection_firstName"]',
        fieldType: 'text', label: 'First Name',
        required: true, visible: true, disabled: false,
      };
      expect((orch as any).fieldFingerprint(field)).toBe('[data-automation-id="legalNameSection_firstName"]');
    });

    it('falls back to label+type+structural metadata for synthetic scan-idx selectors', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'field-3', selector: '[data-gh-scan-idx="5"]',
        fieldType: 'text', label: 'First Name',
        required: true, visible: true, disabled: false,
      };
      // Should NOT use the synthetic selector — falls back to label::type::parent::depth::ord
      expect((orch as any).fieldFingerprint(field)).toBe('label:First Name::text::parent:root::depth:-1::ord:-1');
    });

    it('disambiguates repeated labels by parentContainer and domDepth', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field1: FormField = {
        id: 'field-1', selector: '[data-gh-scan-idx="1"]',
        fieldType: 'text', label: 'Company',
        required: true, visible: true, disabled: false,
        parentContainer: 'workExperience-0',
        domDepth: 5,
      };
      const field2: FormField = {
        id: 'field-5', selector: '[data-gh-scan-idx="5"]',
        fieldType: 'text', label: 'Company',
        required: true, visible: true, disabled: false,
        parentContainer: 'workExperience-1',
        domDepth: 5,
      };

      const fp1 = (orch as any).fieldFingerprint(field1);
      const fp2 = (orch as any).fieldFingerprint(field2);
      // Same label+type but different parent containers → different fingerprints
      expect(fp1).not.toBe(fp2);
      expect(fp1).toBe('label:Company::text::parent:workExperience-0::depth:5::ord:-1');
      expect(fp2).toBe('label:Company::text::parent:workExperience-1::depth:5::ord:-1');
    });

    it('disambiguates same-container siblings by domOrdinal', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field1: FormField = {
        id: 'field-1', selector: '[data-gh-scan-idx="1"]',
        fieldType: 'text', label: 'Company',
        required: true, visible: true, disabled: false,
        parentContainer: 'workExperience',
        domDepth: 5,
        domOrdinal: 0,
      };
      const field2: FormField = {
        id: 'field-5', selector: '[data-gh-scan-idx="5"]',
        fieldType: 'text', label: 'Company',
        required: true, visible: true, disabled: false,
        parentContainer: 'workExperience',
        domDepth: 5,
        domOrdinal: 1,
      };

      const fp1 = (orch as any).fieldFingerprint(field1);
      const fp2 = (orch as any).fieldFingerprint(field2);
      // Same label+type+container+depth but different ordinal → different fingerprints
      expect(fp1).not.toBe(fp2);
      expect(fp1).toBe('label:Company::text::parent:workExperience::depth:5::ord:0');
      expect(fp2).toBe('label:Company::text::parent:workExperience::depth:5::ord:1');
    });

    it('uses name attribute when available for non-durable selectors', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'field-1', selector: '[data-gh-scan-idx="1"]',
        name: 'email', fieldType: 'email', label: 'Email',
        required: true, visible: true, disabled: false,
      };
      expect((orch as any).fieldFingerprint(field)).toBe('name:email');
    });
  });

  describe('run() — submit button click on terminal page', () => {
    it('clicks submit button when terminal page is detected', async () => {
      const dom = new MockLayer('dom');

      dom.observe = async () => ({
        fields: [{
          id: 'f1', selector: '#name', fieldType: 'text' as const,
          label: 'First Name', required: true, visible: true, disabled: false,
        }],
        buttons: [{ selector: '#submit', text: 'Submit Application' }],
        url: 'https://example.com/apply',
        platform: 'unknown',
        pageType: 'unknown',
        fingerprint: 'page-1',
        blockers: [],
        timestamp: Date.now(),
        observedBy: 'dom' as const,
        costIncurred: 0,
      });

      dom.process = async (obs) => {
        if (obs.fields.length === 0) return [];
        return obs.fields.map((f) => ({
          field: f,
          userDataKey: 'firstName',
          value: 'John',
          confidence: 0.95,
          matchMethod: 'automation_id' as const,
        }));
      };

      const orch = new SectionOrchestrator([dom]);
      const ctx = makeCtx();

      // The submit flow has two phases:
      // Phase 1: clickSubmitButton calls page.evaluate with pattern sources → click
      // Phase 2: polling loop calls page.evaluate to check if submit button is gone
      //
      // We track which phase we're in to return appropriate values.
      let phase: 'processPage' | 'click' | 'verify' = 'processPage';
      let evaluateCallCount = 0;
      let verifyCallCount = 0;
      ctx.page.evaluate = (async () => {
        evaluateCallCount++;
        if (phase === 'processPage') {
          // getPageFingerprint, verifyFieldFilled, stale-field-pruning, etc.
          return true;
        }
        if (phase === 'click') {
          // Submit button click — succeeded
          phase = 'verify';
          return true;
        }
        // Verify phase: polling loop checks if submit button still present.
        // After 2 polls, report button gone (simulates slow transition completing).
        verifyCallCount++;
        return verifyCallCount <= 2; // true = still present, then false = gone
      }) as any;

      // URL stays the same (SPA submit, button disappearance is the signal)
      ctx.page.url = () => 'https://example.com/apply';

      // Override waitForTimeout to switch phase when clickSubmitButton starts
      const originalWaitForTimeout = ctx.page.waitForTimeout;
      let waitCalls = 0;
      ctx.page.waitForTimeout = (async () => {
        waitCalls++;
        // processPage fills happen first, then clickSubmitButton does waitForTimeout
        // in its polling loop. Switch to 'click' phase on first polling wait.
        if (waitCalls === 1 && phase === 'processPage') {
          phase = 'click';
        }
        return originalWaitForTimeout?.call(ctx.page);
      }) as any;

      const result = await orch.run(ctx);

      // Terminal page detected → submit button clicked → polling detected button gone → success
      expect(result.actionsVerified).toBeGreaterThan(0);
      expect(result.success).toBe(true);
    });
  });

  describe('planActions — userDataKey threading', () => {
    it('threads userDataKey from FieldMatch into PlannedAction', () => {
      const dom = new MockLayer('dom');
      const orch = new SectionOrchestrator([dom]);

      const field: FormField = {
        id: 'f1',
        selector: '#email',
        fieldType: 'email',
        label: 'Email Address',
        required: true,
        visible: true,
        disabled: false,
      };

      const matches: FieldMatch[] = [{
        field,
        userDataKey: 'email',
        value: 'test@example.com',
        confidence: 0.95,
        matchMethod: 'automation_id',
      }];

      const actions = (orch as any).planActions(matches);
      expect(actions[0].userDataKey).toBe('email');
    });
  });
});
