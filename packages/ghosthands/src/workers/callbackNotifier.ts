/**
 * CallbackNotifier - Sends job results to VALET callback URLs
 *
 * After a job completes or fails, if a callback_url was provided,
 * POST the results back to VALET. Retries on failure (3 attempts).
 * Callback failures are logged but never fail the job.
 *
 * Dedupe: Each callback is guarded by an INSERT into gh_callback_dedupe.
 * If the INSERT conflicts (same job_id + event_type + nonce), the callback
 * is skipped. Fail-open on DB errors — callbacks are never blocked by dedupe
 * failures.
 */

import { getLogger } from '../monitoring/logger.js';
import { getSupabaseClient } from '../db/client.js';

export interface InteractionInfo {
  type: string;
  screenshot_url?: string;
  page_url?: string;
  timeout_seconds?: number;
  description?: string;
  message?: string;
  original_blocker_type?: string;
  metadata?: {
    blocker_confidence?: number;
    captcha_type?: string;
    detection_method?: string;
  };
}

export interface CallbackPayload {
  job_id: string;
  valet_task_id: string | null;
  status: 'completed' | 'failed' | 'needs_human' | 'resumed' | 'running';
  worker_id?: string;
  result_data?: Record<string, any>;
  result_summary?: string;
  screenshot_url?: string;
  error_code?: string;
  error_message?: string;
  interaction?: InteractionInfo;
  cost?: {
    total_cost_usd: number;
    action_count: number;
    total_tokens: number;
  };
  execution_mode?: string;
  browser_mode?: string;
  final_mode?: string;
  cost_breakdown?: {
    total_cost_usd: number;
    action_count: number;
    total_tokens: number;
    magnitude_steps: number;
    magnitude_cost_usd: number;
    image_cost_usd: number;
    reasoning_cost_usd: number;
  } | null;
  /** Kasm session URL for live browser view (WEK-162) */
  kasm_url?: string;
  completed_at?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 10000]; // 1s, 3s, 10s
const TIMEOUT_MS = 10_000;

export class CallbackNotifier {
  /**
   * Notify completion of a job.
   * Returns true if callback was successful, false if it failed after retries.
   * Never throws -- callback failure should not impact job status.
   */
  async notifyCompletion(callbackUrl: string, payload: CallbackPayload): Promise<boolean> {
    return this.sendWithRetry(callbackUrl, payload);
  }

  /**
   * Convenience: build payload from job row data and notify.
   */
  async notifyFromJob(job: {
    id: string;
    valet_task_id?: string | null;
    callback_url?: string | null;
    status: string;
    worker_id?: string;
    result_data?: Record<string, any>;
    result_summary?: string;
    screenshot_urls?: string[];
    error_code?: string;
    error_details?: { message?: string };
    llm_cost_cents?: number;
    action_count?: number;
    total_tokens?: number;
    execution_mode?: string;
    browser_mode?: string;
    final_mode?: string;
    metadata?: Record<string, any>;
  }): Promise<boolean> {
    if (!job.callback_url) return false;

    const payload: CallbackPayload = {
      job_id: job.id,
      valet_task_id: job.valet_task_id || null,
      status: job.status === 'completed' ? 'completed' : 'failed',
      ...(job.worker_id && { worker_id: job.worker_id }),
      ...((job.status === 'completed' || job.status === 'failed') && { completed_at: new Date().toISOString() }),
    };

    if (job.status === 'completed') {
      payload.result_data = job.result_data;
      payload.result_summary = job.result_summary;
      payload.screenshot_url = job.screenshot_urls?.[0];
    } else {
      payload.error_code = job.error_code;
      payload.error_message = job.error_details?.message;
    }

    // Always include cost data — even on failure (cost may be zero)
    payload.cost = {
      total_cost_usd: job.llm_cost_cents != null ? job.llm_cost_cents / 100 : 0,
      action_count: job.action_count || 0,
      total_tokens: job.total_tokens || 0,
    };

    // WEK-162: Include Kasm session URL if available (from job metadata or env)
    const jobMeta = typeof job.metadata === 'object' ? (job.metadata || {}) : {};
    const kasmUrl = jobMeta.kasm_session_url || jobMeta.kasm_url || process.env.KASM_SESSION_URL;
    if (kasmUrl) {
      payload.kasm_url = kasmUrl;
    }

    // Sprint 3: Mode tracking fields
    if (job.execution_mode) {
      payload.execution_mode = job.execution_mode;
    }
    if (job.browser_mode) {
      payload.browser_mode = job.browser_mode;
    }
    if (job.final_mode) {
      payload.final_mode = job.final_mode;
    }

    return this.sendWithRetry(job.callback_url, payload);
  }

