/**
 * Page Decision Loop Step — Mastra step wrapping the DecisionLoopRunner.
 *
 * This step replaces `execute_handler` in the decision engine workflow.
 * It runs an internal observe-decide-act loop within a single Mastra step,
 * using the three-tier execution cascade (DOM -> Stagehand -> Magnitude).
 *
 * The entire loop runs inside one step execution because:
 * - Mastra step boundaries serialize to Postgres (~200ms per transition)
 * - The Playwright Page (browser session) cannot survive step boundaries
 * - Sub-second iteration is required for responsive form filling
 *
 * HITL suspend is supported within the loop for blocker detection,
 * using the same suspend() mechanism as check_blockers_checkpoint.
 *
 * ADDITIVE ONLY: This does NOT modify the existing execute_handler step.
 */

import { createStep } from '@mastra/core/workflows';

import { workflowState, blockerResumeSchema, type RuntimeContext, type WorkflowState } from '../types.js';
import { getLogger } from '../../../monitoring/logger.js';
import { callbackNotifier } from '../../../workers/callbackNotifier.js';
import { BlockerDetector } from '../../../detection/BlockerDetector.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// HITL resume helpers (ported from factory.ts check_blockers_checkpoint)
// ---------------------------------------------------------------------------

const blockerDetector = new BlockerDetector();

async function readAndClearResolutionData(
  supabase: SupabaseClient,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('gh_automation_jobs')
    .select('interaction_data')
    .eq('id', jobId)
    .single();

  if (error || !data?.interaction_data) return null;

  const interactionData = data.interaction_data as Record<string, unknown>;
  const resolutionData = (interactionData.resolution_data as Record<string, unknown>) ?? null;

  const stripped = { ...interactionData };
  delete stripped.resolution_data;
  delete stripped.resolution_type;
  delete stripped.resolved_by;
  delete stripped.resolved_at;
  delete stripped.otp;
  delete stripped.credentials;

  await supabase
    .from('gh_automation_jobs')
    .update({ interaction_data: stripped })
    .eq('id', jobId);

  return resolutionData;
}

async function injectResolution(
  adapter: { act: (instruction: string, opts?: { data?: Record<string, unknown> }) => Promise<any> },
  resolution: Record<string, unknown>,
): Promise<void> {
  const resolutionType = resolution.type as string | undefined;
  if (resolutionType === 'code_entry' && resolution.code) {
    await adapter.act(`Type "${resolution.code}" into the verification code input field`);
  } else if (resolutionType === 'credentials' && resolution.username) {
    if (resolution.username) {
      await adapter.act(`Type "${resolution.username}" into the username or email field`);
    }
    if (resolution.password) {
      await adapter.act(`Type the password into the password field`, {
        data: { password: resolution.password as string },
      });
    }
  }
}

