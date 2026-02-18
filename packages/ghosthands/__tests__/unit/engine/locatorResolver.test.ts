import { describe, expect, test, vi } from 'vitest';
import { LocatorResolver } from '../../../src/engine/LocatorResolver';
import type { Page, Locator } from 'playwright';
import type { LocatorDescriptor } from '../../../src/engine/types';

// ── Mock helpers ─────────────────────────────────────────────────────────

/** Create a mock Locator that resolves to `count` elements. */
function mockLocator(count: number): Locator {
  return { count: vi.fn(() => Promise.resolve(count)) } as unknown as Locator;
}

/** Create a Locator whose count() throws on first call (stale), then succeeds. */
function staleLocator(eventualCount: number): Locator {
  let calls = 0;
  return {
    count: vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('Element is not attached to the DOM'));
      return Promise.resolve(eventualCount);
    }),
  } as unknown as Locator;
}

/** Create a Locator whose count() always throws. */
function errorLocator(message: string): Locator {
  return { count: vi.fn(() => Promise.reject(new Error(message))) } as unknown as Locator;
}

/**
 * Create a mock Playwright Page.
 * `locatorMap` maps strategy method calls to locators.
 */
function createMockPage(locatorMap: {
  getByTestId?: Locator;
  getByRole?: Locator;
  getByLabel?: Locator;
  getByText?: Locator;
  locator?: Record<string, Locator>;
}): Page {
  return {
    getByTestId: vi.fn((_testId: string) => locatorMap.getByTestId ?? mockLocator(0)),
    getByRole: vi.fn((_role: string, _opts?: any) => locatorMap.getByRole ?? mockLocator(0)),
    getByLabel: vi.fn((_label: string) => locatorMap.getByLabel ?? mockLocator(0)),
    getByText: vi.fn((_text: string) => locatorMap.getByText ?? mockLocator(0)),
    locator: vi.fn((selector: string) => locatorMap.locator?.[selector] ?? mockLocator(0)),
  } as unknown as Page;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('LocatorResolver', () => {
  const resolver = new LocatorResolver({ timeout: 1000 });

  // ── Strategy priority ──────────────────────────────────────────────

  describe('strategy priority', () => {
    test('prefers testId over all other strategies', async () => {
      const page = createMockPage({
        getByTestId: mockLocator(1),
        getByRole: mockLocator(1),
        getByLabel: mockLocator(1),
        locator: {
          '#myid': mockLocator(1),
          'div.my-css': mockLocator(1),
        },
      });

      const descriptor: LocatorDescriptor = {
        testId: 'submit',
        role: 'button',
        ariaLabel: 'Submit',
        id: 'myid',
        css: 'div.my-css',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('testId');
      expect(result.locator).not.toBeNull();
      expect(result.attempts).toBe(1);
    });

    test('falls back to role when testId not in descriptor', async () => {
      const page = createMockPage({
        getByRole: mockLocator(1),
        getByLabel: mockLocator(1),
      });

      const descriptor: LocatorDescriptor = {
        role: 'button',
        name: 'Submit',
        ariaLabel: 'Submit form',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('role');
    });

    test('falls back to ariaLabel when testId and role not present', async () => {
      const page = createMockPage({
        getByLabel: mockLocator(1),
      });

      const descriptor: LocatorDescriptor = {
        ariaLabel: 'Email address',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('ariaLabel');
    });

    test('falls back to name attribute when higher strategies absent', async () => {
      const page = createMockPage({
        locator: { '[name="email"]': mockLocator(1) },
      });

      const descriptor: LocatorDescriptor = {
        name: 'email',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('name');
    });

    test('name strategy skipped when role is also present (role+name combined)', async () => {
      const page = createMockPage({
        getByRole: mockLocator(0), // role strategy fails
        locator: { '[name="email"]': mockLocator(1) },
      });

      const descriptor: LocatorDescriptor = {
        role: 'textbox',
        name: 'email',
      };

      const result = await resolver.resolve(page, descriptor);
      // Should NOT use standalone 'name' strategy since role is present
      // It should fall through to other strategies or return null
      expect(result.strategy).not.toBe('name');
    });

    test('falls back to id when higher strategies fail', async () => {
      const page = createMockPage({
        getByTestId: mockLocator(0),
        locator: { '#submit-btn': mockLocator(1) },
      });

      const descriptor: LocatorDescriptor = {
        testId: 'submit',
        id: 'submit-btn',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('id');
      expect(result.attempts).toBe(2); // tried testId first, then id
    });

    test('falls back to text when others fail', async () => {
      const page = createMockPage({
        getByText: mockLocator(1),
      });

      const descriptor: LocatorDescriptor = {
        text: 'Submit Application',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('text');
    });

    test('falls back to css when semantic strategies fail', async () => {
      const page = createMockPage({
        getByTestId: mockLocator(0),
        locator: { 'button.submit-btn': mockLocator(1) },
      });

      const descriptor: LocatorDescriptor = {
        testId: 'submit',
        css: 'button.submit-btn',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('css');
    });

    test('falls back to xpath as last resort', async () => {
      const page = createMockPage({
        locator: { '//button[@type="submit"]': mockLocator(1) },
      });

      const descriptor: LocatorDescriptor = {
        xpath: '//button[@type="submit"]',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('xpath');
    });
  });

  // ── No match ───────────────────────────────────────────────────────

  describe('no match', () => {
    test('returns null locator and "none" strategy when nothing resolves', async () => {
      const page = createMockPage({
        getByTestId: mockLocator(0),
        locator: { '#nope': mockLocator(0) },
      });

      const descriptor: LocatorDescriptor = {
        testId: 'missing',
        id: 'nope',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.locator).toBeNull();
      expect(result.strategy).toBe('none');
      expect(result.attempts).toBe(2);
    });
  });

  // ── Stale element retry ────────────────────────────────────────────

  describe('stale element retry', () => {
    test('retries once on stale element and succeeds', async () => {
      const stale = staleLocator(1);
      const page = createMockPage({
        getByTestId: stale,
      });

      const descriptor: LocatorDescriptor = { testId: 'flaky' };

      const result = await resolver.resolve(page, descriptor);
      expect(result.locator).not.toBeNull();
      expect(result.strategy).toBe('testId');
      expect((stale.count as any).mock.calls.length).toBe(2);
    });

    test('fails after exhausting retries on persistent stale errors', async () => {
      const alwaysStale = errorLocator('Element is not attached to the DOM');
      const page = createMockPage({
        getByTestId: alwaysStale,
      });

      const descriptor: LocatorDescriptor = { testId: 'broken' };

      const result = await resolver.resolve(page, descriptor);
      expect(result.locator).toBeNull();
      expect(result.strategy).toBe('none');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe('error handling', () => {
    test('treats non-stale errors as failures without retry', async () => {
      const broken = errorLocator('Navigation interrupted');
      const page = createMockPage({
        getByTestId: broken,
      });

      const descriptor: LocatorDescriptor = { testId: 'nav-error' };

      const result = await resolver.resolve(page, descriptor);
      expect(result.locator).toBeNull();
      // Should have tried only once (no retry for non-stale errors)
      expect((broken.count as any).mock.calls.length).toBe(1);
    });
  });

  // ── Attempts counting ─────────────────────────────────────────────

  describe('attempts counting', () => {
    test('counts each strategy attempted', async () => {
      const page = createMockPage({
        getByTestId: mockLocator(0),
        getByRole: mockLocator(0),
        getByLabel: mockLocator(0),
        getByText: mockLocator(0),
        locator: {
          '[name="x"]': mockLocator(0),
          '#x': mockLocator(0),
          'div.x': mockLocator(0),
          '//div': mockLocator(1), // xpath succeeds
        },
      });

      const descriptor: LocatorDescriptor = {
        testId: 'x',
        role: 'textbox',
        ariaLabel: 'x',
        name: 'x',
        id: 'x',
        text: 'x',
        css: 'div.x',
        xpath: '//div',
      };

      const result = await resolver.resolve(page, descriptor);
      expect(result.strategy).toBe('xpath');
      // testId, role, ariaLabel, id (name skipped because role present), text, css, xpath = 7
      expect(result.attempts).toBe(7);
    });
  });

  // ── Constructor defaults ───────────────────────────────────────────

  describe('constructor defaults', () => {
    test('uses default timeout and retries', async () => {
      const defaultResolver = new LocatorResolver();
      const page = createMockPage({
        getByTestId: mockLocator(1),
      });

      const result = await defaultResolver.resolve(page, { testId: 'x' });
      expect(result.strategy).toBe('testId');
    });
  });
});
