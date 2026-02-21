import { PgBoss, type Job } from 'pg-boss';
import { Client as PgClient } from 'pg';
import { JobExecutor } from './JobExecutor.js';
import type { AutomationJob } from './taskHandlers/types.js';

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
 * retries, backoff, expiration, and dead-letter queues.
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

  constructor(opts: PgBossConsumerOptions) {
    this.boss = opts.boss;
    this.pgDirect = opts.pgDirect;
    this.workerId = opts.workerId;
    this.executor = opts.executor;
  }

  async start(): Promise<void> {
    this.running = true;

    // Create queues if they don't exist
    await this.boss.createQueue(QUEUE_APPLY_JOB).catch(() => {
      // Queue may already exist — that's fine
    });

    const targetedQueue = `${QUEUE_APPLY_JOB}:${this.workerId}`;
    await this.boss.createQueue(targetedQueue).catch(() => {
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

    console.log(`[PgBossConsumer] Subscribed to queues: ${QUEUE_APPLY_JOB}, ${targetedQueue}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    // pg-boss stop is handled by the caller (main.ts) since PgBoss is shared
    console.log(`[PgBossConsumer] Stopped (active jobs: ${this.activeJobs})`);
  }

  private async handleJobs(jobs: Job<GhJobPayload>[]): Promise<void> {
    for (const job of jobs) {
      await this.handleJob(job);
    }
  }

  private async handleJob(job: Job<GhJobPayload>): Promise<void> {
    const payload = job.data;
    const ghJobId = payload.ghJobId;

    console.log(
      `[PgBossConsumer] Received job ${job.id} (ghJobId=${ghJobId}, type=${payload.jobType})`,
    );

    this.activeJobs++;
    this._currentJobId = ghJobId;

    try {
      // Look up the full gh_automation_jobs record (created by VALET in WEK-98)
      const result = await this.pgDirect.query(
        `SELECT * FROM gh_automation_jobs WHERE id = $1 LIMIT 1`,
        [ghJobId],
      );

      if (!result.rows || result.rows.length === 0) {
        console.error(`[PgBossConsumer] gh_automation_jobs record not found for ${ghJobId}`);
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

      // Execute the job (same path as JobPoller)
      await this.executor.execute(automationJob);

      console.log(`[PgBossConsumer] Job ${ghJobId} completed successfully`);
    } catch (err) {
      console.error(`[PgBossConsumer] Job ${ghJobId} failed:`, err);
      // pg-boss will handle retries based on the queue config
      throw err;
    } finally {
      this.activeJobs--;
      this._currentJobId = null;
      console.log(
        `[PgBossConsumer] Job ${ghJobId} finished (active=${this.activeJobs})`,
      );
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
   */
  async releaseClaimedJobs(): Promise<void> {
    try {
      const result = await this.pgDirect.query(
        `UPDATE gh_automation_jobs
         SET status = 'pending', worker_id = NULL,
             error_details = jsonb_build_object('released_by', $1::TEXT, 'reason', 'worker_shutdown')
         WHERE worker_id = $1 AND status IN ('queued', 'running')
         RETURNING id`,
        [this.workerId],
      );

      if (result.rows && result.rows.length > 0) {
        console.log(
          `[PgBossConsumer] Released ${result.rows.length} job(s): ${result.rows.map((j: { id: string }) => j.id).join(', ')}`,
        );
      }
    } catch (err) {
      console.error('[PgBossConsumer] Failed to release claimed jobs:', err);
    }
  }
}