  /**
   * Notify VALET that a job has started executing.
   */
  async notifyRunning(
    jobId: string,
    callbackUrl: string,
    valetTaskId?: string | null,
    metadata?: { execution_mode?: string; kasm_url?: string },
    workerId?: string,
  ): Promise<boolean> {
    const kasmUrl = metadata?.kasm_url || process.env.KASM_SESSION_URL;
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'running',
      ...(workerId && { worker_id: workerId }),
      ...(metadata?.execution_mode && { execution_mode: metadata.execution_mode }),
      ...(kasmUrl && { kasm_url: kasmUrl }),
    };
    return this.sendWithRetry(callbackUrl, payload);
  }

  /**
   * Notify VALET that a job needs human intervention.
   */
  async notifyHumanNeeded(
    jobId: string,
    callbackUrl: string,
    interactionData: InteractionInfo,
    valetTaskId?: string | null,
    workerId?: string,
    cost?: { total_cost_usd: number; action_count: number; total_tokens: number },
    kasmUrl?: string,
  ): Promise<boolean> {
    const resolvedKasmUrl = kasmUrl || process.env.KASM_SESSION_URL;
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'needs_human',
      ...(workerId && { worker_id: workerId }),
      interaction: interactionData,
      ...(cost && { cost }),
      ...(resolvedKasmUrl && { kasm_url: resolvedKasmUrl }),
    };
    return this.sendWithRetry(callbackUrl, payload);
  }

  /**
   * Notify VALET that a paused job has resumed.
   */
  async notifyResumed(
    jobId: string,
    callbackUrl: string,
    valetTaskId?: string | null,
    workerId?: string,
    kasmUrl?: string,
  ): Promise<boolean> {
    const resolvedKasmUrl = kasmUrl || process.env.KASM_SESSION_URL;
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'resumed',
      ...(workerId && { worker_id: workerId }),
      ...(resolvedKasmUrl && { kasm_url: resolvedKasmUrl }),
    };
    return this.sendWithRetry(callbackUrl, payload);
  }

  /**
   * Attempt to insert a dedupe record. Returns true if the insert succeeded
   * (first time), false if the row already exists (duplicate).
   * Returns true (proceed) on DB errors — fail-open to avoid blocking callbacks.
   */
  private async checkDedupe(jobId: string, eventType: string, nonce: string): Promise<boolean> {
    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase
        .from('gh_callback_dedupe')
        .insert({ job_id: jobId, event_type: eventType, nonce });

      if (error) {
        // Unique constraint violation = already sent
        if (error.code === '23505') {
          getLogger().debug('Callback dedupe: already sent', { jobId, eventType, nonce });
          return false;
        }
        // Other DB errors — fail open
        getLogger().warn('Callback dedupe check failed, proceeding', {
          jobId, eventType, error: error.message,
        });
        return true;
      }

      return true; // Insert succeeded, proceed with send
    } catch (err) {
      // Fail open — don't block callbacks on dedupe errors
      getLogger().warn('Callback dedupe exception, proceeding', {
        jobId, eventType,
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  private async sendWithRetry(url: string, payload: CallbackPayload): Promise<boolean> {
    const logger = getLogger();

    // Dedupe guard: skip if this callback has already been sent.
    // Nonce is deterministic so duplicate invocations collide on the PK
    // (job_id, event_type, nonce). Interaction type is included so that
    // legitimate re-sends (e.g. needs_human:captcha then needs_human:context_lost)
    // use different nonces and are not suppressed.
    const nonce = payload.interaction?.type
      ? `${payload.status}:${payload.interaction.type}`
      : payload.status;
    const shouldSend = await this.checkDedupe(payload.job_id, payload.status, nonce);
    if (!shouldSend) {
      logger.info('Callback skipped (dedupe)', { jobId: payload.job_id, status: payload.status });
      return true; // Already sent — treat as success
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const serviceSecret = process.env.GH_SERVICE_SECRET;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'GhostHands-Callback/1.0',
        };
        // Send auth via header (preferred) in addition to URL token (backward compat).
        // TODO: Remove URL token (?token=...) from callback URLs after VALET is updated
        // to authenticate callbacks via X-GH-Service-Key header instead.
        if (serviceSecret) {
          headers['X-GH-Service-Key'] = serviceSecret;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          logger.info('Callback notification succeeded', { url, jobId: payload.job_id });
          return true;
        }

        logger.warn('Callback returned non-OK status', {
          url, jobId: payload.job_id, status: response.status,
          attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1,
        });
      } catch (err) {
        logger.warn('Callback request failed', {
          jobId: payload.job_id, attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Wait before retry (except on last attempt)
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
      }
    }

    logger.error('All callback retry attempts exhausted', { jobId: payload.job_id, url });
    return false;
  }
}

/** Singleton instance */
export const callbackNotifier = new CallbackNotifier();
