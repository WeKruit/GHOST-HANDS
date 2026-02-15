import pg from 'pg';
import {
  CreateJobInput,
  BatchCreateJobsInput,
  ListJobsQuery,
  GetEventsQuery,
  CANCELLABLE_STATUSES,
  RETRYABLE_STATUSES,
} from '../schemas/index.js';

const { Pool } = pg;

interface JobControllerDeps {
  pool: pg.Pool;
}

export class JobController {
  private pool: pg.Pool;

  constructor({ pool }: JobControllerDeps) {
    this.pool = pool;
  }

  /**
   * Create a new automation job.
   * Handles idempotency key conflicts (409) and validation.
   */
  async createJob(input: CreateJobInput, userId: string, createdBy: string = 'api') {
    // Check idempotency key conflict
    if (input.idempotency_key) {
      const existing = await this.pool.query(
        'SELECT id, status FROM gh_automation_jobs WHERE idempotency_key = $1 LIMIT 1',
        [input.idempotency_key]
      );

      if (existing.rows.length > 0) {
        return {
          conflict: true as const,
          existing_job_id: existing.rows[0].id,
          existing_status: existing.rows[0].status,
        };
      }
    }

    try {
      const result = await this.pool.query(`
        INSERT INTO gh_automation_jobs (
          user_id, created_by, job_type, target_url, task_description,
          input_data, priority, scheduled_at, max_retries,
          timeout_seconds, tags, idempotency_key, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, status, created_at
      `, [
        userId, createdBy, input.job_type, input.target_url, input.task_description,
        JSON.stringify(input.input_data), input.priority, input.scheduled_at || null,
        input.max_retries, input.timeout_seconds, JSON.stringify(input.tags),
        input.idempotency_key || null, JSON.stringify(input.metadata),
      ]);

      return { conflict: false as const, job: result.rows[0] };
    } catch (err: any) {
      // Handle unique constraint violation on idempotency_key (race condition)
      if (err.code === '23505' && err.message?.includes('idempotency_key')) {
        const existing = await this.pool.query(
          'SELECT id, status FROM gh_automation_jobs WHERE idempotency_key = $1 LIMIT 1',
          [input.idempotency_key]
        );
        if (existing.rows.length > 0) {
          return {
            conflict: true as const,
            existing_job_id: existing.rows[0].id,
            existing_status: existing.rows[0].status,
          };
        }
      }
      throw err;
    }
  }

  /** Get a full job record by ID. */
  async getJob(jobId: string, userId?: string) {
    let sql = 'SELECT * FROM gh_automation_jobs WHERE id = $1::UUID';
    const params: any[] = [jobId];

    if (userId) {
      sql += ' AND user_id = $2::TEXT';
      params.push(userId);
    }

    const { rows } = await this.pool.query(sql, params);
    return rows[0] || null;
  }

  /** Get lightweight status for a job. */
  async getJobStatus(jobId: string, userId?: string) {
    let sql = 'SELECT id, status, status_message, started_at, last_heartbeat, completed_at FROM gh_automation_jobs WHERE id = $1::UUID';
    const params: any[] = [jobId];

    if (userId) {
      sql += ' AND user_id = $2::TEXT';
      params.push(userId);
    }

    const { rows } = await this.pool.query(sql, params);
    return rows[0] || null;
  }

  /** Cancel a job. Only works for pending/queued/running/paused jobs. */
  async cancelJob(jobId: string, userId?: string) {
    const job = await this.getJob(jobId, userId);
    if (!job) return { notFound: true as const };

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      return {
        notFound: false as const,
        notCancellable: true as const,
        current_status: job.status,
      };
    }

    const statusList = CANCELLABLE_STATUSES.map((_, i) => `$${i + 3}`).join(', ');
    const { rows } = await this.pool.query(`
      UPDATE gh_automation_jobs
      SET status = 'cancelled', completed_at = NOW()
      WHERE id = $1::UUID AND status IN (${statusList})
      RETURNING id, status, completed_at
    `, [jobId, ...CANCELLABLE_STATUSES]);

