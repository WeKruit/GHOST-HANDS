import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  RealtimeSubscriber,
  type JobSubscription,
  type SubscribeToJobOptions,
  type SubscribeToUserJobsOptions,
} from './realtimeSubscriber';
import {
  type ApiClientConfig,
  type AutomationJob,
  type BatchCreateResult,
  type CreateJobOptions,
  type CreateJobParams,
  type DbClientConfig,
  type GhostHandsClientConfig,
  type JobEvent,
  type JobStatusResponse,
  type ListJobsFilters,
  type PaginatedJobs,
  CANCELLABLE_STATUSES,
  TERMINAL_STATUSES,
  DuplicateIdempotencyKeyError,
  GhostHandsError,
  JobNotCancellableError,
  JobNotFoundError,
} from './types';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Normalise CreateJobParams (snake_case) or CreateJobOptions (camelCase) to API payload. */
function toApiPayload(
  params: CreateJobParams | CreateJobOptions,
  userId?: string,
): Record<string, unknown> {
  // Detect which shape we received
  if ('jobType' in params) {
    // camelCase CreateJobOptions -> snake_case API body
    const opts = params as CreateJobOptions;
    return {
      user_id: userId,
      job_type: opts.jobType,
      target_url: opts.targetUrl,
      task_description: opts.taskDescription,
      input_data: {
        resume_path: opts.inputData?.resumePath,
        resume_id: opts.inputData?.resumeId,
        user_data: opts.inputData?.userData,
        tier: opts.inputData?.tier,
        platform: opts.inputData?.platform,
        qa_overrides: opts.inputData?.qaOverrides,
      },
      priority: opts.priority ?? 5,
      scheduled_at: opts.scheduledAt ?? null,
      max_retries: opts.maxRetries ?? 3,
      timeout_seconds: opts.timeoutSeconds ?? 300,
      tags: opts.tags ?? [],
      idempotency_key: opts.idempotencyKey ?? null,
      metadata: opts.metadata ?? {},
    };
  }

  // snake_case CreateJobParams -- already close to API shape
  const p = params as CreateJobParams;
  return {
    user_id: p.user_id ?? userId,
    job_type: p.job_type ?? p.type ?? 'apply',
    target_url: p.target_url,
    task_description: p.task_description,
    input_data: p.input_data ?? {},
    priority: p.priority ?? 5,
    scheduled_at: p.scheduled_at ?? null,
    max_retries: p.max_retries ?? 3,
    timeout_seconds: p.timeout_seconds ?? 300,
    tags: p.tags ?? [],
    idempotency_key: p.idempotency_key ?? null,
    metadata: p.metadata ?? {},
  };
}

function toDbRow(userId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    user_id: userId,
    created_by: 'valet',
  };
}

// --------------------------------------------------------------------------
// GhostHandsClient
// --------------------------------------------------------------------------

/**
 * VALET client library for the GhostHands automation system.
 *
 * Supports two modes:
 *
 * **API mode** (default) -- talks to the GhostHands REST API via HTTP.
 * ```ts
 * const client = new GhostHandsClient(
 *   process.env.GHOSTHANDS_API_URL!,
 *   process.env.GHOSTHANDS_API_KEY!,
 * );
 * ```
 *
 * **DB mode** -- talks directly to Supabase (Channel 1 DB Queue).
 * ```ts
 * const client = new GhostHandsClient({
 *   mode: 'db',
 *   supabaseUrl: process.env.SUPABASE_URL!,
 *   supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
 * });
 * ```
 */
export class GhostHandsClient {
  private mode: 'api' | 'db';
  private apiUrl: string | null;
  private apiKey: string | null;
  private supabase: SupabaseClient | null;
  private realtime: RealtimeSubscriber | null;

