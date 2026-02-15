import { SupabaseClient } from '@supabase/supabase-js';
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

// Re-export AutomationJob from the canonical location for backward compat
export type { AutomationJob } from './taskHandlers/types.js';
import type { AutomationJob } from './taskHandlers/types.js';

// --- Types ---

export interface JobExecutorOptions {
  supabase: SupabaseClient;
  workerId: string;
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

  constructor(opts: JobExecutorOptions) {
    this.supabase = opts.supabase;
    this.workerId = opts.workerId;
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

      // 6. Build LLM client config
      const llmClient = this.buildLLMClient(job);

      // 7. Create and start adapter
      const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
      adapter = createAdapter(adapterType);
      await adapter.start({
        url: job.target_url,
        llm: llmClient,
      });

      // 8. Register credentials if available
      if (credentials) {
        adapter.registerCredentials(credentials);
      }

      // 9. Wire up event tracking with cost control + progress
      await progress.setStep(ProgressStep.NAVIGATING);

      adapter.on('thought', (thought: string) => {
        progress.recordThought(thought);
      });

      adapter.on('actionStarted', (action: { variant: string }) => {
        costTracker.recordAction(); // throws ActionLimitExceededError if over limit
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

      // 10. Build TaskContext and delegate to handler
      const ctx: TaskContext = {
        job,
        adapter,
        costTracker,
        progress,
        credentials,
        dataPrompt,
      };

      const timeoutMs = job.timeout_seconds * 1000;
      await this.updateJobStatus(job.id, 'running', `Executing ${handler.type} handler`);

      const taskResult: TaskResult = await Promise.race([
        handler.execute(ctx),
        this.createTimeout(timeoutMs),
      ]);

      if (!taskResult.success) {
        throw new Error(taskResult.error || `Task handler '${handler.type}' returned failure`);
      }

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
        const errorMessage = error instanceof Error ? error.message : String(error);
        callbackNotifier.notifyFromJob({
          id: job.id,
          valet_task_id: job.valet_task_id,
          callback_url: job.callback_url,
          status: 'failed',
          error_code: this.classifyError(errorMessage),
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

  private buildLLMClient(job: AutomationJob): LLMConfig {
    const tier = job.input_data.tier || 'starter';

    // Premium tier forces Claude Sonnet
    if (tier === 'premium') {
      const resolved = loadModelConfig('claude-sonnet');
      return resolved.llmClient as LLMConfig;
    }

    // Use job-level model override, GH_MODEL env var, or config default
    const modelOverride = job.metadata?.model
      || process.env.GH_MODEL
      || process.env.GH_DEFAULT_MODEL;
    const resolved = loadModelConfig(modelOverride);
    return resolved.llmClient as LLMConfig;
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

  // --- Timeout ---

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Job execution timeout')), ms)
    );
  }
}
