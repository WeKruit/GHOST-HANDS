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
import type { TaskHandler, TaskContext, TaskResult } from './taskHandlers/types.js';
import { SessionManager } from '../sessions/SessionManager.js';
import { BlockerDetector, type BlockerResult, type BlockerType } from '../detection/BlockerDetector.js';
import { StagehandObserver } from '../engine/StagehandObserver.js';
import type { MagnitudeAdapter } from '../adapters/magnitude.js';
import { ThoughtThrottle, JOB_EVENT_TYPES } from '../events/JobEventTypes.js';
import { ResumeDownloader, type ResumeRef } from './resumeDownloader.js';
import { ResumeProfileLoader } from '../db/resumeProfileLoader.js';
import { getLogger } from '../monitoring/logger.js';
import { AgentApplyHandler } from './taskHandlers/agentApplyHandler.js';
import { getMastra } from '../workflows/mastra/init.js';
import { buildApplyWorkflow } from '../workflows/mastra/applyWorkflow.js';
import { isMastraResume, claimResume, persistMastraRunId } from '../workflows/mastra/resumeCoordinator.js';
import { workflowState, type RuntimeContext, type WorkflowState } from '../workflows/mastra/types.js';
import {
  finalizeHandlerResult,
  finalizeHandlerSideEffects,
  serializeContextReport,
} from './finalization.js';
import { createEmailVerificationServiceFromEnv } from './emailVerification/service.js';
import type { EmailVerificationService } from './emailVerification/types.js';
import {
  createEmptyHitlAttempts,
  decideHitlAction,
  getHitlAttemptsForType,
  hasAnyHitlAttempts,
  incrementHitlAttempt,
  isRecoverableAuthBlocker,
  type HitlDecisionAction,
  type HitlAttemptsByType,
} from './hitl/decisionEngine.js';
import { LivePageContextService, type PageContextService } from '../context/PageContextService.js';
import { RedisPageContextStore } from '../context/RedisPageContextStore.js';
import { SupabasePageContextFlusher } from '../context/SupabasePageContextFlusher.js';
import { VERIFICATION_INPUT_SELECTORS } from './verificationSelectors.js';

const logger = getLogger({ service: 'job-executor' });

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

interface HandleJobErrorInput {
  job: AutomationJob;
  error: unknown;
  actionCount: number;
  totalTokens: number;
  totalCost: number;
  resultData?: Record<string, unknown>;
  pageContext?: PageContextService;
  contextFlushed?: boolean;
  /** Fresh metadata accumulator from finalizeHandlerSideEffects — use instead of stale job.metadata */
  currentMetadata?: Record<string, unknown>;
}

export interface JobExecutorOptions {
  supabase: SupabaseClient;
  workerId: string;
  sessionManager?: SessionManager;
  /** Postgres pool for LISTEN/NOTIFY (HITL resume signals) */
  pgPool?: pg.Pool;
  /** Optional Redis client for real-time progress streaming via Redis Streams. */
  redis?: import('ioredis').default;
  /** Timeout in seconds for human intervention (default: 300 = 5 minutes) */
  hitlTimeoutSeconds?: number;
}

// --- Error classification ---

export const ERROR_CLASSIFICATIONS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /budget.?exceeded/i, code: 'budget_exceeded' },
  { pattern: /action.?limit.?exceeded/i, code: 'action_limit_exceeded' },
  { pattern: /captcha/i, code: 'captcha_blocked' },
  { pattern: /2fa|two.?factor|verification code|authenticator/i, code: '2fa_required' },
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

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_HEARTBEAT_FAILURES = 3;
const DEFAULT_HITL_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_CRASH_RECOVERIES = 2;
const MAX_POST_RESUME_CHECKS = 3;
const BLOCKER_CHECK_INTERVAL_MS = 15_000; // Minimum interval between action-triggered blocker checks
const PERIODIC_BLOCKER_CHECK_MS = 30_000; // Periodic timer-based blocker check interval
const BLOCKER_CHECK_TIMEOUT_MS = 20_000; // Timeout for any single blocker check call
const CONSECUTIVE_FAILURES_BEFORE_BLOCKER_CHECK = 3; // Check for blockers after this many consecutive action failures

/** Error codes that should trigger HITL instead of immediate retry */
export const HITL_ELIGIBLE_ERRORS = new Set([
  'captcha_blocked',
  'login_required',
  '2fa_required',
]);

/** Classify an error message into an error code using ERROR_CLASSIFICATIONS. */
export function classifyError(message: string): string {
  for (const { pattern, code } of ERROR_CLASSIFICATIONS) {
    if (pattern.test(message)) return code;
  }
  return 'internal_error';
}

