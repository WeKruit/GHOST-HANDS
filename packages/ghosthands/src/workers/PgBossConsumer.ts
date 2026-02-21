import { PgBoss, type Job } from 'pg-boss';
import { Client as PgClient } from 'pg';
import { JobExecutor } from './JobExecutor.js';
import { getLogger } from '../monitoring/logger.js';
import type { AutomationJob } from './taskHandlers/types.js';

const logger = getLogger({ service: 'PgBossConsumer' });

/** Payload shape enqueued by VALET's TaskQueueService */
interface GhJobPayload {
  ghJobId: string;
  valetTaskId: string;
  userId: string;
  targetUrl: string;
  platform?: string;
  jobType: string;
  taskDescription?: string;
  callbackUrl?: string;
}

/** The general queue name — must match VALET's QUEUE_APPLY_JOB constant */
const QUEUE_APPLY_JOB = 'gh_apply_job';

/** Max time a job can remain active before pg-boss marks it expired (30 min) */
const JOB_EXPIRE_SECONDS = 1800;

export interface PgBossConsumerOptions {
  boss: PgBoss;
  pgDirect: PgClient;
  workerId: string;
  executor: JobExecutor;
}

/**
 * PgBossConsumer — replaces JobPoller for pg-boss-based job dispatch.
 *
 * Instead of LISTEN/NOTIFY + FOR UPDATE SKIP LOCKED polling, this consumer
 * uses pg-boss's work() method to claim and process jobs. pg-boss handles
 * expiration and dead-letter queues. Retry logic is owned by JobExecutor
 * (retryLimit: 0 disables pg-boss retries to avoid dual-retry conflicts).
 *
 * The consumer subscribes to:
 * 1. `gh_apply_job` — general queue (any worker can pick up)
 * 2. `gh_apply_job:{workerId}` — targeted queue (only this worker picks up)
 */
export class PgBossConsumer {
  private boss: PgBoss;
  private pgDirect: PgClient;
  private workerId: string;
  private executor: JobExecutor;
  private running = false;
  private activeJobs = 0;
  private _currentJobId: string | null = null;
  /** Track the current pg-boss job ID for cleanup in releaseClaimedJobs */
  private _currentPgBossJobId: string | null = null;
  /** Track the current pg-boss queue name for fail() in releaseClaimedJobs */
  private _currentQueueName: string | null = null;
  /** Concurrency lock — ensures only one job runs at a time */
  private processing = false;

  constructor(opts: PgBossConsumerOptions) {
    this.boss = opts.boss;
    this.pgDirect = opts.pgDirect;
    this.workerId = opts.workerId;
    this.executor = opts.executor;
  }

