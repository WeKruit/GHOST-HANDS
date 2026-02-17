import { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { createAdapter, type BrowserAutomationAdapter, type TokenUsage, type AdapterType, type LLMConfig } from '../adapters';
import {
  CostTracker,
  CostControlService,
  BudgetExceededError,
  ActionLimitExceededError,
  resolveQualityPreset,
} from './costControl.js';
import { ProgressTracker, ProgressStep } from './progressTracker.js';
import { loadModelConfig } from '../config/models.js';
import { taskHandlerRegistry } from './taskHandlers/registry.js';
import { callbackNotifier } from './callbackNotifier.js';
import type { TaskContext, TaskResult } from './taskHandlers/types.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { BlockerDetector, type BlockerResult } from '../detection/BlockerDetector.js';
import { ExecutionEngine } from '../engine/ExecutionEngine.js';
import { ManualStore } from '../engine/ManualStore.js';
import { CookbookExecutor } from '../engine/CookbookExecutor.js';
import { TraceRecorder } from '../engine/TraceRecorder.js';

// Re-export AutomationJob from the canonical location for backward compat
export type { AutomationJob } from './taskHandlers/types.js';
import type { AutomationJob } from './taskHandlers/types.js';

// --- Types ---

export interface JobExecutorOptions {
  supabase: SupabaseClient;
  workerId: string;
  sessionManager?: SessionManager;
  /** Postgres pool for LISTEN/NOTIFY (HITL resume signals) */
  pgPool?: pg.Pool;
  /** Timeout in seconds for human intervention (default: 300 = 5 minutes) */
  hitlTimeoutSeconds?: number;
}

// --- Error classification ---

const ERROR_CLASSIFICATIONS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /budget.?exceeded/i, code: 'budget_exceeded' },
  { pattern: /action.?limit.?exceeded/i, code: 'action_limit_exceeded' },
  { pattern: /captcha/i, code: 'captcha_blocked' },
  { pattern: /login|sign.?in/i, code: 'login_required' },
  { pattern: /timeout/i, code: 'timeout' },
  { pattern: /rate.?limit/i, code: 'rate_limited' },
  { pattern: /not.?found|selector/i, code: 'element_not_found' },
  { pattern: /disconnect|connection|ECONNREFUSED|ECONNRESET/i, code: 'network_error' },
  { pattern: /browser.*closed|target.*closed/i, code: 'browser_crashed' },
];

const RETRYABLE_ERRORS = new Set([
  'captcha_blocked',
  'element_not_found',
  'timeout',
  'rate_limited',
  'network_error',
  'browser_crashed',
  'internal_error',
]);

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HITL_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_CRASH_RECOVERIES = 2;

/** Error codes that should trigger HITL instead of immediate retry */
const HITL_ELIGIBLE_ERRORS = new Set([
  'captcha_blocked',
  'login_required',
]);

// --- Platform detection ---

function detectPlatform(url: string): string {
  if (url.includes('greenhouse.io')) return 'greenhouse';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('lever.co')) return 'lever';
  if (url.includes('myworkdayjobs.com') || url.includes('workday.com')) return 'workday';
  if (url.includes('icims.com')) return 'icims';
  if (url.includes('taleo.net')) return 'taleo';
  if (url.includes('smartrecruiters.com')) return 'smartrecruiters';
  return 'other';
}

// --- Data prompt builder ---

function buildDataPrompt(inputData: Record<string, any>): string {
  const parts: string[] = [];
  const userData = inputData.user_data;
  const qaOverrides = inputData.qa_overrides;

  if (userData) {
    parts.push('Use the following personal information when filling form fields:');
    for (const [key, value] of Object.entries(userData)) {
      if (value != null && value !== '') {
        parts.push(`  ${key}: ${value}`);
      }
    }
  }

  if (qaOverrides && Object.keys(qaOverrides).length > 0) {
    parts.push('\nFor screening questions, use these specific answers:');
    for (const [question, answer] of Object.entries(qaOverrides)) {
      parts.push(`  Q: "${question}" -> A: "${answer}"`);
    }
  }

  return parts.join('\n');
}

// --- Executor ---

export class JobExecutor {
  private supabase: SupabaseClient;
  private workerId: string;
  private sessionManager: SessionManager | null;
  private pgPool: pg.Pool | null;
  private hitlTimeoutSeconds: number;
  private blockerDetector = new BlockerDetector();

