import { describe, expect, test, beforeEach } from 'vitest';
import { TaskHandlerRegistry } from '../../../src/workers/taskHandlers/registry.js';
import type { TaskHandler, TaskContext, TaskResult } from '../../../src/workers/taskHandlers/types.js';

/** Minimal stub handler for testing registry behavior */
function stubHandler(type: string, description = 'stub'): TaskHandler {
  return {
    type,
    description,
    execute: async () => ({ success: true }),
  };
}

describe('TaskHandlerRegistry', () => {
  let registry: TaskHandlerRegistry;

  beforeEach(() => {
    registry = new TaskHandlerRegistry();
  });

  test('starts empty', () => {
    expect(registry.listTypes()).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  test('register and retrieve a handler', () => {
    const handler = stubHandler('apply');
    registry.register(handler);

    expect(registry.has('apply')).toBe(true);
    expect(registry.get('apply')).toBe(handler);
    expect(registry.listTypes()).toEqual(['apply']);
  });

  test('register multiple handlers', () => {
    registry.register(stubHandler('apply'));
    registry.register(stubHandler('scrape'));
    registry.register(stubHandler('custom'));

    expect(registry.listTypes()).toEqual(['apply', 'scrape', 'custom']);
    expect(registry.list()).toHaveLength(3);
  });

  test('throws on duplicate registration', () => {
    registry.register(stubHandler('apply'));
    expect(() => registry.register(stubHandler('apply'))).toThrow(
      'TaskHandler already registered for type: apply'
    );
  });

  test('get returns undefined for unregistered type', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  test('getOrThrow throws with helpful message for unregistered type', () => {
    registry.register(stubHandler('apply'));
    registry.register(stubHandler('scrape'));

    expect(() => registry.getOrThrow('fill_form')).toThrow(
      'No TaskHandler registered for type: fill_form. Available: apply, scrape'
    );
  });

  test('getOrThrow returns handler when registered', () => {
    const handler = stubHandler('apply');
    registry.register(handler);
    expect(registry.getOrThrow('apply')).toBe(handler);
  });
});
