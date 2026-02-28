import { describe, expect, test } from 'bun:test';
import { SmartApplyHandler } from '../../workers/taskHandlers/smartApplyHandler.js';

describe('SmartApplyHandler', () => {
  const handler = new SmartApplyHandler();

  test('has type "smart_apply"', () => {
    expect(handler.type).toBe('smart_apply');
  });

  test('has a description', () => {
    expect(handler.description).toBeTruthy();
    expect(handler.description.length).toBeGreaterThan(10);
  });

  describe('validate()', () => {
    test('validates successfully with required fields', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          last_name: 'Doe',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test('fails when user_data is missing', () => {
      const result = handler.validate({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data is required');
    });

    test('fails when first_name is missing', () => {
      const result = handler.validate({
        user_data: {
          last_name: 'Doe',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.first_name is required');
    });

    test('fails when last_name is missing', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          email: 'john@example.com',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.last_name is required');
    });

    test('fails when email is missing', () => {
      const result = handler.validate({
        user_data: {
          first_name: 'John',
          last_name: 'Doe',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('user_data.email is required');
    });

    test('collects multiple missing field errors', () => {
      const result = handler.validate({
        user_data: {},
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });
  });
});
