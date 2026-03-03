/**
 * Step Factory — Builds Mastra workflow steps with RuntimeContext captured via closure.
 *
 * PRD V5.2 Section 5.4: Three steps that compose the gh_apply workflow.
 *
 * 1. check_blockers_checkpoint — Detect CAPTCHAs/login walls, suspend for HITL
 * 2. cookbook_attempt — Try deterministic cookbook replay via ExecutionEngine
 * 3. execute_handler — Fall back to LLM-driven task handler execution
 *
 * IMPORTANT: RuntimeContext is closure-injected. Non-serializable objects
 * (adapter, supabase, costTracker, etc.) are NEVER placed into workflow state.
 */

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import { workflowState, blockerResumeSchema, type RuntimeContext } from '../types.js';
import { ExecutionEngine } from '../../../engine/ExecutionEngine.js';
import { ManualStore } from '../../../engine/ManualStore.js';
import { CookbookExecutor } from '../../../engine/CookbookExecutor.js';
import type { TaskContext } from '../../../workers/taskHandlers/types.js';
import { BlockerDetector, type BlockerType } from '../../../detection/BlockerDetector.js';
import { callbackNotifier } from '../../../workers/callbackNotifier.js';
import { getLogger } from '../../../monitoring/logger.js';
import type { WorkflowState } from '../types.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HitlCapableAdapter } from '../../../adapters/types.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const logger = getLogger({ service: 'workflow-steps' });

/** Map adapter blocker category strings to BlockerType. */
function mapBlockerCategory(category: string): BlockerType {
  const validTypes: BlockerType[] = [
    'captcha',
    'login',
    '2fa',
    'bot_check',
    'rate_limited',
    'verification',
  ];
  if (validTypes.includes(category as BlockerType)) {
    return category as BlockerType;
  }
  return 'verification';
}

/**
 * Read sensitive resolution_data from gh_automation_jobs.interaction_data,
 * then clear the resolution fields from the DB row to avoid persisting secrets.
 */
async function readAndClearResolutionData(
  supabase: SupabaseClient,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('gh_automation_jobs')
    .select('interaction_data')
    .eq('id', jobId)
    .single();

  if (error || !data?.interaction_data) {
    return null;
  }

  const interactionData = data.interaction_data as Record<string, unknown>;
  const resolutionData = (interactionData.resolution_data as Record<string, unknown>) ?? null;

  // Clear resolution fields from the DB — secrets should not linger
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

/**
 * Inject resolution data into the adapter (e.g. 2FA code or login credentials).
 */
async function injectResolution(
  adapter: HitlCapableAdapter,
  resolution: Record<string, unknown>,
): Promise<void> {
  const resolutionType = resolution.type as string | undefined;

  if (resolutionType === 'code_entry' && resolution.code) {
    // Type the code into the active input
    await adapter.act(`Type "${resolution.code}" into the verification code input field`);
  } else if (resolutionType === 'credentials' && resolution.username) {
    // Fill login credentials
    if (resolution.username) {
      await adapter.act(`Type "${resolution.username}" into the username or email field`);
    }
    if (resolution.password) {
      await adapter.act(`Type the password into the password field`, {
        data: { password: resolution.password as string },
      });
    }
  }
  // For 'manual' and 'skip', no injection needed — the human already handled it
}

/**
 * Conditionally update job status to 'paused' (only if not already paused).
 */
async function pauseJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  await supabase
    .from('gh_automation_jobs')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .neq('status', 'paused');
}

/**
 * Send a needs_human callback to VALET for a detected blocker.
 */
