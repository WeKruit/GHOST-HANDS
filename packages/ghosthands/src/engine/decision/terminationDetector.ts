import type { DecisionAction, DecisionLoopState } from './types';

export const MAX_ITERATIONS = 100;
export const MAX_SAME_PAGE = 6;
export const MAX_CONSECUTIVE_FAILURES = 3;

export type TerminationCheck =
  | { type: 'confirmation'; reason: string }
  | { type: 'review_page'; reason: string }
  | { type: 'blocked'; reason: string }
  | { type: 'stuck'; reason: string }
  | { type: 'budget_exceeded'; reason: string }
  | { type: 'max_iterations'; reason: string }
  | { type: 'error'; reason: string };

function countConsecutiveFailures(loopState: DecisionLoopState): number {
  let failures = 0;
  for (let i = loopState.actionHistory.length - 1; i >= 0; i--) {
    if (loopState.actionHistory[i].result === 'failed') {
      failures++;
      continue;
    }
    break;
  }
  return failures;
}

export function checkTermination(
  decision: DecisionAction,
  loopState: DecisionLoopState,
  budgetUsd: number,
): TerminationCheck | null {
  if (decision.action === 'mark_complete') {
    return {
      type: 'confirmation',
      reason: 'Decision engine marked the application flow as complete.',
    };
  }

  if (decision.action === 'stop_for_review') {
    return {
      type: 'review_page',
      reason: 'Decision engine stopped on a review page before final submission.',
    };
  }

  if (decision.action === 'report_blocked') {
    return {
      type: 'blocked',
      reason: 'Decision engine detected a blocker that likely requires human review.',
    };
  }

  if (loopState.samePageCount >= MAX_SAME_PAGE) {
    return {
      type: 'stuck',
      reason: `Page fingerprint remained unchanged for ${loopState.samePageCount} iterations.`,
    };
  }

  if (loopState.loopCostUsd >= budgetUsd) {
    return {
      type: 'budget_exceeded',
      reason: `Loop cost $${loopState.loopCostUsd.toFixed(4)} exceeded budget $${budgetUsd.toFixed(4)}.`,
    };
  }

  if (loopState.iteration >= MAX_ITERATIONS) {
    return {
      type: 'max_iterations',
      reason: `Reached max iteration limit (${MAX_ITERATIONS}).`,
    };
  }

  const consecutiveFailures = countConsecutiveFailures(loopState);
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      type: 'error',
      reason: `${consecutiveFailures} consecutive action failures detected.`,
    };
  }

  return null;
}
