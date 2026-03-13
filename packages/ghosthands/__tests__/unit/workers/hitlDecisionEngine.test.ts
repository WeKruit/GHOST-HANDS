import { describe, expect, test } from 'vitest';

import {
  decideHitlAction,
  getHitlAttemptsForType,
  incrementHitlAttempt,
} from '../../../src/workers/hitl/decisionEngine.js';

describe('HitlDecisionEngine', () => {
  test('hard blockers trigger immediate HITL at or above threshold', () => {
    const decision = decideHitlAction({
      blockerType: 'captcha',
      confidence: 0.8,
    });

    expect(decision.action).toBe('IMMEDIATE_HITL');
    expect(decision.reason).toBe('hard_blocker');
  });

  test('low-confidence hard blockers do not trigger HITL', () => {
    const decision = decideHitlAction({
      blockerType: 'bot_check',
      confidence: 0.7,
    });

    expect(decision.action).toBe('NO_ACTION');
    expect(decision.reason).toBe('low_confidence');
  });

  test('login blocker enters auto-recover path with bounded attempts', () => {
    const decision = decideHitlAction({
      blockerType: 'login',
      confidence: 0.9,
      attemptsByType: {},
      allowAutoRecoverAuth: true,
    });

    expect(decision.action).toBe('AUTO_RECOVER');
    expect(decision.attemptNumber).toBe(1);
    expect(decision.attemptsRemaining).toBe(1);
  });

  test('auth blockers escalate after recovery attempts are exhausted', () => {
    const decision = decideHitlAction({
      blockerType: 'verification',
      confidence: 0.9,
      attemptsByType: { verification: 2 },
      allowAutoRecoverAuth: true,
    });

    expect(decision.action).toBe('IMMEDIATE_HITL');
    expect(decision.reason).toBe('auth_recovery_exhausted');
  });

  test('2FA without a detectable code-entry path escalates immediately', () => {
    const decision = decideHitlAction({
      blockerType: '2fa',
      confidence: 0.9,
      attemptsByType: {},
      hasCodeEntryPath: false,
      allowAutoRecoverAuth: true,
    });

    expect(decision.action).toBe('IMMEDIATE_HITL');
    expect(decision.reason).toBe('no_code_entry_path');
  });

  test('rate limited pages use retry-without-HITL path', () => {
    const decision = decideHitlAction({
      blockerType: 'rate_limited',
      confidence: 0.9,
    });

    expect(decision.action).toBe('RETRY_NO_HITL');
    expect(decision.reason).toBe('rate_limited_retry');
  });

  test('open_question triggers PAUSE_FOR_USER regardless of confidence', () => {
    const decision = decideHitlAction({
      blockerType: 'open_question',
      confidence: 0.1,
    });

    expect(decision.action).toBe('PAUSE_FOR_USER');
    expect(decision.reason).toBe('open_question_needs_user');
    expect(decision.threshold).toBe(0);
  });

  test('open_question at high confidence still triggers PAUSE_FOR_USER', () => {
    const decision = decideHitlAction({
      blockerType: 'open_question',
      confidence: 1.0,
    });

    expect(decision.action).toBe('PAUSE_FOR_USER');
    expect(decision.reason).toBe('open_question_needs_user');
  });

  test('increment helper tracks attempts by blocker type', () => {
    let attempts = incrementHitlAttempt({}, 'login');
    attempts = incrementHitlAttempt(attempts, 'login');
    attempts = incrementHitlAttempt(attempts, '2fa');

    expect(getHitlAttemptsForType(attempts, 'login')).toBe(2);
    expect(getHitlAttemptsForType(attempts, '2fa')).toBe(1);
  });
});
