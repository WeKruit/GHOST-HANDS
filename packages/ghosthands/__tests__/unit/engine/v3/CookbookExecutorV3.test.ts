/**
 * CookbookExecutorV3 unit tests.
 *
 * Tests dual-mode cookbook replay (DOM-first + GUI fallback).
 */

import { describe, it, expect, mock } from 'bun:test';
import { CookbookExecutorV3 } from '../../../../src/engine/v3/CookbookExecutorV3';
import type { CookbookPageEntry, CookbookAction } from '../../../../src/engine/v3/types';

function makeAction(overrides: Partial<CookbookAction> = {}): CookbookAction {
  return {
    fieldSnapshot: {
      id: 'f1',
      selector: '#firstName',
      fieldType: 'text',
      label: 'First Name',
      required: true,
      boundingBox: { x: 10, y: 10, width: 200, height: 30 },
    },
    domAction: {
      selector: '#firstName',
      valueTemplate: '{{firstName}}',
      action: 'fill',
    },
    guiAction: {
      variant: 'type',
      x: 110,
      y: 25,
      content: 'John',
    },
    executedBy: 'dom',
    healthScore: 1.0,
    ...overrides,
  };
}

function makeEntry(actions: CookbookAction[], healthOverrides?: number[]): CookbookPageEntry {
  return {
    pageFingerprint: 'test-page',
    urlPattern: '*.example.com/apply',
    platform: 'unknown',
    actions,
    healthScore: 0.9,
    perActionHealth: healthOverrides ?? actions.map(() => 0.9),
    successCount: 5,
    failureCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

describe('CookbookExecutorV3', () => {
  describe('template resolution', () => {
    it('resolves {{key}} templates from userData', () => {
      const executor = new CookbookExecutorV3();
      // Access private method via prototype
      const result = (executor as any).resolveTemplate('{{firstName}}', { firstName: 'John' });
      expect(result).toBe('John');
    });

    it('resolves templates case-insensitively', () => {
      const executor = new CookbookExecutorV3();
      const result = (executor as any).resolveTemplate('{{firstname}}', { firstName: 'John' });
      expect(result).toBe('John');
    });

    it('returns null for unresolvable templates', () => {
      const executor = new CookbookExecutorV3();
      const result = (executor as any).resolveTemplate('{{unknownKey}}', { firstName: 'John' });
      expect(result).toBeNull();
    });

    it('returns literal values unchanged', () => {
      const executor = new CookbookExecutorV3();
      const result = (executor as any).resolveTemplate('literal text', {});
      expect(result).toBe('literal text');
    });
  });

  describe('action health filtering', () => {
    it('skips actions below health threshold', async () => {
      const events: string[] = [];
      const executor = new CookbookExecutorV3({
        logEvent: async (type) => { events.push(type); },
      });

      const actions = [makeAction()];
      const entry = makeEntry(actions, [0.1]); // Very low health

      // Mock page — execute won't actually run because health is too low
      const mockPage = {} as any;
      const result = await executor.execute(mockPage, entry, { firstName: 'John' });

      expect(result.actionsAttempted).toBe(0);
      expect(events).toContain('cookbook_action_skipped');
    });
  });

  describe('consecutive failure abort', () => {
    it('aborts after maxConsecutiveFailures', async () => {
      const executor = new CookbookExecutorV3({
        maxConsecutiveFailures: 2,
      });

      const actions = [
        makeAction({ fieldSnapshot: { ...makeAction().fieldSnapshot, id: 'f1', selector: '#nonexistent1' } }),
        makeAction({ fieldSnapshot: { ...makeAction().fieldSnapshot, id: 'f2', selector: '#nonexistent2' } }),
        makeAction({ fieldSnapshot: { ...makeAction().fieldSnapshot, id: 'f3', selector: '#nonexistent3' } }),
      ];
      const entry = makeEntry(actions);

      // Mock page that always fails DOM operations
      const mockPage = {
        evaluate: mock(() => Promise.resolve(null)),
        $: mock(() => Promise.resolve(null)),
        waitForSelector: mock(() => Promise.reject(new Error('not found'))),
      } as any;

      const result = await executor.execute(mockPage, entry, { firstName: 'John' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('consecutive failures');
    });
  });
});
