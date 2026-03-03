/**
 * Finalization Helpers — Parity-preserving job lifecycle completion
 *
 * Extracted from JobExecutor per PRD V5.2 Section 6. These helpers handle the
 * post-execution lifecycle: screenshots, session save, DB updates, callbacks,
 * and cost recording. Both the legacy JobExecutor path and the Mastra workflow
 * path call these same functions to guarantee identical finalization behavior.
 *
 * Design constraints:
 * - Cost recording is best-effort (`.catch()`) — never fail the job over cost
 * - Callback notifications are best-effort — never fail over callback errors
 * - Screenshot/session-save failures are logged and swallowed
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowserAutomationAdapter } from '../adapters/types.js';
import type { CostTracker, CostSnapshot } from './costControl.js';
import { CostControlService } from './costControl.js';
import type { ProgressTracker } from './progressTracker.js';
import { ProgressStep } from './progressTracker.js';
import type { TaskResult, AutomationJob } from './taskHandlers/types.js';
import type { ExecutionResult } from '../engine/ExecutionEngine.js';
import { callbackNotifier } from './callbackNotifier.js';
import type { SessionManager } from '../sessions/SessionManager.js';
import { getLogger } from '../monitoring/logger.js';

// ---------------------------------------------------------------------------
// Shared input interface
// ---------------------------------------------------------------------------

export interface CommonFinalizationInput {
  job: AutomationJob;
  adapter: BrowserAutomationAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  sessionManager: SessionManager | null;
  workerId: string;
  supabase: SupabaseClient;
  logEvent: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
  uploadScreenshot: (jobId: string, name: string, buffer: Buffer) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const logger = getLogger({ service: 'finalization' });

/**
 * Take a screenshot via the adapter and upload it. Returns the URL on success,
 * or undefined if the screenshot/upload fails.
 */
