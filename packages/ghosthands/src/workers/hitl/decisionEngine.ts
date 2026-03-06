import type { BlockerType } from '../../detection/BlockerDetector.js';

export type HitlDecisionAction =
  | 'IMMEDIATE_HITL'
  | 'AUTO_RECOVER'
  | 'RETRY_NO_HITL'
  | 'NO_ACTION';

export type RecoverableAuthBlockerType = 'login' | 'verification' | '2fa';

export type HitlAttemptsByType = Partial<Record<RecoverableAuthBlockerType, number>>;

export interface HitlDecisionInput {
  blockerType: BlockerType | 'context_lost';
  confidence: number;
  source?: string;
  selector?: string;
  attemptsByType?: HitlAttemptsByType;
  hasCodeEntryPath?: boolean;
  allowAutoRecoverAuth?: boolean;
}

export interface HitlDecision {
  action: HitlDecisionAction;
  blockerType: BlockerType | 'context_lost';
  reason:
    | 'hard_blocker'
    | 'auth_automation_unavailable'
    | 'auth_recovery_attempt'
    | 'auth_recovery_exhausted'
    | 'no_code_entry_path'
    | 'rate_limited_retry'
    | 'low_confidence'
    | 'unsupported_blocker_type';
  threshold: number;
  attemptNumber?: number;
  attemptsRemaining?: number;
}

export const HITL_DECISION_THRESHOLDS = {
  hardBlocker: 0.75,
  authBlocker: 0.75,
  rateLimited: 0.75,
} as const;

export const AUTH_RECOVERY_MAX_ATTEMPTS = 2;

const RECOVERABLE_AUTH_TYPES: ReadonlySet<RecoverableAuthBlockerType> = new Set([
  'login',
  'verification',
  '2fa',
]);

export function createEmptyHitlAttempts(): HitlAttemptsByType {
  return {};
}

export function isRecoverableAuthBlocker(type: string): type is RecoverableAuthBlockerType {
  return RECOVERABLE_AUTH_TYPES.has(type as RecoverableAuthBlockerType);
}

export function getHitlAttemptsForType(
  attempts: HitlAttemptsByType | undefined,
  blockerType: RecoverableAuthBlockerType,
): number {
  return Math.max(0, attempts?.[blockerType] ?? 0);
}

export function incrementHitlAttempt(
  attempts: HitlAttemptsByType | undefined,
  blockerType: RecoverableAuthBlockerType,
): HitlAttemptsByType {
  const current = getHitlAttemptsForType(attempts, blockerType);
  return {
    ...(attempts || {}),
    [blockerType]: current + 1,
  };
}

export function hasAnyHitlAttempts(attempts: HitlAttemptsByType | undefined): boolean {
  if (!attempts) return false;
  return Object.values(attempts).some((count) => (count ?? 0) > 0);
}

export function decideHitlAction(input: HitlDecisionInput): HitlDecision {
  const {
    blockerType,
    confidence,
    attemptsByType,
    hasCodeEntryPath = true,
    allowAutoRecoverAuth = true,
  } = input;

  if (blockerType === 'context_lost') {
    return {
      action: 'IMMEDIATE_HITL',
      blockerType,
      reason: 'hard_blocker',
      threshold: HITL_DECISION_THRESHOLDS.hardBlocker,
    };
  }

  if (blockerType === 'captcha' || blockerType === 'bot_check') {
    if (confidence >= HITL_DECISION_THRESHOLDS.hardBlocker) {
      return {
        action: 'IMMEDIATE_HITL',
        blockerType,
        reason: 'hard_blocker',
        threshold: HITL_DECISION_THRESHOLDS.hardBlocker,
      };
    }
    return {
      action: 'NO_ACTION',
      blockerType,
      reason: 'low_confidence',
      threshold: HITL_DECISION_THRESHOLDS.hardBlocker,
    };
  }

  if (blockerType === 'rate_limited') {
    if (confidence >= HITL_DECISION_THRESHOLDS.rateLimited) {
      return {
        action: 'RETRY_NO_HITL',
        blockerType,
        reason: 'rate_limited_retry',
        threshold: HITL_DECISION_THRESHOLDS.rateLimited,
      };
    }
    return {
      action: 'NO_ACTION',
      blockerType,
      reason: 'low_confidence',
      threshold: HITL_DECISION_THRESHOLDS.rateLimited,
    };
  }

  if (!isRecoverableAuthBlocker(blockerType)) {
    return {
      action: 'NO_ACTION',
      blockerType,
      reason: 'unsupported_blocker_type',
      threshold: HITL_DECISION_THRESHOLDS.authBlocker,
    };
  }

  if (confidence < HITL_DECISION_THRESHOLDS.authBlocker) {
    return {
      action: 'NO_ACTION',
      blockerType,
      reason: 'low_confidence',
      threshold: HITL_DECISION_THRESHOLDS.authBlocker,
    };
  }

  if (!allowAutoRecoverAuth) {
    return {
      action: 'IMMEDIATE_HITL',
      blockerType,
      reason: 'auth_automation_unavailable',
      threshold: HITL_DECISION_THRESHOLDS.authBlocker,
    };
  }

  if (blockerType === '2fa' && !hasCodeEntryPath) {
    return {
      action: 'IMMEDIATE_HITL',
      blockerType,
      reason: 'no_code_entry_path',
      threshold: HITL_DECISION_THRESHOLDS.authBlocker,
    };
  }

  const attemptsUsed = getHitlAttemptsForType(attemptsByType, blockerType);

  if (attemptsUsed >= AUTH_RECOVERY_MAX_ATTEMPTS) {
    return {
      action: 'IMMEDIATE_HITL',
      blockerType,
      reason: 'auth_recovery_exhausted',
      threshold: HITL_DECISION_THRESHOLDS.authBlocker,
      attemptNumber: attemptsUsed,
      attemptsRemaining: 0,
    };
  }

  const nextAttempt = attemptsUsed + 1;
  return {
    action: 'AUTO_RECOVER',
    blockerType,
    reason: 'auth_recovery_attempt',
    threshold: HITL_DECISION_THRESHOLDS.authBlocker,
    attemptNumber: nextAttempt,
    attemptsRemaining: AUTH_RECOVERY_MAX_ATTEMPTS - nextAttempt,
  };
}