  constructor(opts: JobExecutorOptions) {
    this.supabase = opts.supabase;
    this.workerId = opts.workerId;
    this.sessionManager = opts.sessionManager ?? null;
    this.pgPool = opts.pgPool ?? null;
    this.hitlTimeoutSeconds = opts.hitlTimeoutSeconds ?? DEFAULT_HITL_TIMEOUT_SECONDS;
  }

  async execute(job: AutomationJob): Promise<void> {
    const heartbeat = this.startHeartbeat(job.id);
    let adapter: BrowserAutomationAdapter | null = null;

    // Initialize cost tracker with budget limits
    const qualityPreset = resolveQualityPreset(job.input_data, job.metadata);
    const costTracker = new CostTracker({
      jobId: job.id,
      qualityPreset,
      jobType: job.job_type,
    });

    const costService = new CostControlService(this.supabase);

    // Initialize progress tracker
    const progress = new ProgressTracker({
      jobId: job.id,
      supabase: this.supabase,
      workerId: this.workerId,
      estimatedTotalActions: costTracker.getActionLimit(),
    });

    try {
      // 0. Pre-flight budget check
      const preflight = await costService.preflightBudgetCheck(
        job.user_id,
        qualityPreset,
      );
      if (!preflight.allowed) {
        await this.updateJobStatus(job.id, 'failed', preflight.reason);
        await this.logJobEvent(job.id, 'budget_preflight_failed', {
          reason: preflight.reason,
          remaining_budget: preflight.remainingBudget,
          task_budget: preflight.taskBudget,
        });
        await this.supabase
          .from('gh_automation_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_code: 'budget_exceeded',
            error_details: { message: preflight.reason },
          })
          .eq('id', job.id);
        return;
      }

      // 1. Transition to 'running'
      await this.updateJobStatus(job.id, 'running', 'Starting browser agent');
      await progress.setStep(ProgressStep.INITIALIZING);
      await this.logJobEvent(job.id, 'job_started', {
        worker_id: this.workerId,
        job_type: job.job_type,
        target_url: job.target_url,
        quality_preset: qualityPreset,
        task_budget: costTracker.getTaskBudget(),
        action_limit: costTracker.getActionLimit(),
      });

      // 1a. Notify VALET that the job is now running
      if (job.callback_url) {
        callbackNotifier.notifyRunning(
          job.id,
          job.callback_url,
          job.valet_task_id,
        ).catch((err) => {
          console.warn(`[JobExecutor] Running callback failed for job ${job.id}:`, err);
        });
      }

      // 2. Resolve task handler
      const handler = taskHandlerRegistry.getOrThrow(job.job_type);

      // 3. Validate input if handler supports it
      if (handler.validate) {
        const validation = handler.validate(job.input_data);
        if (!validation.valid) {
          const msg = `Input validation failed: ${validation.errors?.join(', ')}`;
          await this.updateJobStatus(job.id, 'failed', msg);
          await this.supabase
            .from('gh_automation_jobs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_code: 'validation_error',
              error_details: { message: msg, errors: validation.errors },
            })
            .eq('id', job.id);
          return;
        }
      }

      // 4. Load user credentials if available
      const platform = detectPlatform(job.target_url);
      const credentials = await this.loadCredentials(job.user_id, platform);

      // 5. Build data prompt from input_data
      const dataPrompt = buildDataPrompt(job.input_data);

      // 6. Build LLM client config (may include separate image model)
      const llmSetup = this.buildLLMClient(job);

      // 6.5. Load existing browser session if available
      let storedSession: Record<string, unknown> | null = null;
      if (this.sessionManager) {
        try {
          storedSession = await this.sessionManager.loadSession(job.user_id, job.target_url);
          if (storedSession) {
            await this.logJobEvent(job.id, 'session_restored', {
              domain: new URL(job.target_url).hostname,
            });
          }
        } catch (err) {
          console.warn(`[JobExecutor] Session load failed for job ${job.id}:`, err);
        }
      }

      // 7. Create and start adapter
      const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
      adapter = createAdapter(adapterType);
      await adapter.start({
        url: job.target_url,
        llm: llmSetup.llm,
        ...(llmSetup.imageLlm && { imageLlm: llmSetup.imageLlm }),
        ...(storedSession ? { storageState: storedSession } : {}),
      });

      // 8. Register credentials if available
      if (credentials) {
        adapter.registerCredentials(credentials);
      }

      // 9. Try ExecutionEngine (cookbook replay) before Magnitude handler
      await progress.setStep(ProgressStep.NAVIGATING);

      const executionEngine = new ExecutionEngine({
        manualStore: new ManualStore(this.supabase),
        cookbookExecutor: new CookbookExecutor(),
      });

