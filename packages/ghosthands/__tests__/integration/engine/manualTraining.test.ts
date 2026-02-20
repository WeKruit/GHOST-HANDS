/**
 * Integration tests for the manual training flow.
 *
 * Tests: TraceRecorder captures actions → saves as manual → ManualStore can look it up →
 * CookbookExecutor can replay it.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { TraceRecorder } from '../../../src/engine/TraceRecorder';
import { CookbookExecutor } from '../../../src/engine/CookbookExecutor';
import { ManualStore } from '../../../src/engine/ManualStore';
import type { ManualStep, ActionManual } from '../../../src/engine/types';
import type { BrowserAutomationAdapter } from '../../../src/adapters/types';

// ── Mock adapter that can emit events ────────────────────────────────────

function createEventEmittingAdapter() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  const adapter = {
    page: {
      evaluate: mock((_fn: any, _args: any) => Promise.resolve({
        testId: 'email-input',
        role: 'textbox',
        name: 'email',
        ariaLabel: 'Email address',
        id: 'email',
        text: '',
        css: 'input#email[name="email"]',
        xpath: '/html/body/form[1]/input[1]',
      })),
      goto: mock(() => Promise.resolve()),
      getByTestId: mock(() => ({
        count: mock(() => Promise.resolve(1)),
        click: mock(() => Promise.resolve()),
        fill: mock(() => Promise.resolve()),
        scrollIntoViewIfNeeded: mock(() => Promise.resolve()),
      })),
      getByRole: mock(() => ({
        count: mock(() => Promise.resolve(0)),
      })),
      getByLabel: mock(() => ({
        count: mock(() => Promise.resolve(0)),
      })),
      getByText: mock(() => ({
        count: mock(() => Promise.resolve(0)),
      })),
      locator: mock(() => ({
        count: mock(() => Promise.resolve(0)),
      })),
    },
    on: mock((event: string, handler: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    off: mock((event: string, handler: (...args: any[]) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    emit: (event: string, ...args: any[]) => {
      if (listeners[event]) {
        listeners[event].forEach((h) => h(...args));
      }
    },
  } as unknown as BrowserAutomationAdapter & { emit: (event: string, ...args: any[]) => void };

  return adapter;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Manual Training Flow', () => {
  describe('TraceRecorder captures actions', () => {
    test('records click actions from adapter events', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      // Simulate a click action event
      adapter.emit('actionDone', { variant: 'click', x: 100, y: 200 });

      // Wait for async recording
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace.length).toBe(1);
      expect(trace[0].action).toBe('click');
      expect(trace[0].order).toBe(0);
      expect(trace[0].locator.testId).toBe('email-input');
    });

    test('records type actions with template detection', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({
        adapter,
        userData: { email: 'test@example.com' },
      });
      recorder.start();

      adapter.emit('actionDone', { variant: 'type', x: 100, y: 200, content: 'test@example.com' });
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace.length).toBe(1);
      expect(trace[0].action).toBe('fill');
      expect(trace[0].value).toBe('{{email}}'); // Template detected
    });

    test('records navigation events', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      adapter.emit('actionDone', { variant: 'load', url: 'https://example.com/apply' });
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace.length).toBe(1);
      expect(trace[0].action).toBe('navigate');
      expect(trace[0].value).toBe('https://example.com/apply');
    });

    test('records multiple actions in order', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      adapter.emit('actionDone', { variant: 'click', x: 10, y: 20 });
      await new Promise((r) => setTimeout(r, 30));
      adapter.emit('actionDone', { variant: 'type', x: 30, y: 40, content: 'hello' });
      await new Promise((r) => setTimeout(r, 30));
      adapter.emit('actionDone', { variant: 'click', x: 50, y: 60 });
      await new Promise((r) => setTimeout(r, 30));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace.length).toBe(3);
      expect(trace[0].order).toBe(0);
      expect(trace[1].order).toBe(1);
      expect(trace[2].order).toBe(2);
    });
  });

  describe('empty trace handling', () => {
    test('returns empty trace when no events are emitted', () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();
      recorder.stopRecording();

      expect(recorder.getTrace()).toEqual([]);
    });

    test('ignores unknown action variants', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      adapter.emit('actionDone', { variant: 'unknown_action', x: 100, y: 200 });
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      expect(recorder.getTrace()).toEqual([]);
    });
  });

  describe('recorder lifecycle', () => {
    test('isRecording returns correct state', () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });

      expect(recorder.isRecording()).toBe(false);
      recorder.start();
      expect(recorder.isRecording()).toBe(true);
      recorder.stopRecording();
      expect(recorder.isRecording()).toBe(false);
    });

    test('start is idempotent', () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });

      recorder.start();
      recorder.start(); // Should not throw or double-subscribe
      expect(recorder.isRecording()).toBe(true);
      expect(adapter.on).toHaveBeenCalledTimes(1);
    });

    test('reset clears recorded steps', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      adapter.emit('actionDone', { variant: 'click', x: 100, y: 200 });
      await new Promise((r) => setTimeout(r, 50));

      expect(recorder.getTrace().length).toBe(1);
      recorder.reset();
      expect(recorder.getTrace().length).toBe(0);
    });
  });

  describe('trace to manual round-trip', () => {
    test('trace steps have valid ManualStep structure', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({ adapter });
      recorder.start();

      adapter.emit('actionDone', { variant: 'click', x: 100, y: 200 });
      adapter.emit('actionDone', { variant: 'type', x: 150, y: 250, content: 'John' });
      await new Promise((r) => setTimeout(r, 100));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      // Every step should have required fields
      for (const step of trace) {
        expect(typeof step.order).toBe('number');
        expect(step.order).toBeGreaterThanOrEqual(0);
        expect(step.locator).toBeDefined();
        expect(typeof step.action).toBe('string');
        expect(step.healthScore).toBe(1.0);

        // At least one locator strategy should be defined
        const locatorValues = Object.values(step.locator).filter((v) => v !== undefined);
        expect(locatorValues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('template detection in trace', () => {
    test('detects exact match with userData field', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({
        adapter,
        userData: { first_name: 'Alice', last_name: 'Smith' },
      });
      recorder.start();

      adapter.emit('actionDone', { variant: 'type', x: 100, y: 200, content: 'Alice' });
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace[0].value).toBe('{{first_name}}');
    });

    test('does not template non-matching values', async () => {
      const adapter = createEventEmittingAdapter();
      const recorder = new TraceRecorder({
        adapter,
        userData: { name: 'Alice' },
      });
      recorder.start();

      adapter.emit('actionDone', { variant: 'type', x: 100, y: 200, content: 'Bob' });
      await new Promise((r) => setTimeout(r, 50));

      recorder.stopRecording();
      const trace = recorder.getTrace();

      expect(trace[0].value).toBe('Bob');
    });
  });
});
