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
import { createEncryptionFromEnv } from '../db/encryption.js';
import { BlockerDetector, type BlockerResult, type BlockerType } from '../detection/BlockerDetector.js';
import { ExecutionEngine } from '../engine/ExecutionEngine.js';
import { ManualStore } from '../engine/ManualStore.js';
import { CookbookExecutor } from '../engine/CookbookExecutor.js';
import { TraceRecorder } from '../engine/TraceRecorder.js';
import { StagehandObserver } from '../engine/StagehandObserver.js';
import type { MagnitudeAdapter } from '../adapters/magnitude.js';
import { ThoughtThrottle, JOB_EVENT_TYPES } from '../events/JobEventTypes.js';

// Re-export AutomationJob from the canonical location for backward compat
export type { AutomationJob } from './taskHandlers/types.js';
import type { AutomationJob } from './taskHandlers/types.js';
import type { ResolutionContext } from '../adapters/types.js';

// --- Types ---

/** Result of waiting for a paused job to be resumed, including any resolution data. */
interface ResumeResult {
  resumed: boolean;
  resolutionType?: 'manual' | 'code_entry' | 'credentials' | 'skip';
  resolutionData?: Record<string, unknown>;
}

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
const BLOCKER_CONFIDENCE_THRESHOLD = 0.6;
const MAX_POST_RESUME_CHECKS = 3;
const BLOCKER_CHECK_INTERVAL_MS = 15_000; // Minimum interval between action-triggered blocker checks
const PERIODIC_BLOCKER_CHECK_MS = 30_000; // Periodic timer-based blocker check interval
const CONSECUTIVE_FAILURES_BEFORE_BLOCKER_CHECK = 3; // Check for blockers after this many consecutive action failures

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
    let observer: StagehandObserver | undefined;
    let blockerCheckInterval: ReturnType<typeof setInterval> | null = null;

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
        job.job_type,
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
            llm_cost_cents: 0,
            action_count: 0,
            total_tokens: 0,
          })
          .eq('id', job.id);

        // Report zero cost on preflight failure
        if (job.callback_url) {
          callbackNotifier.notifyFromJob({
            id: job.id,
            valet_task_id: job.valet_task_id,
            callback_url: job.callback_url,
            status: 'failed',
            worker_id: this.workerId,
            error_code: 'budget_exceeded',
            error_details: { message: preflight.reason },
            llm_cost_cents: 0,
            action_count: 0,
            total_tokens: 0,
          }).catch((err) => {
            console.warn(`[JobExecutor] Preflight failure callback failed for job ${job.id}:`, err);
          });
        }
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
          undefined,
          this.workerId,
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
              llm_cost_cents: 0,
              action_count: 0,
              total_tokens: 0,
            })
            .eq('id', job.id);

          // Report zero cost on validation failure
          if (job.callback_url) {
            callbackNotifier.notifyFromJob({
              id: job.id,
              valet_task_id: job.valet_task_id,
              callback_url: job.callback_url,
              status: 'failed',
              worker_id: this.workerId,
              error_code: 'validation_error',
              error_details: { message: msg },
              llm_cost_cents: 0,
              action_count: 0,
              total_tokens: 0,
            }).catch((err) => {
              console.warn(`[JobExecutor] Validation failure callback failed for job ${job.id}:`, err);
            });
          }
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

      // 7a. Attach StagehandObserver for enriched blocker detection (optional)
      if (adapter.type === 'magnitude' && 'setObserver' in adapter) {
        try {
          const cdpUrl = (adapter.page?.context()?.browser() as any)?.wsEndpoint?.();
          if (cdpUrl) {
            const observerModel = llmSetup.imageLlm
              ? `${llmSetup.imageLlm.provider}/${llmSetup.imageLlm.options.model}`
              : `${llmSetup.llm.provider}/${llmSetup.llm.options.model}`;
            observer = new StagehandObserver({
              cdpUrl,
              model: observerModel,
              verbose: 0,
              logEvent: (eventType: string, metadata?: Record<string, any>) =>
                this.logJobEvent(job.id, eventType, metadata || {}),
            });
            await observer.init();
            (adapter as MagnitudeAdapter).setObserver(observer);
            await this.logJobEvent(job.id, 'observer_attached', { model: observerModel });
          }
        } catch (err) {
          // Observer is optional — don't fail the job if it can't attach
          console.warn(`[JobExecutor] StagehandObserver init failed for job ${job.id}:`, err);
          observer = undefined;
        }
      }

      // 8. Register credentials if available
      if (credentials) {
        adapter.registerCredentials(credentials);
      }

      // 8.5. Inject stored browser session (e.g. Google auth cookies)
      try {
        const encryption = createEncryptionFromEnv();
        const localSessionMgr = new SessionManager({ supabase: this.supabase, encryption });

        // Load Google session for Sign-in-with-Google flows
        // Try multiple Google-related domains since the session may be stored under any of them
        const googleDomains = ['accounts.google.com', 'mail.google.com', 'google.com'];
        let googleSessionInjected = false;
        for (const domain of googleDomains) {
          if (googleSessionInjected) break;
          const googleSession = await localSessionMgr.loadSession(job.user_id, domain);
          if (googleSession) {
            const cookies = (googleSession as any).cookies || [];
            if (cookies.length > 0) {
              await adapter.page.context().addCookies(cookies);
              console.log(`[JobExecutor] Injected ${cookies.length} Google session cookies (from ${domain}) for user ${job.user_id}`);
              googleSessionInjected = true;
            }
          }
        }

        // Also try loading session for the target domain
        const injTargetDomain = new URL(job.target_url).hostname;
        const targetSession = await localSessionMgr.loadSession(job.user_id, injTargetDomain);
        if (targetSession) {
          const cookies = (targetSession as any).cookies || [];
          if (cookies.length > 0) {
            await adapter.page.context().addCookies(cookies);
            console.log(`[JobExecutor] Injected ${cookies.length} ${injTargetDomain} session cookies`);
          }
        }
        // Reload page after cookie injection so Workday SSO picks up the Google session
        if (googleSessionInjected) {
          console.log(`[JobExecutor] Reloading page after session injection...`);
          await adapter.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
          await adapter.page.waitForTimeout(2000);
        }
      } catch (err) {
        // Session injection failure is non-fatal — worker can still try fresh login
        console.warn(`[JobExecutor] Session injection failed (non-fatal):`, err);
      }

      // 8.6. Check for blockers after initial page navigation
      const initiallyBlocked = await this.checkForBlockers(job, adapter, costTracker);
      if (initiallyBlocked) {
        throw new Error('Page blocked after initial navigation and HITL resolution failed');
      }

      // 9. Try ExecutionEngine (cookbook replay) before Magnitude handler
      await progress.setStep(ProgressStep.NAVIGATING);

      const logEventFn = (eventType: string, metadata: Record<string, any>) =>
        this.logJobEvent(job.id, eventType, metadata);

      const executionEngine = new ExecutionEngine({
        manualStore: new ManualStore(this.supabase),
        cookbookExecutor: new CookbookExecutor({
          logEvent: logEventFn,
        }),
      });

      const engineResult = await executionEngine.execute({
        job,
        adapter,
        costTracker,
        progress,
        logEvent: logEventFn,
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
            worker_id: this.workerId,
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
      await this.logJobEvent(job.id, JOB_EVENT_TYPES.TRACE_RECORDING_STARTED, {});

      // 9a. Wire up event tracking with cost control + progress for Magnitude path
      const thoughtThrottle = new ThoughtThrottle(2000);

      adapter.on('thought', (thought: string) => {
        progress.recordThought(thought);
        if (thoughtThrottle.shouldEmit()) {
          this.logJobEvent(job.id, JOB_EVENT_TYPES.THOUGHT, {
            content: thought.slice(0, 500),
          });
        }
      });

      // Track state for periodic blocker checks, URL monitoring, and failure escalation
      let lastBlockerCheckTime = Date.now();
      let consecutiveActionFailures = 0;
      const targetDomain = new URL(job.target_url).hostname;
      let lastKnownUrl = job.target_url;

      adapter.on('actionStarted', async (action: { variant: string }) => {
        // Track consecutive failures: incremented on start, reset on actionDone
        consecutiveActionFailures++;
        costTracker.recordAction(); // throws ActionLimitExceededError if over limit
        costTracker.recordModeStep('magnitude');
        progress.onActionStarted(action.variant);
        this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_STARTED, {
          action: action.variant,
          action_count: costTracker.getSnapshot().actionCount,
        });

        // If repeated action failures, check for blockers before continuing
        if (consecutiveActionFailures >= CONSECUTIVE_FAILURES_BEFORE_BLOCKER_CHECK && adapter) {
          try {
            const blocked = await this.checkForBlockers(job, adapter, costTracker);
            if (blocked) {
              // HITL handled — the blocker was likely the root cause of failures
            }
          } catch {
            // Non-fatal
          }
        }
      });

      adapter.on('actionDone', async (action: { variant: string }) => {
        progress.onActionDone(action.variant);
        consecutiveActionFailures = 0; // Reset on successful action
        this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_COMPLETED, {
          action: action.variant,
          action_count: costTracker.getSnapshot().actionCount,
        });

        // Periodic blocker check after actions (throttled)
        const now = Date.now();
        if (now - lastBlockerCheckTime >= BLOCKER_CHECK_INTERVAL_MS) {
          lastBlockerCheckTime = now;
          try {
            // URL change detection — check if page navigated to a non-target domain
            const currentUrl = await adapter!.getCurrentUrl();
            if (currentUrl !== lastKnownUrl) {
              lastKnownUrl = currentUrl;
              try {
                const currentDomain = new URL(currentUrl).hostname;
                if (currentDomain !== targetDomain) {
                  await this.logJobEvent(job.id, JOB_EVENT_TYPES.URL_CHANGE_DETECTED, {
                    from_domain: targetDomain,
                    to_url: currentUrl,
                  });
                }
              } catch {
                // Invalid URL — skip domain comparison
              }
            }

            // Use detectBlocker (DOM-only) for speed, not detectWithAdapter (which calls observe/LLM)
            const blocked = await this.checkForBlockers(job, adapter!, costTracker);
            if (blocked) {
              // checkForBlockers already handled HITL flow internally
            }
          } catch (err) {
            if ((err as Error).message?.includes('Blocker detected')) throw err;
            // Detection errors are non-fatal
          }
        }
      });

      adapter.on('tokensUsed', (usage: TokenUsage) => {
        costTracker.recordTokenUsage({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          inputCost: usage.inputCost,
          outputCost: usage.outputCost,
        }); // throws BudgetExceededError if over budget
        this.logJobEvent(job.id, JOB_EVENT_TYPES.TOKENS_USED, {
          model: (usage as any).model || 'unknown',
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cost_usd: usage.inputCost + usage.outputCost,
        });
      });

      // Start periodic blocker check timer (catches blockers even when adapter is stuck)
      blockerCheckInterval = setInterval(async () => {
        if (!adapter || adapter.isPaused?.()) return; // Don't check while paused
        try {
          const blocked = await this.checkForBlockers(job, adapter, costTracker);
          if (blocked) {
            // Already handled internally — the job will be paused
          }
        } catch {
          // Non-fatal
        }
      }, PERIODIC_BLOCKER_CHECK_MS);

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

          // Re-attach StagehandObserver to the new adapter after crash recovery
          if (observer) {
            try { await observer.stop(); } catch { /* old observer cleanup */ }
            observer = undefined;
          }
          if (adapter.type === 'magnitude' && 'setObserver' in adapter) {
            try {
              const cdpUrl = (adapter.page?.context()?.browser() as any)?.wsEndpoint?.();
              if (cdpUrl) {
                const observerModel = llmSetup.imageLlm
                  ? `${llmSetup.imageLlm.provider}/${llmSetup.imageLlm.options.model}`
                  : `${llmSetup.llm.provider}/${llmSetup.llm.options.model}`;
                observer = new StagehandObserver({
                  cdpUrl,
                  model: observerModel,
                  verbose: 0,
                  logEvent: (eventType: string, metadata?: Record<string, any>) =>
                    this.logJobEvent(job.id, eventType, metadata || {}),
                });
                await observer.init();
                (adapter as MagnitudeAdapter).setObserver(observer);
              }
            } catch (err) {
              console.warn(`[JobExecutor] StagehandObserver re-attach failed after crash recovery for job ${job.id}:`, err);
              observer = undefined;
            }
          }

          // Re-wire event handlers on the new adapter
          thoughtThrottle.reset();
          adapter.on('thought', (thought: string) => {
            progress.recordThought(thought);
            if (thoughtThrottle.shouldEmit()) {
              this.logJobEvent(job.id, JOB_EVENT_TYPES.THOUGHT, {
                content: thought.slice(0, 500),
              });
            }
          });
          adapter.on('actionStarted', async (action: { variant: string }) => {
            consecutiveActionFailures++;
            costTracker.recordAction();
            progress.onActionStarted(action.variant);
            this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_STARTED, {
              action: action.variant,
              action_count: costTracker.getSnapshot().actionCount,
            });

            if (consecutiveActionFailures >= CONSECUTIVE_FAILURES_BEFORE_BLOCKER_CHECK && adapter) {
              try {
                const blocked = await this.checkForBlockers(job, adapter, costTracker);
                if (blocked) {
                  // HITL handled
                }
              } catch {
                // Non-fatal
              }
            }
          });
          // Reset blocker check state after crash recovery
          lastBlockerCheckTime = Date.now();
          consecutiveActionFailures = 0;
          lastKnownUrl = job.target_url;

          adapter.on('actionDone', async (action: { variant: string }) => {
            progress.onActionDone(action.variant);
            consecutiveActionFailures = 0;
            this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_COMPLETED, {
              action: action.variant,
              action_count: costTracker.getSnapshot().actionCount,
            });

            // Periodic blocker check after actions (throttled)
            const now = Date.now();
            if (now - lastBlockerCheckTime >= BLOCKER_CHECK_INTERVAL_MS) {
              lastBlockerCheckTime = now;
              try {
                const currentUrl = await adapter!.getCurrentUrl();
                if (currentUrl !== lastKnownUrl) {
                  lastKnownUrl = currentUrl;
                  try {
                    const currentDomain = new URL(currentUrl).hostname;
                    if (currentDomain !== targetDomain) {
                      await this.logJobEvent(job.id, JOB_EVENT_TYPES.URL_CHANGE_DETECTED, {
                        from_domain: targetDomain,
                        to_url: currentUrl,
                      });
                    }
                  } catch {
                    // Invalid URL — skip domain comparison
                  }
                }
                const blocked = await this.checkForBlockers(job, adapter!, costTracker);
                if (blocked) {
                  // checkForBlockers already handled HITL flow
                }
              } catch (err) {
                if ((err as Error).message?.includes('Blocker detected')) throw err;
              }
            }
          });
          adapter.on('tokensUsed', (usage: TokenUsage) => {
            costTracker.recordTokenUsage({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              inputCost: usage.inputCost,
              outputCost: usage.outputCost,
            });
            this.logJobEvent(job.id, JOB_EVENT_TYPES.TOKENS_USED, {
              model: (usage as any).model || 'unknown',
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cost_usd: usage.inputCost + usage.outputCost,
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

      if (!taskResult.success && !taskResult.keepBrowserOpen) {
        throw new Error(taskResult.error || `Task handler '${handler.type}' returned failure`);
      }

      // 10a. Save trace as manual for future cookbook replay
      if (traceRecorder && traceRecorder.isRecording()) {
        traceRecorder.stopRecording();
        await this.logJobEvent(job.id, JOB_EVENT_TYPES.TRACE_RECORDING_COMPLETED, {
          steps: traceRecorder.getTrace().length,
        });
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

      // 12.5. Save fresh session cookies back to DB after successful auth
      try {
        const encryption = createEncryptionFromEnv();
        const sessionManager = new SessionManager({ supabase: this.supabase, encryption });
        const freshState = await adapter.page.context().storageState();
        // Save Google session (use mail.google.com for consistency with session persistence test)
        await sessionManager.saveSession(
          job.user_id,
          'mail.google.com',
          freshState as unknown as Record<string, unknown>,
        );
        // Save target domain session
        const targetDomain = new URL(job.target_url).hostname;
        await sessionManager.saveSession(
          job.user_id,
          targetDomain,
          freshState as unknown as Record<string, unknown>,
        );
        console.log(`[JobExecutor] Saved fresh session cookies for user ${job.user_id}`);
      } catch (err) {
        console.warn(`[JobExecutor] Session save failed (non-fatal):`, err);
      }

      // 13. Handle awaiting_user_review vs completed
      if (taskResult.awaitingUserReview) {
        // Job paused at review page — keep browser open
        await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
        await progress.flush();

        const resultData = {
          ...(taskResult.data || {}),
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
            status: 'awaiting_user_review',
            result_data: resultData,
            result_summary: 'Application filled — waiting for user to review and submit',
            screenshot_urls: screenshotUrls,
            llm_cost_cents: Math.round(finalCost.totalCost * 100),
            action_count: finalCost.actionCount,
            total_tokens: finalCost.inputTokens + finalCost.outputTokens,
          })
          .eq('id', job.id);

        await this.logJobEvent(job.id, 'awaiting_user_review', {
          handler: handler.type,
          action_count: finalCost.actionCount,
          total_tokens: finalCost.inputTokens + finalCost.outputTokens,
          cost_cents: Math.round(finalCost.totalCost * 100),
        });

        await costService.recordJobCost(job.user_id, job.id, finalCost);

        console.log(`[JobExecutor] Job ${job.id} awaiting user review (actions=${finalCost.actionCount}, cost=$${finalCost.totalCost.toFixed(4)})`);

        // Keep heartbeat running and browser open — wait indefinitely
        // The worker process must stay alive for the browser to remain open
        console.log(`[JobExecutor] Browser is open for manual review. Heartbeat continues.`);
        console.log(`[JobExecutor] Press Ctrl+C to shut down the worker when done.`);

        // Block indefinitely — the user will Ctrl+C when done
        await new Promise<void>(() => {
          // Never resolves — worker stays alive with browser open
        });
      }

      // Normal completion flow
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
          worker_id: this.workerId,
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
          // Use checkForBlockers for proper detect → pause → verify flow
          const stillBlocked = await this.checkForBlockers(job, adapter, costTracker);
          if (!stillBlocked) {
            // Blocker resolved (or detection didn't find one after error classification).
            // Try direct HITL as fallback since the error was classified as captcha/login.
            const resumed = await this.requestHumanIntervention(job, adapter, {
              type: errorCode === 'captcha_blocked' ? 'captcha' : 'login',
              confidence: 0.9,
              details: errorMessage,
              source: 'dom',
            }, costTracker);
            if (resumed) {
              const hitlSnapshot = costTracker.getSnapshot();
              await costService.recordJobCost(job.user_id, job.id, hitlSnapshot).catch((err) => {
                console.warn(`[JobExecutor] Failed to record HITL partial cost for job ${job.id}:`, err);
              });
              console.log(`[JobExecutor] Job ${job.id} resumed after HITL intervention`);
              return;
            }
          } else {
            // checkForBlockers handled the HITL flow but the blocker couldn't be resolved
            console.warn(`[JobExecutor] Job ${job.id} blocked and HITL could not resolve`);
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

      // Always record cost on failure (even zero cost for consistent accounting)
      await costService.recordJobCost(job.user_id, job.id, snapshot).catch((err) => {
        console.warn(`[JobExecutor] Failed to record cost for job ${job.id}:`, err);
      });

      // Fire VALET callback on failure too
      if (job.callback_url) {
        callbackNotifier.notifyFromJob({
          id: job.id,
          valet_task_id: job.valet_task_id,
          callback_url: job.callback_url,
          status: 'failed',
          worker_id: this.workerId,
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
      if (blockerCheckInterval) clearInterval(blockerCheckInterval);
      if (observer) {
        try { await observer.stop(); } catch { /* best-effort cleanup */ }
      }
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

  // --- Blocker Detection ---

  /**
   * Check for blockers using the adapter's observe() method and DOM detection.
   * If a blocker is detected with confidence above threshold:
   *   - Emits blocker_detected event
   *   - Triggers HITL flow (pause, screenshot, callback)
   * Returns true if blocked and paused (job should stop), false if clear.
   */
  async checkForBlockers(
    job: AutomationJob,
    adapter: BrowserAutomationAdapter,
    costTracker?: CostTracker,
  ): Promise<boolean> {
    // Log that we're starting blocker detection
    let currentUrl: string | undefined;
    try {
      currentUrl = await adapter.getCurrentUrl();
    } catch { /* best effort */ }

    await this.logJobEvent(job.id, JOB_EVENT_TYPES.OBSERVATION_STARTED, {
      url: currentUrl,
    });

    let blockerResult: BlockerResult | null = null;
    try {
      blockerResult = await this.blockerDetector.detectWithAdapter(adapter);
    } catch (err) {
      // Detection failure should not crash the job
      console.warn(`[JobExecutor] Blocker detection failed for job ${job.id}:`, err);
      return false;
    }

    if (!blockerResult || blockerResult.confidence < BLOCKER_CONFIDENCE_THRESHOLD) {
      await this.logJobEvent(job.id, JOB_EVENT_TYPES.OBSERVATION_COMPLETED, {
        result: 'clear',
        url: currentUrl,
      });
      return false;
    }

    // Blocker detected — emit event and trigger HITL
    await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_DETECTED, {
      blocker_type: blockerResult.type,
      confidence: blockerResult.confidence,
      source: blockerResult.source,
      selector: blockerResult.selector,
      details: blockerResult.details,
    });

    const resumed = await this.requestHumanIntervention(job, adapter, blockerResult, costTracker);

    if (resumed) {
      // Post-resume verification: re-check for blockers up to MAX_POST_RESUME_CHECKS times
      for (let attempt = 1; attempt <= MAX_POST_RESUME_CHECKS; attempt++) {
        let stillBlocked: BlockerResult | null = null;
        try {
          stillBlocked = await this.blockerDetector.detectWithAdapter(adapter);
        } catch {
          // Detection failed — assume clear
          break;
        }

        if (!stillBlocked || stillBlocked.confidence < BLOCKER_CONFIDENCE_THRESHOLD) {
          // Clear — continue execution
          return false;
        }

        console.warn(
          `[JobExecutor] Job ${job.id} still blocked after resume (attempt ${attempt}/${MAX_POST_RESUME_CHECKS}): ${stillBlocked.type} (${stillBlocked.confidence})`,
        );

        if (attempt < MAX_POST_RESUME_CHECKS) {
          // Re-pause and wait for another human intervention
          const reResumed = await this.requestHumanIntervention(job, adapter, stillBlocked, costTracker);
          if (!reResumed) {
            return true; // Timed out — still blocked
          }
        }
      }

      // Exhausted re-checks but still blocked
      return true;
    }

    // HITL timed out — still blocked
    return true;
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
    costTracker?: CostTracker,
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

    await this.logJobEvent(job.id, JOB_EVENT_TYPES.HITL_PAUSED, {
      blocker_type: blockerResult.type,
      confidence: blockerResult.confidence,
      source: blockerResult.source,
      page_url: pageUrl,
      screenshot_url: screenshotUrl,
    });

    // 4. Notify VALET via callback
    if (job.callback_url) {
      const costSnapshot = costTracker?.getSnapshot();
      callbackNotifier.notifyHumanNeeded(
        job.id,
        job.callback_url,
        {
          type: blockerResult.type,
          screenshot_url: screenshotUrl,
          page_url: pageUrl,
          timeout_seconds: timeoutSeconds,
          description: blockerResult.details,
          metadata: {
            blocker_confidence: blockerResult.confidence,
            captcha_type: blockerResult.type === 'captcha'
              ? (blockerResult.selector?.match(/recaptcha|hcaptcha|funcaptcha|turnstile/i)?.[0]?.toLowerCase() ?? 'unknown')
              : undefined,
            detection_method: blockerResult.source,
          },
        },
        job.valet_task_id,
        this.workerId,
        costSnapshot ? {
          total_cost_usd: costSnapshot.totalCost,
          action_count: costSnapshot.actionCount,
          total_tokens: costSnapshot.inputTokens + costSnapshot.outputTokens,
        } : undefined,
      ).catch((err) => {
        console.warn(`[JobExecutor] HITL callback failed for job ${job.id}:`, err);
      });
    }

    // 5. Wait for NOTIFY or timeout
    const result = await this.waitForResume(job.id, timeoutSeconds);

    if (result.resumed) {
      // 6. Inject credentials/code BEFORE resuming the adapter
      if (result.resolutionType === 'code_entry' && result.resolutionData?.code) {
        await this.injectCode(job.id, adapter, result.resolutionData.code as string);
      } else if (result.resolutionType === 'credentials' && result.resolutionData) {
        await this.injectCredentials(job.id, adapter, result.resolutionData);
      }
      // 'manual' and 'skip' — no injection needed

      // 7. Resume the adapter (unblock the pause gate)
      if (adapter.resume) {
        const ctx: ResolutionContext = {
          resolutionType: result.resolutionType || 'manual',
          resolutionData: result.resolutionData,
        };
        await adapter.resume(ctx);
      }
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'running',
          paused_at: null,
          status_message: 'Resumed after human intervention',
        })
        .eq('id', job.id);

      await this.logJobEvent(job.id, JOB_EVENT_TYPES.HITL_RESUMED, {
        resolution_type: result.resolutionType || 'manual',
        // SECURITY: Never log resolutionData — it may contain passwords/codes
      });

      if (job.callback_url) {
        callbackNotifier.notifyResumed(job.id, job.callback_url, job.valet_task_id, this.workerId).catch((err) => {
          console.warn(`[JobExecutor] Resume callback failed for job ${job.id}:`, err);
        });
      }
      return true;
    }

    // 8. Timeout — fail the job
    await this.logJobEvent(job.id, JOB_EVENT_TYPES.HITL_TIMEOUT, { timeout_seconds: timeoutSeconds });
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
   * Returns ResumeResult with resolution type/data from the DB.
   */
  private async waitForResume(jobId: string, timeoutSeconds: number): Promise<ResumeResult> {
    if (this.pgPool) {
      return this.waitForResumeViaPg(jobId, timeoutSeconds);
    }
    // Fallback: poll the job status
    return this.waitForResumeViaPolling(jobId, timeoutSeconds);
  }

  private async waitForResumeViaPg(jobId: string, timeoutSeconds: number): Promise<ResumeResult> {
    const client = await this.pgPool!.connect();
    try {
      await client.query('LISTEN gh_job_resume');

      const notified = await new Promise<boolean>((resolve) => {
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

      if (!notified) {
        return { resumed: false };
      }

      // Read resolution data from DB
      return this.readAndClearResolutionData(jobId);
    } catch (err) {
      client.release();
      console.warn(`[JobExecutor] PG LISTEN failed for job ${jobId}, falling back to polling:`, err);
      return this.waitForResumeViaPolling(jobId, timeoutSeconds);
    }
  }

  private async waitForResumeViaPolling(jobId: string, timeoutSeconds: number): Promise<ResumeResult> {
    const pollIntervalMs = 3000;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      const { data } = await this.supabase
        .from('gh_automation_jobs')
        .select('status')
        .eq('id', jobId)
        .single();

      if (data?.status === 'running') {
        // Read resolution data from DB
        return this.readAndClearResolutionData(jobId);
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return { resumed: false };
  }

  /**
   * Read resolution data from DB and clear it immediately for security.
   * Resolution data may contain passwords, 2FA codes, etc.
   * Uses pgPool if available, falls back to Supabase.
   */
  private async readAndClearResolutionData(jobId: string): Promise<ResumeResult> {
    try {
      if (this.pgPool) {
        const { rows } = await this.pgPool.query(
          `SELECT interaction_data FROM gh_automation_jobs WHERE id = $1::UUID`,
          [jobId],
        );
        const interactionData = rows[0]?.interaction_data as Record<string, any> | null;
        const resolutionType = interactionData?.resolution_type || 'manual';
        const resolutionData = interactionData?.resolution_data || undefined;

        // SECURITY: Clear resolution data from DB immediately after reading.
        // This data may contain passwords, 2FA codes, or other credentials.
        await this.pgPool.query(`
          UPDATE gh_automation_jobs
          SET interaction_data = interaction_data - 'resolution_type' - 'resolution_data' - 'resolved_by' - 'resolved_at'
          WHERE id = $1::UUID
        `, [jobId]);

        return { resumed: true, resolutionType, resolutionData };
      }

      // Fallback: use Supabase client
      const { data } = await this.supabase
        .from('gh_automation_jobs')
        .select('interaction_data')
        .eq('id', jobId)
        .single();

      const interactionData = data?.interaction_data as Record<string, any> | null;
      const resolutionType = interactionData?.resolution_type || 'manual';
      const resolutionData = interactionData?.resolution_data || undefined;

      // SECURITY: Clear resolution data via Supabase
      // Build cleaned interaction_data without resolution fields
      if (interactionData) {
        const { resolution_type, resolution_data, resolved_by, resolved_at, ...cleaned } = interactionData;
        await this.supabase
          .from('gh_automation_jobs')
          .update({ interaction_data: cleaned })
          .eq('id', jobId);
      }

      return { resumed: true, resolutionType, resolutionData };
    } catch (err) {
      console.warn(`[JobExecutor] Failed to read resolution data for job ${jobId}:`, err);
      // Still resumed, just without resolution data
      return { resumed: true, resolutionType: 'manual' };
    }
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

  // --- Credential / Code Injection ---

  /**
   * Inject a 2FA/verification code into the current page via Playwright.
   * Deterministic field-filling — bypasses the AI agent for reliability.
   * SECURITY: Never log the code value.
   */
  private async injectCode(jobId: string, adapter: BrowserAutomationAdapter, code: string): Promise<void> {
    const page = adapter.page;
    if (!page) return;

    await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_ATTEMPTED, {
      injection_type: 'code_entry',
    });

    const selectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code" i]',
      'input[name*="otp" i]',
      'input[name*="totp" i]',
      'input[name*="verification" i]',
      'input[name*="token" i]',
      'input[name*="2fa" i]',
      'input[name*="mfa" i]',
      'input[type="tel"][maxlength="6"]',
      'input[type="number"][maxlength="6"]',
      'input[inputmode="numeric"]',
    ];

    for (const selector of selectors) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.fill(code);
          console.log(`[JobExecutor] Injected 2FA code via selector: ${selector}`);
          await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_SUCCEEDED, {
            injection_type: 'code_entry',
            selector,
          });
          // Try to submit
          const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")');
          if (submitBtn && await submitBtn.isVisible()) {
            await submitBtn.click();
          }
          return;
        }
      } catch {
        // Selector may not be valid on this page, try next
      }
    }
    console.warn('[JobExecutor] Could not find 2FA code input field — resuming without injection');
    await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_FAILED, {
      injection_type: 'code_entry',
      reason: 'no_matching_input_field',
    });
  }

  /**
   * Inject login credentials into the current page via Playwright.
   * SECURITY: Never log credential values — only log the selector matched.
   */
  private async injectCredentials(
    jobId: string,
    adapter: BrowserAutomationAdapter,
    data: Record<string, unknown>,
  ): Promise<void> {
    const page = adapter.page;
    if (!page) return;

    const username = (data.username || data.email) as string | undefined;
    const password = data.password as string | undefined;

    if (!username && !password) return;

    await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_ATTEMPTED, {
      injection_type: 'credentials',
      has_username: !!username,
      has_password: !!password,
    });

    let usernameInjected = false;
    let passwordInjected = false;

    if (username) {
      const usernameSelectors = [
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
        'input[name="username"]',
        'input[name="email"]',
        'input[name="login"]',
        'input[name="userId"]',
        'input[name="loginId"]',
        'input[type="email"]',
        'input[id*="username" i]',
        'input[id*="email" i]',
        'input[id*="login" i]',
      ];
      for (const sel of usernameSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            await el.fill(username);
            console.log(`[JobExecutor] Injected username via selector: ${sel}`);
            usernameInjected = true;
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (password) {
      const passwordSelectors = [
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input[name="password"]',
        'input[name="passwd"]',
      ];
      for (const sel of passwordSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            await el.fill(password);
            console.log(`[JobExecutor] Injected password via selector: ${sel}`);
            passwordInjected = true;
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (usernameInjected || passwordInjected) {
      await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_SUCCEEDED, {
        injection_type: 'credentials',
        username_injected: usernameInjected,
        password_injected: passwordInjected,
      });
      try {
        const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button:has-text("Continue")');
        if (submitBtn && await submitBtn.isVisible()) {
          await submitBtn.click();
          await page.waitForLoadState('networkidle').catch(() => {});
        }
      } catch { /* best effort */ }
    } else {
      await this.logJobEvent(jobId, JOB_EVENT_TYPES.CREDENTIAL_INJECTION_FAILED, {
        injection_type: 'credentials',
        reason: 'no_matching_input_fields',
      });
    }
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