      const engineResult = await executionEngine.execute({
        job,
        adapter,
        costTracker,
        progress,
        logEvent: (eventType, metadata) => this.logJobEvent(job.id, eventType, metadata),
      });

      // Track TraceRecorder for Magnitude path (manual training)
      let traceRecorder: TraceRecorder | null = null;

      if (engineResult.success) {
        // Cookbook succeeded — update mode and skip to success handling
        await this.supabase
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

        // Take final screenshot and upload
        const screenshotUrls: string[] = [];
        try {
          const screenshotBuffer = await adapter.screenshot();
          const screenshotUrl = await this.uploadScreenshot(job.id, 'final', screenshotBuffer);
          screenshotUrls.push(screenshotUrl);
        } catch (err) {
          console.warn(`[JobExecutor] Screenshot failed for job ${job.id}:`, err);
        }

        // Save browser session
        if (this.sessionManager && adapter.getBrowserSession) {
          try {
            const sessionJson = await adapter.getBrowserSession();
            if (sessionJson) {
              const sessionState = JSON.parse(sessionJson);
              await this.sessionManager.saveSession(job.user_id, job.target_url, sessionState);
            }
          } catch (err) {
            console.warn(`[JobExecutor] Session save failed for job ${job.id}:`, err);
          }
        }

        // Get final cost and mark complete
        const finalCost = costTracker.getSnapshot();
        await progress.setStep(ProgressStep.COMPLETED);
        await progress.flush();

        const resultData = {
          success_message: 'Task completed via cookbook replay',
          cost: {
            input_tokens: finalCost.inputTokens,
            output_tokens: finalCost.outputTokens,
            total_cost_usd: finalCost.totalCost,
            action_count: finalCost.actionCount,
          },
        };

        await this.supabase
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

        await this.logJobEvent(job.id, 'job_completed', {
          handler: 'cookbook',
          result_summary: 'Task completed via cookbook replay',
          action_count: finalCost.actionCount,
          cost_cents: Math.round(finalCost.totalCost * 100),
          final_mode: 'cookbook',
          cookbook_steps: engineResult.cookbookSteps,
        });

        await costService.recordJobCost(job.user_id, job.id, finalCost);

        if (job.callback_url) {
          callbackNotifier.notifyFromJob({
            id: job.id,
            valet_task_id: job.valet_task_id,
            callback_url: job.callback_url,
            status: 'completed',
            result_data: resultData,
            result_summary: 'Task completed via cookbook replay',
            screenshot_urls: screenshotUrls,
            llm_cost_cents: Math.round(finalCost.totalCost * 100),
            action_count: finalCost.actionCount,
            total_tokens: finalCost.inputTokens + finalCost.outputTokens,
          }).catch((err) => {
            console.warn(`[JobExecutor] Callback notification failed for job ${job.id}:`, err);
          });
        }

        console.log(`[JobExecutor] Job ${job.id} completed via cookbook (steps=${engineResult.cookbookSteps}, cost=$${finalCost.totalCost.toFixed(4)})`);
        return;
      }

      // Engine returned failure — fall back to Magnitude handler
      // Start trace recording so we can create a manual from this run
      traceRecorder = new TraceRecorder({
        adapter,
        userData: (job.input_data?.user_data as Record<string, string>) || {},
      });
      traceRecorder.start();

      // 9a. Wire up event tracking with cost control + progress for Magnitude path
      adapter.on('thought', (thought: string) => {
        progress.recordThought(thought);
      });

      adapter.on('actionStarted', (action: { variant: string }) => {
        costTracker.recordAction(); // throws ActionLimitExceededError if over limit
        costTracker.recordModeStep('magnitude');
        progress.onActionStarted(action.variant);
        this.logJobEvent(job.id, 'step_started', {
          action: action.variant,
          action_count: costTracker.getSnapshot().actionCount,
        });
      });

      adapter.on('actionDone', (action: { variant: string }) => {
        progress.onActionDone(action.variant);
        this.logJobEvent(job.id, 'step_completed', {
          action: action.variant,
          action_count: costTracker.getSnapshot().actionCount,
        });
      });

      adapter.on('tokensUsed', (usage: TokenUsage) => {
        costTracker.recordTokenUsage({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          inputCost: usage.inputCost,
          outputCost: usage.outputCost,
        }); // throws BudgetExceededError if over budget
      });

      // 10. Build TaskContext and delegate to handler (with crash recovery)
      const timeoutMs = job.timeout_seconds * 1000;
      await this.updateJobStatus(job.id, 'running', `Executing ${handler.type} handler (Magnitude mode)`);

