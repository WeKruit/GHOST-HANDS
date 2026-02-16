import { describe, expect, test, beforeEach, mock } from 'bun:test';
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
    evaluate: mock(async (fn: any, ...args: any[]) => {
      const result = evaluateResults[evaluateCallIndex];
      evaluateCallIndex++;
      return result ?? null;
    }),
    url: mock(() => 'https://boards.greenhouse.io/company/jobs/12345'),
  } as unknown as Page;

  const adapter = {
    type: 'magnitude' as const,
    on: mock((event: AdapterEvent, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
    }),
    off: mock((event: AdapterEvent, handler: (...args: any[]) => void) => {
      emitter.off(event, handler);
    }),
    get page() { return mockPage; },
    // Stubs for interface completeness
    start: mock(async () => {}),
    stop: mock(async () => {}),
    isActive: mock(() => true),
    act: mock(async () => ({ success: true, message: '', durationMs: 0 })),
    extract: mock(async () => ({} as any)),
    navigate: mock(async () => {}),
    getCurrentUrl: mock(async () => 'https://example.com'),
    screenshot: mock(async () => Buffer.from('')),
    registerCredentials: mock(() => {}),
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

  describe('recording click actions', () => {
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

  describe('recording type actions', () => {
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

  describe('recording scroll actions', () => {
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

  describe('recording navigate actions', () => {
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
});
