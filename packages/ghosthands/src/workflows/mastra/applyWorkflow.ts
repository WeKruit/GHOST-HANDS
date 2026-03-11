/**
 * Apply Workflow — Assembles the gh_apply Mastra workflow.
 *
 * Two workflow variants:
 *   1. buildApplyWorkflow()          — checkBlockers -> executeHandler (existing, SmartApplyHandler)
 *   2. buildDecisionApplyWorkflow()  — checkBlockers -> pageDecisionLoop (new, decision engine)
 *
 * Both share the same check_blockers_checkpoint step. The second step differs:
 * - execute_handler delegates to SmartApplyHandler.execute()
 * - page_decision_loop runs the internal observe-decide-act loop with tiered execution
 */

import { createWorkflow } from '@mastra/core/workflows';

import { workflowState, type RuntimeContext } from './types.js';
import { buildSteps, buildPageDecisionLoopStep } from './steps/factory.js';

/**
 * Build the committed gh_apply workflow with RuntimeContext captured via closure.
 *
 * The returned workflow is ready to be registered with a Mastra instance and
 * executed via `mastra.getWorkflow('gh_apply').start(initialState)`.
 */
export function buildApplyWorkflow(rt: RuntimeContext) {
  const { checkBlockers, executeHandler } = buildSteps(rt);

  const workflow = createWorkflow({
    id: 'gh_apply',
    inputSchema: workflowState,
    outputSchema: workflowState,
  })
    .then(checkBlockers)
    .then(executeHandler)
    .commit();

  return workflow;
}

// ---------------------------------------------------------------------------
// Decision Engine Workflow (additive — does NOT modify buildApplyWorkflow)
// ---------------------------------------------------------------------------

/**
 * Build the decision engine variant of the gh_apply workflow.
 *
 * Flow: checkBlockers -> pageDecisionLoop
 *
 * Uses the same check_blockers_checkpoint step for initial blocker detection,
 * then runs the decision engine loop instead of SmartApplyHandler.
 *
 * @param rt - RuntimeContext (closure-injected, never serialized)
 * @param loopRunnerFactory - Factory to create DecisionLoopRunner instances.
 *   This is injected by the caller (jobExecutor) so the step does not
 *   directly depend on engine/decision module resolution at import time.
 */
export function buildDecisionApplyWorkflow(
  rt: RuntimeContext,
  loopRunnerFactory: Parameters<typeof buildPageDecisionLoopStep>[1],
) {
  const { checkBlockers } = buildSteps(rt);
  const pageDecisionLoop = buildPageDecisionLoopStep(rt, loopRunnerFactory);

  const workflow = createWorkflow({
    id: 'gh_apply_decision',
    inputSchema: workflowState,
    outputSchema: workflowState,
  })
    .then(checkBlockers)
    .then(pageDecisionLoop)
    .commit();

  return workflow;
}
