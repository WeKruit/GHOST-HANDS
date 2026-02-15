import { describe, expect, test, beforeEach } from 'vitest';
import { ApplyHandler } from '../../../src/workers/taskHandlers/applyHandler.js';
import { ScrapeHandler } from '../../../src/workers/taskHandlers/scrapeHandler.js';
import { FillFormHandler } from '../../../src/workers/taskHandlers/fillFormHandler.js';
import { CustomHandler } from '../../../src/workers/taskHandlers/customHandler.js';
import { registerBuiltinHandlers, taskHandlerRegistry } from '../../../src/workers/taskHandlers/index.js';
import { TaskHandlerRegistry } from '../../../src/workers/taskHandlers/registry.js';

describe('Built-in TaskHandlers', () => {
  describe('ApplyHandler', () => {
    const handler = new ApplyHandler();

    test('has correct type and description', () => {
      expect(handler.type).toBe('apply');
      expect(handler.description).toBeTruthy();
    });

    test('validates input — valid profile', () => {
      const result = handler.validate!({
        user_data: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test('validates input — missing fields', () => {
      const result = handler.validate!({ user_data: {} });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.first_name is required');
      expect(result.errors).toContain('user_data.last_name is required');
      expect(result.errors).toContain('user_data.email is required');
    });

    test('validates input — no user_data is valid (optional)', () => {
      const result = handler.validate!({});
      expect(result.valid).toBe(true);
    });
  });

  describe('ScrapeHandler', () => {
    test('has correct type', () => {
      const handler = new ScrapeHandler();
      expect(handler.type).toBe('scrape');
      expect(handler.description).toBeTruthy();
    });
  });

  describe('FillFormHandler', () => {
    test('has correct type', () => {
      const handler = new FillFormHandler();
      expect(handler.type).toBe('fill_form');
      expect(handler.description).toBeTruthy();
    });
  });

  describe('CustomHandler', () => {
    test('has correct type', () => {
      const handler = new CustomHandler();
      expect(handler.type).toBe('custom');
      expect(handler.description).toBeTruthy();
    });
  });

  describe('registerBuiltinHandlers', () => {
    test('registers all built-in handler types', () => {
      // Use a fresh registry to avoid conflicts with the singleton
      const registry = new TaskHandlerRegistry();
      registry.register(new ApplyHandler());
      registry.register(new ScrapeHandler());
      registry.register(new FillFormHandler());
      registry.register(new CustomHandler());

      expect(registry.has('apply')).toBe(true);
      expect(registry.has('scrape')).toBe(true);
      expect(registry.has('fill_form')).toBe(true);
      expect(registry.has('custom')).toBe(true);
      expect(registry.listTypes()).toHaveLength(4);
    });
  });
});
