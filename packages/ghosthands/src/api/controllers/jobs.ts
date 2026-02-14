import { SupabaseClient } from '@supabase/supabase-js';
import {
  CreateJobInput,
  BatchCreateJobsInput,
  ListJobsQuery,
  GetEventsQuery,
  CANCELLABLE_STATUSES,
  RETRYABLE_STATUSES,
} from '../schemas/index.js';

interface JobControllerDeps {
  supabase: SupabaseClient;
}

export class JobController {
  private supabase: SupabaseClient;

  constructor({ supabase }: JobControllerDeps) {
    this.supabase = supabase;
  }

  /**
   * Create a new automation job.
   * Handles idempotency key conflicts (409) and validation.
   */
  async createJob(input: CreateJobInput, userId: string, createdBy: string = 'api') {
    // Check idempotency key conflict
    if (input.idempotency_key) {
      const { data: existing } = await this.supabase
        .from('gh_automation_jobs')
        .select('id, status')
        .eq('idempotency_key', input.idempotency_key)
        .single();

      if (existing) {
        return {
          conflict: true as const,
          existing_job_id: existing.id,
          existing_status: existing.status,
        };
      }
    }

    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .insert({
        user_id: userId,
        created_by: createdBy,
        job_type: input.job_type,
        target_url: input.target_url,
        task_description: input.task_description,
        input_data: input.input_data,
        priority: input.priority,
        scheduled_at: input.scheduled_at || null,
        max_retries: input.max_retries,
        timeout_seconds: input.timeout_seconds,
        tags: input.tags,
        idempotency_key: input.idempotency_key || null,
        metadata: input.metadata,
      })
      .select('id, status, created_at')
      .single();

    if (error) {
      // Handle unique constraint violation on idempotency_key (race condition)
      if (error.code === '23505' && error.message.includes('idempotency_key')) {
        const { data: existing } = await this.supabase
          .from('gh_automation_jobs')
          .select('id, status')
          .eq('idempotency_key', input.idempotency_key!)
          .single();

        if (existing) {
          return {
            conflict: true as const,
            existing_job_id: existing.id,
            existing_status: existing.status,
          };
        }
      }
      throw error;
    }

    return { conflict: false as const, job: data };
  }

  /** Get a full job record by ID. */
  async getJob(jobId: string, userId?: string) {
    let query = this.supabase
      .from('gh_automation_jobs')
      .select('*')
      .eq('id', jobId);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  }

  /** Get lightweight status for a job. */
  async getJobStatus(jobId: string, userId?: string) {
    let query = this.supabase
      .from('gh_automation_jobs')
      .select('id, status, status_message, started_at, last_heartbeat, completed_at')
      .eq('id', jobId);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.single();
    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  /** Cancel a job. Only works for pending/queued/running/paused jobs. */
  async cancelJob(jobId: string, userId?: string) {
    // First fetch current status
    const job = await this.getJob(jobId, userId);
    if (!job) return { notFound: true as const };

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      return {
        notFound: false as const,
        notCancellable: true as const,
        current_status: job.status,
      };
    }

    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .in('status', CANCELLABLE_STATUSES)
      .select('id, status, completed_at')
      .single();

    if (error) throw error;
    if (!data) {
      // Race condition: status changed between read and update
      return {
        notFound: false as const,
        notCancellable: true as const,
        current_status: 'unknown',
      };
    }

    return {
      notFound: false as const,
      notCancellable: false as const,
      job: { id: data.id, status: data.status, cancelled_at: data.completed_at },
    };
  }

  /** List jobs with filters and pagination. */
  async listJobs(params: ListJobsQuery, userId?: string) {
    const { status, job_type, limit, offset, sort } = params;
    const effectiveUserId = params.user_id || userId;

    let query = this.supabase
      .from('gh_automation_jobs')
      .select('*', { count: 'exact' });

    if (effectiveUserId) {
      query = query.eq('user_id', effectiveUserId);
    }

    if (status) {
      const statuses = status.split(',').map((s) => s.trim());
      query = query.in('status', statuses);
    }

    if (job_type) {
      query = query.eq('job_type', job_type);
    }

    // Parse sort param: "field:direction"
    const [sortField, sortDir] = sort.split(':');
    query = query.order(sortField || 'created_at', {
      ascending: sortDir === 'asc',
    });

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    return {
      jobs: data || [],
      total: count || 0,
      limit,
      offset,
    };
  }

  /** Get job events for debugging/audit. */
  async getJobEvents(jobId: string, params: GetEventsQuery, userId?: string) {
    // Verify job exists and user has access
    const job = await this.getJob(jobId, userId);
    if (!job) return null;

    const { limit, offset } = params;

    const { data, error, count } = await this.supabase
      .from('gh_job_events')
      .select('*', { count: 'exact' })
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return {
      events: data || [],
      total: count || 0,
    };
  }

  /** Retry a failed or cancelled job by resetting it to pending. */
  async retryJob(jobId: string, userId?: string) {
    const job = await this.getJob(jobId, userId);
    if (!job) return { notFound: true as const };

    if (!RETRYABLE_STATUSES.includes(job.status)) {
      return {
        notFound: false as const,
        notRetryable: true as const,
        current_status: job.status,
      };
    }

    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .update({
        status: 'pending',
        retry_count: job.retry_count + 1,
        worker_id: null,
        error_code: null,
        error_details: null,
        started_at: null,
        completed_at: null,
        last_heartbeat: null,
      })
      .eq('id', jobId)
      .in('status', RETRYABLE_STATUSES)
      .select('id, status, retry_count')
      .single();

    if (error) throw error;
    if (!data) {
      return {
        notFound: false as const,
        notRetryable: true as const,
        current_status: 'unknown',
      };
    }

    return { notFound: false as const, notRetryable: false as const, job: data };
  }

  /** Batch create multiple jobs. */
  async batchCreateJobs(input: BatchCreateJobsInput, userId: string, createdBy: string = 'api') {
    const defaults = input.defaults || {};

    const rows = input.jobs.map((job) => ({
      user_id: userId,
      created_by: createdBy,
      job_type: job.job_type,
      target_url: job.target_url,
      task_description: job.task_description,
      input_data: job.input_data,
      priority: job.priority ?? defaults.priority ?? 5,
      scheduled_at: job.scheduled_at || null,
      max_retries: job.max_retries ?? defaults.max_retries ?? 3,
      timeout_seconds: job.timeout_seconds ?? defaults.timeout_seconds ?? 300,
      tags: job.tags.length > 0 ? job.tags : (defaults.tags || []),
      idempotency_key: job.idempotency_key || null,
      metadata: { ...defaults.metadata, ...job.metadata },
    }));

    const { data, error } = await this.supabase
      .from('gh_automation_jobs')
      .insert(rows)
      .select('id');

    if (error) throw error;

    return {
      created: data?.length || 0,
      job_ids: (data || []).map((row: { id: string }) => row.id),
    };
  }
}
