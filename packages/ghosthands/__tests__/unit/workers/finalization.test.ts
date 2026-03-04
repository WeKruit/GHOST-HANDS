import { describe, it, expect } from 'bun:test';
import { serializeContextReport } from '../../../src/workers/finalization.js';
import { redactSensitiveValue } from '../../../src/context/PageContextReducer.js';
import type { ContextReport } from '../../../src/context/types.js';

// ---------------------------------------------------------------------------
// redactSensitiveValue
// ---------------------------------------------------------------------------

describe('redactSensitiveValue', () => {
  it('redacts values when field name matches sensitive patterns', () => {
    expect(redactSensitiveValue('Password', 'hunter2')).toBe('[REDACTED]');
    expect(redactSensitiveValue('Enter your OTP code', '123456')).toBe('[REDACTED]');
    expect(redactSensitiveValue('SSN', '123-45-6789')).toBe('[REDACTED]');
    expect(redactSensitiveValue('Credit Card Number', '4111111111111111')).toBe('[REDACTED]');
    expect(redactSensitiveValue('CVV', '123')).toBe('[REDACTED]');
    expect(redactSensitiveValue('auth_token', 'eyJhbGciOi...')).toBe('[REDACTED]');
    expect(redactSensitiveValue('secret_key', 'my-secret')).toBe('[REDACTED]');
    expect(redactSensitiveValue('api_secret', 'sk-abc123')).toBe('[REDACTED]');
    expect(redactSensitiveValue('PIN code', '9999')).toBe('[REDACTED]');
  });

  it('does not redact values for non-sensitive fields', () => {
    expect(redactSensitiveValue('First Name', 'John')).toBe('John');
    expect(redactSensitiveValue('Email', 'john@example.com')).toBe('john@example.com');
    expect(redactSensitiveValue('Phone Number', '555-1234')).toBe('555-1234');
    expect(redactSensitiveValue('Address', '123 Main St')).toBe('123 Main St');
  });

  it('redacts empty string values for sensitive fields', () => {
    expect(redactSensitiveValue('Password', '')).toBe('[REDACTED]');
  });

  it('is case-insensitive on field name', () => {
    expect(redactSensitiveValue('PASSWORD', 'x')).toBe('[REDACTED]');
    expect(redactSensitiveValue('pAssWoRd', 'x')).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// serializeContextReport — redaction integration
// ---------------------------------------------------------------------------

describe('serializeContextReport', () => {
  function makeReport(overrides: Partial<ContextReport> = {}): ContextReport {
    return {
      pagesVisited: 1,
      requiredUnresolved: [],
      riskyOptionalAnswers: [],
      lowConfidenceAnswers: [],
      ambiguousQuestionGroups: [],
      bestEffortGuesses: [],
      partialPages: [],
      flushStatus: 'flushed',
      ...overrides,
    };
  }

  it('redacts sensitive answers in riskyOptionalAnswers', () => {
    const report = makeReport({
      riskyOptionalAnswers: [
        {
          pageId: 'p1',
          pageSequence: 1,
          promptText: 'Enter your Password',
          questionKey: 'q1',
          riskLevel: 'optional_risky',
          answer: 'hunter2',
        },
        {
          pageId: 'p1',
          pageSequence: 1,
          promptText: 'Your name',
          questionKey: 'q2',
          riskLevel: 'optional_risky',
          answer: 'Alice',
        },
      ],
    });
    const serialized = serializeContextReport(report);
    const risky = serialized.risky_optional_answers as Array<{ answer?: string }>;
    expect(risky[0].answer).toBe('[REDACTED]');
    expect(risky[1].answer).toBe('Alice');
  });

  it('redacts sensitive answers in lowConfidenceAnswers', () => {
    const report = makeReport({
      lowConfidenceAnswers: [
        {
          pageId: 'p1',
          pageSequence: 1,
          promptText: 'Social Security Number',
          questionKey: 'q1',
          confidence: 0.3,
          answer: '123-45-6789',
        },
      ],
    });
    const serialized = serializeContextReport(report);
    const low = serialized.low_confidence_answers as Array<{ answer?: string }>;
    expect(low[0].answer).toBe('[REDACTED]');
  });

  it('redacts sensitive answers in bestEffortGuesses', () => {
    const report = makeReport({
      bestEffortGuesses: [
        {
          pageId: 'p1',
          pageSequence: 1,
          questionKey: 'q1',
          promptText: 'OTP Code',
          answer: '999999',
        },
      ],
    });
    const serialized = serializeContextReport(report);
    const guesses = serialized.best_effort_guesses as Array<{ answer?: string }>;
    expect(guesses[0].answer).toBe('[REDACTED]');
  });

  it('preserves non-sensitive answers unchanged', () => {
    const report = makeReport({
      bestEffortGuesses: [
        {
          pageId: 'p1',
          pageSequence: 1,
          questionKey: 'q1',
          promptText: 'City of residence',
          answer: 'San Francisco',
        },
      ],
    });
    const serialized = serializeContextReport(report);
    const guesses = serialized.best_effort_guesses as Array<{ answer?: string }>;
    expect(guesses[0].answer).toBe('San Francisco');
  });
});