async function sendNeedsHumanCallback(
  rt: RuntimeContext,
  state: WorkflowState,
  blockerInfo: { type: string; confidence: number; pageUrl: string },
): Promise<void> {
  if (!rt.job.callback_url) return;

  const costSnapshot = rt.costTracker.getSnapshot();

  await callbackNotifier.notifyHumanNeeded(
    state.jobId,
    rt.job.callback_url,
    {
      type: blockerInfo.type,
      page_url: blockerInfo.pageUrl,
      description: `Blocker detected: ${blockerInfo.type}`,
      metadata: {
        blocker_confidence: blockerInfo.confidence,
        detection_method: 'BlockerDetector.detectWithAdapter',
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

/**
 * Log a context_lost event and send callback with full PRD V5.2 payload —
 * the human resolved the blocker but the page context has changed, so we
 * need to suspend again.
 */
async function emitContextLost(rt: RuntimeContext, state: WorkflowState): Promise<void> {
  await rt.logEvent('blocker_context_lost', {
    jobId: state.jobId,
    message: 'Blocker persists after HITL resolution — page context may have changed',
  });

  if (rt.job.callback_url) {
    // Capture screenshot (best-effort)
    let screenshotUrl: string | undefined;
    if (rt.uploadScreenshot) {
      try {
        const buffer = await rt.adapter.screenshot();
        screenshotUrl = await rt.uploadScreenshot(state.jobId, 'context_lost', buffer);
      } catch (err) {
        logger.warn('context_lost screenshot failed', {
          jobId: state.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Get current page URL (best-effort)
    const pageUrl = await rt.adapter.getCurrentUrl().catch(() => state.targetUrl);

    const contextLostMessage =
      'Browser context could not be restored after interruption. ' +
      'The application may need to be restarted or the page state verified.';

    await callbackNotifier.notifyHumanNeeded(
      state.jobId,
      rt.job.callback_url,
      {
        type: 'context_lost',
        message: contextLostMessage,
        description: contextLostMessage,
        screenshot_url: screenshotUrl,
        page_url: pageUrl,
        original_blocker_type: state.hitl.blockerType || 'unknown',
        timeout_seconds: 300,
        metadata: {
          detection_method: 'post_resume_recheck',
        },
      },
      rt.job.valet_task_id,
      rt.workerId,
    );
  }
}

// ---------------------------------------------------------------------------
// Step Factory
// ---------------------------------------------------------------------------

/**
 * Build the three Mastra workflow steps for gh_apply, capturing RuntimeContext
 * via closure so that non-serializable objects stay out of workflow state.
 */
export function buildSteps(rt: RuntimeContext) {
  const detector = new BlockerDetector();

  // ─── Step 1: check_blockers_checkpoint ──────────────────────────────

  const checkBlockers = createStep({
    id: 'check_blockers_checkpoint',
    inputSchema: workflowState,
    outputSchema: workflowState,
    resumeSchema: blockerResumeSchema,
    execute: async ({ inputData, resumeData, suspend }) => {
      const state: WorkflowState = { ...inputData };

      // ── Resuming from HITL suspension ──
      if (resumeData) {
        logger.info('Resuming from HITL suspension', {
          jobId: state.jobId,
          resolutionType: resumeData.resolutionType,
        });

        // Read sensitive data from DB (never from workflow state)
        const resolutionData = await readAndClearResolutionData(rt.supabase, state.jobId);

        // Inject resolution data into adapter if applicable
        if (resolutionData && (resolutionData.code || resolutionData.username)) {
          await injectResolution(rt.adapter, {
            ...resolutionData,
            type: resumeData.resolutionType,
          });
        }

        // Resume the adapter
        await rt.adapter.resume?.({ resolutionType: resumeData.resolutionType });

        // Verify the blocker is actually resolved (up to 3 attempts, 2s apart)
        let stillBlocked = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));
          const recheck = await detector.detectWithAdapter(rt.adapter);
          if (!recheck || recheck.confidence <= 0.6) {
            stillBlocked = false;
            break;
          }
          stillBlocked = true;
        }

        if (stillBlocked) {
          // Context lost — blocker persists after human resolution
          await emitContextLost(rt, state);
          const currentUrl = await rt.adapter.getCurrentUrl().catch(() => state.targetUrl);
          return await suspend({ blockerType: 'context_lost', pageUrl: currentUrl });
        }

        // Clear HITL state and continue
        state.hitl = {
          blocked: false,
          blockerType: null,
          resumeNonce: null,
          checkpoint: null,
        };
        state.status = 'running';

        await rt.logEvent('blocker_resolved', {
          jobId: state.jobId,
          resolutionType: resumeData.resolutionType,
        });

        // Resume job status in DB
        await rt.supabase
          .from('gh_automation_jobs')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', state.jobId);

        // Notify VALET that the job has resumed (parity with legacy path)
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

        return state;
      }

      // ── Fresh blocker check ──
      const blockerResult = await detector.detectWithAdapter(rt.adapter);

      if (blockerResult && blockerResult.confidence > 0.6) {
        const blockerType = mapBlockerCategory(blockerResult.type);
        const pageUrl = await rt.adapter.getCurrentUrl().catch(() => state.targetUrl);

        logger.warn('Blocker detected, suspending for HITL', {
          jobId: state.jobId,
          blockerType,
          confidence: blockerResult.confidence,
          pageUrl,
        });

        // Update job status to paused (conditional: only if not already paused)
        await pauseJob(rt.supabase, state.jobId);

        // Log blocker_detected event
        await rt.logEvent('blocker_detected', {
          jobId: state.jobId,
          blockerType,
          confidence: blockerResult.confidence,
          pageUrl,
          details: blockerResult.details,
        });

        // Notify VALET via callback
        await sendNeedsHumanCallback(rt, state, {
          type: blockerType,
          confidence: blockerResult.confidence,
          pageUrl,
        });

        // Set HITL state
        const resumeNonce = crypto.randomUUID();
        state.hitl = {
          blocked: true,
          blockerType,
          resumeNonce,
          checkpoint: 'check_blockers_checkpoint',
        };
        state.status = 'suspended';

        // Suspend the workflow — Mastra persists state, worker releases
        return await suspend({ blockerType, pageUrl });
      }

      // No blocker found — pass through unchanged
      return state;
    },
  });

  // ─── Step 2: cookbook_attempt ────────────────────────────────────────

  const cookbookAttempt = createStep({
    id: 'cookbook_attempt',
    inputSchema: workflowState,
    outputSchema: workflowState,
    execute: async ({ inputData }) => {
      const state: WorkflowState = { ...inputData };

      const manualStore = new ManualStore(rt.supabase);
      const cookbookExecutor = new CookbookExecutor({ logEvent: rt.logEvent });
      const engine = new ExecutionEngine({
        manualStore,
        cookbookExecutor,
      });

      const result = await engine.execute({
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        logEvent: rt.logEvent,
        resumeFilePath: rt.resumeFilePath,
      });

      // Map ExecutionResult to cookbook state fields
      state.cookbook = {
        attempted: true,
        success: result.success,
        manualId: result.manualId ?? null,
        steps: result.cookbookSteps,
        error: result.error ?? null,
      };

      // Read current cost from tracker
      const costSnapshot = rt.costTracker.getSnapshot();
      state.metrics = {
        ...state.metrics,
        costUsd: costSnapshot.totalCost,
      };

      if (result.success) {
        state.status = 'completed';
        logger.info('Cookbook execution succeeded', {
          jobId: state.jobId,
          manualId: result.manualId,
          steps: result.cookbookSteps,
        });
      } else {
        logger.info('Cookbook execution did not succeed, falling through to handler', {
          jobId: state.jobId,
          mode: result.mode,
          error: result.error,
        });
      }

      return state;
    },
  });

  // ─── Step 3: execute_handler ────────────────────────────────────────

  const executeHandler = createStep({
    id: 'execute_handler',
    inputSchema: workflowState,
    outputSchema: workflowState,
    execute: async ({ inputData }) => {
      const state: WorkflowState = { ...inputData };

      // Build TaskContext from RuntimeContext fields
      const ctx: TaskContext = {
        job: rt.job,
        adapter: rt.adapter,
        costTracker: rt.costTracker,
        progress: rt.progress,
        credentials: rt.credentials,
        dataPrompt: rt.dataPrompt,
        resumeFilePath: rt.resumeFilePath,
      };

      let result: Awaited<ReturnType<typeof rt.handler.execute>>;
      try {
        result = await rt.handler.execute(ctx);
      } catch (handlerError) {
        const msg = handlerError instanceof Error ? handlerError.message : String(handlerError);
        logger.error('Handler threw an unhandled exception', { jobId: state.jobId, error: msg });
        result = {
          success: false,
          error: msg,
          data: { unhandled_exception: true },
        };
      }

      // Map TaskResult to handler state fields
      state.handler = {
        attempted: true,
        success: result.success,
        taskResult: {
          success: result.success,
          data: result.data,
          error: result.error,
          screenshotUrl: result.screenshotUrl,
          keepBrowserOpen: result.keepBrowserOpen,
          awaitingUserReview: result.awaitingUserReview,
        },
      };

      // Update cost metrics
      const costSnapshot = rt.costTracker.getSnapshot();
      state.metrics = {
        ...state.metrics,
        costUsd: costSnapshot.totalCost,
      };

      // Determine final status
      const awaitingReview =
        result.awaitingUserReview === true || result.keepBrowserOpen === true;

      if (awaitingReview) {
        state.status = 'awaiting_review';
      } else if (result.success) {
        state.status = 'completed';
      } else {
        state.status = 'failed';
      }

      logger.info('Handler execution finished', {
        jobId: state.jobId,
        success: result.success,
        status: state.status,
        awaitingReview,
      });

      return state;
    },
  });

  return { checkBlockers, cookbookAttempt, executeHandler };
}