      let taskResult: TaskResult | undefined;
      let crashRecoveryAttempts = 0;

      while (crashRecoveryAttempts <= MAX_CRASH_RECOVERIES) {
        const ctx: TaskContext = {
          job,
          adapter: adapter!,
          costTracker,
          progress,
          credentials,
          dataPrompt,
        };

        try {
          taskResult = await Promise.race([
            handler.execute(ctx),
            this.createTimeout(timeoutMs),
          ]);
          break; // Success -- exit retry loop
        } catch (execError) {
          const execMsg = execError instanceof Error ? execError.message : String(execError);
          const isCrash = this.classifyError(execMsg) === 'browser_crashed'
            || !this.isBrowserAlive(adapter!);

          if (!isCrash || crashRecoveryAttempts >= MAX_CRASH_RECOVERIES) {
            throw execError; // Not a crash, or exhausted recovery attempts
          }

          crashRecoveryAttempts++;
          console.warn(
            `[JobExecutor] Browser crash detected for job ${job.id}, recovery attempt ${crashRecoveryAttempts}/${MAX_CRASH_RECOVERIES}`,
          );

          await this.logJobEvent(job.id, 'browser_crash_detected', {
            attempt: crashRecoveryAttempts,
            error_message: execMsg,
          });

          const recovered = await this.recoverFromCrash(job, adapter!, llmSetup, credentials);
          if (!recovered) {
            throw new Error(
              `Browser crashed and recovery failed after ${crashRecoveryAttempts} attempt(s): ${execMsg}`,
            );
          }

          adapter = recovered;

          // Re-wire event handlers on the new adapter
          adapter.on('thought', (thought: string) => {
            progress.recordThought(thought);
          });
          adapter.on('actionStarted', (action: { variant: string }) => {
            costTracker.recordAction();
            progress.onActionStarted(action.variant);
            this.logJobEvent(job.id, 'step_started', {
              action: action.variant,
              action_count: costTracker.getSnapshot().actionCount,
            });
          });
          adapter.on('actionDone', (action: { variant: string }) => {
            progress.onActionDone(action.variant);
            this.logJobEvent(job.id, 'step_completed', {
              action: action.variant,
              action_count: costTracker.getSnapshot().actionCount,
            });
          });
          adapter.on('tokensUsed', (usage: TokenUsage) => {
            costTracker.recordTokenUsage({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              inputCost: usage.inputCost,
              outputCost: usage.outputCost,
            });
          });

          await this.logJobEvent(job.id, 'browser_crash_recovered', {
            attempt: crashRecoveryAttempts,
          });
          await this.updateJobStatus(job.id, 'running', `Recovered from crash, retrying handler`);
        }
      }

      if (!taskResult) {
        throw new Error('Task handler did not produce a result');
      }

      if (!taskResult.success) {
        throw new Error(taskResult.error || `Task handler '${handler.type}' returned failure`);
      }

      // 10a. Save trace as manual for future cookbook replay
      if (traceRecorder && traceRecorder.isRecording()) {
        traceRecorder.stopRecording();
        const trace = traceRecorder.getTrace();
        if (trace.length > 0) {
          try {
            const manualStore = new ManualStore(this.supabase);
            const platform = detectPlatform(job.target_url);
            await manualStore.saveFromTrace(trace, {
              url: job.target_url,
              taskType: job.job_type,
              platform,
            });
            await this.logJobEvent(job.id, 'manual_created', {
              steps: trace.length,
              url_pattern: ManualStore.urlToPattern(job.target_url),
            });
          } catch (err) {
            console.warn(`[JobExecutor] Manual save failed for job ${job.id}:`, err);
          }
        }
      }

      // Determine final mode based on engine result
      const finalMode = engineResult.cookbookSteps > 0 ? 'hybrid' : 'magnitude';

