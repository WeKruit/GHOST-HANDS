import { describe, expect, test, beforeEach, vi } from 'vitest';
import { TraceRecorder, type TraceRecorderOptions } from '../../../src/engine/TraceRecorder';
import type { ManualStep, LocatorDescriptor } from '../../../src/engine/types';
import type { BrowserAutomationAdapter, AdapterEvent } from '../../../src/adapters/types';
import type { Page } from 'playwright';
import EventEmitter from 'eventemitter3';

// --- Mock Adapter ---

function createMockAdapter() {
  const emitter = new EventEmitter();
  const evaluateResults: any[] = [];
  let evaluateCallIndex = 0;

  const mockPage = {
    evaluate: vi.fn(async (fn: any, ...args: any[]) => {
      const result = evaluateResults[evaluateCallIndex];
      evaluateCallIndex++;
      return result ?? null;
    }),
    url: vi.fn(() => 'https://boards.greenhouse.io/company/jobs/12345'),
  } as unknown as Page;

  const adapter = {
    type: 'magnitude' as const,
    on: vi.fn((event: AdapterEvent, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
    }),
    off: vi.fn((event: AdapterEvent, handler: (...args: any[]) => void) => {
      emitter.off(event, handler);
    }),
    get page() { return mockPage; },
    // Stubs for interface completeness
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    isActive: vi.fn(() => true),
    act: vi.fn(async () => ({ success: true, message: '', durationMs: 0 })),
    extract: vi.fn(async () => ({} as any)),
    navigate: vi.fn(async () => {}),
    getCurrentUrl: vi.fn(async () => 'https://example.com'),
    screenshot: vi.fn(async () => Buffer.from('')),
    registerCredentials: vi.fn(() => {}),
  } as unknown as BrowserAutomationAdapter;

  return {
    adapter,
    emitter,
    mockPage,
    queueEvaluateResult(result: any) {
      evaluateResults.push(result);
    },
    resetEvaluateIndex() {
      evaluateCallIndex = 0;
    },
  };
}

// --- Locator extraction result from page.evaluate ---
// This is the shape returned by our elementFromPoint extraction script.
const SAMPLE_ELEMENT_INFO = {
  testId: 'email-input',
  role: 'textbox',
  name: 'email',
  ariaLabel: 'Email Address',
  id: 'email',
  text: '',
  css: 'input#email[name="email"]',
  xpath: '/html/body/form/input[1]',
};

const BUTTON_ELEMENT_INFO = {
  testId: 'submit-btn',
  role: 'button',
  name: '',
  ariaLabel: 'Submit Application',
  id: 'submit',
  text: 'Submit',
  css: 'button#submit',
  xpath: '/html/body/form/button',
};

