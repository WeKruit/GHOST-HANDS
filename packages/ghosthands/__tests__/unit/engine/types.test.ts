import { describe, expect, test } from 'vitest';
import {
  PageObservationSchema,
  FieldObservationSchema,
  FormObservationSchema,
  ButtonObservationSchema,
  NavObservationSchema,
  BlockerDetectionSchema,
  BlockerTypeSchema,
  ObservedElementSchema,
} from '../../../src/engine/types';

// ── Observation subtypes ─────────────────────────────────────────────────

describe('FieldObservationSchema', () => {
  test('accepts a valid field observation', () => {
    const result = FieldObservationSchema.parse({
      selector: '#email',
      type: 'email',
      label: 'Email Address',
      name: 'email',
      required: true,
      placeholder: 'you@example.com',
    });
    expect(result.selector).toBe('#email');
    expect(result.required).toBe(true);
  });

  test('requires selector and type', () => {
    expect(() => FieldObservationSchema.parse({ label: 'Email' })).toThrow();
  });
});

describe('FormObservationSchema', () => {
  test('accepts a valid form observation', () => {
    const result = FormObservationSchema.parse({
      selector: 'form#apply',
      action: '/submit',
      method: 'POST',
      fields: [{ selector: '#name', type: 'text' }],
    });
    expect(result.fields).toHaveLength(1);
  });

  test('accepts empty fields array', () => {
    const result = FormObservationSchema.parse({
      selector: 'form',
      fields: [],
    });
    expect(result.fields).toHaveLength(0);
  });
});

describe('ButtonObservationSchema', () => {
  test('accepts a valid button observation', () => {
    const result = ButtonObservationSchema.parse({
      selector: 'button.submit',
      text: 'Submit Application',
      type: 'submit',
      disabled: false,
    });
    expect(result.text).toBe('Submit Application');
  });

  test('requires selector and text', () => {
    expect(() => ButtonObservationSchema.parse({ selector: 'button' })).toThrow();
  });
});

describe('NavObservationSchema', () => {
  test('accepts a valid nav observation', () => {
    const result = NavObservationSchema.parse({
      selector: 'a.next',
      text: 'Next Page',
      href: '/page/2',
    });
    expect(result.href).toBe('/page/2');
  });
});

// ── PageObservation ──────────────────────────────────────────────────────

describe('PageObservationSchema', () => {
  const validObservation = {
    url: 'https://jobs.lever.co/company/apply',
    platform: 'lever',
    pageType: 'application_form',
    fingerprint: 'abc123def456',
    forms: [{
      selector: 'form#apply',
      fields: [{ selector: '#name', type: 'text' }],
    }],
    buttons: [{ selector: 'button.submit', text: 'Submit' }],
    navigation: [{ selector: 'a.back', text: 'Back' }],
    urlPattern: 'https://jobs.lever.co/**/apply',
    structureHash: 'sha256:abc123',
  };

  test('accepts a valid page observation', () => {
    const result = PageObservationSchema.parse(validObservation);
    expect(result.platform).toBe('lever');
    expect(result.forms).toHaveLength(1);
    expect(result.buttons).toHaveLength(1);
  });

  test('rejects missing required fields', () => {
    expect(() => PageObservationSchema.parse({
      url: 'https://example.com',
    })).toThrow();
  });
});

// ── BlockerDetection ─────────────────────────────────────────────────────

describe('BlockerDetectionSchema', () => {
  test('accepts a valid blocker detection', () => {
    const result = BlockerDetectionSchema.parse({
      type: 'captcha',
      confidence: 0.95,
      description: 'reCAPTCHA detected',
      selectors: ['iframe[src*="recaptcha"]'],
    });
    expect(result.type).toBe('captcha');
    expect(result.selectors).toHaveLength(1);
  });

  test('accepts without optional screenshot and selectors', () => {
    const result = BlockerDetectionSchema.parse({
      type: 'login',
      confidence: 0.8,
      description: 'Login form detected',
    });
    expect(result.screenshot).toBeUndefined();
    expect(result.selectors).toBeUndefined();
  });

  test('validates blocker type enum', () => {
    expect(() => BlockerDetectionSchema.parse({
      type: 'popup',
      confidence: 0.5,
      description: 'Unknown',
    })).toThrow();
  });

  test('rejects confidence outside 0-1 range', () => {
    expect(() => BlockerDetectionSchema.parse({
      type: 'captcha',
      confidence: 1.5,
      description: 'Invalid',
    })).toThrow();
  });
});

describe('BlockerTypeSchema', () => {
  test('accepts all valid blocker types', () => {
    const types = ['captcha', 'login', '2fa', 'bot_check', 'rate_limited', 'verification'];
    for (const t of types) {
      expect(BlockerTypeSchema.parse(t)).toBe(t);
    }
  });
});

// ── ObservedElement ──────────────────────────────────────────────────────

describe('ObservedElementSchema', () => {
  test('accepts a valid observed element', () => {
    const result = ObservedElementSchema.parse({
      selector: '#submit-btn',
      description: 'Submit button',
      action: 'click',
    });
    expect(result.selector).toBe('#submit-btn');
    expect(result.action).toBe('click');
  });

  test('accepts "unknown" action', () => {
    const result = ObservedElementSchema.parse({
      selector: 'div.container',
      description: 'Container element',
      action: 'unknown',
    });
    expect(result.action).toBe('unknown');
  });

  test('rejects invalid action', () => {
    expect(() => ObservedElementSchema.parse({
      selector: 'div',
      description: 'Test',
      action: 'doubleclick',
    })).toThrow();
  });

  test('requires all three fields', () => {
    expect(() => ObservedElementSchema.parse({
      selector: '#btn',
    })).toThrow();
  });
});
