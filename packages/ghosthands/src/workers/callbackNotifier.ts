/**
 * CallbackNotifier - Sends job results to VALET callback URLs
 *
 * After a job completes or fails, if a callback_url was provided,
 * POST the results back to VALET. Retries on failure (3 attempts).
 * Callback failures are logged but never fail the job.
 */

export interface InteractionInfo {
  type: string;
  screenshot_url?: string;
  page_url?: string;
  timeout_seconds?: number;
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
  manual?: {
    id: string | null;
    status: string;
    health_score: number | null;
    fallback_reason: string | null;
  } | null;
  cost_breakdown?: {
    total_cost_usd: number;
    action_count: number;
    total_tokens: number;
    cookbook_steps: number;
    magnitude_steps: number;
    cookbook_cost_usd: number;
    magnitude_cost_usd: number;
    image_cost_usd: number;
    reasoning_cost_usd: number;
  } | null;
  completed_at: string;
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
      completed_at: new Date().toISOString(),
    };

    if (job.status === 'completed') {
      payload.result_data = job.result_data;
      payload.result_summary = job.result_summary;
      payload.screenshot_url = job.screenshot_urls?.[0];
    } else {
      payload.error_code = job.error_code;
      payload.error_message = job.error_details?.message;
    }

    if (job.llm_cost_cents != null) {
      payload.cost = {
        total_cost_usd: job.llm_cost_cents / 100,
        action_count: job.action_count || 0,
        total_tokens: job.total_tokens || 0,
      };
    }

    // Sprint 3: Mode tracking fields
    const jobMeta = typeof job.metadata === 'object' ? (job.metadata || {}) : {};
    if (job.execution_mode) {
      payload.execution_mode = job.execution_mode;
    }
    if (job.browser_mode) {
      payload.browser_mode = job.browser_mode;
    }
    if (job.final_mode) {
      payload.final_mode = job.final_mode;
    }

    const engineMeta = jobMeta?.engine || {};
    if (engineMeta.manual_id) {
      payload.manual = {
        id: engineMeta.manual_id,
        status: engineMeta.manual_status || 'ai_only',
        health_score: engineMeta.health_score ?? null,
        fallback_reason: engineMeta.fallback_reason ?? null,
      };
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
    metadata?: { execution_mode?: string; manual_id?: string | null },
    workerId?: string,
  ): Promise<boolean> {
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'running',
      ...(workerId && { worker_id: workerId }),
      completed_at: new Date().toISOString(),
      ...(metadata?.execution_mode && { execution_mode: metadata.execution_mode }),
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
  ): Promise<boolean> {
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'needs_human',
      ...(workerId && { worker_id: workerId }),
      interaction: interactionData,
      completed_at: new Date().toISOString(),
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
  ): Promise<boolean> {
    const payload: CallbackPayload = {
      job_id: jobId,
      valet_task_id: valetTaskId || null,
      status: 'resumed',
      ...(workerId && { worker_id: workerId }),
      completed_at: new Date().toISOString(),
    };
    return this.sendWithRetry(callbackUrl, payload);
  }

  private async sendWithRetry(url: string, payload: CallbackPayload): Promise<boolean> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GhostHands-Callback/1.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          console.log(`[CallbackNotifier] Successfully notified ${url} for job ${payload.job_id}`);
          return true;
        }

        console.warn(
          `[CallbackNotifier] Callback returned ${response.status} for job ${payload.job_id} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      } catch (err) {
        console.warn(
          `[CallbackNotifier] Callback failed for job ${payload.job_id} (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
          err instanceof Error ? err.message : err
        );
      }

      // Wait before retry (except on last attempt)
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
      }
    }

    console.error(`[CallbackNotifier] All retry attempts exhausted for job ${payload.job_id} -> ${url}`);
    return false;
  }
}

/** Singleton instance */
export const callbackNotifier = new CallbackNotifier();