    if (rows.length === 0) {
      return {
        notFound: false as const,
        notCancellable: true as const,
        current_status: 'unknown',
      };
    }

    return {
      notFound: false as const,
      notCancellable: false as const,
      job: { id: rows[0].id, status: rows[0].status, cancelled_at: rows[0].completed_at },
    };
  }

  /** List jobs with filters and pagination. */
  async listJobs(params: ListJobsQuery, userId?: string) {
    const { status, job_type, limit, offset, sort } = params;
    const effectiveUserId = params.user_id || userId;
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (effectiveUserId) {
      conditions.push(`user_id = $${paramIdx++}::TEXT`);
      values.push(effectiveUserId);
    }

    if (status) {
      const statuses = status.split(',').map((s) => s.trim());
      conditions.push(`status = ANY($${paramIdx++}::TEXT[])`);
      values.push(statuses);
    }

    if (job_type) {
      conditions.push(`job_type = $${paramIdx++}::TEXT`);
      values.push(job_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [sortField, sortDir] = sort.split(':');
    const orderField = sortField || 'created_at';
    const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM gh_automation_jobs ${where}`,
      values
    );

    const dataResult = await this.pool.query(
      `SELECT * FROM gh_automation_jobs ${where} ORDER BY ${orderField} ${orderDir} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...values, limit, offset]
    );

    return {
      jobs: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      limit,
      offset,
    };
  }

  /** Get job events for debugging/audit. */
  async getJobEvents(jobId: string, params: GetEventsQuery, userId?: string) {
    const job = await this.getJob(jobId, userId);
    if (!job) return null;

    const { limit, offset } = params;

    const countResult = await this.pool.query(
      'SELECT COUNT(*) as total FROM gh_job_events WHERE job_id = $1::UUID',
      [jobId]
    );

    const dataResult = await this.pool.query(
      'SELECT * FROM gh_job_events WHERE job_id = $1::UUID ORDER BY created_at ASC LIMIT $2 OFFSET $3',
      [jobId, limit, offset]
    );

    return {
      events: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
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

    const statusList = RETRYABLE_STATUSES.map((_, i) => `$${i + 3}`).join(', ');
    const { rows } = await this.pool.query(`
      UPDATE gh_automation_jobs
      SET status = 'pending', retry_count = retry_count + 1,
          worker_id = NULL, error_code = NULL, error_details = NULL,
          started_at = NULL, completed_at = NULL, last_heartbeat = NULL
      WHERE id = $1::UUID AND status IN (${statusList})
      RETURNING id, status, retry_count
    `, [jobId, ...RETRYABLE_STATUSES]);

    if (rows.length === 0) {
      return {
        notFound: false as const,
        notRetryable: true as const,
        current_status: 'unknown',
      };
    }

    return { notFound: false as const, notRetryable: false as const, job: rows[0] };
  }

  /** Batch create multiple jobs. */
  async batchCreateJobs(input: BatchCreateJobsInput, userId: string, createdBy: string = 'api') {
    const defaults = input.defaults || {};
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const jobIds: string[] = [];
      for (const job of input.jobs) {
        const result = await client.query(`
          INSERT INTO gh_automation_jobs (
            user_id, created_by, job_type, target_url, task_description,
            input_data, priority, scheduled_at, max_retries,
            timeout_seconds, tags, idempotency_key, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id
        `, [
          userId, createdBy, job.job_type, job.target_url, job.task_description,
          JSON.stringify(job.input_data),
          job.priority ?? defaults.priority ?? 5,
          job.scheduled_at || null,
          job.max_retries ?? defaults.max_retries ?? 3,
          job.timeout_seconds ?? defaults.timeout_seconds ?? 300,
          JSON.stringify(job.tags.length > 0 ? job.tags : (defaults.tags || [])),
          job.idempotency_key || null,
          JSON.stringify({ ...defaults.metadata, ...job.metadata }),
        ]);
        jobIds.push(result.rows[0].id);
      }

      await client.query('COMMIT');
      return { created: jobIds.length, job_ids: jobIds };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