  async start(): Promise<void> {
    this.running = true;

    const queueOptions = {
      retryLimit: 0,           // JobExecutor owns retry logic — no pg-boss retries
      expireInSeconds: JOB_EXPIRE_SECONDS,
    };

    // Create queues if they don't exist
    await this.boss.createQueue(QUEUE_APPLY_JOB, queueOptions).catch(() => {
      // Queue may already exist — that's fine
    });

    const targetedQueue = `${QUEUE_APPLY_JOB}/${this.workerId}`;
    await this.boss.createQueue(targetedQueue, queueOptions).catch(() => {
      // Queue may already exist — that's fine
    });

    // Subscribe to general queue
    await this.boss.work<GhJobPayload>(
      QUEUE_APPLY_JOB,
      { batchSize: 1 },
      async (jobs: Job<GhJobPayload>[]) => {
        await this.handleJobs(jobs);
      },
    );

    // Subscribe to targeted queue (worker-specific)
    await this.boss.work<GhJobPayload>(
      targetedQueue,
      { batchSize: 1 },
      async (jobs: Job<GhJobPayload>[]) => {
        await this.handleJobs(jobs);
      },
    );

    logger.info('Subscribed to queues', {
      generalQueue: QUEUE_APPLY_JOB,
      targetedQueue,
      workerId: this.workerId,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    // pg-boss stop is handled by the caller (main.ts) since PgBoss is shared
    logger.info('Stopped', { activeJobs: this.activeJobs, workerId: this.workerId });
  }

  private async handleJobs(jobs: Job<GhJobPayload>[]): Promise<void> {
    for (const job of jobs) {
      await this.handleJob(job);
    }
  }

  private async handleJob(job: Job<GhJobPayload>): Promise<void> {
    const payload = job.data;
    const ghJobId = payload.ghJobId;
    const queueName = job.name;

    // Concurrency guard: if already processing a job, re-enqueue and return
    if (this.processing) {
      logger.warn('Worker busy, re-enqueueing job', {
        pgBossJobId: job.id,
        ghJobId,
        queueName,
        workerId: this.workerId,
      });
      await this.boss.send(queueName, payload);
      return;
    }

    this.processing = true;
    this.activeJobs++;
    this._currentJobId = ghJobId;
    this._currentPgBossJobId = job.id;
    this._currentQueueName = queueName;

    logger.info('Received job', {
      pgBossJobId: job.id,
      ghJobId,
      jobType: payload.jobType,
      workerId: this.workerId,
    });

    try {
      // Look up the full gh_automation_jobs record (created by VALET in WEK-98)
      const result = await this.pgDirect.query(
        `SELECT * FROM gh_automation_jobs WHERE id = $1 LIMIT 1`,
        [ghJobId],
      );

      if (!result.rows || result.rows.length === 0) {
        logger.error('gh_automation_jobs record not found', { ghJobId });
        throw new Error(`Job record not found: ${ghJobId}`);
      }

      const dbJob = result.rows[0];

      // Update status to running, set worker_id
      await this.pgDirect.query(
        `UPDATE gh_automation_jobs SET status = 'running', worker_id = $1, started_at = NOW(), last_heartbeat = NOW() WHERE id = $2`,
        [this.workerId, ghJobId],
      );

      // Map DB row to AutomationJob shape that JobExecutor expects
      const automationJob: AutomationJob = {
        id: dbJob.id,
        job_type: dbJob.job_type || payload.jobType,
        target_url: dbJob.target_url || payload.targetUrl,
        task_description: dbJob.task_description || payload.taskDescription || '',
        input_data: typeof dbJob.input_data === 'string' ? JSON.parse(dbJob.input_data) : (dbJob.input_data || {}),
        user_id: dbJob.user_id || payload.userId,
        timeout_seconds: dbJob.timeout_seconds || 1800,
        max_retries: dbJob.max_retries || 3,
        retry_count: dbJob.retry_count || 0,
        metadata: typeof dbJob.metadata === 'string' ? JSON.parse(dbJob.metadata) : (dbJob.metadata || {}),
        priority: dbJob.priority || 0,
        tags: Array.isArray(dbJob.tags) ? dbJob.tags : (typeof dbJob.tags === 'string' ? JSON.parse(dbJob.tags) : []),
        callback_url: dbJob.callback_url || payload.callbackUrl,
        valet_task_id: dbJob.valet_task_id || payload.valetTaskId,
        execution_mode: dbJob.execution_mode || undefined,
      };

      // Execute the job (same path as JobPoller).
      // JobExecutor handles its own retry logic (sets status='pending', re-queues via DB update).
      // Do NOT re-throw — retryLimit: 0 means pg-boss would move the job to dead letter.
      await this.executor.execute(automationJob);

      logger.info('Job completed successfully', { ghJobId, workerId: this.workerId });
    } catch (err) {
      // JobExecutor.execute() already handles retryable errors internally by setting
      // status='pending' + retry_count++ in the DB. If we get here, it's either:
      // 1. A job record lookup failure (not found) — genuinely non-retryable
      // 2. An error that JobExecutor already classified and handled
      // Don't re-throw: with retryLimit: 0, pg-boss would move it to the dead-letter queue,
      // conflicting with JobExecutor's own retry logic.
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Job failed', { ghJobId, error: errorMsg, workerId: this.workerId });
    } finally {
      this.activeJobs--;
      this._currentJobId = null;
      this._currentPgBossJobId = null;
      this._currentQueueName = null;
      this.processing = false;
      logger.debug('Job finished', { ghJobId, activeJobs: this.activeJobs, workerId: this.workerId });
    }
  }

  get activeJobCount(): number {
    return this.activeJobs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentJobId(): string | null {
    return this._currentJobId;
  }

  /**
   * Release jobs claimed by this worker back to the queue.
   * Mirror of JobPoller.releaseClaimedJobs() for shutdown compatibility.
   *
   * Also fails the current pg-boss job so pg-boss doesn't think it's still active.
   */
  async releaseClaimedJobs(): Promise<void> {
    try {
      // Fail the current pg-boss job so it doesn't remain "active" in pg-boss
      if (this._currentPgBossJobId && this._currentQueueName) {
        try {
          await this.boss.fail(this._currentQueueName, this._currentPgBossJobId, { reason: 'worker_shutdown' });
          logger.info('Failed current pg-boss job for release', {
            pgBossJobId: this._currentPgBossJobId,
            workerId: this.workerId,
          });
        } catch (pgBossErr) {
          logger.warn('Could not fail pg-boss job during release', {
            pgBossJobId: this._currentPgBossJobId,
            error: pgBossErr instanceof Error ? pgBossErr.message : String(pgBossErr),
          });
        }
      }

      const result = await this.pgDirect.query(
        `UPDATE gh_automation_jobs
         SET status = 'pending', worker_id = NULL,
             error_details = jsonb_build_object('released_by', $1::TEXT, 'reason', 'worker_shutdown')
         WHERE worker_id = $1 AND status IN ('queued', 'running')
         RETURNING id`,
        [this.workerId],
      );

      if (result.rows && result.rows.length > 0) {
        logger.info('Released jobs', {
          count: result.rows.length,
          jobIds: result.rows.map((j: { id: string }) => j.id),
          workerId: this.workerId,
        });
      }
    } catch (err) {
      logger.error('Failed to release claimed jobs', {
        error: err instanceof Error ? err.message : String(err),
        workerId: this.workerId,
      });
    }
  }
}
