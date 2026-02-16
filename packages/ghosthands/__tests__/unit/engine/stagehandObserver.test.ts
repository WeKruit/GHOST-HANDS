import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { StagehandObserver, type StagehandObserverConfig } from '../../../src/engine/StagehandObserver';
import type { ObservedElement } from '../../../src/engine/types';

// --- Mock Stagehand ---

// We mock the Stagehand module to avoid launching real browsers in unit tests.
// The mock captures constructor args and returns controllable observe() results.

let mockInitCalled = false;
let mockCloseCalled = false;
let mockCloseForce = false;
let mockObserveResult: any[] = [];
let mockObserveInstruction: string | undefined;
let mockConstructorOpts: any = null;

const MockStagehandInstance = {
  init: async () => { mockInitCalled = true; },
  close: async (opts?: { force?: boolean }) => {
    mockCloseCalled = true;
    mockCloseForce = opts?.force ?? false;
  },
  observe: async (instruction: string) => {
    mockObserveInstruction = instruction;
    return mockObserveResult;
  },
};

mock.module('@browserbasehq/stagehand', () => ({
  Stagehand: class MockStagehand {
    constructor(opts: any) {
      mockConstructorOpts = opts;
    }
    init = MockStagehandInstance.init;
    close = MockStagehandInstance.close;
    observe = MockStagehandInstance.observe;
  },
}));

function resetMocks() {
  mockInitCalled = false;
  mockCloseCalled = false;
  mockCloseForce = false;
  mockObserveResult = [];
  mockObserveInstruction = undefined;
  mockConstructorOpts = null;
}

// --- Tests ---

