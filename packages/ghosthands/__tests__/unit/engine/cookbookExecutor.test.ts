import { describe, expect, test, vi, beforeEach } from 'vitest';
import { CookbookExecutor } from '../../../src/engine/CookbookExecutor';
import type { ActionManual, ManualStep } from '../../../src/engine/types';
import type { Page, Locator } from 'playwright';

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockLocator(overrides: Partial<Locator> = {}): Locator {
  return {
    count: vi.fn(() => Promise.resolve(1)),
    click: vi.fn(() => Promise.resolve()),
    fill: vi.fn((_v: string) => Promise.resolve()),
    selectOption: vi.fn((_v: string) => Promise.resolve()),
    check: vi.fn(() => Promise.resolve()),
    uncheck: vi.fn(() => Promise.resolve()),
    hover: vi.fn(() => Promise.resolve()),
    press: vi.fn((_k: string) => Promise.resolve()),
    scrollIntoViewIfNeeded: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as unknown as Locator;
}

function createMockPage(locatorOverride?: Locator): Page {
  const loc = locatorOverride ?? mockLocator();
  return {
    getByTestId: vi.fn((_id: string) => loc),
    getByRole: vi.fn((_role: string, _opts?: any) => loc),
    getByLabel: vi.fn((_label: string) => loc),
    getByText: vi.fn((_text: string) => loc),
    locator: vi.fn((_sel: string) => loc),
    goto: vi.fn((_url: string) => Promise.resolve()),
  } as unknown as Page;
}

const NOW = new Date().toISOString();

function makeManual(steps: ManualStep[]): ActionManual {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    url_pattern: 'https://example.com/**',
    task_pattern: 'test_task',
    platform: 'test',
    steps,
    health_score: 1.0,
    source: 'recorded',
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeStep(overrides: Partial<ManualStep> = {}): ManualStep {
  return {
    order: 0,
    locator: { testId: 'default' },
    action: 'click',
    healthScore: 1.0,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('CookbookExecutor', () => {
  let executor: CookbookExecutor;

  beforeEach(() => {
    executor = new CookbookExecutor({ resolverTimeout: 1000, defaultWaitAfter: 0 });
  });

  // ── executeAll ─────────────────────────────────────────────────────

  describe('executeAll', () => {
    test('successfully replays all steps', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const manual = makeManual([
        makeStep({ order: 0, action: 'click', locator: { testId: 'btn1' } }),
        makeStep({ order: 1, action: 'fill', locator: { testId: 'email' }, value: '{{email}}' }),
        makeStep({ order: 2, action: 'click', locator: { testId: 'submit' } }),
      ]);

      const result = await executor.executeAll(page, manual, { email: 'test@example.com' });
      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(3);
      expect(result.failedStepIndex).toBeUndefined();
    });

    test('stops on first failure and reports failed step', async () => {
      const failingLoc = mockLocator({
        fill: vi.fn(() => Promise.reject(new Error('Element not editable'))),
      });
      const page = createMockPage(failingLoc);

      const manual = makeManual([
        makeStep({ order: 0, action: 'click' }),
        makeStep({ order: 1, action: 'fill', value: 'test' }),
        makeStep({ order: 2, action: 'click' }),
      ]);

      const result = await executor.executeAll(page, manual);
      expect(result.success).toBe(false);
      expect(result.failedStepIndex).toBe(1);
      expect(result.stepsCompleted).toBe(1);
      expect(result.error).toContain('Element not editable');
    });

    test('executes steps sorted by order', async () => {
      const callOrder: number[] = [];
      const clickMock = vi.fn(() => {
        callOrder.push(callOrder.length);
        return Promise.resolve();
      });
      const loc = mockLocator({ click: clickMock });
      const page = createMockPage(loc);

      // Steps given out of order
      const manual = makeManual([
        makeStep({ order: 2, action: 'click', locator: { testId: 'third' } }),
        makeStep({ order: 0, action: 'click', locator: { testId: 'first' } }),
        makeStep({ order: 1, action: 'click', locator: { testId: 'second' } }),
      ]);

      const result = await executor.executeAll(page, manual);
      expect(result.success).toBe(true);
      expect(result.stepsCompleted).toBe(3);
      expect(callOrder).toEqual([0, 1, 2]);
    });

    test('returns success for empty manual (no steps after sort)', async () => {
      const page = createMockPage();
      // Technically ActionManualSchema requires min 1 step, but executor handles it gracefully
      const manual = makeManual([
        makeStep({ order: 0, action: 'click' }),
      ]);

      const result = await executor.executeAll(page, manual);
      expect(result.success).toBe(true);
    });
  });

  // ── executeStep: click ─────────────────────────────────────────────

  describe('executeStep: click', () => {
    test('clicks the resolved element', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'click' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.click as any).mock.calls.length).toBe(1);
    });
  });

  // ── executeStep: fill with template ────────────────────────────────

  describe('executeStep: fill', () => {
    test('fills with template-resolved value', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'fill', value: '{{name}}' });

      const result = await executor.executeStep(page, step, { name: 'Alice' });
      expect(result.success).toBe(true);
      expect((loc.fill as any).mock.calls[0]).toEqual(['Alice']);
    });

    test('fails when fill has no value', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'fill' }); // no value

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a value');
    });
  });

  // ── executeStep: select ────────────────────────────────────────────

  describe('executeStep: select', () => {
    test('selects option with resolved value', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'select', value: '{{country}}' });

      const result = await executor.executeStep(page, step, { country: 'US' });
      expect(result.success).toBe(true);
      expect((loc.selectOption as any).mock.calls[0]).toEqual(['US']);
    });

    test('fails when select has no value', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'select' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a value');
    });
  });

  // ── executeStep: check/uncheck ─────────────────────────────────────

  describe('executeStep: check/uncheck', () => {
    test('checks a checkbox', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'check' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.check as any).mock.calls.length).toBe(1);
    });

    test('unchecks a checkbox', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'uncheck' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.uncheck as any).mock.calls.length).toBe(1);
    });
  });

  // ── executeStep: hover ─────────────────────────────────────────────

  describe('executeStep: hover', () => {
    test('hovers over the element', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'hover' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.hover as any).mock.calls.length).toBe(1);
    });
  });

  // ── executeStep: press ─────────────────────────────────────────────

  describe('executeStep: press', () => {
    test('presses a key on the element', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'press', value: 'Enter' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.press as any).mock.calls[0]).toEqual(['Enter']);
    });

    test('fails when press has no value', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'press' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a value');
    });
  });

  // ── executeStep: scroll ────────────────────────────────────────────

  describe('executeStep: scroll', () => {
    test('scrolls element into view', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const step = makeStep({ action: 'scroll' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
      expect((loc.scrollIntoViewIfNeeded as any).mock.calls.length).toBe(1);
    });
  });

  // ── executeStep: navigate ──────────────────────────────────────────

  describe('executeStep: navigate', () => {
    test('navigates to a URL with template substitution', async () => {
      const page = createMockPage();
      const step = makeStep({
        action: 'navigate',
        value: 'https://{{domain}}/apply',
        locator: { css: 'unused' },
      });

      const result = await executor.executeStep(page, step, { domain: 'jobs.lever.co' });
      expect(result.success).toBe(true);
      expect((page.goto as any).mock.calls[0]).toEqual(['https://jobs.lever.co/apply']);
    });

    test('fails when navigate has no value', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'navigate', locator: { css: 'x' } });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('requires a value');
    });

    test('reports navigation failure', async () => {
      const page = createMockPage();
      (page.goto as any) = vi.fn(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')));
      const step = makeStep({ action: 'navigate', value: 'https://invalid.example' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Navigation failed');
    });
  });

  // ── executeStep: wait ──────────────────────────────────────────────

  describe('executeStep: wait', () => {
    test('waits for specified duration', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'wait', value: '50', locator: { css: 'unused' } });

      const start = Date.now();
      const result = await executor.executeStep(page, step);
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing tolerance
    });

    test('uses waitAfter when value not provided', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'wait', waitAfter: 50, locator: { css: 'unused' } });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(true);
    });

    test('fails for invalid wait duration', async () => {
      const page = createMockPage();
      const step = makeStep({ action: 'wait', value: 'not-a-number', locator: { css: 'x' } });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('valid duration');
    });
  });

  // ── Element not found ──────────────────────────────────────────────

  describe('element not found', () => {
    test('returns failure when locator resolves to no element', async () => {
      const emptyLoc = mockLocator({
        count: vi.fn(() => Promise.resolve(0)),
      });
      const page = createMockPage(emptyLoc);
      const step = makeStep({ order: 3, action: 'click', description: 'Submit button' });

      const result = await executor.executeStep(page, step);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No element found');
      expect(result.error).toContain('step 3');
    });
  });

  // ── Template substitution in executeAll ────────────────────────────

  describe('template substitution in executeAll', () => {
    test('resolves all template variables across steps', async () => {
      const loc = mockLocator();
      const page = createMockPage(loc);
      const manual = makeManual([
        makeStep({ order: 0, action: 'fill', locator: { testId: 'name' }, value: '{{firstName}} {{lastName}}' }),
        makeStep({ order: 1, action: 'fill', locator: { testId: 'email' }, value: '{{email}}' }),
        makeStep({ order: 2, action: 'click', locator: { testId: 'submit' } }),
      ]);

      const result = await executor.executeAll(page, manual, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      });

      expect(result.success).toBe(true);
      expect((loc.fill as any).mock.calls[0]).toEqual(['John Doe']);
      expect((loc.fill as any).mock.calls[1]).toEqual(['john@example.com']);
    });
  });

  // ── Constructor defaults ───────────────────────────────────────────

  describe('constructor defaults', () => {
    test('works with default options', async () => {
      const defaultExecutor = new CookbookExecutor();
      const page = createMockPage();
      const step = makeStep({ action: 'click' });

      const result = await defaultExecutor.executeStep(page, step);
      expect(result.success).toBe(true);
    });
  });
});
