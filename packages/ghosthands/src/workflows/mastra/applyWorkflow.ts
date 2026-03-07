/**
 * Apply Workflow — Assembles the gh_apply Mastra workflow.
 *
 * Flow:
 *   checkBlockers -> executeHandler
 */

import { createWorkflow } from '@mastra/core/workflows';

import { workflowState, type RuntimeContext } from './types.js';
import { buildSteps } from './steps/factory.js';

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
