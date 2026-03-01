/**
 * Apply Workflow — Assembles the gh_apply Mastra workflow.
 *
 * PRD V5.2 Section 5.4: The top-level workflow that orchestrates a single
 * job application through blocker detection, cookbook replay, and handler
 * execution.
 *
 * Flow:
 *   checkBlockers -> cookbookAttempt -> branch:
 *     - cookbook.success === true  -> cookbook_done (passthrough, status='completed')
 *     - else                      -> executeHandler
 */

import { createWorkflow, createStep } from '@mastra/core/workflows';

import { workflowState, type RuntimeContext } from './types.js';
import { buildSteps } from './steps/factory.js';

/**
 * Build the committed gh_apply workflow with RuntimeContext captured via closure.
 *
 * The returned workflow is ready to be registered with a Mastra instance and
 * executed via `mastra.getWorkflow('gh_apply').start(initialState)`.
 */
export function buildApplyWorkflow(rt: RuntimeContext) {
  const { checkBlockers, cookbookAttempt, executeHandler } = buildSteps(rt);

  // Inline passthrough step for the cookbook-success branch.
  // When the cookbook fully completes the application, we just confirm
  // status='completed' and pass through — no handler execution needed.
  const cookbookDone = createStep({
    id: 'cookbook_done',
    inputSchema: workflowState,
    outputSchema: workflowState,
    execute: async ({ inputData }) => {
      return {
        ...inputData,
        status: 'completed' as const,
      };
    },
  });

  const workflow = createWorkflow({
    id: 'gh_apply',
    inputSchema: workflowState,
    outputSchema: workflowState,
  })
    .then(checkBlockers)
    .then(cookbookAttempt)
    .branch([
      [
        async ({ inputData }) => inputData.cookbook.success === true,
        cookbookDone,
      ],
      [
        async ({ inputData }) => inputData.cookbook.success !== true,
        executeHandler,
      ],
    ])
    .commit();

  return workflow;
}