describe('TraceRecorder', () => {
  let mockSetup: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockSetup = createMockAdapter();
  });

  describe('constructor and lifecycle', () => {
    test('creates with adapter reference', () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      expect(recorder).toBeDefined();
    });

    test('starts recording and subscribes to events', () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      expect(mockSetup.adapter.on).toHaveBeenCalled();
      expect(recorder.isRecording()).toBe(true);
    });

    test('stops recording and unsubscribes from events', () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();
      recorder.stopRecording();

      expect(mockSetup.adapter.off).toHaveBeenCalled();
      expect(recorder.isRecording()).toBe(false);
    });

    test('getTrace returns empty array before any events', () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      expect(recorder.getTrace()).toEqual([]);
    });

    test('reset clears recorded steps', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // Simulate a click action
      mockSetup.emitter.emit('actionDone', {
        variant: 'click',
        x: 100,
        y: 200,
      });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace().length).toBeGreaterThan(0);

      recorder.reset();
      expect(recorder.getTrace()).toEqual([]);
    });
  });

  describe('recording click actions (legacy)', () => {
    test('records click with locator from elementFromPoint', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'click',
        x: 100,
        y: 200,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('click');
      expect(trace[0].order).toBe(0);
      expect(trace[0].locator.testId).toBe('submit-btn');
      expect(trace[0].locator.role).toBe('button');
      expect(trace[0].locator.ariaLabel).toBe('Submit Application');
      expect(trace[0].locator.id).toBe('submit');
    });
  });

  describe('recording type actions (legacy)', () => {
    test('records fill with value', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'type',
        x: 200,
        y: 300,
        content: 'test@example.com',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('fill');
      expect(trace[0].value).toBe('test@example.com');
      expect(trace[0].locator.testId).toBe('email-input');
    });
  });

  describe('template detection', () => {
    test('replaces typed value with {{field_name}} when matching user_data', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
        userData: {
          email: 'jane@example.com',
          first_name: 'Jane',
          last_name: 'Doe',
        },
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'type',
        x: 200,
        y: 300,
        content: 'jane@example.com',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace[0].value).toBe('{{email}}');
    });

    test('does not template values that do not match user_data', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
        userData: {
          email: 'jane@example.com',
        },
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'type',
        x: 200,
        y: 300,
        content: 'some random text',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace[0].value).toBe('some random text');
    });

    test('handles multiple user_data fields — picks first match', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
        userData: {
          name: 'Jane',
          first_name: 'Jane',
        },
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'type',
        x: 200,
        y: 300,
        content: 'Jane',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      // Should match the first field found
      expect(trace[0].value).toMatch(/^\{\{(name|first_name)\}\}$/);
    });

    test('works without user_data (no templating)', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'type',
        x: 200,
        y: 300,
        content: 'jane@example.com',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace[0].value).toBe('jane@example.com');
    });
  });

  describe('recording scroll actions (legacy)', () => {
    test('records scroll action', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'scroll',
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 300,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('scroll');
    });
  });

  describe('recording navigate actions (legacy)', () => {
    test('records navigate/load action with URL', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'load',
        url: 'https://boards.greenhouse.io/company/jobs/12345',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('navigate');
      expect(trace[0].value).toBe('https://boards.greenhouse.io/company/jobs/12345');
      // Navigate steps use URL as the locator
      expect(trace[0].locator.css).toBeDefined();
    });
  });

  describe('step ordering', () => {
    test('assigns sequential order numbers', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // Three sequential actions
      mockSetup.emitter.emit('actionDone', { variant: 'click', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 50));

      mockSetup.emitter.emit('actionDone', { variant: 'type', x: 30, y: 40, content: 'hello' });
      await new Promise((r) => setTimeout(r, 50));

      mockSetup.emitter.emit('actionDone', { variant: 'click', x: 50, y: 60 });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(3);
      expect(trace[0].order).toBe(0);
      expect(trace[1].order).toBe(1);
      expect(trace[2].order).toBe(2);
    });
  });

  describe('null element handling', () => {
    test('skips step when elementFromPoint returns null', async () => {
      mockSetup.queueEvaluateResult(null);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'click', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(0);
    });
  });

  describe('locator cleaning', () => {
    test('omits empty string values from locator', async () => {
      mockSetup.queueEvaluateResult({
        testId: '',
        role: 'button',
        name: '',
        ariaLabel: '',
        id: '',
        text: 'Click me',
        css: 'button',
        xpath: '/html/body/button',
      });

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'click', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      const locator = trace[0].locator;
      // Empty strings should be omitted
      expect(locator.testId).toBeUndefined();
      expect(locator.id).toBeUndefined();
      expect(locator.ariaLabel).toBeUndefined();
      expect(locator.name).toBeUndefined();
      // Non-empty values preserved
      expect(locator.role).toBe('button');
      expect(locator.text).toBe('Click me');
      expect(locator.css).toBe('button');
      expect(locator.xpath).toBe('/html/body/button');
    });
  });

  describe('healthScore default', () => {
    test('all steps start with healthScore 1.0', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'click', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace[0].healthScore).toBe(1.0);
    });
  });

  // ── Magnitude namespaced variant tests ──────────────────────────────

  describe('Magnitude mouse:click variant', () => {
    test('records mouse:click as click action', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:click',
        x: 100,
        y: 200,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('click');
      expect(trace[0].locator.testId).toBe('submit-btn');
    });

    test('records mouse:double_click as click action', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:double_click',
        x: 100,
        y: 200,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('click');
    });

    test('records mouse:right_click as click action', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:right_click',
        x: 50,
        y: 75,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('click');
    });
  });

  describe('Magnitude keyboard:type variant', () => {
    test('uses last-clicked element info (no page.evaluate call)', async () => {
      // Only one evaluate call for the click — keyboard:type should not call evaluate
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // Click first to establish lastClickInfo
      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:click',
        x: 200,
        y: 300,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Then type — should reuse last-click element info
      mockSetup.emitter.emit('actionDone', {
        variant: 'keyboard:type',
        content: 'test@example.com',
      });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(2);
      expect(trace[0].action).toBe('click');
      expect(trace[1].action).toBe('fill');
      expect(trace[1].value).toBe('test@example.com');
      expect(trace[1].locator.testId).toBe('email-input');

      // page.evaluate should only have been called once (for the click)
      expect(mockSetup.mockPage.evaluate).toHaveBeenCalledTimes(1);
    });

    test('skipped when no prior click (no lastClickInfo)', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // keyboard:type with no prior click
      mockSetup.emitter.emit('actionDone', {
        variant: 'keyboard:type',
        content: 'orphaned text',
      });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(0);
    });

    test('template detection works with keyboard:type', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
        userData: { email: 'jane@example.com' },
      });
      recorder.start();

      // Click, then type a matching value
      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:click',
        x: 200,
        y: 300,
      });
      await new Promise((r) => setTimeout(r, 50));

      mockSetup.emitter.emit('actionDone', {
        variant: 'keyboard:type',
        content: 'jane@example.com',
      });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace[1].action).toBe('fill');
      expect(trace[1].value).toBe('{{email}}');
    });
  });

  describe('Magnitude mouse:scroll variant', () => {
    test('records mouse:scroll as scroll action', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'mouse:scroll',
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 500,
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('scroll');
    });
  });

  describe('Magnitude browser:nav variant', () => {
    test('records browser:nav as navigate with URL', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', {
        variant: 'browser:nav',
        url: 'https://example.com/apply',
      });

      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('navigate');
      expect(trace[0].value).toBe('https://example.com/apply');
      expect(trace[0].locator.css).toBe('body');
    });
  });

  describe('Magnitude keyboard key press variants', () => {
    test('keyboard:enter records as press with value Enter', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // Click first to set lastClickInfo
      mockSetup.emitter.emit('actionDone', { variant: 'mouse:click', x: 100, y: 200 });
      await new Promise((r) => setTimeout(r, 50));

      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:enter' });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(2);
      expect(trace[1].action).toBe('press');
      expect(trace[1].value).toBe('Enter');
      expect(trace[1].locator.testId).toBe('email-input');
    });

    test('keyboard:tab records as press with value Tab', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'mouse:click', x: 50, y: 60 });
      await new Promise((r) => setTimeout(r, 50));

      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:tab' });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(2);
      expect(trace[1].action).toBe('press');
      expect(trace[1].value).toBe('Tab');
    });

    test('keyboard:enter without prior click uses body locator', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:enter' });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('press');
      expect(trace[0].value).toBe('Enter');
      expect(trace[0].locator.css).toBe('body');
    });
  });

  describe('Magnitude wait variant', () => {
    test('records wait action', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'wait' });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].action).toBe('wait');
      expect(trace[0].locator.css).toBe('body');
    });
  });

  describe('skipped Magnitude variants', () => {
    test('mouse:drag is silently skipped', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'mouse:drag', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace()).toHaveLength(0);
    });

    test('browser:nav:back is silently skipped', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'browser:nav:back' });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace()).toHaveLength(0);
    });

    test('browser:tab:* variants are silently skipped', async () => {
      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      mockSetup.emitter.emit('actionDone', { variant: 'browser:tab:new' });
      mockSetup.emitter.emit('actionDone', { variant: 'browser:tab:close' });
      mockSetup.emitter.emit('actionDone', { variant: 'browser:tab:switch' });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace()).toHaveLength(0);
    });
  });

  describe('reset clears lastClickInfo', () => {
    test('keyboard:type after reset with no new click is skipped', async () => {
      mockSetup.queueEvaluateResult(BUTTON_ELEMENT_INFO);

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
      });
      recorder.start();

      // Click to set lastClickInfo
      mockSetup.emitter.emit('actionDone', { variant: 'mouse:click', x: 100, y: 200 });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace()).toHaveLength(1);

      // Reset clears both steps and lastClickInfo
      recorder.reset();
      expect(recorder.getTrace()).toHaveLength(0);

      // keyboard:type without a new click should be skipped
      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:type', content: 'hello' });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace()).toHaveLength(0);
    });
  });

  describe('full Magnitude sequence', () => {
    test('nav → click → type → enter produces correct trace', async () => {
      mockSetup.queueEvaluateResult(SAMPLE_ELEMENT_INFO); // for the click

      const recorder = new TraceRecorder({
        adapter: mockSetup.adapter,
        userData: { email: 'test@example.com' },
      });
      recorder.start();

      // 1. Navigate
      mockSetup.emitter.emit('actionDone', { variant: 'browser:nav', url: 'https://example.com/apply' });
      await new Promise((r) => setTimeout(r, 50));

      // 2. Click the email field
      mockSetup.emitter.emit('actionDone', { variant: 'mouse:click', x: 200, y: 300 });
      await new Promise((r) => setTimeout(r, 50));

      // 3. Type email
      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:type', content: 'test@example.com' });
      await new Promise((r) => setTimeout(r, 50));

      // 4. Press Enter
      mockSetup.emitter.emit('actionDone', { variant: 'keyboard:enter' });
      await new Promise((r) => setTimeout(r, 50));

      const trace = recorder.getTrace();
      expect(trace).toHaveLength(4);
      expect(trace[0]).toMatchObject({ order: 0, action: 'navigate', value: 'https://example.com/apply' });
      expect(trace[1]).toMatchObject({ order: 1, action: 'click', locator: { testId: 'email-input' } });
      expect(trace[2]).toMatchObject({ order: 2, action: 'fill', value: '{{email}}' });
      expect(trace[3]).toMatchObject({ order: 3, action: 'press', value: 'Enter' });
    });
  });
});
