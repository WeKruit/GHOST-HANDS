/**
 * Unit tests for ValetResumeSchema — credential injection schema validation.
 *
 * Tests:
 * - Accepts resolution_type + resolution_data (new credential injection fields)
 * - Backwards compatibility (legacy format without resolution fields)
 * - resolution_type enum validation
 * - resolution_data accepts arbitrary JSON objects
 * - Rejects invalid resolution_type values
 * - Defaults behavior (resolved_by defaults to 'human')
 */

import { describe, expect, test } from 'vitest';
import { ValetResumeSchema } from '../../../src/api/schemas/valet.js';

describe('ValetResumeSchema', () => {
  // ─── New credential injection fields ──────────────────────────────────

  test('accepts resolution_type code_entry with resolution_data containing code', () => {
    const result = ValetResumeSchema.safeParse({
      resolved_by: 'human',
      resolution_type: 'code_entry',
      resolution_data: { code: '123456' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolution_type).toBe('code_entry');
      expect(result.data.resolution_data).toEqual({ code: '123456' });
    }
  });

  test('accepts resolution_type credentials with username and password', () => {
    const result = ValetResumeSchema.safeParse({
      resolved_by: 'human',
      resolution_type: 'credentials',
      resolution_data: { username: 'user@example.com', password: 's3cret' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolution_type).toBe('credentials');
      expect(result.data.resolution_data).toEqual({
        username: 'user@example.com',
        password: 's3cret',
      });
    }
  });

  // ─── Backwards compatibility ──────────────────────────────────────────

  test('accepts legacy format without resolution_type or resolution_data', () => {
    const result = ValetResumeSchema.safeParse({
      resolved_by: 'human',
      resolution_notes: 'Manually solved captcha',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolution_type).toBeUndefined();
      expect(result.data.resolution_data).toBeUndefined();
    }
  });

  test('accepts empty object (all fields optional or have defaults)', () => {
    const result = ValetResumeSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved_by).toBe('human'); // default
    }
  });

  // ─── resolution_type enum validation ──────────────────────────────────

  test('accepts resolution_type manual', () => {
    const result = ValetResumeSchema.safeParse({ resolution_type: 'manual' });
    expect(result.success).toBe(true);
  });

  test('accepts resolution_type skip', () => {
    const result = ValetResumeSchema.safeParse({ resolution_type: 'skip' });
    expect(result.success).toBe(true);
  });

  test('rejects invalid resolution_type value', () => {
    const result = ValetResumeSchema.safeParse({
      resolution_type: 'hack_it',
    });
    expect(result.success).toBe(false);
  });

  // ─── resolution_data accepts arbitrary JSON ───────────────────────────

  test('resolution_data accepts nested objects', () => {
    const result = ValetResumeSchema.safeParse({
      resolution_type: 'credentials',
      resolution_data: {
        username: 'admin',
        password: 'p@ss',
        extra: { mfa_token: 'abc', remember_me: true },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.resolution_data as any).extra.mfa_token).toBe('abc');
    }
  });

  test('resolution_data accepts empty object', () => {
    const result = ValetResumeSchema.safeParse({
      resolution_type: 'manual',
      resolution_data: {},
    });
    expect(result.success).toBe(true);
  });

  // ─── resolved_by field ────────────────────────────────────────────────

  test('resolved_by defaults to human', () => {
    const result = ValetResumeSchema.safeParse({
      resolution_type: 'code_entry',
      resolution_data: { code: '000000' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved_by).toBe('human');
    }
  });

  test('accepts resolved_by system', () => {
    const result = ValetResumeSchema.safeParse({
      resolved_by: 'system',
      resolution_type: 'skip',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved_by).toBe('system');
    }
  });

  test('rejects invalid resolved_by value', () => {
    const result = ValetResumeSchema.safeParse({
      resolved_by: 'robot',
    });
    expect(result.success).toBe(false);
  });
});
