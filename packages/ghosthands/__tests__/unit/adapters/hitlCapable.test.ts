/**
 * Unit tests for HitlCapableAdapter interface and implementations.
 *
 * Tests:
 * - HitlCapableAdapter interface compliance for MockAdapter
 * - pause/resume/isPaused state transitions with promise-based gate
 * - observe() returns structured results
 * - observeWithBlockerDetection() returns ObservationResult
 * - Configurable mock observations and blocker simulation
 * - Factory returns HitlCapableAdapter with runtime validation
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { MockAdapter } from '../../../src/adapters/mock';
import { createAdapter } from '../../../src/adapters/index';
import type {
  HitlCapableAdapter,
  ObservedElement,
  ObservationResult,
} from '../../../src/adapters/types';

const DEFAULT_START_OPTS = {
  url: 'https://example.com',
  llm: { provider: 'mock', options: { model: 'mock' } },
} as const;

// ── HitlCapableAdapter interface compliance ──────────────────────────────

describe('HitlCapableAdapter interface compliance', () => {
  let adapter: MockAdapter;

  beforeEach(async () => {
    adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
  });

  test('MockAdapter has observe() as a function', () => {
    expect(typeof adapter.observe).toBe('function');
  });

  test('MockAdapter has pause() as a function', () => {
    expect(typeof adapter.pause).toBe('function');
  });

  test('MockAdapter has resume() as a function', () => {
    expect(typeof adapter.resume).toBe('function');
  });

  test('MockAdapter has isPaused() as a function', () => {
    expect(typeof adapter.isPaused).toBe('function');
  });

  test('MockAdapter has screenshot() as a function', () => {
    expect(typeof adapter.screenshot).toBe('function');
  });

  test('MockAdapter has getCurrentUrl() as a function', () => {
    expect(typeof adapter.getCurrentUrl).toBe('function');
  });

  test('MockAdapter has observeWithBlockerDetection() as a function', () => {
    expect(typeof adapter.observeWithBlockerDetection).toBe('function');
  });

  test('MockAdapter satisfies HitlCapableAdapter type', () => {
    const hitlAdapter: HitlCapableAdapter = adapter;
    expect(hitlAdapter.type).toBe('mock');
  });
});

// ── pause/resume/isPaused state transitions ──────────────────────────────

describe('pause/resume/isPaused state transitions', () => {
  let adapter: MockAdapter;

  beforeEach(async () => {
    adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
  });

  test('isPaused() returns false initially', () => {
    expect(adapter.isPaused()).toBe(false);
  });

  test('isPaused() returns true after pause()', async () => {
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);
  });

  test('isPaused() returns false after pause() then resume()', async () => {
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);
  });

  test('double pause() is idempotent', async () => {
    await adapter.pause();
    await adapter.pause();
    expect(adapter.isPaused()).toBe(true);
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);
  });

  test('double resume() is idempotent', async () => {
    await adapter.pause();
    await adapter.resume();
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);
  });

  test('resume() without pause() is a no-op', async () => {
    await adapter.resume();
    expect(adapter.isPaused()).toBe(false);
  });

  test('waitIfPaused() resolves immediately when not paused', async () => {
    const start = Date.now();
    await adapter.waitIfPaused();
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('waitIfPaused() blocks until resume() is called', async () => {
    await adapter.pause();
    let resolved = false;

    const waiting = adapter.waitIfPaused().then(() => { resolved = true; });

    // Give the event loop a tick — should still be blocked
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    await adapter.resume();
    await waiting;
    expect(resolved).toBe(true);
  });
});

// ── observe() returns structured results ─────────────────────────────────

describe('observe() returns structured results', () => {
  test('returns default mock elements when no config', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);

    const elements = await adapter.observe('find form fields');
    expect(elements).toBeDefined();
    expect(Array.isArray(elements)).toBe(true);
    expect(elements!.length).toBe(2);

    const el = elements![0];
    expect(el).toHaveProperty('selector');
    expect(el).toHaveProperty('description');
    expect(el).toHaveProperty('method');
    expect(el).toHaveProperty('arguments');
  });

  test('returns custom observation results from config', async () => {
    const customElements: ObservedElement[] = [
      { selector: '#name', description: 'Name field', method: 'fill', arguments: ['John'] },
      { selector: '#email', description: 'Email field', method: 'fill', arguments: ['j@x.com'] },
      { selector: 'button.submit', description: 'Submit button', method: 'click', arguments: [] },
    ];

    const adapter = new MockAdapter({ observationResults: customElements });
    await adapter.start(DEFAULT_START_OPTS);

    const elements = await adapter.observe('find all fields');
    expect(elements).toEqual(customElements);
  });
});

// ── observeWithBlockerDetection() ────────────────────────────────────────

describe('observeWithBlockerDetection()', () => {
  test('returns ObservationResult with no blockers by default', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);

    const result: ObservationResult = await adapter.observeWithBlockerDetection('check page');
    expect(result).toHaveProperty('elements');
    expect(result).toHaveProperty('blockers');
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('screenshot');

    expect(Array.isArray(result.elements)).toBe(true);
    expect(result.elements.length).toBe(2); // default mock elements
    expect(result.blockers).toEqual([]);
    expect(result.url).toBe('https://example.com');
    expect(typeof result.timestamp).toBe('number');
    expect(Buffer.isBuffer(result.screenshot)).toBe(true);
  });

  test('returns simulated blockers from config', async () => {
    const adapter = new MockAdapter({
      simulatedBlockers: [
        { category: 'captcha', confidence: 0.95, selector: 'iframe[src*="recaptcha"]', description: 'reCAPTCHA detected' },
        { category: 'login', confidence: 0.7, description: 'Login form present' },
      ],
    });
    await adapter.start(DEFAULT_START_OPTS);

    const result = await adapter.observeWithBlockerDetection('check blockers');
    expect(result.blockers.length).toBe(2);
    expect(result.blockers[0].category).toBe('captcha');
    expect(result.blockers[0].confidence).toBe(0.95);
    expect(result.blockers[0].selector).toBe('iframe[src*="recaptcha"]');
    expect(result.blockers[1].category).toBe('login');
    expect(result.blockers[1].selector).toBeUndefined();
  });

  test('uses current URL from navigate()', async () => {
    const adapter = new MockAdapter();
    await adapter.start(DEFAULT_START_OPTS);
    await adapter.navigate('https://boards.greenhouse.io/apply/123');

    const result = await adapter.observeWithBlockerDetection('check page');
    expect(result.url).toBe('https://boards.greenhouse.io/apply/123');
  });
});

// ── Factory returns HitlCapableAdapter ───────────────────────────────────

describe('createAdapter factory', () => {
  test('createAdapter("mock") returns HitlCapableAdapter', () => {
    const adapter = createAdapter('mock');
    expect(typeof adapter.observe).toBe('function');
    expect(typeof adapter.pause).toBe('function');
    expect(typeof adapter.resume).toBe('function');
    expect(typeof adapter.isPaused).toBe('function');
    expect(typeof adapter.screenshot).toBe('function');
    expect(typeof adapter.getCurrentUrl).toBe('function');
    expect(typeof adapter.observeWithBlockerDetection).toBe('function');
  });

  test('createAdapter("magnitude") returns HitlCapableAdapter', () => {
    const adapter = createAdapter('magnitude');
    expect(typeof adapter.observe).toBe('function');
    expect(typeof adapter.pause).toBe('function');
    expect(typeof adapter.resume).toBe('function');
    expect(typeof adapter.isPaused).toBe('function');
    expect(typeof adapter.observeWithBlockerDetection).toBe('function');
  });

  test('createAdapter defaults to magnitude', () => {
    const adapter = createAdapter();
    expect(adapter.type).toBe('magnitude');
  });

  test('createAdapter throws for unimplemented adapters', () => {
    expect(() => createAdapter('actionbook')).toThrow('not yet implemented');
    expect(() => createAdapter('hybrid')).toThrow('not yet implemented');
  });

  test('createAdapter creates stagehand adapter', () => {
    const adapter = createAdapter('stagehand');
    expect(adapter.type).toBe('stagehand');
  });

  test('createAdapter throws for unknown type', () => {
    expect(() => createAdapter('nonexistent' as any)).toThrow('Unknown adapter type');
  });
});

// ── Backwards compatibility ──────────────────────────────────────────────

describe('backwards compatibility', () => {
  test('MockAdapter still works as BrowserAutomationAdapter', async () => {
    // HitlCapableAdapter extends BrowserAutomationAdapter, so all
    // existing code that uses BrowserAutomationAdapter should still work
    const adapter = new MockAdapter({ actionCount: 2, actionDelayMs: 0 });
    await adapter.start(DEFAULT_START_OPTS);

    const result = await adapter.act('click submit');
    expect(result.success).toBe(true);

    const extracted = await adapter.extract('get name', {} as any);
    expect(extracted).toEqual({ submitted: true });

    expect(adapter.isActive()).toBe(true);
    expect(adapter.isConnected()).toBe(true);

    const url = await adapter.getCurrentUrl();
    expect(url).toBe('https://example.com');

    const shot = await adapter.screenshot();
    expect(Buffer.isBuffer(shot)).toBe(true);

    await adapter.stop();
    expect(adapter.isActive()).toBe(false);
  });

  test('event emitter still works', async () => {
    const adapter = new MockAdapter({ actionCount: 1, actionDelayMs: 0 });
    await adapter.start(DEFAULT_START_OPTS);

    const events: string[] = [];
    adapter.on('actionStarted', () => events.push('started'));
    adapter.on('actionDone', () => events.push('done'));

    await adapter.act('test');
    expect(events).toEqual(['started', 'done']);
  });
});