async function captureAndUpload(
  adapter: BrowserAutomationAdapter,
  jobId: string,
  name: string,
  uploadScreenshot: CommonFinalizationInput['uploadScreenshot'],
): Promise<string | undefined> {
  try {
    const buffer = await adapter.screenshot();
    return await uploadScreenshot(jobId, name, buffer);
  } catch (err) {
    logger.warn('Screenshot failed', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Save the browser session (Playwright storageState) via the adapter's
 * `getBrowserSession()` method if both the session manager and the adapter
 * method are available.
 */
async function saveBrowserSession(
  adapter: BrowserAutomationAdapter,
  sessionManager: SessionManager | null,
  userId: string,
  targetUrl: string,
  jobId: string,
  logEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (!sessionManager || !adapter.getBrowserSession) return;
  try {
    const sessionJson = await adapter.getBrowserSession();
    if (sessionJson) {
      const sessionState = JSON.parse(sessionJson);
      await sessionManager.saveSession(userId, targetUrl, sessionState);
      if (logEvent) {
        await logEvent('session_saved', {
          domain: new URL(targetUrl).hostname,
        });
      }
    }
  } catch (err) {
    logger.warn('Session save failed', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Save fresh session cookies for both Google and the target domain from the
 * current Playwright browser context.
 */
async function saveFreshSessionCookies(
  adapter: BrowserAutomationAdapter,
  sessionManager: SessionManager | null,
  userId: string,
  targetUrl: string,
): Promise<void> {
  if (!sessionManager) return;
  try {
    const freshState = await adapter.page.context().storageState();
    // Save Google session (use mail.google.com for consistency with session persistence)
    await sessionManager.saveSession(
      userId,
      'mail.google.com',
      freshState as unknown as Record<string, unknown>,
    );
    // Save target domain session
    const saveDomain = new URL(targetUrl).hostname;
    await sessionManager.saveSession(
      userId,
      saveDomain,
      freshState as unknown as Record<string, unknown>,
    );
    logger.info('Saved fresh session cookies', { userId });
  } catch (err) {
    logger.warn('Session save failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record cost against user's monthly usage. Best-effort — failures are logged
 * and swallowed.
 */
function recordCostBestEffort(
  supabase: SupabaseClient,
  userId: string,
  jobId: string,
  cost: CostSnapshot,
): void {
  const costService = new CostControlService(supabase);
  costService.recordJobCost(userId, jobId, cost).catch((err) => {
    logger.warn('Failed to record cost', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Fire a VALET callback notification. Best-effort — failures are logged and
 * swallowed.
 */
function fireCallbackBestEffort(
  job: AutomationJob,
  workerId: string,
  status: 'completed' | 'failed',
  resultData: Record<string, unknown>,
  resultSummary: string,
  screenshotUrls: string[],
  finalCost: CostSnapshot,
): void {
  if (!job.callback_url) return;
  callbackNotifier
    .notifyFromJob({
      id: job.id,
      valet_task_id: job.valet_task_id,
      callback_url: job.callback_url,
      status,
      worker_id: workerId,
      result_data: resultData,
      result_summary: resultSummary,
      screenshot_urls: screenshotUrls,
      llm_cost_cents: Math.round(finalCost.totalCost * 100),
      action_count: finalCost.actionCount,
      total_tokens: finalCost.inputTokens + finalCost.outputTokens,
    })
    .catch((err) => {
      logger.warn('Callback notification failed', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finalize a job that completed via cookbook replay.
 *
 * Steps:
 * 1. Update job metadata with engine result (final_mode, manual_id, health_score, cost_breakdown)
 * 2. Take final screenshot and upload
 * 3. Save browser session if sessionManager available
 * 4. Get final cost snapshot
 * 5. Set progress to COMPLETED and flush
 * 6. Build result_data with cost info
 * 7. Update job status to 'completed' with result_data, screenshot_urls, cost fields
 * 8. Log 'job_completed' event
 * 9. Record cost via CostControlService.recordJobCost (best-effort)
 * 10. Fire VALET callback if callback_url exists
 */
export async function finalizeCookbookSuccess(
  input: CommonFinalizationInput & {
    engineResult: ExecutionResult;
  },
): Promise<void> {
  const {
    job,
    adapter,
    costTracker,
    progress,
    sessionManager,
    workerId,
    supabase,
    logEvent,
    uploadScreenshot,
    engineResult,
  } = input;

  // 1. Update job metadata with engine result
  await supabase
    .from('gh_automation_jobs')
    .update({
      final_mode: engineResult.mode,
      metadata: {
        ...(job.metadata || {}),
        engine: {
          manual_id: engineResult.manualId,
          manual_status: 'cookbook_success',
          health_score: engineResult.cookbookSteps > 0 ? 95 : null,
        },
        cost_breakdown: {
          cookbook_steps: engineResult.cookbookSteps,
          magnitude_steps: 0,
          cookbook_cost_usd: costTracker.getSnapshot().totalCost,
          magnitude_cost_usd: 0,
          image_cost_usd: costTracker.getSnapshot().imageCost,
          reasoning_cost_usd: costTracker.getSnapshot().reasoningCost,
        },
      },
    })
    .eq('id', job.id);

  // 2. Take final screenshot and upload
  const screenshotUrls: string[] = [];
  const screenshotUrl = await captureAndUpload(adapter, job.id, 'final', uploadScreenshot);
  if (screenshotUrl) {
    screenshotUrls.push(screenshotUrl);
  }

  // 3. Save browser session
  await saveBrowserSession(adapter, sessionManager, job.user_id, job.target_url, job.id);

  // 4. Get final cost snapshot
  const finalCost = costTracker.getSnapshot();

  // 5. Set progress to COMPLETED and flush
  await progress.setStep(ProgressStep.COMPLETED);
  await progress.flush();

  // 6. Build result_data with cost info
  const resultData = {
    success_message: 'Task completed via cookbook replay',
    cost: {
      input_tokens: finalCost.inputTokens,
      output_tokens: finalCost.outputTokens,
      total_cost_usd: finalCost.totalCost,
      action_count: finalCost.actionCount,
    },
  };

  // 7. Update job status to 'completed'
  await supabase
    .from('gh_automation_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result_data: resultData,
      result_summary: 'Task completed via cookbook replay',
      screenshot_urls: screenshotUrls,
      llm_cost_cents: Math.round(finalCost.totalCost * 100),
      action_count: finalCost.actionCount,
      total_tokens: finalCost.inputTokens + finalCost.outputTokens,
    })
    .eq('id', job.id);

  // 8. Log 'job_completed' event
  await logEvent('job_completed', {
    handler: 'cookbook',
    result_summary: 'Task completed via cookbook replay',
    action_count: finalCost.actionCount,
    cost_cents: Math.round(finalCost.totalCost * 100),
    final_mode: 'cookbook',
    cookbook_steps: engineResult.cookbookSteps,
  });

  // 9. Record cost (best-effort)
  recordCostBestEffort(supabase, job.user_id, job.id, finalCost);

  // 10. Fire VALET callback if callback_url exists
  fireCallbackBestEffort(
    job,
    workerId,
    'completed',
    resultData,
    'Task completed via cookbook replay',
    screenshotUrls,
    finalCost,
  );

  logger.info('Job completed via cookbook', {
    jobId: job.id,
    cookbookSteps: engineResult.cookbookSteps,
    costUsd: finalCost.totalCost,
  });
}

/**
 * Finalize a job that completed via handler execution.
 *
 * Steps:
 * 1. Take final screenshot and upload (prepend taskResult.screenshotUrl if present)
 * 2. Save browser session
 * 3. Get final cost snapshot
 * 4. Save fresh session cookies (Google + target domain)
 * 5. Check if awaitingUserReview:
 *    - If true: update DB, log event, record cost, return { awaitingReview: true }
 *    - NOTE: Does NOT block — blocking is the caller's responsibility
 * 6. If normal completion: set progress, build result_data, update DB, log event,
 *    record cost, fire callback, return { awaitingReview: false }
 */
export async function finalizeHandlerResult(
  input: CommonFinalizationInput & {
    taskResult: TaskResult;
    finalMode: string;
    engineResult: ExecutionResult;
  },
): Promise<{ awaitingReview: boolean }> {
  const {
    job,
    adapter,
    costTracker,
    progress,
    sessionManager,
    workerId,
    supabase,
    logEvent,
    uploadScreenshot,
    taskResult,
    finalMode,
    engineResult,
  } = input;

  // 1. Take final screenshot and upload (prepend handler screenshot if present)
  const screenshotUrls: string[] = [];
  if (taskResult.screenshotUrl) {
    screenshotUrls.push(taskResult.screenshotUrl);
  }
  const screenshotUrl = await captureAndUpload(adapter, job.id, 'final', uploadScreenshot);
  if (screenshotUrl) {
    screenshotUrls.push(screenshotUrl);
  }

  // 2. Save browser session
  await saveBrowserSession(
    adapter,
    sessionManager,
    job.user_id,
    job.target_url,
    job.id,
    logEvent,
  );

  // 3. Get final cost snapshot
  const finalCost = costTracker.getSnapshot();

  // 4. Save fresh session cookies (Google + target domain)
  await saveFreshSessionCookies(adapter, sessionManager, job.user_id, job.target_url);

  // 4.5. Persist final_mode and engine/cost metadata (parity with legacy path)
  await supabase
    .from('gh_automation_jobs')
    .update({
      final_mode: finalMode,
      metadata: {
        ...(job.metadata || {}),
        engine: {
          manual_id: engineResult.manualId || null,
          manual_status: engineResult.manualId ? 'cookbook_failed_fallback' : 'no_manual_available',
          fallback_reason: engineResult.error || null,
        },
        cost_breakdown: {
          cookbook_steps: engineResult.cookbookSteps,
          magnitude_steps: finalCost.actionCount,
          cookbook_cost_usd: 0,
          magnitude_cost_usd: finalCost.totalCost,
          image_cost_usd: finalCost.imageCost,
          reasoning_cost_usd: finalCost.reasoningCost,
        },
      },
    })
    .eq('id', job.id);

  // 5. Handle awaiting_review vs normal completion
  if (taskResult.awaitingUserReview) {
    await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
    await progress.flush();

    const resultData: Record<string, unknown> = {
      ...(taskResult.data || {}),
      cost: {
        input_tokens: finalCost.inputTokens,
        output_tokens: finalCost.outputTokens,
        total_cost_usd: finalCost.totalCost,
        action_count: finalCost.actionCount,
      },
    };

    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'awaiting_review',
        result_data: resultData,
        result_summary: 'Application filled — waiting for user to review and submit',
        screenshot_urls: screenshotUrls,
        llm_cost_cents: Math.round(finalCost.totalCost * 100),
        action_count: finalCost.actionCount,
        total_tokens: finalCost.inputTokens + finalCost.outputTokens,
      })
      .eq('id', job.id);

    await logEvent('awaiting_review', {
      action_count: finalCost.actionCount,
      total_tokens: finalCost.inputTokens + finalCost.outputTokens,
      cost_cents: Math.round(finalCost.totalCost * 100),
    });

    // Best-effort cost recording
    recordCostBestEffort(supabase, job.user_id, job.id, finalCost);

    logger.info('Job awaiting user review', {
      jobId: job.id,
      actionCount: finalCost.actionCount,
      costUsd: finalCost.totalCost,
    });

    // NOTE: Do NOT block here. The caller (JobExecutor or Mastra workflow)
    // is responsible for keeping the browser open if needed.
    return { awaitingReview: true };
  }

  // 6. Build result data (shared by success and failure paths)
  const resultData: Record<string, unknown> = {
    ...(taskResult.data || {}),
    cost: {
      input_tokens: finalCost.inputTokens,
      output_tokens: finalCost.outputTokens,
      total_cost_usd: finalCost.totalCost,
      action_count: finalCost.actionCount,
    },
  };

  // 7. Handler failure — mark job as failed, not completed
  if (!taskResult.success) {
    await progress.setStep(ProgressStep.COMPLETED);
    await progress.flush();

    const errorMessage = taskResult.error || 'Handler returned success: false';

    await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_code: 'handler_failed',
        error_details: { message: errorMessage },
        result_data: resultData,
        screenshot_urls: screenshotUrls,
        llm_cost_cents: Math.round(finalCost.totalCost * 100),
        action_count: finalCost.actionCount,
        total_tokens: finalCost.inputTokens + finalCost.outputTokens,
      })
      .eq('id', job.id);

    await logEvent('job_failed', {
      error_code: 'handler_failed',
      error_message: errorMessage,
      action_count: finalCost.actionCount,
      total_tokens: finalCost.inputTokens + finalCost.outputTokens,
      cost_cents: Math.round(finalCost.totalCost * 100),
      final_mode: finalMode,
    });

    recordCostBestEffort(supabase, job.user_id, job.id, finalCost);

    fireCallbackBestEffort(
      job,
      workerId,
      'failed',
      resultData,
      errorMessage,
      screenshotUrls,
      finalCost,
    );

    logger.info('Job failed via handler', {
      jobId: job.id,
      error: errorMessage,
      actionCount: finalCost.actionCount,
      costUsd: finalCost.totalCost,
    });

    return { awaitingReview: false };
  }

  // 8. Normal completion flow
  await progress.setStep(ProgressStep.COMPLETED);
  await progress.flush();

  const resultSummary =
    taskResult.data?.success_message ||
    taskResult.data?.summary ||
    (taskResult.data?.submitted ? 'Application submitted successfully' : 'Task completed');

  await supabase
    .from('gh_automation_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result_data: resultData,
      result_summary: resultSummary,
      screenshot_urls: screenshotUrls,
      llm_cost_cents: Math.round(finalCost.totalCost * 100),
      action_count: finalCost.actionCount,
      total_tokens: finalCost.inputTokens + finalCost.outputTokens,
    })
    .eq('id', job.id);

  await logEvent('job_completed', {
    result_summary: resultSummary,
    action_count: finalCost.actionCount,
    total_tokens: finalCost.inputTokens + finalCost.outputTokens,
    cost_cents: Math.round(finalCost.totalCost * 100),
    final_mode: finalMode,
    cookbook_steps: engineResult.cookbookSteps,
    magnitude_steps: finalCost.actionCount,
  });

  // Best-effort cost recording
  recordCostBestEffort(supabase, job.user_id, job.id, finalCost);

  // Fire VALET callback
  fireCallbackBestEffort(
    job,
    workerId,
    'completed',
    resultData,
    resultSummary,
    screenshotUrls,
    finalCost,
  );

  logger.info('Job completed via handler', {
    jobId: job.id,
    actionCount: finalCost.actionCount,
    totalTokens: finalCost.inputTokens + finalCost.outputTokens,
    costUsd: finalCost.totalCost,
  });

  return { awaitingReview: false };
}

// ---------------------------------------------------------------------------
// Side-effects-only finalization (for Mastra failure → retry path)
// ---------------------------------------------------------------------------

/**
 * Perform handler finalization side effects WITHOUT writing job status.
 *
 * Used by the Mastra path when the handler failed, so that error classification
 * and retry logic in JobExecutor.handleJobError() can run instead of the
 * hardcoded 'failed' write in finalizeHandlerResult().
 *
 * Side effects performed:
 * 1. Take final screenshot and upload
 * 2. Save browser session
 * 3. Save fresh session cookies
 * 4. Persist final_mode and engine/cost metadata
 */
export async function finalizeHandlerSideEffects(
  input: CommonFinalizationInput & {
    taskResult: TaskResult;
    finalMode: string;
    engineResult: ExecutionResult;
  },
): Promise<{ screenshotUrls: string[]; finalCost: CostSnapshot }> {
  const {
    job,
    adapter,
    costTracker,
    sessionManager,
    supabase,
    logEvent,
    uploadScreenshot,
    taskResult,
    finalMode,
    engineResult,
  } = input;

  // 1. Take final screenshot and upload
  const screenshotUrls: string[] = [];
  if (taskResult.screenshotUrl) {
    screenshotUrls.push(taskResult.screenshotUrl);
  }
  const screenshotUrl = await captureAndUpload(adapter, job.id, 'final', uploadScreenshot);
  if (screenshotUrl) {
    screenshotUrls.push(screenshotUrl);
  }

  // 2. Save browser session
  await saveBrowserSession(adapter, sessionManager, job.user_id, job.target_url, job.id, logEvent);

  // 3. Get final cost snapshot
  const finalCost = costTracker.getSnapshot();

  // 4. Save fresh session cookies (Google + target domain)
  await saveFreshSessionCookies(adapter, sessionManager, job.user_id, job.target_url);

  // 5. Persist final_mode and engine/cost metadata
  await supabase
    .from('gh_automation_jobs')
    .update({
      final_mode: finalMode,
      screenshot_urls: screenshotUrls,
      metadata: {
        ...(job.metadata || {}),
        engine: {
          manual_id: engineResult.manualId || null,
          manual_status: engineResult.manualId ? 'cookbook_failed_fallback' : 'no_manual_available',
          fallback_reason: engineResult.error || null,
        },
        cost_breakdown: {
          cookbook_steps: engineResult.cookbookSteps,
          magnitude_steps: finalCost.actionCount,
          cookbook_cost_usd: 0,
          magnitude_cost_usd: finalCost.totalCost,
          image_cost_usd: finalCost.imageCost,
          reasoning_cost_usd: finalCost.reasoningCost,
        },
      },
    })
    .eq('id', job.id);

  return { screenshotUrls, finalCost };
}
