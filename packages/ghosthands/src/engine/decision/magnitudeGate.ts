import type { Page } from 'playwright';
import type { PageContextService } from '../../context/PageContextService.js';
import type { DurableFieldRecord, MergedFieldState } from './mergedObserverTypes';

export const MAGNITUDE_ALLOWED_STATES: Set<MergedFieldState> = new Set([
  'empty',
  'missing_required',
  'invalid_after_fill',
  'ambiguous_observer_mismatch',
  'wrong_value',
]);

export const MAGNITUDE_BLOCKED_STATES: Set<MergedFieldState> = new Set([
  'valid',
  'skipped_optional',
  'unresolvable',
  'pending_stagehand',
]);

export const MAX_MAGNITUDE_ATTEMPTS_PER_FIELD = 2;

export type EscalationFieldState = {
  mergedState: MergedFieldState;
  durableRecord: DurableFieldRecord | null;
  required?: boolean;
};

function normalizeValue(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function appendStateTransition(
  field: DurableFieldRecord,
  nextState: MergedFieldState,
  actor: NonNullable<DurableFieldRecord['lastActor']>,
  timestamp: string,
): DurableFieldRecord['stateHistory'] {
  if (field.lastMergedState === nextState) {
    return field.stateHistory.slice(-5);
  }

  return [
    ...field.stateHistory,
    {
      from: field.lastMergedState,
      to: nextState,
      actor,
      timestamp,
    },
  ].slice(-5);
}

async function readCurrentValue(page: Page, fieldSelector: string): Promise<string> {
  try {
    return await page.locator(fieldSelector).first().evaluate((node) => {
      if (node instanceof HTMLInputElement) {
        if (node.type === 'checkbox' || node.type === 'radio') {
          return node.checked ? 'checked' : '';
        }
        return node.value?.trim() || '';
      }

      if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
        return node.value?.trim() || '';
      }

      const checked = node.getAttribute('aria-checked');
      if (checked === 'true') return 'checked';
      if (checked === 'false') return '';

      const selected = node.getAttribute('aria-selected');
      if (selected === 'true') {
        return (node.textContent || '').replace(/\s+/g, ' ').trim();
      }

      return (node.textContent || '').replace(/\s+/g, ' ').trim();
    });
  } catch {
    return '';
  }
}

export function shouldEscalateToMagnitude(
  field: DurableFieldRecord | null,
  mergedState: MergedFieldState,
  /** When true, stale_context_mismatch fields are escalated to Magnitude */
  isRequired?: boolean,
): boolean {
  if (MAGNITUDE_BLOCKED_STATES.has(mergedState)) return false;
  if (field && field.magnitudeAttemptCount >= MAX_MAGNITUDE_ATTEMPTS_PER_FIELD) return false;
  if (MAGNITUDE_ALLOWED_STATES.has(mergedState)) return true;
  if (mergedState === 'stale_context_mismatch' && isRequired) return true;
  return false;
}

export async function commitMagnitudeResult(
  page: Page,
  field: DurableFieldRecord,
  fieldSelector: string,
  pageContext?: PageContextService,
): Promise<DurableFieldRecord> {
  const timestamp = new Date().toISOString();
  const currentValue = await readCurrentValue(page, fieldSelector);
  const expectedValue = field.expectedValue ?? field.lastCommittedValue ?? null;
  const hasValue = normalizeValue(currentValue).length > 0;
  const hasExpected = expectedValue !== null && normalizeValue(expectedValue).length > 0;
  const matchesExpected = hasExpected
    ? hasValue && normalizeValue(currentValue) === normalizeValue(expectedValue)
    : hasValue; // No expected value → any non-empty fill is considered success
  const nextState: MergedFieldState = matchesExpected ? 'valid' : 'invalid_after_fill';

  const updated: DurableFieldRecord = {
    ...field,
    lastMergedState: nextState,
    lastActor: 'magnitude',
    lastActorTimestamp: timestamp,
    fillAttemptCount: field.fillAttemptCount + 1,
    magnitudeAttemptCount: field.magnitudeAttemptCount + 1,
    lastCommittedValue: currentValue || field.lastCommittedValue,
    stateHistory: appendStateTransition(field, nextState, 'magnitude', timestamp),
  };

  if (pageContext) {
    await pageContext.recordFieldResult({
      questionKey: field.fieldKey,
      state: matchesExpected ? 'filled' : 'failed',
      currentValue: updated.lastCommittedValue ?? undefined,
      source: 'magnitude',
    });
  }

  return updated;
}

export function partitionByEscalationTier(
  fields: Map<string, EscalationFieldState>,
): {
  domEligible: string[];
  magnitudeEligible: string[];
  skip: string[];
} {
  const domEligible: string[] = [];
  const magnitudeEligible: string[] = [];
  const skip: string[] = [];

  for (const [fieldKey, fieldState] of fields.entries()) {
    if (fieldState.mergedState === 'stale_context_mismatch') {
      if (fieldState.required === true) {
        magnitudeEligible.push(fieldKey);
      } else {
        domEligible.push(fieldKey);
      }
      continue;
    }

    if (MAGNITUDE_BLOCKED_STATES.has(fieldState.mergedState)) {
      skip.push(fieldKey);
      continue;
    }

    if (shouldEscalateToMagnitude(fieldState.durableRecord, fieldState.mergedState)) {
      magnitudeEligible.push(fieldKey);
      continue;
    }

    domEligible.push(fieldKey);
  }

  return { domEligible, magnitudeEligible, skip };
}