function isEmailAutomationDisabled(raw: string | undefined = process.env.GH_EMAIL_AUTOMATION_ENABLED): boolean {
  const normalized = (raw || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

interface HitlRecoveryState {
  attemptsByType: HitlAttemptsByType;
  lastDecision: HitlDecisionAction | null;
}

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
  private redis: import('ioredis').default | null;
  private hitlTimeoutSeconds: number;
  private blockerDetector = new BlockerDetector();
  private resumeDownloader: ResumeDownloader;
  private _cancelled = false;
  private _activeAdapter: BrowserAutomationAdapter | null = null;
  private _executionAttemptId: string | null = null;

  constructor(opts: JobExecutorOptions) {
    this.supabase = opts.supabase;
    this.workerId = opts.workerId;
    this.sessionManager = opts.sessionManager ?? null;
    this.pgPool = opts.pgPool ?? null;
    this.redis = opts.redis ?? null;
    this.hitlTimeoutSeconds = opts.hitlTimeoutSeconds ?? DEFAULT_HITL_TIMEOUT_SECONDS;
    this.resumeDownloader = new ResumeDownloader(opts.supabase);
  }

  private canAutoRecoverAuth(job: AutomationJob): boolean {
    const executionMode = (job.execution_mode || '').toLowerCase();
    const jobType = (job.job_type || '').toLowerCase();
    if (executionMode === 'smart_apply' || executionMode === 'agent_apply') {
      return true;
    }
    return jobType === 'smart_apply' || jobType === 'workday_apply' || jobType === 'agent_apply';
  }

  private getHitlRecoveryState(job: AutomationJob): HitlRecoveryState {
    const metadata = (job.metadata || {}) as Record<string, any>;
    const raw = metadata.hitl_recovery;
    const attemptsByType = raw?.attemptsByType && typeof raw.attemptsByType === 'object'
      ? (raw.attemptsByType as HitlAttemptsByType)
      : createEmptyHitlAttempts();
    const lastDecision = typeof raw?.lastDecision === 'string'
      ? raw.lastDecision as HitlDecisionAction
      : null;
    return {
      attemptsByType,
      lastDecision,
    };
  }

  private async persistHitlRecoveryState(job: AutomationJob, state: HitlRecoveryState): Promise<void> {
    const metadata = {
      ...(job.metadata || {}),
      hitl_recovery: {
        attemptsByType: state.attemptsByType,
        lastDecision: state.lastDecision,
        updatedAt: new Date().toISOString(),
      },
    };
    job.metadata = metadata;
    try {
      await this.supabase
        .from('gh_automation_jobs')
        .update({ metadata, updated_at: new Date().toISOString() })
        .eq('id', job.id);
    } catch (err) {
      getLogger().warn('Failed to persist HITL recovery state', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async clearHitlRecoveryState(job: AutomationJob): Promise<void> {
    const current = this.getHitlRecoveryState(job);
    if (!hasAnyHitlAttempts(current.attemptsByType) && !current.lastDecision) {
      return;
    }
    await this.persistHitlRecoveryState(job, {
      attemptsByType: createEmptyHitlAttempts(),
      lastDecision: 'NO_ACTION',
    });
  }

  private async hasVisibleVerificationInput(adapter: BrowserAutomationAdapter): Promise<boolean> {
    for (const selector of VERIFICATION_INPUT_SELECTORS) {
      try {
        const el = await adapter.page.$(selector);
        if (el && await el.isVisible()) {
          return true;
        }
      } catch {
        // ignore invalid selectors and detached DOM nodes
      }
    }

    return false;
  }

  private mapErrorCodeToBlockerType(errorCode: string): BlockerType | null {
    if (errorCode === 'captcha_blocked') return 'captcha';
    if (errorCode === 'login_required') return 'login';
    if (errorCode === '2fa_required') return '2fa';
    if (errorCode === 'rate_limited') return 'rate_limited';
    return null;
  }

  async execute(job: AutomationJob): Promise<void> {
    this._cancelled = false;
    this._activeAdapter = null;
    this._executionAttemptId = crypto.randomUUID();
    const heartbeat = this.startHeartbeat(job.id);
    let adapter: BrowserAutomationAdapter | null = null;
    let observer: StagehandObserver | undefined;
    let blockerCheckInterval: ReturnType<typeof setInterval> | null = null;
    let resumeFilePath: string | null = null;
    let fileChooserHandler: ((chooser: any) => Promise<void>) | null = null;
    let cancelListenClient: pg.PoolClient | null = null;
    let emailVerification: EmailVerificationService | null = null;

    // Initialize cost tracker with budget limits
    const qualityPreset = resolveQualityPreset(job.input_data, job.metadata);
    const costTracker = new CostTracker({
      jobId: job.id,
      qualityPreset,
      jobType: job.job_type,
    });

    const costService = new CostControlService(this.supabase);

    // Initialize progress tracker (with optional Redis Streams for real-time SSE)
    const progress = new ProgressTracker({
      jobId: job.id,
      supabase: this.supabase,
      workerId: this.workerId,
      estimatedTotalActions: costTracker.getActionLimit(),
      ...(this.redis && { redis: this.redis }),
    });

    // Declared outside try so error handler can flush on failure
    let pageContext: PageContextService | null = null;
    let contextAlreadyFlushed = false;

    try {
      // 0a. Stamp execution_attempt_id to prevent duplicate execution (EC3)
      if (this.pgPool) {
        await this.pgPool.query(
          'UPDATE gh_automation_jobs SET execution_attempt_id = $1 WHERE id = $2',
          [this._executionAttemptId, job.id],
        );
        logger.info('Stamped execution attempt', { jobId: job.id, executionAttemptId: this._executionAttemptId });
      }

      // 0b. Subscribe to instant cancel channel (EC2 — LISTEN/NOTIFY)
      if (this.pgPool) {
        try {
          cancelListenClient = await this.pgPool.connect();
          const cancelChannel = `gh_job_cancel_${job.id}`;
          await cancelListenClient.query(`LISTEN "${cancelChannel}"`);
          cancelListenClient.on('notification', (msg: pg.Notification) => {
            if (msg.channel === cancelChannel) {
              logger.info('Received instant cancel NOTIFY', { jobId: job.id });
              this._cancelled = true;
              if (this._activeAdapter) {
                this._activeAdapter.stop().catch(() => {});
              }
            }
          });
        } catch (err) {
          logger.warn('Failed to set up cancel LISTEN channel', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          // Non-fatal — heartbeat polling still catches cancellation
          if (cancelListenClient) {
            try { cancelListenClient.release(); } catch { /* noop */ }
            cancelListenClient = null;
          }
        }
      }

      // 0. Pre-flight budget check (skip in development)
      const isDev = (process.env.NODE_ENV || 'development') === 'development';
      const preflight = isDev
        ? { allowed: true, remainingBudget: Infinity, taskBudget: 0 }
        : await costService.preflightBudgetCheck(
            job.user_id,
            qualityPreset,
          );
      if (isDev) {
        getLogger().debug('Skipping budget preflight', { nodeEnv: 'development' });
      }
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
            getLogger().warn('Preflight failure callback failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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

      // 1a. Notify VALET that the job is now running (include kasm_url if available)
      const kasmUrl = process.env.KASM_SESSION_URL;
      if (kasmUrl) {
        progress.setKasmUrl(kasmUrl);
      }
      if (job.callback_url) {
        callbackNotifier.notifyRunning(
          job.id,
          job.callback_url,
          job.valet_task_id,
          kasmUrl ? { kasm_url: kasmUrl } : undefined,
          this.workerId,
        ).catch((err) => {
          getLogger().warn('Running callback failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        });
      }

      // 1b. Auto-populate user_data from VALET's resumes table if not provided
      await this.enrichJobFromResumeProfile(job);

      // 2. Resolve task handler — execution_mode can override the default handler
      let handler: TaskHandler = taskHandlerRegistry.getOrThrow(job.job_type);
      if (job.execution_mode === 'agent_apply') {
        handler = new AgentApplyHandler();
        logger.info('execution_mode override: using AgentApplyHandler', { jobId: job.id });
      } else if (job.execution_mode === 'smart_apply') {
        // SmartApplyHandler is already registered in the registry as 'smart_apply'.
        // If the job_type doesn't match, override with SmartApplyHandler.
        if (handler.type !== 'smart_apply') {
          handler = taskHandlerRegistry.getOrThrow('smart_apply');
          logger.info('execution_mode override: using SmartApplyHandler', { jobId: job.id });
        }
      }

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
              getLogger().warn('Validation failure callback failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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

      // 5a. Per-user Gmail verification automation (SmartApply scope).
      // Enabled by default; disable only via explicit false-like values.
      if (handler.type === 'smart_apply' && !isEmailAutomationDisabled()) {
        try {
          emailVerification = createEmailVerificationServiceFromEnv({
            supabase: this.supabase,
            userId: job.user_id,
          });
          if (emailVerification) {
            await this.logJobEvent(job.id, 'email_verification_service_enabled', {
              provider: process.env.GH_EMAIL_PROVIDER || 'gmail_api',
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('Email verification service init failed (continuing without it)', { jobId: job.id, error: message });
          await this.logJobEvent(job.id, 'email_verification_service_init_failed', {
            error: message,
          });
          emailVerification = null;
        }
      }

      // 5b. Download resume if resume_ref is provided
      const resumeRef = this.resolveResumeRef(job);
      if (resumeRef) {
        try {
          resumeFilePath = await this.resumeDownloader.download(resumeRef, job.id);
          await this.logJobEvent(job.id, JOB_EVENT_TYPES.RESUME_DOWNLOADED, {
            source: resumeRef.storage_path ? 'supabase' : resumeRef.download_url ? 'url' : 's3',
            file_path: resumeFilePath,
          });
          logger.info('Resume downloaded', { jobId: job.id, filePath: resumeFilePath });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.logJobEvent(job.id, JOB_EVENT_TYPES.RESUME_DOWNLOAD_FAILED, {
            error: errMsg,
          });
          logger.warn('Resume download failed, continuing without file', {
            jobId: job.id,
            error: errMsg,
          });
        }
      }

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
          getLogger().warn('Session load failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // 7. Create and start adapter
      logger.debug('[exec] Step 7: Creating adapter', { jobId: job.id });
      const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
      adapter = createAdapter(adapterType);
      this._activeAdapter = adapter;
      const headless = process.env.GH_HEADLESS !== 'false'; // default true
      await adapter.start({
        url: job.target_url,
        llm: llmSetup.llm,
        ...(llmSetup.imageLlm && { imageLlm: llmSetup.imageLlm }),
        ...(storedSession ? { storageState: storedSession } : {}),
        browserOptions: { headless },
      });

      logger.debug('[exec] Step 7: Adapter started, waiting for page load', { jobId: job.id, adapterType });

      // 7b. Wait for page to be ready before any interactions (SPA pages like Greenhouse need this)
      try {
        await Promise.race([
          adapter.page.waitForLoadState('domcontentloaded'),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        logger.debug('[exec] Step 7: Page domcontentloaded', { jobId: job.id });
      } catch {
        logger.debug('[exec] Step 7: Page load wait skipped', { jobId: job.id });
      }

      // 7c. For SPA platforms (non-Workday), wait for networkidle to let React/JS finish rendering
      if (platform !== 'workday') {
        try {
          await Promise.race([
            adapter.page.waitForLoadState('networkidle'),
            new Promise((resolve) => setTimeout(resolve, 15_000)),
          ]);
          logger.debug('[exec] Step 7c: Page networkidle (SPA ready)', { jobId: job.id });
        } catch {
          logger.debug('[exec] Step 7c: networkidle wait skipped (timeout ok)', { jobId: job.id });
        }
      }

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
          getLogger().warn('StagehandObserver init failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
          observer = undefined;
        }
      }

      logger.debug('[exec] Step 8: Registering credentials', { jobId: job.id, hasCredentials: !!credentials });
      // 8. Register credentials if available
      if (credentials) {
        adapter.registerCredentials(credentials);
      }

      logger.debug('[exec] Step 8.5: Injecting browser session', { jobId: job.id, hasSessionManager: !!this.sessionManager });
      // 8.5. Inject stored browser session (e.g. Google auth cookies)
      if (this.sessionManager) try {
        // Load Google session for Sign-in-with-Google flows
        // Try multiple Google-related domains since the session may be stored under any of them
        const googleDomains = ['accounts.google.com', 'mail.google.com', 'google.com'];
        let googleSessionInjected = false;
        for (const domain of googleDomains) {
          if (googleSessionInjected) break;
          const googleSession = await this.sessionManager.loadSession(job.user_id, domain);
          if (googleSession) {
            const cookies = (googleSession as any).cookies || [];
            if (cookies.length > 0) {
              await adapter.page.context().addCookies(cookies);
              getLogger().info('Injected Google session cookies', { count: cookies.length, domain, userId: job.user_id });
              googleSessionInjected = true;
            }
          }
        }

        // Also try loading session for the target domain
        const injTargetDomain = new URL(job.target_url).hostname;
        const targetSession = await this.sessionManager.loadSession(job.user_id, injTargetDomain);
        if (targetSession) {
          const cookies = (targetSession as any).cookies || [];
          if (cookies.length > 0) {
            await adapter.page.context().addCookies(cookies);
            getLogger().info('Injected target domain session cookies', { count: cookies.length, domain: injTargetDomain });
          }
        }
        // Reload page after cookie injection so Workday SSO picks up the Google session
        if (googleSessionInjected) {
          getLogger().info('Reloading page after session injection');
          logger.debug('[exec] Step 8.5: Reloading page (networkidle)...', { jobId: job.id });
          await adapter.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
          await adapter.page.waitForTimeout(2000);
          logger.debug('[exec] Step 8.5: Page reload complete', { jobId: job.id });
        }
      } catch (err) {
        // Session injection failure is non-fatal — worker can still try fresh login
        getLogger().warn('Session injection failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }

      logger.debug('[exec] Step 8.5: Session injection done', { jobId: job.id });

      // 8a. Auto-attach resume to file inputs via Playwright filechooser event.
      // This covers ALL execution paths (handlers, crash recovery).
      if (resumeFilePath) {
        fileChooserHandler = async (chooser: any) => {
          try {
            await chooser.setFiles(resumeFilePath!);
            logger.info('Resume auto-attached via filechooser', { jobId: job.id });
          } catch (err) {
            logger.warn('filechooser setFiles failed', { jobId: job.id, error: String(err) });
          }
        };
        adapter.page.on('filechooser', fileChooserHandler);
      }

      // --- MASTRA WORKFLOW PATH ---
      if (job.execution_mode === 'mastra') {
        const logEventFn = (eventType: string, metadata: Record<string, any>) =>
          this.logJobEvent(job.id, eventType, metadata);
        await this.executeMastraWorkflow({
          job,
          adapter: adapter!,
          handler,
          costTracker,
          progress,
          credentials,
          dataPrompt,
          resumeFilePath,
          emailVerification,
          logEventFn,
        });
        return;
      }

      // 8.6. Check for blockers after initial page navigation (with timeout)
      // Skip for non-Workday platforms — SPA pages (Greenhouse) cause page.evaluate() to hang
      const skipInitialBlockerCheck = platform !== 'workday';
      if (skipInitialBlockerCheck) {
        logger.debug('[exec] Step 8.6: Skipping initial blocker check (non-workday platform)', { jobId: job.id, platform });
      } else {
        logger.debug('[exec] Step 8.6: Checking for blockers', { jobId: job.id });
        let initiallyBlocked = false;
        try {
          initiallyBlocked = await Promise.race([
            this.checkForBlockers(job, adapter, costTracker),
            new Promise<false>((resolve) =>
              setTimeout(() => {
                logger.warn('[exec] Step 8.6: Blocker check timed out, skipping', { jobId: job.id });
                resolve(false);
              }, BLOCKER_CHECK_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          logger.warn('[exec] Step 8.6: Blocker check error, skipping', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        }
        if (initiallyBlocked) {
          throw new Error('Page blocked after initial navigation and HITL resolution failed');
        }
        logger.debug('[exec] Step 8.6: Blocker check passed', { jobId: job.id });
      }

      // 9. Set up handler execution
      await progress.setStep(ProgressStep.NAVIGATING);

      const logEventFn = (eventType: string, metadata: Record<string, any>) =>
        this.logJobEvent(job.id, eventType, metadata);

      // 9.1. Wire page context for real-time context snapshots (non-Mastra path)
      // Best-effort: Redis unavailability should not block job execution
      if (this.redis) {
        try {
          pageContext = new LivePageContextService(
            job.id,
            new RedisPageContextStore(this.redis, job.id),
            new SupabasePageContextFlusher(this.supabase),
          );
          await pageContext.initializeRun(`run-${job.id}-${this._executionAttemptId ?? '0'}`);
          progress.setPageContext(pageContext);
        } catch (err) {
          getLogger().warn('Page context init failed (non-fatal, continuing without context snapshots)', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          pageContext = null;
        }
      }

      // 9a. Wire up event tracking with cost control + progress
      const thoughtThrottle = new ThoughtThrottle(2000);
      const targetDomain = new URL(job.target_url).hostname;
      const blockerState = {
        lastCheckTime: Date.now(),
        consecutiveFailures: 0,
        lastKnownUrl: job.target_url,
      };

      this.wireAdapterEvents(adapter, {
        job, costTracker, progress, thoughtThrottle, blockerState, targetDomain,
      });

      // Start periodic blocker check timer (catches blockers even when adapter is stuck)
      // Only for workday_apply — SPA platforms (Greenhouse) cause page.evaluate() to hang,
      // creating contention with Magnitude's own evaluate calls
      if (handler.type === 'workday_apply') {
        blockerCheckInterval = setInterval(async () => {
          if (!adapter || adapter.isPaused?.()) return; // Don't check while paused
          try {
            await Promise.race([
              this.checkForBlockers(job, adapter, costTracker),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), BLOCKER_CHECK_TIMEOUT_MS)),
            ]);
          } catch {
            // Non-fatal
          }
        }, PERIODIC_BLOCKER_CHECK_MS);
      } else {
        logger.debug('[exec] Periodic blocker checks disabled for non-workday handler', { jobId: job.id, handler: handler.type });
      }

      // 10. Build TaskContext and delegate to handler (with crash recovery)
      logger.debug('[exec] Step 10: Delegating to handler', { jobId: job.id, handler: handler.type, timeoutSeconds: job.timeout_seconds });
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
          resumeFilePath,
          emailVerification: emailVerification || undefined,
          logEvent: logEventFn,
          ...(pageContext && { pageContext }),
          // Wire HITL pause for open-question handling (same infrastructure as Mastra path)
          waitForManualAction: async (actionOpts) => {
            const timeout = actionOpts.timeoutSeconds ?? this.hitlTimeoutSeconds;

            let screenshotUrl: string | undefined;
            try {
              const buf = await adapter!.screenshot();
              screenshotUrl = await this.uploadScreenshot(job.id, 'manual-action', buf);
            } catch { /* non-fatal */ }

            const pageUrl = await adapter!.getCurrentUrl().catch(() => job.target_url);

            await this.supabase
              .from('gh_automation_jobs')
              .update({
                status: 'paused',
                interaction_type: actionOpts.type,
                interaction_data: {
                  type: actionOpts.type,
                  description: actionOpts.description,
                  metadata: actionOpts.metadata || null,
                  screenshot_url: screenshotUrl,
                  page_url: pageUrl,
                  detected_at: new Date().toISOString(),
                },
                paused_at: new Date().toISOString(),
                status_message: `Waiting for human: ${actionOpts.description}`,
              })
              .eq('id', job.id);

            await logEventFn('manual_action_required', {
              jobId: job.id,
              action_type: actionOpts.type,
              description: actionOpts.description,
            });

            if (job.callback_url) {
              const rawMeta = (actionOpts.metadata || {}) as Record<string, any>;
              const { questions: hoistedQuestions, ...remainingMeta } = rawMeta;
              callbackNotifier.notifyHumanNeeded(
                job.id,
                job.callback_url,
                {
                  type: actionOpts.type,
                  screenshot_url: screenshotUrl,
                  page_url: pageUrl,
                  timeout_seconds: timeout,
                  description: actionOpts.description,
                  ...(hoistedQuestions ? { questions: hoistedQuestions } : {}),
                  metadata: remainingMeta,
                },
                job.valet_task_id,
                this.workerId,
              ).catch(() => { /* non-fatal */ });
            }

            logger.info('Handler suspended for manual action (legacy path)', {
              jobId: job.id,
              type: actionOpts.type,
              timeoutSeconds: timeout,
            });

            const result = await this.waitForResume(job.id, timeout);

            if (result.resumed) {
              await this.supabase
                .from('gh_automation_jobs')
                .update({
                  status: 'running',
                  paused_at: null,
                  status_message: 'Resumed after manual action',
                })
                .eq('id', job.id);

              await logEventFn('manual_action_resolved', {
                jobId: job.id,
                action_type: actionOpts.type,
              });

              if (job.callback_url) {
                callbackNotifier.notifyResumed(job.id, job.callback_url, job.valet_task_id, this.workerId)
                  .catch(() => { /* non-fatal */ });
              }

              logger.info('Handler resumed after manual action (legacy path)', { jobId: job.id });
            } else {
              logger.warn('Manual action timed out (legacy path)', { jobId: job.id, timeoutSeconds: timeout });
            }

            return {
              resumed: result.resumed,
              resolutionData: result.resolutionData as Record<string, unknown> | undefined,
            };
          },
        };

        try {
          logger.debug('[exec] Step 10: Calling handler.execute()', { jobId: job.id, handler: handler.type, attempt: crashRecoveryAttempts });
          taskResult = await Promise.race([
            handler.execute(ctx),
            this.createTimeout(timeoutMs),
          ]);
          logger.debug('[exec] Step 10: Handler returned', { jobId: job.id, success: taskResult?.success });
          break; // Success -- exit retry loop
        } catch (execError) {
          const execMsg = execError instanceof Error ? execError.message : String(execError);
          const isCrash = this.classifyError(execMsg) === 'browser_crashed'
            || !this.isBrowserAlive(adapter!);

          if (!isCrash || crashRecoveryAttempts >= MAX_CRASH_RECOVERIES) {
            throw execError; // Not a crash, or exhausted recovery attempts
          }

          crashRecoveryAttempts++;
          getLogger().warn('Browser crash detected', {
            jobId: job.id, attempt: crashRecoveryAttempts, maxAttempts: MAX_CRASH_RECOVERIES,
          });

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
              getLogger().warn('StagehandObserver re-attach failed after crash recovery', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
              observer = undefined;
            }
          }

          // Re-wire event handlers on the new adapter
          thoughtThrottle.reset();
          blockerState.lastCheckTime = Date.now();
          blockerState.consecutiveFailures = 0;
          blockerState.lastKnownUrl = job.target_url;

          this.wireAdapterEvents(adapter, {
            job, costTracker, progress, thoughtThrottle, blockerState, targetDomain,
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

      // Update final_mode and cost metadata
      // Map execution_mode to a valid final_mode value for the DB constraint.
      // Valid final_mode values: 'magnitude', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'
      const VALID_FINAL_MODES = new Set(['magnitude', 'hybrid', 'smart_apply', 'agent_apply', 'mastra']);
      const finalMode = (job.execution_mode && VALID_FINAL_MODES.has(job.execution_mode)) ? job.execution_mode : 'magnitude';
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          final_mode: finalMode,
          metadata: {
            ...(job.metadata || {}),
            cost_breakdown: {
              magnitude_steps: costTracker.getSnapshot().actionCount,
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
        getLogger().warn('Screenshot failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
          getLogger().warn('Session save failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // 12. Get final cost snapshot
      const finalCost = costTracker.getSnapshot();

      // 12.5. Save fresh session cookies back to DB after successful auth
      if (this.sessionManager) try {
        const freshState = await adapter.page.context().storageState();
        // Save Google session (use mail.google.com for consistency with session persistence test)
        await this.sessionManager.saveSession(
          job.user_id,
          'mail.google.com',
          freshState as unknown as Record<string, unknown>,
        );
        // Save target domain session
        const saveDomain = new URL(job.target_url).hostname;
        await this.sessionManager.saveSession(
          job.user_id,
          saveDomain,
          freshState as unknown as Record<string, unknown>,
        );
        getLogger().info('Saved fresh session cookies', { userId: job.user_id });
      } catch (err) {
        getLogger().warn('Session save failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }

      // 12.7. Flush page context report if wired
      if (pageContext) {
        try {
          await pageContext.flushToSupabase();
          contextAlreadyFlushed = true;
        } catch (err) {
          getLogger().warn('Page context flush failed (non-fatal)', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
          // Mark as pending so a future backfill can pick it up
          await pageContext.markFlushPending(err instanceof Error ? err.message : String(err)).catch(() => {});
        }
      }

      // 13. Handle awaiting_review vs completed
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
            status: 'awaiting_review',
            result_data: resultData,
            result_summary: 'Application filled — waiting for user to review and submit',
            screenshot_urls: screenshotUrls,
            llm_cost_cents: Math.round(finalCost.totalCost * 100),
            action_count: finalCost.actionCount,
            total_tokens: finalCost.inputTokens + finalCost.outputTokens,
          })
          .eq('id', job.id);

        await this.logJobEvent(job.id, 'awaiting_review', {
          handler: handler.type,
          action_count: finalCost.actionCount,
          total_tokens: finalCost.inputTokens + finalCost.outputTokens,
          cost_cents: Math.round(finalCost.totalCost * 100),
        });

        await costService.recordJobCost(job.user_id, job.id, finalCost).catch((err) => {
          getLogger().warn('Failed to record cost', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        });

        getLogger().info('Job awaiting user review', { jobId: job.id, actionCount: finalCost.actionCount, costUsd: finalCost.totalCost });

        // Keep heartbeat running and browser open — wait indefinitely
        // The worker process must stay alive for the browser to remain open
        getLogger().info('Browser is open for manual review, heartbeat continues');
        getLogger().info('Press Ctrl+C to shut down the worker when done');

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
        magnitude_steps: finalCost.actionCount,
      });

      // 14. Record cost against user's monthly usage (best-effort, don't fail the job)
      await costService.recordJobCost(job.user_id, job.id, finalCost).catch((err) => {
        getLogger().warn('Failed to record cost', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
      });

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
          getLogger().warn('Callback notification failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        });
      }

      getLogger().info('Job completed via handler', { jobId: job.id, handler: handler.type, actionCount: finalCost.actionCount, totalTokens: finalCost.inputTokens + finalCost.outputTokens, costUsd: finalCost.totalCost });
    } catch (error: unknown) {
      // Handle external cancellation (heartbeat detected cancelled status)
      if (this._cancelled) {
        getLogger().info('Job was cancelled by user', { jobId: job.id });
        await progress.setStep(ProgressStep.FAILED);
        await progress.flush();
        const snapshot = costTracker.getSnapshot();
        await costService.recordJobCost(job.user_id, job.id, snapshot).catch(() => {});
        if (job.callback_url) {
          callbackNotifier.notifyFromJob({
            id: job.id,
            valet_task_id: job.valet_task_id,
            callback_url: job.callback_url,
            status: 'cancelled',
            worker_id: this.workerId,
            llm_cost_cents: Math.round(snapshot.totalCost * 100),
            action_count: snapshot.actionCount,
            total_tokens: snapshot.inputTokens + snapshot.outputTokens,
          }).catch(() => {});
        }
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = this.classifyError(errorMessage);

      // Attempt HITL pause for eligible errors (captcha/login) when adapter is available
      if (adapter && HITL_ELIGIBLE_ERRORS.has(errorCode)) {
        try {
          // Use checkForBlockers for proper detect → pause → verify flow
          const stillBlocked = await this.checkForBlockers(job, adapter, costTracker);
          if (!stillBlocked) {
            const inferredBlockerType = this.mapErrorCodeToBlockerType(errorCode);
            if (inferredBlockerType) {
              const recoveryState = this.getHitlRecoveryState(job);
              const allowAutoRecoverAuth = this.canAutoRecoverAuth(job);
              const hasCodeEntryPath = inferredBlockerType === '2fa'
                ? await this.hasVisibleVerificationInput(adapter)
                : undefined;
              const decision = decideHitlAction({
                blockerType: inferredBlockerType,
                confidence: 0.9,
                attemptsByType: recoveryState.attemptsByType,
                hasCodeEntryPath,
                allowAutoRecoverAuth,
              });

              if (decision.action === 'AUTO_RECOVER' && isRecoverableAuthBlocker(inferredBlockerType)) {
                const attemptsBefore = getHitlAttemptsForType(recoveryState.attemptsByType, inferredBlockerType);
                const alreadyRecordedThisCycle =
                  recoveryState.lastDecision === 'AUTO_RECOVER' && attemptsBefore > 0;
                let effectiveAttempt = attemptsBefore;

                if (!alreadyRecordedThisCycle && attemptsBefore === 0) {
                  await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_STARTED, {
                    blocker_type: inferredBlockerType,
                    source: 'error_fallback',
                  });
                }

                if (!alreadyRecordedThisCycle) {
                  const attemptsAfter = incrementHitlAttempt(
                    recoveryState.attemptsByType,
                    inferredBlockerType,
                  );
                  effectiveAttempt = attemptsAfter[inferredBlockerType] || 1;
                  await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_ATTEMPTED, {
                    blocker_type: inferredBlockerType,
                    attempt: effectiveAttempt,
                    attempts_remaining: decision.attemptsRemaining ?? 0,
                    source: 'error_fallback',
                    reason: errorMessage,
                  });
                  await this.persistHitlRecoveryState(job, {
                    attemptsByType: attemptsAfter,
                    lastDecision: decision.action,
                  });
                }

                const backoffSeconds = Math.min(20, 5 * Math.max(1, effectiveAttempt));
                const scheduledAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
                await this.supabase
                  .from('gh_automation_jobs')
                  .update({
                    status: 'pending',
                    worker_id: null,
                    scheduled_at: scheduledAt,
                    error_code: errorCode,
                    error_details: {
                      message: errorMessage,
                      auth_recovery: true,
                      blocker_type: inferredBlockerType,
                      attempt: effectiveAttempt,
                      backoff_seconds: backoffSeconds,
                    },
                  })
                  .eq('id', job.id);

                const hitlSnapshot = costTracker.getSnapshot();
                await costService.recordJobCost(job.user_id, job.id, hitlSnapshot).catch((err) => {
                  getLogger().warn('Failed to record auth-recovery partial cost', {
                    jobId: job.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
                getLogger().info('Re-queued job for auth auto-recovery', {
                  jobId: job.id,
                  blockerType: inferredBlockerType,
                  scheduledAt,
                });
                return;
              }

              if (decision.reason === 'auth_recovery_exhausted') {
                await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_EXHAUSTED, {
                  blocker_type: inferredBlockerType,
                  source: 'error_fallback',
                  attempts_by_type: recoveryState.attemptsByType,
                });
              }

              if (decision.action === 'IMMEDIATE_HITL') {
                const resumed = await this.requestHumanIntervention(job, adapter, {
                  type: inferredBlockerType,
                  confidence: 0.9,
                  details: errorMessage,
                  source: 'dom',
                }, costTracker);
                if (resumed) {
                  const hitlSnapshot = costTracker.getSnapshot();
                  await costService.recordJobCost(job.user_id, job.id, hitlSnapshot).catch((err) => {
                    getLogger().warn('Failed to record HITL partial cost', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
                  });
                  getLogger().info('Job resumed after HITL intervention', { jobId: job.id });
                  return;
                }
              }
            }
          } else {
            // checkForBlockers handled the HITL flow but the blocker couldn't be resolved
            getLogger().warn('Job blocked and HITL could not resolve', { jobId: job.id });
          }
        } catch (hitlErr) {
          getLogger().warn('HITL intervention failed', { jobId: job.id, error: hitlErr instanceof Error ? hitlErr.message : String(hitlErr) });
          // Fall through to normal error handling
        }
      }

      await progress.setStep(ProgressStep.FAILED);
      await progress.flush();
      const snapshot = costTracker.getSnapshot();
      await this.handleJobError({
        job,
        error,
        actionCount: snapshot.actionCount,
        totalTokens: snapshot.inputTokens + snapshot.outputTokens,
        totalCost: snapshot.totalCost,
        ...(pageContext && { pageContext, contextFlushed: contextAlreadyFlushed }),
      });

      // Always record cost on failure (even zero cost for consistent accounting)
      await costService.recordJobCost(job.user_id, job.id, snapshot).catch((err) => {
        getLogger().warn('Failed to record cost', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
          getLogger().warn('Callback notification failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
        });
      }
    } finally {
      clearInterval(heartbeat);
      this._activeAdapter = null;
      this._executionAttemptId = null;
      if (blockerCheckInterval) clearInterval(blockerCheckInterval);
      // Clean up cancel LISTEN subscription (EC2)
      if (cancelListenClient) {
        try {
          await cancelListenClient.query(`UNLISTEN "gh_job_cancel_${job.id}"`);
          cancelListenClient.release();
        } catch { /* connection may already be closed */ }
      }
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
      // Remove filechooser listener
      if (fileChooserHandler && adapter) {
        try { adapter.page.off('filechooser', fileChooserHandler); } catch { /* page may be closed */ }
      }
      if (emailVerification) {
        try {
          await emailVerification.close?.();
        } catch {
          // Non-fatal cleanup.
        }
      }
      // Clean up downloaded resume file
      if (resumeFilePath) {
        this.resumeDownloader.cleanup(resumeFilePath).catch((err) => {
          logger.warn('Resume cleanup failed', { jobId: job.id, error: String(err) });
        });
      }
    }
  }

  /**
   * Execute a job using the Mastra workflow engine.
   * Implements PRD V5.2 Phase 1: wraps handler in a durable workflow
   * with suspend/resume for HITL blockers.
   */
  private async executeMastraWorkflow(opts: {
    job: AutomationJob;
    adapter: BrowserAutomationAdapter;
    handler: TaskHandler;
    costTracker: CostTracker;
    progress: ProgressTracker;
    credentials: Record<string, string> | null;
    dataPrompt: string;
    resumeFilePath: string | null;
    emailVerification?: EmailVerificationService | null;
    logEventFn: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
  }): Promise<void> {
    const {
      job,
      adapter,
      handler,
      costTracker,
      progress,
      credentials,
      dataPrompt,
      resumeFilePath,
      emailVerification,
      logEventFn,
    } = opts;
    const logger = getLogger({ service: 'mastra-executor' });
    const pageContext = new LivePageContextService(
      job.id,
      new RedisPageContextStore(this.redis, job.id),
      new SupabasePageContextFlusher(this.supabase),
    );
    progress.setPageContext(pageContext);

    // Build RuntimeContext (closure-injected, never serialized)
    const rt: RuntimeContext = {
      job,
      handler,
      adapter: adapter as any, // HitlCapableAdapter
      costTracker,
      progress,
      credentials,
      dataPrompt,
      resumeFilePath,
      emailVerification: emailVerification || undefined,
      pageContext,
      supabase: this.supabase,
      logEvent: logEventFn,
      workerId: this.workerId,
      uploadScreenshot: (jid: string, name: string, buf: Buffer) => this.uploadScreenshot(jid, name, buf),

      // Allow handlers to pause mid-execution for manual user actions (email verification, etc.)
      waitForManualAction: async (actionOpts) => {
        const timeout = actionOpts.timeoutSeconds ?? this.hitlTimeoutSeconds;

        // 1. Take screenshot of the current page state
        let screenshotUrl: string | undefined;
        try {
          const buf = await adapter.screenshot();
          screenshotUrl = await this.uploadScreenshot(job.id, 'manual-action', buf);
        } catch { /* non-fatal */ }

        const pageUrl = await adapter.getCurrentUrl().catch(() => job.target_url);

        // 2. Update job to 'paused' with interaction_data
        await this.supabase
          .from('gh_automation_jobs')
          .update({
            status: 'paused',
            interaction_type: actionOpts.type,
            interaction_data: {
              type: actionOpts.type,
              description: actionOpts.description,
              metadata: actionOpts.metadata || null,
              screenshot_url: screenshotUrl,
              page_url: pageUrl,
              detected_at: new Date().toISOString(),
            },
            paused_at: new Date().toISOString(),
            status_message: `Waiting for human: ${actionOpts.description}`,
          })
          .eq('id', job.id);

        // 3. Log event + notify VALET
        await logEventFn('manual_action_required', {
          jobId: job.id,
          action_type: actionOpts.type,
          description: actionOpts.description,
        });

        if (job.callback_url) {
          // Hoist questions out of metadata to top-level interaction for VALET
          const rawMeta = (actionOpts.metadata || {}) as Record<string, any>;
          const { questions: hoistedQuestions, ...remainingMeta } = rawMeta;
          callbackNotifier.notifyHumanNeeded(
            job.id,
            job.callback_url,
            {
              type: actionOpts.type,
              screenshot_url: screenshotUrl,
              page_url: pageUrl,
              timeout_seconds: timeout,
              description: actionOpts.description,
              ...(hoistedQuestions ? { questions: hoistedQuestions } : {}),
              metadata: remainingMeta,
            },
            job.valet_task_id,
            this.workerId,
          ).catch(() => { /* non-fatal */ });
        }

        logger.info('Handler suspended for manual action', {
          jobId: job.id,
          type: actionOpts.type,
          timeoutSeconds: timeout,
        });

        // 4. Wait for resume signal (reuses existing LISTEN/NOTIFY infrastructure)
        const result = await this.waitForResume(job.id, timeout);

        if (result.resumed) {
          // 5. Update back to running
          await this.supabase
            .from('gh_automation_jobs')
            .update({
              status: 'running',
              paused_at: null,
              status_message: 'Resumed after manual action',
            })
            .eq('id', job.id);

          await logEventFn('manual_action_resolved', {
            jobId: job.id,
            action_type: actionOpts.type,
          });

          if (job.callback_url) {
            callbackNotifier.notifyResumed(job.id, job.callback_url, job.valet_task_id, this.workerId)
              .catch(() => { /* non-fatal */ });
          }

          logger.info('Handler resumed after manual action', { jobId: job.id });
        } else {
          logger.warn('Manual action timed out', { jobId: job.id, timeoutSeconds: timeout });
        }

        return {
          resumed: result.resumed,
          resolutionData: result.resolutionData as Record<string, unknown> | undefined,
        };
      },
    };

    // Build the workflow (per-job, captures rt via closure)
    const workflow = buildApplyWorkflow(rt);
    const mastra = getMastra();

    if (!mastra) {
      const failMsg = 'Mastra workflows are not available in desktop mode (no DATABASE_URL)';
      logger.warn(failMsg, { jobId: job.id });

      await this.updateJobStatus(job.id, 'failed', failMsg);
      await this.logJobEvent(job.id, 'mastra_unavailable', { message: failMsg });
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_code: 'mastra_unavailable',
          error_details: { message: failMsg },
          llm_cost_cents: 0,
          action_count: 0,
          total_tokens: 0,
        })
        .eq('id', job.id);

      if (job.callback_url) {
        callbackNotifier.notifyFromJob({
          id: job.id,
          valet_task_id: job.valet_task_id,
          callback_url: job.callback_url,
          status: 'failed',
          worker_id: this.workerId,
          error_code: 'mastra_unavailable',
          error_details: { message: failMsg },
          llm_cost_cents: 0,
          action_count: 0,
          total_tokens: 0,
        }).catch((err) => {
          logger.warn('Mastra unavailable failure callback failed', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }

    // Register workflow with Mastra for this execution.
    // Use per-job key to avoid addWorkflow's silent skip on duplicate keys
    // (a new workflow is built per job with a unique RuntimeContext closure).
    const workflowKey = `gh_apply_${job.id}`;
    mastra.addWorkflow(workflow, workflowKey);
    const registeredWf = mastra.getWorkflow(workflowKey);

    // Check if this is a resume or a fresh execution
    const isResume = isMastraResume(job);

    let result: any;
    let run: any;

    if (isResume) {
      // --- RESUME PATH ---
      logger.info('Mastra resume path', { jobId: job.id, runId: job.metadata.mastra_run_id });

      // Atomically claim the resume
      const claimed = this.pgPool
        ? await claimResume(this.pgPool, job.id, job.metadata.mastra_run_id)
        : null;

      if (!claimed) {
        logger.warn('Resume claim failed (already claimed or preconditions not met)', { jobId: job.id });
        return;
      }

      // Read resolution type (non-destructive) — the workflow step handles
      // the full read-and-clear of credentials via readAndClearResolutionData.
      // We must NOT call readResolutionData here as it would clear the
      // credentials before the workflow step can inject them into the browser.
      let resolutionType = 'manual';
      const { data: interactionRow } = await this.supabase
        .from('gh_automation_jobs')
        .select('interaction_data')
        .eq('id', job.id)
        .single();
      if (interactionRow?.interaction_data?.resolution_type) {
        resolutionType = interactionRow.interaction_data.resolution_type;
      }

      run = await registeredWf.createRun({ runId: job.metadata.mastra_run_id });
      await pageContext.initializeRun(run.runId);
      result = await run.resume({
        step: 'check_blockers_checkpoint',
        resumeData: {
          resolutionType,
          resumeNonce: job.metadata.resume_nonce || crypto.randomUUID(),
        },
      });
    } else {
      // --- FRESH EXECUTION PATH ---
      // Per PRD AD-6: reuse existing mastra_run_id if one exists (re-entry after
      // worker crash). Only generate a new run ID when there is no existing one.
      const existingRunId = job.metadata?.mastra_run_id;

      if (typeof existingRunId === 'string') {
        // Re-entry: a previous execution created this run ID but didn't complete.
        logger.info('Reusing existing mastra_run_id for re-entry', { jobId: job.id, runId: existingRunId });
        try {
          run = await registeredWf.createRun({ runId: existingRunId });
        } catch (reuseErr) {
          // Corruption path: existing run state is unrecoverable.
          // Per PRD AD-6, create a new run and mark as recreated.
          logger.warn('Failed to reuse existing run, creating new (corruption recovery)', {
            jobId: job.id,
            existingRunId,
            error: reuseErr instanceof Error ? reuseErr.message : String(reuseErr),
          });
          run = await registeredWf.createRun();
          job.metadata = {
            ...job.metadata,
            mastra_run_id: run.runId,
            mastra_run_recreated: true,
          };
          if (this.pgPool) {
            await persistMastraRunId(this.pgPool, job.id, run.runId, { mastra_run_recreated: true });
          }
          await logEventFn('context_lost', {
            jobId: job.id,
            reason: 'mastra_run_recreated',
            previousRunId: existingRunId,
            newRunId: run.runId,
          });
        }
      } else {
        // Truly fresh: no existing run ID
        run = await registeredWf.createRun();
        if (this.pgPool) {
          await persistMastraRunId(this.pgPool, job.id, run.runId);
        }
        job.metadata = { ...job.metadata, mastra_run_id: run.runId };
      }

      await pageContext.initializeRun(run.runId);
      logger.info('Mastra fresh execution', { jobId: job.id, runId: run.runId });

      const initialState = workflowState.parse({
        jobId: job.id,
        userId: job.user_id,
        targetUrl: job.target_url,
        platform: job.metadata?.platform || 'other',
        qualityPreset: resolveQualityPreset(job.input_data, job.metadata),
        budgetUsd: costTracker.getRemainingBudget(),
        handler: {},
        hitl: {},
        metrics: {},
      });

      result = await run.start({ inputData: initialState });
    }

    // --- HITL WAIT LOOP ---
    // When the workflow suspends for HITL, keep the browser alive and wait
    // for the user to resolve the blocker (via LISTEN/NOTIFY or polling).
    // Once resolved, resume the Mastra workflow in-process with the same
    // browser session — no context loss.
    const MAX_HITL_SUSPENSIONS = 3;
    let hitlAttempts = 0;

    while (result?.status === 'suspended' && hitlAttempts < MAX_HITL_SUSPENSIONS) {
      hitlAttempts++;
      logger.info('Workflow suspended for HITL, waiting for human resolution (browser stays open)', {
        jobId: job.id,
        attempt: hitlAttempts,
        maxAttempts: MAX_HITL_SUSPENSIONS,
        timeoutSeconds: this.hitlTimeoutSeconds,
      });

      // Wait for the job status to change to 'running' (human resolved the blocker)
      const resumeResult = await this.waitForResume(job.id, this.hitlTimeoutSeconds);

      if (!resumeResult.resumed) {
        // Timeout — fail the job
        logger.warn('HITL wait timed out, failing job', { jobId: job.id, timeoutSeconds: this.hitlTimeoutSeconds });
        await this.logJobEvent(job.id, JOB_EVENT_TYPES.HITL_TIMEOUT, { timeout_seconds: this.hitlTimeoutSeconds });
        await this.supabase
          .from('gh_automation_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_code: 'hitl_timeout',
            error_details: {
              message: `Human intervention timed out after ${this.hitlTimeoutSeconds}s`,
            },
          })
          .eq('id', job.id);
        return;
      }

      // Human resolved — resume the Mastra workflow in-process
      logger.info('HITL resolved, resuming workflow in-process', {
        jobId: job.id,
        resolutionType: resumeResult.resolutionType,
      });

      result = await run.resume({
        step: 'check_blockers_checkpoint',
        resumeData: {
          resolutionType: resumeResult.resolutionType || 'manual',
          resumeNonce: crypto.randomUUID(),
        },
      });
    }

    if (result?.status === 'suspended') {
      // Exhausted max HITL attempts
      logger.error('Max HITL suspension attempts exceeded', { jobId: job.id, attempts: hitlAttempts });
      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_code: 'hitl_max_attempts',
          error_details: { message: `Blocker persisted after ${hitlAttempts} HITL attempts` },
        })
        .eq('id', job.id);
      return;
    }

    logger.info('Mastra workflow completed', { jobId: job.id, status: result?.status });

    // --- FINALIZATION ---
    // The workflow returned; now we finalize based on the result status.
    // Finalization stays in JobExecutor (not inside the workflow) to avoid
    // duplicating the ~150 lines of finalization logic.

    // Extract the workflow state from the result.
    // Mastra may return the state directly as result.result, or wrapped inside
    // a StepResult (result.result.output), or keyed by step ID in result.steps.
    let finalState: WorkflowState | undefined;
    const raw = result?.result;

    if (raw && typeof raw === 'object' && 'handler' in raw) {
      // Direct: result.result IS the WorkflowState
      finalState = raw as WorkflowState;
    } else if (raw && typeof raw === 'object' && 'output' in raw && typeof raw.output === 'object' && raw.output && 'handler' in raw.output) {
      // Wrapped in StepResult: result.result.output is the WorkflowState
      finalState = raw.output as WorkflowState;
    } else if (result?.steps) {
      // Fallback: extract from individual step results
      const stepKeys = ['execute_handler'];
      for (const key of stepKeys) {
        const stepResult = (result.steps as Record<string, any>)[key];
        if (stepResult?.output && typeof stepResult.output === 'object' && 'handler' in stepResult.output) {
          finalState = stepResult.output as WorkflowState;
          break;
        }
      }
    }

    if (!finalState) {
      logger.error('Mastra workflow returned no extractable state', {
        jobId: job.id,
        resultStatus: result?.status,
        resultKeys: raw ? Object.keys(raw) : 'null',
        hasSteps: !!result?.steps,
        stepKeys: result?.steps ? Object.keys(result.steps) : [],
      });
      throw new Error('Mastra workflow returned no extractable state');
    }

    if (finalState.handler?.attempted && finalState.handler.taskResult) {
      const taskResult = finalState.handler.taskResult as any;
      // Map execution_mode to a valid final_mode value for the DB constraint.
      // Valid final_mode values: 'magnitude', 'hybrid', 'smart_apply', 'agent_apply', 'mastra'
      const VALID_FINAL_MODES = new Set(['magnitude', 'hybrid', 'smart_apply', 'agent_apply', 'mastra']);
      const finalMode = (job.execution_mode && VALID_FINAL_MODES.has(job.execution_mode)) ? job.execution_mode : 'magnitude';
      const engineResult = {
        success: false,
        mode: 'magnitude' as const,
        magnitudeSteps: costTracker.getSnapshot().actionCount,
      };

      // PRD V5.2: If handler failed, check if browser should stay open for
      // manual recovery (keepBrowserOpen=true) before routing to retry logic.
      if (!taskResult.success) {
        const awaitingManualRecovery =
          taskResult.awaitingUserReview === true || taskResult.keepBrowserOpen === true;

        if (awaitingManualRecovery) {
          // Browser stays open for manual recovery even on failure.
          // Use standard finalization (writes awaiting_review status).
          const { awaitingReview: isReviewing } = await finalizeHandlerResult({
            job,
            adapter,
            costTracker,
            progress,
            sessionManager: this.sessionManager,
            workerId: this.workerId,
            supabase: this.supabase,
            logEvent: logEventFn,
            uploadScreenshot: (jid, name, buf) => this.uploadScreenshot(jid, name, buf),
            pageContext,
            taskResult,
            finalMode,
            engineResult,
          });
          if (isReviewing) {
            logger.info('Browser open for manual review/recovery, heartbeat continues', { jobId: job.id });
            await new Promise<void>(() => {});
          }
          return;
        }

        // True failure — perform side effects then throw so the outer catch
        // runs handleJobError() with classification + retry + backoff.
        const sideEffects = await finalizeHandlerSideEffects({
          job,
          adapter,
          costTracker,
          progress,
          sessionManager: this.sessionManager,
          workerId: this.workerId,
          supabase: this.supabase,
          logEvent: logEventFn,
          uploadScreenshot: (jid, name, buf) => this.uploadScreenshot(jid, name, buf),
          pageContext,
          taskResult,
          finalMode,
          engineResult,
        });
        await this.handleJobError({
          job,
          error: new Error(taskResult.error || 'Handler returned success: false'),
          actionCount: sideEffects.finalCost.actionCount,
          totalTokens: sideEffects.finalCost.inputTokens + sideEffects.finalCost.outputTokens,
          totalCost: sideEffects.finalCost.totalCost,
          resultData: sideEffects.resultData,
          pageContext,
          contextFlushed: sideEffects.contextFlushed,
          currentMetadata: sideEffects.currentMetadata,
        });
        return;
      }

      // Handler succeeded (or awaiting review) — use standard finalization
      const { awaitingReview } = await finalizeHandlerResult({
        job,
        adapter,
        costTracker,
        progress,
        sessionManager: this.sessionManager,
        workerId: this.workerId,
        supabase: this.supabase,
        logEvent: logEventFn,
        uploadScreenshot: (jid, name, buf) => this.uploadScreenshot(jid, name, buf),
        pageContext,
        taskResult,
        finalMode,
        engineResult,
      });

      if (awaitingReview) {
        // Block indefinitely — browser stays open for user review
        logger.info('Browser is open for manual review, heartbeat continues', { jobId: job.id });
        await new Promise<void>(() => {});
      }
      return;
    }

    // Workflow completed but handler did not succeed — fail
    throw new Error(`Mastra workflow completed with unexpected state: ${finalState.status}`);
  }

  // --- Error handling ---

  private async handleJobError({
    job,
    error,
    actionCount,
    totalTokens,
    totalCost,
    resultData,
    pageContext,
    contextFlushed,
    currentMetadata: incomingMetadata,
  }: HandleJobErrorInput): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = this.classifyError(errorMessage);

    getLogger().error('Job failed', { jobId: job.id, errorCode, errorMessage });

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

      getLogger().info('Job re-queued for retry', { jobId: job.id, retryCount: job.retry_count + 1, maxRetries: job.max_retries, backoffSeconds });
    } else {
      let finalResultData = resultData;
      let flushFailed = false;
      // Only flush if finalizeHandlerSideEffects hasn't already flushed
      if (pageContext && !contextFlushed) {
        try {
          const report = await pageContext.flushToSupabase();
          finalResultData = {
            ...(finalResultData || {}),
            context_report: serializeContextReport(report),
          };
        } catch (flushErr) {
          flushFailed = true;
          const message = flushErr instanceof Error ? flushErr.message : String(flushErr);
          await pageContext.markFlushPending(message).catch(() => {});
          await this.logJobEvent(job.id, 'page_context_flush_failed', { error: message }).catch(() => {});
          const pendingReport = await pageContext.getContextReport('pending').catch(() => undefined);
          if (pendingReport) {
            finalResultData = {
              ...(finalResultData || {}),
              context_report: serializeContextReport(pendingReport),
            };
          }
        }
      }

      await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_code: errorCode,
          error_details: { message: errorMessage },
          ...(finalResultData && { result_data: finalResultData }),
          ...(flushFailed && {
            metadata: { ...(incomingMetadata ?? job.metadata ?? {}), page_context_flush_pending: true },
          }),
          action_count: actionCount,
          total_tokens: totalTokens,
          llm_cost_cents: Math.round(totalCost * 100),
        })
        .eq('id', job.id);
    }
  }

  // --- Adapter Event Wiring ---

  /**
   * Wire adapter event handlers for cost tracking, progress, and blocker detection.
   * Used both for initial Magnitude-path setup and after crash recovery.
   */
  private wireAdapterEvents(
    adapter: BrowserAutomationAdapter,
    opts: {
      job: AutomationJob;
      costTracker: CostTracker;
      progress: ProgressTracker;
      thoughtThrottle: ThoughtThrottle;
      blockerState: { lastCheckTime: number; consecutiveFailures: number; lastKnownUrl: string };
      targetDomain: string;
    },
  ): void {
    const { job, costTracker, progress, thoughtThrottle, blockerState, targetDomain } = opts;

    adapter.on('thought', (thought: string) => {
      progress.recordThought(thought);
      if (thoughtThrottle.shouldEmit()) {
        this.logJobEvent(job.id, JOB_EVENT_TYPES.THOUGHT, {
          content: thought.slice(0, 500),
        });
      }
    });

    adapter.on('actionStarted', (action: { variant: string }) => {
      logger.debug('[magnitude] actionStarted', { variant: action.variant, jobId: job.id });
      blockerState.consecutiveFailures++;
      costTracker.recordAction(); // throws ActionLimitExceededError if over limit
      costTracker.recordModeStep();
      progress.onActionStarted(action.variant);
      this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_STARTED, {
        action: action.variant,
        action_count: costTracker.getSnapshot().actionCount,
      });

      // Fire-and-forget — never await in event handlers (blocks Magnitude's page.evaluate)
      if (blockerState.consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_BLOCKER_CHECK && adapter) {
        this.checkForBlockers(job, adapter, costTracker).catch(() => {});
      }
    });

    adapter.on('actionDone', (action: { variant: string }) => {
      logger.debug('[magnitude] actionDone', { variant: action.variant, jobId: job.id });
      progress.onActionDone(action.variant);
      blockerState.consecutiveFailures = 0;
      this.logJobEvent(job.id, JOB_EVENT_TYPES.STEP_COMPLETED, {
        action: action.variant,
        action_count: costTracker.getSnapshot().actionCount,
      });

      const now = Date.now();
      if (now - blockerState.lastCheckTime >= BLOCKER_CHECK_INTERVAL_MS) {
        blockerState.lastCheckTime = now;
        // Fire-and-forget — never await in event handlers (blocks Magnitude's page.evaluate)
        (async () => {
          try {
            const currentUrl = await adapter.getCurrentUrl();
            if (currentUrl !== blockerState.lastKnownUrl) {
              blockerState.lastKnownUrl = currentUrl;
              try {
                const currentDomain = new URL(currentUrl).hostname;
                if (currentDomain !== targetDomain) {
                  this.logJobEvent(job.id, JOB_EVENT_TYPES.URL_CHANGE_DETECTED, {
                    from_domain: targetDomain,
                    to_url: currentUrl,
                  });
                }
              } catch {
                // Invalid URL — skip domain comparison
              }
            }
            this.checkForBlockers(job, adapter, costTracker).catch(() => {});
          } catch {
            // Detection errors are non-fatal
          }
        })();
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
      getLogger().warn('Blocker detection failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    const recoveryState = this.getHitlRecoveryState(job);

    if (!blockerResult) {
      if (hasAnyHitlAttempts(recoveryState.attemptsByType) && recoveryState.lastDecision === 'AUTO_RECOVER') {
        await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_SUCCEEDED, {
          attempts_by_type: recoveryState.attemptsByType,
        });
        await this.clearHitlRecoveryState(job);
      }

      await this.logJobEvent(job.id, JOB_EVENT_TYPES.OBSERVATION_COMPLETED, {
        result: 'clear',
        url: currentUrl,
      });
      return false;
    }

    const allowAutoRecoverAuth = this.canAutoRecoverAuth(job);
    const hasCodeEntryPath = blockerResult.type === '2fa'
      ? await this.hasVisibleVerificationInput(adapter)
      : undefined;
    const decision = decideHitlAction({
      blockerType: blockerResult.type,
      confidence: blockerResult.confidence,
      source: blockerResult.source,
      selector: blockerResult.selector,
      attemptsByType: recoveryState.attemptsByType,
      hasCodeEntryPath,
      allowAutoRecoverAuth,
    });

    await this.logJobEvent(job.id, JOB_EVENT_TYPES.OBSERVATION_COMPLETED, {
      result: 'blocker',
      blocker_type: blockerResult.type,
      confidence: blockerResult.confidence,
      decision: decision.action,
      url: currentUrl,
    });

    if (decision.action === 'NO_ACTION' || decision.action === 'RETRY_NO_HITL') {
      if (decision.action === 'RETRY_NO_HITL') {
        await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_ATTEMPTED, {
          blocker_type: blockerResult.type,
          decision: decision.action,
          reason: decision.reason,
        });
      }
      if (recoveryState.lastDecision !== decision.action) {
        await this.persistHitlRecoveryState(job, {
          attemptsByType: recoveryState.attemptsByType,
          lastDecision: decision.action,
        });
      }
      return false;
    }

    if (decision.action === 'AUTO_RECOVER' && isRecoverableAuthBlocker(blockerResult.type)) {
      const attemptsBefore = getHitlAttemptsForType(recoveryState.attemptsByType, blockerResult.type);
      const attemptsAfter = incrementHitlAttempt(recoveryState.attemptsByType, blockerResult.type);
      if (attemptsBefore === 0) {
        await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_STARTED, {
          blocker_type: blockerResult.type,
        });
      }
      await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_ATTEMPTED, {
        blocker_type: blockerResult.type,
        confidence: blockerResult.confidence,
        attempt: attemptsAfter[blockerResult.type],
        attempts_remaining: decision.attemptsRemaining ?? 0,
        reason: decision.reason,
      });
      await this.persistHitlRecoveryState(job, {
        attemptsByType: attemptsAfter,
        lastDecision: decision.action,
      });
      return false;
    }

    if (decision.reason === 'auth_recovery_exhausted') {
      await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_RECOVERY_EXHAUSTED, {
        blocker_type: blockerResult.type,
        confidence: blockerResult.confidence,
        attempts_by_type: recoveryState.attemptsByType,
      });
    }

    // Blocker detected — emit event and trigger HITL
    await this.logJobEvent(job.id, JOB_EVENT_TYPES.BLOCKER_DETECTED, {
      blocker_type: blockerResult.type,
      confidence: blockerResult.confidence,
      source: blockerResult.source,
      selector: blockerResult.selector,
      details: blockerResult.details,
    });

    await this.persistHitlRecoveryState(job, {
      attemptsByType: recoveryState.attemptsByType,
      lastDecision: decision.action,
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

        if (!stillBlocked) {
          await this.clearHitlRecoveryState(job);
          return false;
        }

        const postResumeHasCodeEntryPath = stillBlocked.type === '2fa'
          ? await this.hasVisibleVerificationInput(adapter)
          : undefined;
        const postResumeDecision = decideHitlAction({
          blockerType: stillBlocked.type,
          confidence: stillBlocked.confidence,
          source: stillBlocked.source,
          selector: stillBlocked.selector,
          attemptsByType: this.getHitlRecoveryState(job).attemptsByType,
          hasCodeEntryPath: postResumeHasCodeEntryPath,
          allowAutoRecoverAuth,
        });

        if (postResumeDecision.action !== 'IMMEDIATE_HITL') {
          await this.clearHitlRecoveryState(job);
          return false;
        }

        getLogger().warn('Job still blocked after resume', {
          jobId: job.id, attempt, maxAttempts: MAX_POST_RESUME_CHECKS,
          blockerType: stillBlocked.type, confidence: stillBlocked.confidence,
        });

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
      getLogger().warn('HITL screenshot failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
        getLogger().warn('HITL callback failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
          getLogger().warn('Resume callback failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
      getLogger().warn('PG LISTEN failed, falling back to polling', { jobId, error: err instanceof Error ? err.message : String(err) });
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
      getLogger().warn('Failed to read resolution data', { jobId, error: err instanceof Error ? err.message : String(err) });
      // Still resumed, just without resolution data
      return { resumed: true, resolutionType: 'manual' };
    }
  }

  // --- Heartbeat ---

  private startHeartbeat(jobId: string): ReturnType<typeof setInterval> {
    let consecutiveFailures = 0;

    return setInterval(async () => {
      try {
        const { data } = await this.supabase
          .from('gh_automation_jobs')
          .update({ last_heartbeat: new Date().toISOString() })
          .eq('id', jobId)
          .select('status, execution_attempt_id')
          .single();

        // Heartbeat succeeded — reset failure counter (EC8)
        consecutiveFailures = 0;

        // Detect external cancellation (e.g. user clicked cancel in VALET)
        if (data?.status === 'cancelled') {
          getLogger().info('Job cancelled externally, stopping execution', { jobId });
          this._cancelled = true;
          if (this._activeAdapter) {
            try { await this._activeAdapter.stop(); } catch { /* adapter may already be stopped */ }
          }
        }

        // EC3: Verify execution_attempt_id — another worker may have taken over
        if (
          this._executionAttemptId &&
          data?.execution_attempt_id &&
          data.execution_attempt_id !== this._executionAttemptId
        ) {
          getLogger().warn('Execution attempt ID mismatch — another worker has claimed this job', {
            jobId,
            ours: this._executionAttemptId,
            theirs: data.execution_attempt_id,
          });
          this._cancelled = true;
          if (this._activeAdapter) {
            try { await this._activeAdapter.stop(); } catch { /* adapter may already be stopped */ }
          }
        }
      } catch (err) {
        // EC8: Track consecutive heartbeat failures
        consecutiveFailures++;
        getLogger().warn('Heartbeat failed', {
          jobId,
          consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        });

        if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) {
          getLogger().error('Aborting job after consecutive heartbeat failures', {
            jobId,
            consecutiveFailures,
            maxAllowed: MAX_HEARTBEAT_FAILURES,
          });
          this._cancelled = true;
          if (this._activeAdapter) {
            try { await this._activeAdapter.stop(); } catch { /* adapter may already be stopped */ }
          }
        }
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
      getLogger().warn('Event log failed', { eventType, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // --- Resume profile enrichment ---

  /**
   * If the job has no user_data, attempt to load it from VALET's `resumes` table.
   * Also sets up resume_ref from the resume's file_key if not already provided.
   * This is backwards-compatible: if user_data is already present, this is a no-op.
   */
  private async enrichJobFromResumeProfile(job: AutomationJob): Promise<void> {
    const hasUserData = job.input_data.user_data
      && typeof job.input_data.user_data === 'object'
      && Object.keys(job.input_data.user_data).length > 0;

    if (hasUserData) return;

    try {
      const loader = new ResumeProfileLoader(this.supabase);
      const result = await loader.loadForUser(job.user_id);

      job.input_data.user_data = result.profile;

      if (!job.resume_ref && result.fileKey) {
        (job as any).resume_ref = { storage_path: result.fileKey };
      }

      await this.logJobEvent(job.id, 'resume_profile_loaded', {
        resume_id: result.resumeId,
        user_id: result.userId,
        confidence: result.parsingConfidence,
      });

      getLogger().info('Auto-populated user_data from VALET resumes table', {
        jobId: job.id,
        resumeId: result.resumeId,
      });
    } catch (err) {
      getLogger().warn('Failed to auto-populate user_data from resumes table', {
        jobId: job.id,
        userId: job.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
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

  // --- Resume resolution ---

  /**
   * Resolve the resume reference from the job.
   * Checks: job.resume_ref (DB column), metadata.resume_ref (backup), input_data.resume_path.
   * Returns null if no resume or empty/invalid reference.
   */
  private resolveResumeRef(job: AutomationJob): ResumeRef | null {
    // 1. Direct column (preferred)
    const directRef = job.resume_ref;
    if (directRef && typeof directRef === 'object') {
      const ref = directRef as ResumeRef;
      if (ref.storage_path || ref.download_url || ref.s3_key) {
        return ref;
      }
    }

    // 2. Backup in metadata
    const metaRef = job.metadata?.resume_ref;
    if (metaRef && typeof metaRef === 'object') {
      const ref = metaRef as ResumeRef;
      if (ref.storage_path || ref.download_url || ref.s3_key) {
        return ref;
      }
    }

    // 3. Legacy: input_data.resume_path as a download_url or storage_path
    const legacyPath = job.input_data?.resume_path;
    if (legacyPath && typeof legacyPath === 'string' && legacyPath.trim() !== '') {
      if (legacyPath.startsWith('http://') || legacyPath.startsWith('https://')) {
        return { download_url: legacyPath };
      }
      return { storage_path: legacyPath };
    }

    return null;
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

    for (const selector of VERIFICATION_INPUT_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.fill(code);
          getLogger().debug('Injected 2FA code via selector', { selector });
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
    getLogger().warn('Could not find 2FA code input field, resuming without injection');
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
            getLogger().debug('Injected username via selector', { selector: sel });
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
            getLogger().debug('Injected password via selector', { selector: sel });
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
    return classifyError(message);
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
      getLogger().error('Crash recovery failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
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
