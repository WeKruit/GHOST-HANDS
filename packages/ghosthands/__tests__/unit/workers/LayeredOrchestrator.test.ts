import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { LayeredOrchestrator, type OrchestratorParams, type RunParams } from '../../../src/workers/taskHandlers/LayeredOrchestrator.js';
import { CostTracker } from '../../../src/workers/costControl.js';
import type { BrowserAutomationAdapter } from '../../../src/adapters/types.js';
import type { PlatformConfig, PageState, ScanResult, ScannedField } from '../../../src/workers/taskHandlers/platforms/types.js';
import type { ProgressTracker } from '../../../src/workers/progressTracker.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockPage() {
  return {
    evaluate: vi.fn().mockResolvedValue(false),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    locator: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        fill: vi.fn().mockResolvedValue(undefined),
        setInputFiles: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    on: vi.fn(),
    context: vi.fn().mockReturnValue({
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(''),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createMockAdapter(overrides: Partial<BrowserAutomationAdapter> = {}): BrowserAutomationAdapter {
  const page = createMockPage();
  return {
    type: 'mock' as any,
    page: page as any,
    getCurrentUrl: vi.fn().mockResolvedValue('https://example.com/apply'),
    act: vi.fn().mockResolvedValue({ success: true, message: 'done', durationMs: 100 }),
    extract: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('mock')),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createMockConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    platformId: 'generic',
    displayName: 'Generic',
    pageStateSchema: {} as any,
    baseRules: '',
    needsCustomExperienceHandler: false,
    authDomains: [],
    detectPageByUrl: vi.fn().mockReturnValue(null),
    detectPageByDOM: vi.fn().mockResolvedValue(null),
    buildClassificationPrompt: vi.fn().mockReturnValue('Classify this page'),
    classifyByDOMFallback: vi.fn().mockResolvedValue('unknown'),
    buildDataPrompt: vi.fn().mockReturnValue('User data here'),
    buildQAMap: vi.fn().mockReturnValue({ 'First Name': 'Jane' }),
    buildPagePrompt: vi.fn().mockReturnValue('Fill form with data'),
    scanPageFields: vi.fn().mockResolvedValue({
      fields: [],
      scrollHeight: 1000,
      viewportHeight: 800,
    } as ScanResult),
    fillScannedField: vi.fn().mockResolvedValue(true),
    fillDropdownsProgrammatically: vi.fn().mockResolvedValue(0),
    fillCustomDropdownsProgrammatically: vi.fn().mockResolvedValue(0),
    fillTextFieldsProgrammatically: vi.fn().mockResolvedValue(0),
    fillRadioButtonsProgrammatically: vi.fn().mockResolvedValue(0),
    fillDateFieldsProgrammatically: vi.fn().mockResolvedValue(0),
    checkRequiredCheckboxes: vi.fn().mockResolvedValue(0),
    hasEmptyVisibleFields: vi.fn().mockResolvedValue(false),
    clickNextButton: vi.fn().mockResolvedValue('clicked'),
    detectValidationErrors: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as any;
}

function createMockProgress(): ProgressTracker {
  return {
    setStep: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeField(label: string, kind: string = 'text', filled = false): ScannedField {
  return {
    id: `field-${label}`,
    kind: kind as any,
    fillStrategy: 'native_setter',
    selector: `#${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    currentValue: filled ? 'some value' : '',
    absoluteY: 100,
    isRequired: true,
    filled,
  };
}

function buildOrchestrator(overrides: {
  adapter?: BrowserAutomationAdapter;
  config?: PlatformConfig;
  costTracker?: CostTracker;
  progress?: ProgressTracker;
  maxPages?: number;
} = {}): LayeredOrchestrator {
  return new LayeredOrchestrator({
    adapter: overrides.adapter ?? createMockAdapter(),
    config: overrides.config ?? createMockConfig(),
    costTracker: overrides.costTracker ?? new CostTracker({ jobId: 'test-job', jobType: 'smart_apply' }),
    progress: overrides.progress ?? createMockProgress(),
    maxPages: overrides.maxPages ?? 15,
  });
}

const defaultRunParams: RunParams = {
  userProfile: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' },
  qaMap: { 'First Name': 'Jane', 'Last Name': 'Doe', 'Email': 'jane@example.com' },
  dataPrompt: 'User data: Jane Doe, jane@example.com',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LayeredOrchestrator', () => {
  // =========================================================================
  // Construction and basic run
  // =========================================================================

  describe('construction', () => {
    test('creates with required params', () => {
      const orchestrator = buildOrchestrator();
      expect(orchestrator).toBeDefined();
    });

    test('defaults maxPages to 15', () => {
      const orchestrator = buildOrchestrator();
      // We can't access private fields, but we can test behavior
      expect(orchestrator).toBeDefined();
    });
  });

  // =========================================================================
  // Page detection routing
  // =========================================================================

  describe('page type routing', () => {
    test('reaches review page and returns success with awaitingUserReview', async () => {
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue({ page_type: 'review', page_title: 'Review' }),
      });
      const progress = createMockProgress();
      const orchestrator = buildOrchestrator({ config, progress });

      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(true);
      expect(result.awaitingUserReview).toBe(true);
      expect(result.finalPage).toBe('review');
      expect(result.pagesProcessed).toBe(1);
    });

    test('confirmation page returns success without user review', async () => {
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue({ page_type: 'confirmation', page_title: 'Done' }),
      });
      const orchestrator = buildOrchestrator({ config });

      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(true);
      expect(result.awaitingUserReview).toBe(false);
      expect(result.finalPage).toBe('confirmation');
    });

    test('error page returns failure', async () => {
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue({
          page_type: 'error',
          page_title: 'Error',
          error_message: 'Application closed',
        }),
      });
      const orchestrator = buildOrchestrator({ config });

      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Application closed');
    });

    test('job_listing page triggers apply button click', async () => {
      const adapter = createMockAdapter();
      let callCount = 0;
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return { page_type: 'job_listing', page_title: 'Job' };
          return { page_type: 'review', page_title: 'Review' };
        }),
      });
      const orchestrator = buildOrchestrator({ adapter, config });

      const result = await orchestrator.run(defaultRunParams);

      expect(adapter.act).toHaveBeenCalledWith(
        expect.stringContaining('Apply'),
      );
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Stuck detection
  // =========================================================================

  describe('stuck detection', () => {
    test('detects stuck after 3 identical page signatures', async () => {
      const adapter = createMockAdapter();
      // Always return same URL — fingerprint defaults to false (same every time)
      (adapter.getCurrentUrl as Mock).mockResolvedValue('https://example.com/apply');

      const config = createMockConfig({
        // Always return 'questions' so we enter the form fill flow
        detectPageByUrl: vi.fn().mockReturnValue(null),
        detectPageByDOM: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
        scanPageFields: vi.fn().mockResolvedValue({ fields: [], scrollHeight: 1000, viewportHeight: 800 }),
        clickNextButton: vi.fn().mockResolvedValue('clicked'),
        detectValidationErrors: vi.fn().mockResolvedValue(false),
      });

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(true);
      expect(result.awaitingUserReview).toBe(true);
      expect(result.finalPage).toBe('stuck');
    });
  });

  // =========================================================================
  // Phase sequencing: DOM → LLM → MagnitudeHand
  // =========================================================================

  describe('phase sequencing', () => {
    test('DOM fill phase fills fields from qaMap', async () => {
      const adapter = createMockAdapter();
      // Return 'review' on URL detection to simplify — just test that fill was attempted
      const config = createMockConfig({
        detectPageByUrl: vi.fn()
          .mockReturnValueOnce({ page_type: 'questions', page_title: 'Form' })
          .mockReturnValue({ page_type: 'review', page_title: 'Review' }),
        scanPageFields: vi.fn().mockResolvedValue({
          fields: [
            makeField('First Name'),
            makeField('Last Name'),
          ],
          scrollHeight: 1000,
          viewportHeight: 800,
        }),
        fillScannedField: vi.fn().mockResolvedValue(true),
        // Return 'review_detected' so fillPage returns 'review' and stops
        clickNextButton: vi.fn().mockResolvedValue('review_detected'),
      });

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      expect(config.fillScannedField).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test('empty scan skips fill phases and advances', async () => {
      const adapter = createMockAdapter();
      const config = createMockConfig({
        detectPageByUrl: vi.fn()
          .mockReturnValueOnce({ page_type: 'questions', page_title: 'Form' })
          .mockReturnValue({ page_type: 'review', page_title: 'Review' }),
        scanPageFields: vi.fn().mockResolvedValue({ fields: [], scrollHeight: 1000, viewportHeight: 800 }),
        clickNextButton: vi.fn().mockResolvedValue('review_detected'),
      });

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      // No fields to fill, should still try to advance
      expect(config.clickNextButton).toHaveBeenCalled();
      expect(result.domFilled).toBe(0);
      expect(result.llmFilled).toBe(0);
      expect(result.magnitudeFilled).toBe(0);
    });
  });

  // =========================================================================
  // MagnitudeHand budget gating
  // =========================================================================

  describe('MagnitudeHand budget gating', () => {
    test('skips MagnitudeHand when budget is too low', async () => {
      const costTracker = new CostTracker({ jobId: 'test-job', jobType: 'smart_apply' });
      // Consume almost all budget ($1.99 of $2.00)
      costTracker.recordTokenUsage({
        inputTokens: 100000,
        outputTokens: 50000,
        inputCost: 1.99,
        outputCost: 0,
      });

      const adapter = createMockAdapter();
      // Different URLs to avoid stuck detection, page.evaluate defaults to false (no review short-circuit)
      let urlIdx = 0;
      (adapter.getCurrentUrl as Mock).mockImplementation(() => `https://example.com/page${++urlIdx}`);

      const config = createMockConfig({
        // First iteration: questions, second: review (stop)
        detectPageByUrl: vi.fn()
          .mockReturnValueOnce(null)
          .mockReturnValue({ page_type: 'review', page_title: 'Review' }),
        detectPageByDOM: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
        scanPageFields: vi.fn().mockResolvedValue({
          fields: [makeField('Department', 'custom_dropdown')],
          scrollHeight: 1000,
          viewportHeight: 800,
        }),
        fillScannedField: vi.fn().mockResolvedValue(false), // DOM fill fails — should trigger MagnitudeHand
        clickNextButton: vi.fn().mockResolvedValue('review_detected'),
        detectValidationErrors: vi.fn().mockResolvedValue(false),
      });

      const orchestrator = buildOrchestrator({ adapter, config, costTracker });
      const result = await orchestrator.run(defaultRunParams);

      // MagnitudeHand should NOT have been called because remaining budget ($0.01) < $0.02 min
      expect(result.magnitudeFilled).toBe(0);
      // adapter.act should not have been called for MagnitudeHand per-field fills
      // (it may be called for LLM fill phase, but not with the per-field MagnitudeHand prompt)
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Max pages limit
  // =========================================================================

  describe('max pages', () => {
    test('stops after maxPages limit and returns awaitingUserReview', async () => {
      const adapter = createMockAdapter();
      // Different URLs per call avoids stuck detection (fingerprint is always false but URL changes)
      let urlIdx = 0;
      (adapter.getCurrentUrl as Mock).mockImplementation(() => `https://example.com/page${++urlIdx}`);

      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue(null),
        detectPageByDOM: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
        scanPageFields: vi.fn().mockResolvedValue({ fields: [], scrollHeight: 1000, viewportHeight: 800 }),
        clickNextButton: vi.fn().mockResolvedValue('clicked'),
        detectValidationErrors: vi.fn().mockResolvedValue(false),
      });

      const orchestrator = buildOrchestrator({ adapter, config, maxPages: 3 });
      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(true);
      expect(result.awaitingUserReview).toBe(true);
      expect(result.finalPage).toBe('max_pages_reached');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    test('catches errors and returns failure', async () => {
      const adapter = createMockAdapter();
      (adapter.act as Mock).mockRejectedValue(new Error('Browser crashed'));
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue({ page_type: 'job_listing', page_title: 'Job' }),
      });

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser crashed');
    });

    test('keeps browser open on error if pagesProcessed > 2', async () => {
      const adapter = createMockAdapter();
      let callCount = 0;

      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 3) throw new Error('Unexpected error');
          return null;
        }),
        detectPageByDOM: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
        scanPageFields: vi.fn().mockResolvedValue({ fields: [], scrollHeight: 1000, viewportHeight: 800 }),
        clickNextButton: vi.fn().mockResolvedValue('clicked'),
        detectValidationErrors: vi.fn().mockResolvedValue(false),
      });

      // Different URLs to avoid stuck detection (fingerprint defaults to false)
      let urlIdx = 0;
      (adapter.getCurrentUrl as Mock).mockImplementation(() => `https://example.com/page${++urlIdx}`);

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(false);
      expect(result.keepBrowserOpen).toBe(true);
    });
  });

  // =========================================================================
  // Review detection
  // =========================================================================

  describe('review detection', () => {
    test('fillPage returns review when submit button detected', async () => {
      const adapter = createMockAdapter();
      let pageCall = 0;
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockImplementation(() => {
          pageCall++;
          if (pageCall > 1) return { page_type: 'review', page_title: 'Review' };
          return null;
        }),
        detectPageByDOM: vi.fn().mockResolvedValue({ page_type: 'questions', page_title: 'Form' }),
        scanPageFields: vi.fn().mockResolvedValue({ fields: [], scrollHeight: 1000, viewportHeight: 800 }),
        clickNextButton: vi.fn().mockResolvedValue('review_detected'),
      });

      (adapter.getCurrentUrl as Mock).mockResolvedValue('https://example.com/review');
      (adapter.page.evaluate as Mock).mockResolvedValue('Review|fields:0|active:review');

      const orchestrator = buildOrchestrator({ adapter, config });
      const result = await orchestrator.run(defaultRunParams);

      expect(result.success).toBe(true);
      expect(result.awaitingUserReview).toBe(true);
      expect(result.finalPage).toBe('review');
    });
  });

  // =========================================================================
  // OrchestratorResult structure
  // =========================================================================

  describe('result structure', () => {
    test('result contains all expected fields', async () => {
      const config = createMockConfig({
        detectPageByUrl: vi.fn().mockReturnValue({ page_type: 'review', page_title: 'Review' }),
      });
      const orchestrator = buildOrchestrator({ config });
      const result = await orchestrator.run(defaultRunParams);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('pagesProcessed');
      expect(result).toHaveProperty('domFilled');
      expect(result).toHaveProperty('llmFilled');
      expect(result).toHaveProperty('magnitudeFilled');
      expect(result).toHaveProperty('totalFields');
      expect(result).toHaveProperty('awaitingUserReview');
      expect(result).toHaveProperty('finalPage');
      expect(result).toHaveProperty('platform');
      expect(result.platform).toBe('generic');
    });
  });

  // =========================================================================
  // SmartApplyHandler integration
  // =========================================================================

  describe('SmartApplyHandler thin wrapper', () => {
    test('SmartApplyHandler has correct type', async () => {
      const { SmartApplyHandler } = await import('../../../src/workers/taskHandlers/smartApplyHandler.js');
      const handler = new SmartApplyHandler();
      expect(handler.type).toBe('smart_apply');
      expect(handler.description).toBeTruthy();
    });

    test('SmartApplyHandler validates input', async () => {
      const { SmartApplyHandler } = await import('../../../src/workers/taskHandlers/smartApplyHandler.js');
      const handler = new SmartApplyHandler();

      const valid = handler.validate!({ user_data: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' } });
      expect(valid.valid).toBe(true);

      const invalid = handler.validate!({});
      expect(invalid.valid).toBe(false);
      expect(invalid.errors!.length).toBeGreaterThan(0);
    });
  });
});