async function detectBlockerSafe(
  adapter: import('../../../adapters/types.js').HitlCapableAdapter,
): Promise<{ type: string; confidence: number } | null> {
  try {
    return await blockerDetector.detectWithAdapter(adapter);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types for the decision engine classes (imported from engine/decision/)
// ---------------------------------------------------------------------------

import type { DecisionLoopState, ActionHistoryEntry } from '../../../engine/decision/types.js';
import type { CostTracker } from '../../../workers/costControl.js';

/** Result returned by DecisionLoopRunner.run() */
type DecisionLoopResult = DecisionLoopState & {
  blockerDetected?: {
    type: string;
    confidence: number;
    pageUrl: string;
  };
};

interface DecisionLoopRunnerInterface {
  run(): Promise<DecisionLoopResult>;
}

interface DecisionLoopRunnerFactory {
  create(options: {
    page: import('playwright').Page;
    adapter: import('../../../adapters/types.js').HitlCapableAdapter;
    costTracker: CostTracker;
    platform: string;
    budgetUsd: number;
    logEvent: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
    previousActionHistory?: ActionHistoryEntry[];
    previousIteration?: number;
  }): DecisionLoopRunnerInterface;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum action history entries to persist in workflow state */
const MAX_PERSISTED_ACTION_HISTORY = 50;

const logger = getLogger({ service: 'page-decision-loop' });

// ---------------------------------------------------------------------------
// Step Builder
// ---------------------------------------------------------------------------

/**
 * Build the page_decision_loop Mastra step with RuntimeContext captured via closure.
 *
 * This step:
 * 1. Creates the DecisionLoopRunner with dependencies from RuntimeContext
 * 2. Runs the observe-decide-act loop
 * 3. Maps the result to WorkflowState updates (decisionLoop, metrics, status)
 * 4. Handles HITL suspend for blockers detected during the loop
 *
 * @param rt - RuntimeContext (closure-injected, never serialized)
 * @param loopRunnerFactory - Factory to create DecisionLoopRunner instances
 */
export function buildPageDecisionLoopStep(
  rt: RuntimeContext,
  loopRunnerFactory: DecisionLoopRunnerFactory,
) {
  return createStep({
    id: 'page_decision_loop',
    inputSchema: workflowState,
    outputSchema: workflowState,
    resumeSchema: blockerResumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      const state: WorkflowState = { ...inputData };

      // Initialize decisionLoop state if not present (first run)
      if (!state.decisionLoop) {
        state.decisionLoop = {
          iteration: 0,
          pagesProcessed: 0,
          currentPageFingerprint: null,
          previousPageFingerprint: null,
          samePageCount: 0,
          actionHistory: [],
          loopCostUsd: 0,
          terminalState: 'running',
          terminationReason: null,
        };
      }

      // ── Handle HITL resume ──
      if (resumeData) {
        logger.info('Decision loop resuming from HITL suspension', {
          jobId: state.jobId,
          resolutionType: resumeData.resolutionType,
          iteration: state.decisionLoop.iteration,
        });

        // Read sensitive resolution data from DB (OTP codes, credentials, etc.)
        const resolutionData = await readAndClearResolutionData(rt.supabase, state.jobId);

        // Inject resolution data (2FA code, login credentials) into adapter
        if (resolutionData && (resolutionData.code || resolutionData.username)) {
          await injectResolution(rt.adapter, {
            ...resolutionData,
            type: resumeData.resolutionType,
          });
        }

        // Resume the adapter
        await rt.adapter.resume?.({ resolutionType: resumeData.resolutionType });

        // Verify blocker is actually cleared (up to 3 attempts, 2s apart)
        let stillBlocked = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));
          const blockerCheck = await detectBlockerSafe(rt.adapter);
          if (!blockerCheck) {
            stillBlocked = false;
            break;
          }
          stillBlocked = true;
        }

        if (stillBlocked) {
          // Blocker persists after human resolution — re-suspend
          logger.warn('Blocker persists after HITL resolution', {
            jobId: state.jobId,
            resolutionType: resumeData.resolutionType,
          });
          const currentUrl = await rt.adapter.getCurrentUrl?.().catch(() => state.targetUrl) ?? state.targetUrl;
          return await suspend({ blockerType: 'context_lost', pageUrl: currentUrl });
        }

        // Resume job status in DB
        await rt.supabase
          .from('gh_automation_jobs')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', state.jobId);

        // Notify VALET that the job has resumed
        if (rt.job.callback_url) {
          callbackNotifier.notifyResumed(
            state.jobId,
            rt.job.callback_url,
            rt.job.valet_task_id,
            rt.workerId,
          ).catch((err) => {
            logger.warn('Resume callback failed', {
              jobId: state.jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        state.hitl = {
          blocked: false,
          blockerType: null,
          resumeNonce: null,
          checkpoint: null,
          attemptsByType: state.hitl.attemptsByType,
          lastDecision: 'NO_ACTION',
        };
        state.status = 'running';
      }

      // ── Run the decision loop ──
      logger.info('Starting decision loop', {
        jobId: state.jobId,
        platform: state.platform,
        budgetUsd: state.budgetUsd,
        qualityPreset: state.qualityPreset,
        resuming: !!resumeData,
        previousIteration: state.decisionLoop.iteration,
      });

      let result: DecisionLoopResult;

      try {
        const runner = loopRunnerFactory.create({
          page: rt.adapter.page,
          adapter: rt.adapter,
          costTracker: rt.costTracker,
          platform: state.platform,
          budgetUsd: state.budgetUsd,
          logEvent: rt.logEvent,
          previousActionHistory: state.decisionLoop.actionHistory,
          previousIteration: state.decisionLoop.iteration,
        });

        result = await runner.run();
      } catch (runError) {
        const msg = runError instanceof Error ? runError.message : String(runError);
        logger.error('Decision loop threw an unhandled exception', {
          jobId: state.jobId,
          error: msg,
        });

        result = {
          terminalState: 'error',
          terminationReason: `Unhandled exception: ${msg}`,
          iteration: state.decisionLoop.iteration,
          pagesProcessed: state.decisionLoop.pagesProcessed,
          currentPageFingerprint: state.decisionLoop.currentPageFingerprint,
          previousPageFingerprint: state.decisionLoop.previousPageFingerprint,
          samePageCount: state.decisionLoop.samePageCount,
          actionHistory: state.decisionLoop.actionHistory,
          loopCostUsd: state.decisionLoop.loopCostUsd,
        };
      }

      // ── Handle blocker-triggered HITL suspend ──
      if (result.blockerDetected) {
        const { type, confidence, pageUrl } = result.blockerDetected;

        logger.warn('Decision loop detected blocker, suspending for HITL', {
          jobId: state.jobId,
          blockerType: type,
          confidence,
          pageUrl,
          iteration: result.iteration,
        });

        // Update job status to paused
        await rt.supabase
          .from('gh_automation_jobs')
          .update({ status: 'paused', updated_at: new Date().toISOString() })
          .eq('id', state.jobId)
          .neq('status', 'paused');

        // Log blocker event
        await rt.logEvent('blocker_detected', {
          jobId: state.jobId,
          blockerType: type,
          confidence,
          pageUrl,
          source: 'decision_loop',
        });

        // Persist loop state before suspending
        const resumeNonce = crypto.randomUUID();
        state.decisionLoop = {
          ...mapLoopResult(result),
          terminalState: 'running', // Still running, just paused for HITL
        };
        state.hitl = {
          blocked: true,
          blockerType: type,
          resumeNonce,
          checkpoint: 'page_decision_loop',
          attemptsByType: state.hitl.attemptsByType,
          lastDecision: 'IMMEDIATE_HITL',
        };
        state.status = 'suspended';

        // Update cost metrics
        const costSnapshot = rt.costTracker.getSnapshot();
        state.metrics = {
          ...state.metrics,
          costUsd: costSnapshot.totalCost,
          pagesProcessed: result.pagesProcessed,
        };

        // Notify VALET via callback
        if (rt.job.callback_url) {
          await callbackNotifier.notifyHumanNeeded(
            state.jobId,
            rt.job.callback_url,
            {
              type,
              page_url: pageUrl,
              description: `Blocker detected during decision loop: ${type}`,
              metadata: {
                blocker_confidence: confidence,
                detection_method: 'decision_loop_observation',
              },
            },
            rt.job.valet_task_id,
            process.env.GH_WORKER_ID,
            {
              total_cost_usd: costSnapshot.totalCost,
              action_count: costSnapshot.actionCount,
              total_tokens: costSnapshot.inputTokens + costSnapshot.outputTokens,
            },
          );
        }

        return await suspend({ blockerType: type, pageUrl });
      }

      // ── Map result to workflow state ──
      state.decisionLoop = mapLoopResult(result);

      // Update cost metrics
      const costSnapshot = rt.costTracker.getSnapshot();
      state.metrics = {
        ...state.metrics,
        costUsd: costSnapshot.totalCost,
        pagesProcessed: result.pagesProcessed,
      };

      // Map terminal state to workflow status
      switch (result.terminalState) {
        case 'confirmation':
        case 'submitted':
          state.status = 'completed';
          state.handler = {
            attempted: true,
            success: true,
            taskResult: {
              success: true,
              data: {
                decision_engine: true,
                iterations: result.iteration,
                pages_processed: result.pagesProcessed,
                terminal_state: result.terminalState,
              },
            },
          };
          break;

        case 'review_page':
          state.status = 'awaiting_review';
          state.handler = {
            attempted: true,
            success: true,
            taskResult: {
              success: true,
              data: {
                decision_engine: true,
                iterations: result.iteration,
                pages_processed: result.pagesProcessed,
                terminal_state: result.terminalState,
              },
              awaitingUserReview: true,
              keepBrowserOpen: true,
            },
          };
          break;

        case 'stuck':
        case 'max_iterations':
          state.status = 'awaiting_review';
          state.handler = {
            attempted: true,
            success: false,
            taskResult: {
              success: false,
              error: result.terminationReason ?? undefined,
              data: {
                decision_engine: true,
                iterations: result.iteration,
                pages_processed: result.pagesProcessed,
                terminal_state: result.terminalState,
              },
              awaitingUserReview: true,
              keepBrowserOpen: true,
            },
          };
          break;

        case 'budget_exceeded':
        case 'error':
          state.status = 'failed';
          state.handler = {
            attempted: true,
            success: false,
            taskResult: {
              success: false,
              error: result.terminationReason ?? undefined,
              data: {
                decision_engine: true,
                iterations: result.iteration,
                pages_processed: result.pagesProcessed,
                terminal_state: result.terminalState,
              },
            },
          };
          break;
      }

      logger.info('Decision loop completed', {
        jobId: state.jobId,
        terminalState: result.terminalState,
        terminationReason: result.terminationReason,
        iterations: result.iteration,
        pagesProcessed: result.pagesProcessed,
        totalActions: result.actionHistory.length,
        loopCostUsd: result.loopCostUsd,
        status: state.status,
      });

      return state;
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a DecisionLoopResult to the decisionLoop field of WorkflowState,
 * trimming action history to the max persisted length.
 */
function mapLoopResult(result: DecisionLoopResult): NonNullable<WorkflowState['decisionLoop']> {
  // Trim action history to max persisted entries (keep most recent)
  const trimmedHistory = result.actionHistory.length > MAX_PERSISTED_ACTION_HISTORY
    ? result.actionHistory.slice(-MAX_PERSISTED_ACTION_HISTORY)
    : result.actionHistory;

  return {
    iteration: result.iteration,
    pagesProcessed: result.pagesProcessed,
    currentPageFingerprint: result.currentPageFingerprint,
    previousPageFingerprint: result.previousPageFingerprint,
    samePageCount: result.samePageCount,
    actionHistory: trimmedHistory,
    loopCostUsd: result.loopCostUsd,
    terminalState: result.terminalState,
    terminationReason: result.terminationReason,
  };
}
