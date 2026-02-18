import { describe, expect, test } from 'vitest';
import {
  LocatorDescriptorSchema,
  ManualStepSchema,
  ActionManualSchema,
  ManualSourceSchema,
  PageObservationSchema,
  FieldObservationSchema,
  FormObservationSchema,
  ButtonObservationSchema,
  NavObservationSchema,
  BlockerDetectionSchema,
  BlockerTypeSchema,
  ObservedElementSchema,
} from '../../../src/engine/types';

// ── LocatorDescriptor ────────────────────────────────────────────────────

describe('LocatorDescriptorSchema', () => {
  test('accepts a descriptor with testId only', () => {
    const result = LocatorDescriptorSchema.parse({ testId: 'submit-btn' });
    expect(result.testId).toBe('submit-btn');
  });

  test('accepts a descriptor with role + name', () => {
    const result = LocatorDescriptorSchema.parse({ role: 'button', name: 'Submit' });
    expect(result.role).toBe('button');
    expect(result.name).toBe('Submit');
  });

  test('accepts a descriptor with css only', () => {
    const result = LocatorDescriptorSchema.parse({ css: '#email-input' });
    expect(result.css).toBe('#email-input');
  });

  test('accepts a descriptor with xpath only', () => {
    const result = LocatorDescriptorSchema.parse({ xpath: '//button[@type="submit"]' });
    expect(result.xpath).toBe('//button[@type="submit"]');
  });

  test('accepts a descriptor with all strategies', () => {
    const full = {
      testId: 'submit',
      role: 'button',
      name: 'Submit',
      ariaLabel: 'Submit form',
      id: 'submit-btn',
      text: 'Submit',
      css: '#submit-btn',
      xpath: '//button[@id="submit-btn"]',
    };
    const result = LocatorDescriptorSchema.parse(full);
    expect(result.testId).toBe('submit');
    expect(result.xpath).toBe('//button[@id="submit-btn"]');
  });

  test('rejects an empty descriptor (no strategies)', () => {
    expect(() => LocatorDescriptorSchema.parse({})).toThrow();
  });

  test('rejects a descriptor with all undefined values', () => {
    expect(() => LocatorDescriptorSchema.parse({
      testId: undefined,
      role: undefined,
    })).toThrow();
  });

  test('strips unknown keys', () => {
    const result = LocatorDescriptorSchema.parse({ testId: 'x', bogus: 'y' } as any);
    expect(result.testId).toBe('x');
    expect((result as any).bogus).toBeUndefined();
  });
});

// ── ManualStep ───────────────────────────────────────────────────────────

describe('ManualStepSchema', () => {
  const validStep = {
    order: 0,
    locator: { testId: 'email' },
    action: 'fill' as const,
    value: 'test@example.com',
  };

  test('accepts a valid step with required fields', () => {
    const result = ManualStepSchema.parse(validStep);
    expect(result.order).toBe(0);
    expect(result.action).toBe('fill');
    expect(result.value).toBe('test@example.com');
  });

  test('defaults healthScore to 1.0', () => {
    const result = ManualStepSchema.parse(validStep);
    expect(result.healthScore).toBe(1.0);
  });

  test('accepts optional fields', () => {
    const result = ManualStepSchema.parse({
      ...validStep,
      description: 'Enter email address',
      waitAfter: 500,
      verification: 'input has value',
      healthScore: 0.8,
    });
    expect(result.description).toBe('Enter email address');
    expect(result.waitAfter).toBe(500);
    expect(result.verification).toBe('input has value');
    expect(result.healthScore).toBe(0.8);
  });

  test('rejects missing locator', () => {
    expect(() => ManualStepSchema.parse({ order: 0, action: 'click' })).toThrow();
  });

  test('rejects invalid action', () => {
    expect(() => ManualStepSchema.parse({
      order: 0,
      locator: { testId: 'x' },
      action: 'doubleclick',
    })).toThrow();
  });

  test('rejects negative order', () => {
    expect(() => ManualStepSchema.parse({
      order: -1,
      locator: { testId: 'x' },
      action: 'click',
    })).toThrow();
  });

  test('rejects healthScore out of range', () => {
    expect(() => ManualStepSchema.parse({
      ...validStep,
      healthScore: 1.5,
    })).toThrow();
  });

  test('rejects negative waitAfter', () => {
    expect(() => ManualStepSchema.parse({
      ...validStep,
      waitAfter: -100,
    })).toThrow();
  });

  test('accepts all valid action types', () => {
    const actions = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'press', 'navigate', 'wait', 'scroll'];
    for (const action of actions) {
      const result = ManualStepSchema.parse({
        order: 0,
        locator: { css: 'button' },
        action,
      });
      expect(result.action).toBe(action);
    }
  });
});

// ── ManualSource ─────────────────────────────────────────────────────────

describe('ManualSourceSchema', () => {
  test('accepts "recorded"', () => {
    expect(ManualSourceSchema.parse('recorded')).toBe('recorded');
  });

  test('accepts "actionbook"', () => {
    expect(ManualSourceSchema.parse('actionbook')).toBe('actionbook');
  });

  test('accepts "template"', () => {
    expect(ManualSourceSchema.parse('template')).toBe('template');
  });

  test('rejects invalid source', () => {
    expect(() => ManualSourceSchema.parse('manual')).toThrow();
  });
});

// ── ActionManual ─────────────────────────────────────────────────────────

describe('ActionManualSchema', () => {
  const now = new Date().toISOString();
  const validManual = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    url_pattern: 'https://jobs.lever.co/**/apply',
    task_pattern: 'apply_to_job',
    platform: 'lever',
    steps: [
      { order: 0, locator: { testId: 'name-input' }, action: 'fill' as const, value: '{{name}}' },
      { order: 1, locator: { css: 'button[type="submit"]' }, action: 'click' as const },
    ],
    health_score: 0.95,
    source: 'recorded' as const,
    created_at: now,
    updated_at: now,
  };

  test('accepts a valid manual', () => {
    const result = ActionManualSchema.parse(validManual);
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.platform).toBe('lever');
    expect(result.steps).toHaveLength(2);
    expect(result.source).toBe('recorded');
  });

  test('rejects invalid UUID for id', () => {
    expect(() => ActionManualSchema.parse({
      ...validManual,
      id: 'not-a-uuid',
    })).toThrow();
  });

  test('rejects empty steps array', () => {
    expect(() => ActionManualSchema.parse({
      ...validManual,
      steps: [],
    })).toThrow();
  });

  test('rejects invalid datetime strings', () => {
    expect(() => ActionManualSchema.parse({
      ...validManual,
      created_at: 'not-a-date',
    })).toThrow();
  });

  test('defaults health_score to 1.0', () => {
    const { health_score, ...withoutScore } = validManual;
    const result = ActionManualSchema.parse(withoutScore);
    expect(result.health_score).toBe(1.0);
  });

  test('rejects health_score above 1', () => {
    expect(() => ActionManualSchema.parse({
      ...validManual,
      health_score: 2.0,
    })).toThrow();
  });
});

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
    const types = ['captcha', 'login', '2fa', 'bot_check'];
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