  /**
   * Create a GhostHandsClient.
   *
   * @param apiUrlOrConfig - API base URL string, or a full config object.
   * @param apiKey - API key (only when first arg is a URL string).
   */
  constructor(apiUrlOrConfig: string | GhostHandsClientConfig, apiKey?: string) {
    if (typeof apiUrlOrConfig === 'string') {
      // Simple constructor: new GhostHandsClient(apiUrl, apiKey)
      this.mode = 'api';
      this.apiUrl = apiUrlOrConfig.replace(/\/+$/, '');
      this.apiKey = apiKey ?? null;
      this.supabase = null;
      this.realtime = null;
    } else if (apiUrlOrConfig.mode === 'db') {
      // DB mode
      const cfg = apiUrlOrConfig as DbClientConfig;
      this.mode = 'db';
      this.apiUrl = null;
      this.apiKey = null;
      this.supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
      this.realtime = new RealtimeSubscriber(this.supabase);
    } else {
      // API mode with config object
      const cfg = apiUrlOrConfig as ApiClientConfig;
      this.mode = 'api';
      this.apiUrl = cfg.apiUrl.replace(/\/+$/, '');
      this.apiKey = cfg.apiKey;
      // Optional Supabase for Realtime
      if (cfg.supabaseUrl && cfg.supabaseKey) {
        this.supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
        this.realtime = new RealtimeSubscriber(this.supabase);
      } else {
        this.supabase = null;
        this.realtime = null;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal HTTP helpers (API mode)
  // --------------------------------------------------------------------------

  private async fetch<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!this.apiUrl) {
      throw new GhostHandsError('API URL not configured', 'client_config', 500);
    }

    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'X-GH-Service-Key': this.apiKey } : {}),
      ...(init.headers as Record<string, string> ?? {}),
    };

    const res = await globalThis.fetch(url, { ...init, headers });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const code = body?.error ?? `http_${res.status}`;
      const message = body?.message ?? body?.error ?? res.statusText;

      // Map known error codes to typed errors
      if (res.status === 409 && code === 'duplicate_idempotency_key') {
        throw new DuplicateIdempotencyKeyError(
          body.existing_job_id,
          body.existing_status,
        );
      }
      if (res.status === 404) {
        throw new JobNotFoundError(path.split('/').pop() ?? 'unknown');
      }
      if (res.status === 409 && code === 'job_not_cancellable') {
        throw new JobNotCancellableError(
          path.split('/').at(-2) ?? 'unknown',
          body.current_status,
        );
      }

      throw new GhostHandsError(message, code, res.status, body?.details);
    }

    return body as T;
  }

  // --------------------------------------------------------------------------
  // Job CRUD
  // --------------------------------------------------------------------------

  /**
   * Create a new automation job.
   *
   * Accepts either snake_case `CreateJobParams` (matching the REST API) or
   * camelCase `CreateJobOptions` (convenience).
   *
   * In API mode the userId can be embedded in params.user_id.
   * In DB mode you must pass userId explicitly.
   */
  async createJob(
    paramsOrUserId: CreateJobParams | string,
    optionsOrUndefined?: CreateJobOptions | CreateJobParams,
  ): Promise<AutomationJob> {
    // Normalise the two calling conventions:
    //   createJob(params)           -- API style
    //   createJob(userId, options)  -- DB / convenience style
    let userId: string | undefined;
    let params: CreateJobParams | CreateJobOptions;

    if (typeof paramsOrUserId === 'string' && optionsOrUndefined) {
      userId = paramsOrUserId;
      params = optionsOrUndefined;
    } else if (typeof paramsOrUserId === 'object') {
      params = paramsOrUserId;
      userId = (paramsOrUserId as CreateJobParams).user_id;
    } else {
      throw new GhostHandsError(
        'createJob requires either (params) or (userId, options)',
        'invalid_args',
        400,
      );
    }

    const payload = toApiPayload(params, userId);

    if (this.mode === 'api') {
      return this.fetch<AutomationJob>('/jobs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    // DB mode -- insert directly
    const supabase = this.requireSupabase();
    const idempotencyKey = payload.idempotency_key as string | null;

    if (idempotencyKey) {
      const { data: existing } = await supabase
        .from('gh_automation_jobs')
        .select('id, status')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existing) {
        throw new DuplicateIdempotencyKeyError(existing.id, existing.status);
      }
    }

    const row = toDbRow(userId!, payload);
    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .insert(row)
      .select()
      .single();

    if (error) {
      if (error.code === '23505' && idempotencyKey) {
        const { data: existing } = await supabase
          .from('gh_automation_jobs')
          .select('id, status')
          .eq('idempotency_key', idempotencyKey)
          .single();
        if (existing) {
          throw new DuplicateIdempotencyKeyError(existing.id, existing.status);
        }
      }
      throw new GhostHandsError(error.message, error.code ?? 'unknown', 500);
    }

    return data as AutomationJob;
  }

  /**
   * Get the full job record by id.
   */
  async getJob(jobId: string): Promise<AutomationJob> {
    if (this.mode === 'api') {
      return this.fetch<AutomationJob>(`/jobs/${jobId}`);
    }

    const supabase = this.requireSupabase();
    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .select()
      .eq('id', jobId)
      .single();

    if (error || !data) throw new JobNotFoundError(jobId);
    return data as AutomationJob;
  }

  /**
   * Get lightweight status-only payload for a job.
   */
  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    if (this.mode === 'api') {
      return this.fetch<JobStatusResponse>(`/jobs/${jobId}/status`);
    }

    const supabase = this.requireSupabase();
    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .select('id, status, status_message, started_at, last_heartbeat, completed_at')
      .eq('id', jobId)
      .single();

    if (error || !data) throw new JobNotFoundError(jobId);

    return {
      id: data.id,
      status: data.status,
      status_message: data.status_message,
      progress_pct: null,
      started_at: data.started_at,
      last_heartbeat: data.last_heartbeat,
      estimated_completion: null,
    } as JobStatusResponse;
  }

  /**
   * Cancel a pending, queued, running, or paused job.
   */
  async cancelJob(jobId: string): Promise<void> {
    if (this.mode === 'api') {
      await this.fetch(`/jobs/${jobId}/cancel`, { method: 'POST' });
      return;
    }

    const supabase = this.requireSupabase();
    const current = await this.getJob(jobId);
    if (!CANCELLABLE_STATUSES.has(current.status)) {
      throw new JobNotCancellableError(jobId, current.status);
    }

    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', [...CANCELLABLE_STATUSES])
      .select()
      .single();

    if (error || !data) {
      const refreshed = await this.getJob(jobId);
      throw new JobNotCancellableError(jobId, refreshed.status);
    }
  }

  /**
   * Re-queue a failed or cancelled job for another attempt.
   */
  async retryJob(jobId: string): Promise<AutomationJob> {
    if (this.mode === 'api') {
      return this.fetch<AutomationJob>(`/jobs/${jobId}/retry`, { method: 'POST' });
    }

    const supabase = this.requireSupabase();
    const current = await this.getJob(jobId);

    if (current.status !== 'failed' && current.status !== 'cancelled') {
      throw new GhostHandsError(
        `Job ${jobId} cannot be retried (current status: ${current.status})`,
        'job_not_retryable',
        409,
      );
    }

    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        worker_id: null,
        error_code: null,
        error_details: null,
        started_at: null,
        completed_at: null,
        last_heartbeat: null,
        retry_count: current.retry_count + 1,
      })
      .eq('id', jobId)
      .in('status', ['failed', 'cancelled'])
      .select()
      .single();

    if (error || !data) {
      throw new GhostHandsError(`Failed to retry job ${jobId}`, 'retry_failed', 500);
    }

    return data as AutomationJob;
  }

  /**
   * List jobs with optional filters and pagination.
   *
   * In API mode, userId is passed as a query parameter.
   * In DB mode, userId is required.
   */
  async listJobs(
    filtersOrUserId?: ListJobsFilters | string,
    filtersArg?: ListJobsFilters,
  ): Promise<PaginatedJobs> {
    // Normalise: listJobs(filters) or listJobs(userId, filters)
    let userId: string | undefined;
    let filters: ListJobsFilters;

    if (typeof filtersOrUserId === 'string') {
      userId = filtersOrUserId;
      filters = filtersArg ?? {};
    } else {
      filters = filtersOrUserId ?? {};
    }

    if (this.mode === 'api') {
      const qs = new URLSearchParams();
      if (userId) qs.set('user_id', userId);
      if (filters.status?.length) qs.set('status', filters.status.join(','));
      if (filters.jobType) qs.set('job_type', filters.jobType);
      if (filters.limit) qs.set('limit', String(filters.limit));
      if (filters.offset) qs.set('offset', String(filters.offset));
      if (filters.sort) qs.set('sort', filters.sort);

      return this.fetch<PaginatedJobs>(`/jobs?${qs.toString()}`);
    }

    // DB mode
    const supabase = this.requireSupabase();
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = filters.offset ?? 0;

    let query = supabase
      .from('gh_automation_jobs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (userId) query = query.eq('user_id', userId);
    if (filters.status?.length) query = query.in('status', filters.status);
    if (filters.jobType) query = query.eq('job_type', filters.jobType);
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new GhostHandsError(error.message, error.code ?? 'unknown', 500);

    return {
      jobs: (data ?? []) as AutomationJob[],
      total: count ?? 0,
      limit,
      offset,
    };
  }

  /**
   * Create multiple jobs in a single request.
   */
  async createBatch(
    jobsOrUserId: CreateJobParams[] | string,
    jobsArg?: (CreateJobParams | CreateJobOptions)[],
  ): Promise<BatchCreateResult> {
    // Normalise: createBatch(jobs) or createBatch(userId, jobs)
    let userId: string | undefined;
    let jobs: (CreateJobParams | CreateJobOptions)[];

    if (typeof jobsOrUserId === 'string') {
      userId = jobsOrUserId;
      jobs = jobsArg ?? [];
    } else {
      jobs = jobsOrUserId;
    }

    if (this.mode === 'api') {
      const apiJobs = jobs.map((j) => {
        const p = toApiPayload(j, userId);
        // Remove user_id from individual payloads -- API resolves from auth
        const { user_id: _uid, ...rest } = p;
        return rest;
      });

      const result = await this.fetch<{ created: number; job_ids: string[] }>(
        '/jobs/batch',
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, jobs: apiJobs }),
        },
      );

      return {
        created: result.job_ids.map((id: string) => ({ id, status: 'pending' as const })),
        errors: [],
      };
    }

    // DB mode
    const supabase = this.requireSupabase();
    const rows: Record<string, unknown>[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < jobs.length; i++) {
      try {
        const payload = toApiPayload(jobs[i], userId);
        rows.push(toDbRow(userId!, payload));
      } catch (err) {
        errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (rows.length === 0) return { created: [], errors };

    const { data, error } = await supabase
      .from('gh_automation_jobs')
      .insert(rows)
      .select('id, status');

    if (error) throw new GhostHandsError(error.message, error.code ?? 'unknown', 500);

    return {
      created: (data ?? []).map((row: any) => ({ id: row.id, status: row.status })),
      errors,
    };
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  /**
   * Get the event timeline for a job (audit log).
   */
  async getJobEvents(jobId: string, limit: number = 50): Promise<JobEvent[]> {
    if (this.mode === 'api') {
      const result = await this.fetch<{ events: JobEvent[] }>(
        `/jobs/${jobId}/events?limit=${limit}`,
      );
      return result.events;
    }

    const supabase = this.requireSupabase();
    const { data, error } = await supabase
      .from('gh_job_events')
      .select()
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw new GhostHandsError(error.message, error.code ?? 'unknown', 500);
    return (data ?? []) as JobEvent[];
  }

  // --------------------------------------------------------------------------
  // Realtime subscriptions (require Supabase connection)
  // --------------------------------------------------------------------------

  /**
   * Subscribe to real-time status updates for a single job via Supabase
   * Realtime (postgres_changes).
   */
  subscribeToJobStatus(
    jobId: string,
    callback: (status: JobStatusResponse) => void,
  ): JobSubscription {
    const rt = this.requireRealtime();
    return rt.subscribeToJobStatus(jobId, {
      onUpdate: (job) => {
        callback({
          id: job.id,
          status: job.status,
          status_message: job.status_message,
          progress_pct: null,
          started_at: job.started_at,
          last_heartbeat: job.last_heartbeat,
          estimated_completion: null,
        });
      },
    });
  }

  /**
   * Subscribe to all job updates for a user (useful for dashboards).
   */
  subscribeToUserJobs(
    userId: string,
    options: SubscribeToUserJobsOptions,
  ): JobSubscription {
    return this.requireRealtime().subscribeToUserJobs(userId, options);
  }

  /**
   * Wait for a job to reach a terminal status, resolving with the final
   * job record. Uses Realtime if available, otherwise falls back to polling.
   */
  async waitForCompletion(
    jobId: string,
    timeoutMs: number = 600_000,
  ): Promise<AutomationJob> {
    if (this.realtime) {
      return this.realtime.waitForCompletion(jobId, timeoutMs);
    }
    // Fallback to polling when no Realtime connection
    return this.pollForCompletion(jobId, { timeoutMs });
  }

  // --------------------------------------------------------------------------
  // Polling fallback
  // --------------------------------------------------------------------------

  /**
   * Poll for job completion at a fixed interval. Use this from server-side
   * code (Next.js API routes, background jobs) where WebSocket connections
   * are not practical.
   */
  async pollForCompletion(
    jobId: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<AutomationJob> {
    const { intervalMs = 2000, timeoutMs = 600_000 } = options;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      if (TERMINAL_STATUSES.has(job.status)) {
        return job;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new GhostHandsError(
      `Job ${jobId} did not complete within ${timeoutMs}ms`,
      'poll_timeout',
      408,
    );
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.realtime) await this.realtime.dispose();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private requireSupabase(): SupabaseClient {
    if (!this.supabase) {
      throw new GhostHandsError(
        'Supabase client not configured. Provide supabaseUrl and supabaseKey.',
        'client_config',
        500,
      );
    }
    return this.supabase;
  }

  private requireRealtime(): RealtimeSubscriber {
    if (!this.realtime) {
      throw new GhostHandsError(
        'Realtime not available. Provide supabaseUrl and supabaseKey for Realtime subscriptions, or use pollForCompletion instead.',
        'client_config',
        500,
      );
    }
    return this.realtime;
  }
}