describe('StagehandObserver', () => {
  beforeEach(() => {
    resetMocks();
  });

  const defaultConfig: StagehandObserverConfig = {
    cdpUrl: 'ws://localhost:9222/devtools/browser/abc123',
    model: 'openai/gpt-4o-mini',
  };

  describe('constructor', () => {
    test('stores config', () => {
      const observer = new StagehandObserver(defaultConfig);
      expect(observer).toBeDefined();
    });

    test('accepts model as string', () => {
      const observer = new StagehandObserver({
        cdpUrl: 'ws://localhost:9222',
        model: 'openai/gpt-4o-mini',
      });
      expect(observer).toBeDefined();
    });

    test('accepts model as object', () => {
      const observer = new StagehandObserver({
        cdpUrl: 'ws://localhost:9222',
        model: { modelName: 'gpt-4o-mini', apiKey: 'sk-test', baseURL: 'https://custom.endpoint' },
      });
      expect(observer).toBeDefined();
    });
  });

  describe('init()', () => {
    test('creates Stagehand with LOCAL env and cdpUrl', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      expect(mockConstructorOpts).toBeDefined();
      expect(mockConstructorOpts.env).toBe('LOCAL');
      expect(mockConstructorOpts.localBrowserLaunchOptions?.cdpUrl).toBe(defaultConfig.cdpUrl);
    });

    test('passes model config to Stagehand constructor', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      expect(mockConstructorOpts.model).toBe('openai/gpt-4o-mini');
    });

    test('passes object model config', async () => {
      const observer = new StagehandObserver({
        cdpUrl: 'ws://localhost:9222',
        model: { modelName: 'gpt-4o-mini', apiKey: 'sk-test' },
      });
      await observer.init();

      expect(mockConstructorOpts.model).toEqual({
        modelName: 'gpt-4o-mini',
        apiKey: 'sk-test',
      });
    });

    test('calls stagehand.init()', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      expect(mockInitCalled).toBe(true);
    });

    test('sets initialized flag', async () => {
      const observer = new StagehandObserver(defaultConfig);
      expect(observer.isInitialized()).toBe(false);
      await observer.init();
      expect(observer.isInitialized()).toBe(true);
    });

    test('throws if already initialized', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      expect(observer.init()).rejects.toThrow('already initialized');
    });

    test('passes verbose option', async () => {
      const observer = new StagehandObserver({
        ...defaultConfig,
        verbose: 2,
      });
      await observer.init();

      expect(mockConstructorOpts.verbose).toBe(2);
    });
  });

  describe('observe()', () => {
    test('returns mapped ObservedElement[] from Stagehand Action[]', async () => {
      mockObserveResult = [
        {
          selector: '//button[@id="submit"]',
          description: 'Submit form button',
          method: 'click',
          arguments: [],
        },
        {
          selector: '//input[@name="email"]',
          description: 'Email input field',
          method: 'fill',
          arguments: ['test@example.com'],
        },
      ];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find all form elements');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        selector: '//button[@id="submit"]',
        description: 'Submit form button',
        action: 'click',
      });
      expect(result[1]).toEqual({
        selector: '//input[@name="email"]',
        description: 'Email input field',
        action: 'fill',
      });
    });

    test('passes instruction to stagehand.observe()', async () => {
      mockObserveResult = [];
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      await observer.observe('Find all buttons');
      expect(mockObserveInstruction).toBe('Find all buttons');
    });

    test('maps unknown methods to "unknown" action', async () => {
      mockObserveResult = [
        {
          selector: '//div',
          description: 'A div element',
          method: 'drag-and-drop',
          arguments: [],
        },
      ];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find all elements');
      expect(result[0].action).toBe('unknown');
    });

    test('maps undefined method to "unknown" action', async () => {
      mockObserveResult = [
        {
          selector: '//span',
          description: 'A span element',
          // method is undefined
        },
      ];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find elements');
      expect(result[0].action).toBe('unknown');
    });

    test('maps all recognized Stagehand methods', async () => {
      const methodMap: Record<string, string> = {
        click: 'click',
        fill: 'fill',
        type: 'fill',
        select: 'select',
        check: 'check',
        hover: 'hover',
        scroll: 'scroll',
        press: 'press',
        navigate: 'navigate',
      };

      for (const [stagehandMethod, expectedAction] of Object.entries(methodMap)) {
        mockObserveResult = [
          { selector: '//el', description: 'test', method: stagehandMethod },
        ];

        const observer = new StagehandObserver(defaultConfig);
        await observer.init();

        const result = await observer.observe('test');
        expect(result[0].action).toBe(expectedAction);

        // Reset for next iteration
        resetMocks();
      }
    });

    test('returns empty array when Stagehand returns empty', async () => {
      mockObserveResult = [];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find nothing');
      expect(result).toEqual([]);
    });

    test('throws if not initialized', async () => {
      const observer = new StagehandObserver(defaultConfig);
      expect(observer.observe('test')).rejects.toThrow('not initialized');
    });
  });

  describe('stop()', () => {
    test('calls stagehand.close()', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();
      await observer.stop();

      expect(mockCloseCalled).toBe(true);
    });

    test('does not force-close (preserves browser)', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();
      await observer.stop();

      // We do NOT pass force: true because Magnitude owns the browser
      expect(mockCloseForce).toBe(false);
    });

    test('resets initialized flag', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();
      expect(observer.isInitialized()).toBe(true);

      await observer.stop();
      expect(observer.isInitialized()).toBe(false);
    });

    test('is safe to call when not initialized', async () => {
      const observer = new StagehandObserver(defaultConfig);
      // Should not throw
      await observer.stop();
      expect(mockCloseCalled).toBe(false);
    });

    test('can re-initialize after stop', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();
      await observer.stop();

      resetMocks();
      await observer.init();
      expect(mockInitCalled).toBe(true);
      expect(observer.isInitialized()).toBe(true);
    });
  });

  describe('error handling and graceful fallback', () => {
    test('handles Stagehand Action with empty selector gracefully', async () => {
      mockObserveResult = [
        { selector: '', description: 'Empty selector element', method: 'click' },
      ];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find elements');
      expect(result[0].selector).toBe('');
    });

    test('handles Stagehand Action with empty description', async () => {
      mockObserveResult = [
        { selector: '//button', description: '', method: 'click' },
      ];

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      const result = await observer.observe('Find elements');
      expect(result[0].description).toBe('');
    });

    test('observe throws if stagehand.observe() throws', async () => {
      // Override the mock to throw
      const origObserve = MockStagehandInstance.observe;
      MockStagehandInstance.observe = async () => { throw new Error('CDP disconnected'); };

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      expect(observer.observe('Find elements')).rejects.toThrow('CDP disconnected');

      // Restore
      MockStagehandInstance.observe = origObserve;
    });

    test('stop() is resilient when close() throws', async () => {
      const origClose = MockStagehandInstance.close;
      MockStagehandInstance.close = async () => { throw new Error('already closed'); };

      const observer = new StagehandObserver(defaultConfig);
      await observer.init();

      // stop() should not throw even if close() does
      await observer.stop();
      expect(observer.isInitialized()).toBe(false);

      // Restore
      MockStagehandInstance.close = origClose;
    });

    test('observe after stop throws not initialized', async () => {
      const observer = new StagehandObserver(defaultConfig);
      await observer.init();
      await observer.stop();

      expect(observer.observe('test')).rejects.toThrow('not initialized');
    });
  });
});