      // Update final_mode and engine metadata
      await this.supabase
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
              magnitude_steps: costTracker.getSnapshot().actionCount,
              cookbook_cost_usd: 0,
              magnitude_cost_usd: costTracker.getSnapshot().totalCost,
              image_cost_usd: costTracker.getSnapshot().imageCost,
              reasoning_cost_usd: costTracker.getSnapshot().reasoningCost,
            },
          },
        })
        .eq('id', job.id);

      // 11. Take final screenshot and upload
      const screenshotUrls: string[] = [];
      if (taskResult.screenshotUrl) {
        screenshotUrls.push(taskResult.screenshotUrl);
      }
      try {
        const screenshotBuffer = await adapter.screenshot();
        const screenshotUrl = await this.uploadScreenshot(
          job.id,
          'final',
          screenshotBuffer
        );
        screenshotUrls.push(screenshotUrl);
      } catch (err) {
        console.warn(`[JobExecutor] Screenshot failed for job ${job.id}:`, err);
      }

      // 11.5. Save browser session for future reuse
      if (this.sessionManager && adapter.getBrowserSession) {
        try {
          const sessionJson = await adapter.getBrowserSession();
          if (sessionJson) {
            const sessionState = JSON.parse(sessionJson);
            await this.sessionManager.saveSession(job.user_id, job.target_url, sessionState);
            await this.logJobEvent(job.id, 'session_saved', {
              domain: new URL(job.target_url).hostname,
            });
          }
        } catch (err) {
          console.warn(`[JobExecutor] Session save failed for job ${job.id}:`, err);
        }
      }

      // 12. Get final cost snapshot
      const finalCost = costTracker.getSnapshot();

      // 13. Mark progress complete and flush
      await progress.setStep(ProgressStep.COMPLETED);
      await progress.flush();

      // Mark completed with cost data in result_data
      const resultData = {
        ...(taskResult.data || {}),
        cost: {
          input_tokens: finalCost.inputTokens,
          output_tokens: finalCost.outputTokens,
          total_cost_usd: finalCost.totalCost,
          action_count: finalCost.actionCount,
        },
      };

      const resultSummary =
        taskResult.data?.success_message ||
        taskResult.data?.summary ||
        (taskResult.data?.submitted ? 'Application submitted successfully' : 'Task completed');

      await this.supabase
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

      await this.logJobEvent(job.id, 'job_completed', {
        handler: handler.type,
        result_summary: resultSummary,
        action_count: finalCost.actionCount,
        total_tokens: finalCost.inputTokens + finalCost.outputTokens,
        cost_cents: Math.round(finalCost.totalCost * 100),
        final_mode: finalMode,
        cookbook_steps: engineResult.cookbookSteps,
        magnitude_steps: finalCost.actionCount,
      });

      // 14. Record cost against user's monthly usage
      await costService.recordJobCost(job.user_id, job.id, finalCost);

      // 15. Fire VALET callback if configured
      if (job.callback_url) {
        const jobRow = {
          id: job.id,
          valet_task_id: job.valet_task_id,
          callback_url: job.callback_url,
          status: 'completed',
          result_data: resultData,
          result_summary: resultSummary,
          screenshot_urls: screenshotUrls,
          llm_cost_cents: Math.round(finalCost.totalCost * 100),
          action_count: finalCost.actionCount,
          total_tokens: finalCost.inputTokens + finalCost.outputTokens,
        };
        callbackNotifier.notifyFromJob(jobRow).catch((err) => {
          console.warn(`[JobExecutor] Callback notification failed for job ${job.id}:`, err);
        });
      }

      console.log(`[JobExecutor] Job ${job.id} completed via ${handler.type} handler (actions=${finalCost.actionCount}, tokens=${finalCost.inputTokens + finalCost.outputTokens}, cost=$${finalCost.totalCost.toFixed(4)})`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = this.classifyError(errorMessage);

      // Attempt HITL pause for eligible errors (captcha/login) when adapter is available
      if (adapter && HITL_ELIGIBLE_ERRORS.has(errorCode)) {
        try {
          const resumed = await this.requestHumanIntervention(job, adapter, {
            type: errorCode === 'captcha_blocked' ? 'captcha' : 'login',
            confidence: 0.9,
            details: errorMessage,
          });
          if (resumed) {
            // Human resolved the blocker -- re-throw is NOT needed; the job
            // will naturally resume in the adapter and the outer flow continues
            // on next iteration. But since we are in the catch block the task
            // already threw, so we cannot "continue" easily. Mark the error as
            // handled and return so the finally-block stops the adapter normally.
            console.log(`[JobExecutor] Job ${job.id} resumed after HITL intervention`);
            return;
          }
        } catch (hitlErr) {
          console.warn(`[JobExecutor] HITL intervention failed for job ${job.id}:`, hitlErr);
          // Fall through to normal error handling
        }
      }

      await progress.setStep(ProgressStep.FAILED);
      await progress.flush();
      const snapshot = costTracker.getSnapshot();
      await this.handleJobError(job, error, snapshot.actionCount, snapshot.inputTokens + snapshot.outputTokens, snapshot.totalCost);

      // Record partial cost even on failure
      if (snapshot.totalCost > 0) {
        await costService.recordJobCost(job.user_id, job.id, snapshot).catch((err) => {
          console.warn(`[JobExecutor] Failed to record partial cost for job ${job.id}:`, err);
        });
      }

      // Fire VALET callback on failure too
      if (job.callback_url) {
        callbackNotifier.notifyFromJob({
          id: job.id,
          valet_task_id: job.valet_task_id,
          callback_url: job.callback_url,
          status: 'failed',
          error_code: errorCode,
          error_details: { message: errorMessage },
          llm_cost_cents: Math.round(snapshot.totalCost * 100),
          action_count: snapshot.actionCount,
          total_tokens: snapshot.inputTokens + snapshot.outputTokens,
        }).catch((err) => {
          console.warn(`[JobExecutor] Callback notification failed for job ${job.id}:`, err);
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (adapter) {
        try {
          await adapter.stop();
        } catch {
          // Adapter may already be stopped
        }
      }
    }
  }

  // --- Error handling ---

  private async handleJobError(
    job: AutomationJob,
    error: unknown,
    actionCount: number,
    totalTokens: number,
    totalCost: number,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = this.classifyError(errorMessage);

    console.error(`[JobExecutor] Job ${job.id} failed (code=${errorCode}): ${errorMessage}`);

    await this.logJobEvent(job.id, 'job_failed', {
      error_code: errorCode,
      error_message: errorMessage,
      action_count: actionCount,
      retry_count: job.retry_count,
    });

    // Check if retryable and under retry limit
    const shouldRetry = RETRYABLE_ERRORS.has(errorCode) && job.retry_count < job.max_retries;

    if (shouldRetry) {
      // Calculate exponential backoff delay
      const backoffSeconds = Math.min(60, Math.pow(2, job.retry_count) * 5);
      const scheduledAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'pending',
          retry_count: job.retry_count + 1,
          error_code: errorCode,
          error_details: {
            message: errorMessage,
            retry: job.retry_count + 1,
            backoff_seconds: backoffSeconds,
          },
          worker_id: null, // Release worker claim
          scheduled_at: scheduledAt,
          action_count: actionCount,
          total_tokens: totalTokens,
        })
        .eq('id', job.id);

      console.log(`[JobExecutor] Job ${job.id} re-queued for retry ${job.retry_count + 1}/${job.max_retries} (backoff=${backoffSeconds}s)`);
    } else {
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_code: errorCode,
          error_details: { message: errorMessage },
          action_count: actionCount,
          total_tokens: totalTokens,
          llm_cost_cents: Math.round(totalCost * 100),
        })
        .eq('id', job.id);
    }
  }

  // --- HITL (Human-in-the-Loop) ---

  /**
   * Pause execution, notify VALET, and wait for a human to resolve the blocker.
   * Returns true if the job was resumed, false if it timed out.
   */
  private async requestHumanIntervention(
    job: AutomationJob,
    adapter: BrowserAutomationAdapter,
    blockerResult: BlockerResult,
  ): Promise<boolean> {
    const timeoutSeconds = this.hitlTimeoutSeconds;

    // 1. Take a screenshot of the blocked page
    let screenshotUrl: string | undefined;
    try {
      const screenshotBuffer = await adapter.screenshot();
      screenshotUrl = await this.uploadScreenshot(job.id, 'blocker', screenshotBuffer);
    } catch (err) {
      console.warn(`[JobExecutor] HITL screenshot failed for job ${job.id}:`, err);
    }

    const pageUrl = await adapter.getCurrentUrl();

    // 2. Update job to paused with interaction data
    const interactionData = {
      type: blockerResult.type,
      confidence: blockerResult.confidence,
      selector: blockerResult.selector,
      details: blockerResult.details,
      screenshot_url: screenshotUrl,
      page_url: pageUrl,
      detected_at: new Date().toISOString(),
    };

    await this.supabase
      .from('gh_automation_jobs')
      .update({
        status: 'paused',
        interaction_type: blockerResult.type,
        interaction_data: interactionData,
        paused_at: new Date().toISOString(),
        status_message: `Waiting for human: ${blockerResult.type}`,
      })
      .eq('id', job.id);

    // 3. Pause the adapter
    if (adapter.pause) {
      await adapter.pause();
    }

    await this.logJobEvent(job.id, 'hitl_paused', {
      blocker_type: blockerResult.type,
      confidence: blockerResult.confidence,
      page_url: pageUrl,
    });

    // 4. Notify VALET via callback
    if (job.callback_url) {
      callbackNotifier.notifyHumanNeeded(
        job.id,
        job.callback_url,
        {
          type: blockerResult.type,
          screenshot_url: screenshotUrl,
          page_url: pageUrl,
          timeout_seconds: timeoutSeconds,
        },
        job.valet_task_id,
      ).catch((err) => {
        console.warn(`[JobExecutor] HITL callback failed for job ${job.id}:`, err);
      });
    }

    // 5. Wait for NOTIFY or timeout
    const resumed = await this.waitForResume(job.id, timeoutSeconds);

    if (resumed) {
      // 6. Resume the adapter
      if (adapter.resume) {
        await adapter.resume();
      }
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'running',
          paused_at: null,
          status_message: 'Resumed after human intervention',
        })
        .eq('id', job.id);

      await this.logJobEvent(job.id, 'hitl_resumed', {});

      if (job.callback_url) {
        callbackNotifier.notifyResumed(job.id, job.callback_url, job.valet_task_id).catch((err) => {
          console.warn(`[JobExecutor] Resume callback failed for job ${job.id}:`, err);
        });
      }
      return true;
    }

    // 7. Timeout — fail the job
    await this.logJobEvent(job.id, 'hitl_timeout', { timeout_seconds: timeoutSeconds });
    await this.supabase
      .from('gh_automation_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_code: 'hitl_timeout',
        error_details: {
          message: `Human intervention timed out after ${timeoutSeconds}s`,
          blocker_type: blockerResult.type,
        },
      })
      .eq('id', job.id);

    return false;
  }

  /**
   * Listen on the Postgres NOTIFY channel for a resume signal.
   * Falls back to polling if no pg pool is available.
   */
  private async waitForResume(jobId: string, timeoutSeconds: number): Promise<boolean> {
    if (this.pgPool) {
      return this.waitForResumeViaPg(jobId, timeoutSeconds);
    }
    // Fallback: poll the job status
    return this.waitForResumeViaPolling(jobId, timeoutSeconds);
  }

  private async waitForResumeViaPg(jobId: string, timeoutSeconds: number): Promise<boolean> {
    const client = await this.pgPool!.connect();
    try {
      await client.query('LISTEN gh_job_resume');

      return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve(false);
        }, timeoutSeconds * 1000);

        const onNotification = (msg: pg.Notification) => {
          if (msg.channel === 'gh_job_resume' && msg.payload === jobId) {
            cleanup();
            resolve(true);
          }
        };

        const cleanup = () => {
          clearTimeout(timeout);
          client.removeListener('notification', onNotification);
          client.query('UNLISTEN gh_job_resume').catch(() => {});
          client.release();
        };

        client.on('notification', onNotification);
      });
    } catch (err) {
      client.release();
      console.warn(`[JobExecutor] PG LISTEN failed for job ${jobId}, falling back to polling:`, err);
      return this.waitForResumeViaPolling(jobId, timeoutSeconds);
    }
  }

  private async waitForResumeViaPolling(jobId: string, timeoutSeconds: number): Promise<boolean> {
    const pollIntervalMs = 3000;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const { data } = await this.supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', jobId)
        .single();

      if (data?.status === 'running') {
        return true;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return false;
  }

  // --- Heartbeat ---

  private startHeartbeat(jobId: string): ReturnType<typeof setInterval> {
    return setInterval(async () => {
      try {
        await this.supabase
          .from('gh_automation_jobs')
          .update({ last_heartbeat: new Date().toISOString() })
          .eq('id', jobId);
      } catch (err) {
        console.warn(`[JobExecutor] Heartbeat failed for job ${jobId}:`, err);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // --- Status + event helpers ---

  private async updateJobStatus(
    jobId: string,
    status: string,
    message?: string,
  ): Promise<void> {
    const update: Record<string, any> = {
      status,
      status_message: message,
      last_heartbeat: new Date().toISOString(),
    };
    if (status === 'running') {
      update.started_at = new Date().toISOString();
    }
    await this.supabase
      .from('gh_automation_jobs')
      .update(update)
      .eq('id', jobId);
  }

  private async logJobEvent(
    jobId: string,
    eventType: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.supabase.from('gh_job_events').insert({
        job_id: jobId,
        event_type: eventType,
        metadata: metadata || {},
        actor: this.workerId,
      });
    } catch (err) {
      // Event logging failures should not crash the job
      console.warn(`[JobExecutor] Event log failed (${eventType}):`, err);
    }
  }

  // --- Credential loading ---

  private async loadCredentials(
    userId: string,
    platform: string,
  ): Promise<Record<string, string> | null> {
    try {
      const { data } = await this.supabase
        .from('gh_user_credentials')
        .select('credential_type, encrypted_value')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq('is_valid', true);

      if (!data || data.length === 0) return null;

      const credentials: Record<string, string> = {};
      for (const row of data) {
        // Credentials are stored encrypted in the DB.
        // Decryption would happen here using GH_ENCRYPTION_KEY.
        // For now, pass through the value -- full encryption to be
        // implemented in Security Phase 1.
        credentials[row.credential_type] = row.encrypted_value;
      }
      return credentials;
    } catch {
      return null;
    }
  }

  // --- LLM client configuration ---

  private buildLLMClient(job: AutomationJob): { llm: LLMConfig; imageLlm?: LLMConfig } {
    const tier = job.input_data.tier || 'starter';

    // Premium tier forces Claude Sonnet
    if (tier === 'premium') {
      const resolved = loadModelConfig('claude-sonnet');
      return { llm: resolved.llmClient as LLMConfig };
    }

    // Priority: input_data.model → metadata.model → GH_MODEL env → default
    const modelOverride = job.input_data?.model
      || job.metadata?.model
      || process.env.GH_MODEL
      || process.env.GH_DEFAULT_MODEL;
    const resolved = loadModelConfig(modelOverride);
    const result: { llm: LLMConfig; imageLlm?: LLMConfig } = {
      llm: resolved.llmClient as LLMConfig,
    };

    // Dual-model: if image_model is specified, use it for vision tasks
    const imageModelOverride = job.input_data?.image_model
      || job.metadata?.image_model
      || process.env.GH_IMAGE_MODEL;
    if (imageModelOverride) {
      try {
        const imageResolved = loadModelConfig(imageModelOverride);
        if (imageResolved.vision) {
          result.imageLlm = imageResolved.llmClient as LLMConfig;
        }
      } catch {
        // Unknown image model -- skip dual-model setup
      }
    }

    return result;
  }

  // --- Screenshot upload ---

  private async uploadScreenshot(
    jobId: string,
    name: string,
    buffer: Buffer,
  ): Promise<string> {
    const path = `gh/jobs/${jobId}/${name}-${Date.now()}.png`;

    const { error } = await this.supabase.storage
      .from('screenshots')
      .upload(path, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (error) {
      throw new Error(`Screenshot upload failed: ${error.message}`);
    }

    const { data } = this.supabase.storage
      .from('screenshots')
      .getPublicUrl(path);

    return data.publicUrl;
  }

  // --- Error classification ---

  private classifyError(message: string): string {
    for (const { pattern, code } of ERROR_CLASSIFICATIONS) {
      if (pattern.test(message)) return code;
    }
    return 'internal_error';
  }

  // --- Browser crash detection & recovery ---

  /**
   * Check whether the browser is still alive.
   * Returns true if connected, false if crashed/disconnected.
   */
  private isBrowserAlive(adapter: BrowserAutomationAdapter): boolean {
    try {
      return adapter.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * Attempt to recover from a browser crash by stopping the dead adapter,
   * creating a fresh one, and restoring session state.
   *
   * Returns the new adapter if recovery succeeds, or null if it fails.
   */
  private async recoverFromCrash(
    job: AutomationJob,
    deadAdapter: BrowserAutomationAdapter,
    llmSetup: { llm: LLMConfig; imageLlm?: LLMConfig },
    credentials: Record<string, string> | null,
  ): Promise<BrowserAutomationAdapter | null> {
    // Stop the dead adapter (ignore errors -- it's already dead)
    try { await deadAdapter.stop(); } catch { /* noop */ }

    // Try to load session state for seamless recovery
    let storedSession: Record<string, unknown> | null = null;
    if (this.sessionManager) {
      try {
        storedSession = await this.sessionManager.loadSession(job.user_id, job.target_url);
      } catch {
        // No session available -- will start fresh
      }
    }

    try {
      const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
      const newAdapter = createAdapter(adapterType);
      await newAdapter.start({
        url: job.target_url,
        llm: llmSetup.llm,
        ...(llmSetup.imageLlm && { imageLlm: llmSetup.imageLlm }),
        ...(storedSession ? { storageState: storedSession } : {}),
      });

      if (credentials) {
        newAdapter.registerCredentials(credentials);
      }

      return newAdapter;
    } catch (err) {
      console.error(`[JobExecutor] Crash recovery failed for job ${job.id}:`, err);
      return null;
    }
  }

  // --- Timeout ---

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Job execution timeout')), ms)
    );
  }
}
