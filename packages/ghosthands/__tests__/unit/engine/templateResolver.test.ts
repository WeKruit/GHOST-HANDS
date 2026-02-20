import { describe, expect, test } from 'vitest';
import { resolveTemplate, resolveOptionalTemplate } from '../../../src/engine/templateResolver';

describe('resolveTemplate', () => {
  test('replaces a single variable', () => {
    expect(resolveTemplate('Hello {{name}}', { name: 'Alice' }))
      .toBe('Hello Alice');
  });

  test('replaces multiple different variables', () => {
    const result = resolveTemplate(
      '{{firstName}} {{lastName}} ({{email}})',
      { firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
    );
    expect(result).toBe('John Doe (john@test.com)');
  });

  test('replaces repeated occurrences of the same variable', () => {
    expect(resolveTemplate('{{x}} and {{x}}', { x: 'val' }))
      .toBe('val and val');
  });

  test('leaves unknown variables as-is', () => {
    expect(resolveTemplate('Hello {{unknown}}', { name: 'Alice' }))
      .toBe('Hello {{unknown}}');
  });

  test('returns original string when no variables present', () => {
    expect(resolveTemplate('No variables here', { name: 'test' }))
      .toBe('No variables here');
  });

  test('handles empty data map', () => {
    expect(resolveTemplate('{{name}}', {}))
      .toBe('{{name}}');
  });

  test('handles empty template string', () => {
    expect(resolveTemplate('', { name: 'test' }))
      .toBe('');
  });

  test('replaces with empty string value', () => {
    expect(resolveTemplate('Hello {{name}}!', { name: '' }))
      .toBe('Hello !');
  });

  test('handles special characters in values', () => {
    expect(resolveTemplate('{{url}}', { url: 'https://example.com/path?q=1&r=2' }))
      .toBe('https://example.com/path?q=1&r=2');
  });

  test('does not replace variables with spaces in key', () => {
    expect(resolveTemplate('{{first name}}', { 'first name': 'Bob' }))
      .toBe('{{first name}}');
  });

  test('handles adjacent variables', () => {
    expect(resolveTemplate('{{a}}{{b}}', { a: 'X', b: 'Y' }))
      .toBe('XY');
  });
});

describe('resolveOptionalTemplate', () => {
  test('returns undefined for undefined input', () => {
    expect(resolveOptionalTemplate(undefined, { name: 'test' }))
      .toBeUndefined();
  });

  test('resolves template for defined string', () => {
    expect(resolveOptionalTemplate('{{name}}', { name: 'Alice' }))
      .toBe('Alice');
  });

  test('returns empty string for empty string input', () => {
    expect(resolveOptionalTemplate('', { name: 'test' }))
      .toBe('');
  });
});
