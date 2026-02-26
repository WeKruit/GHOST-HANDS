import { SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient, Notification } from "pg";
import { JobExecutor } from "./JobExecutor.js";
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'JobPoller' });

const POLL_INTERVAL_MS = 5_000;
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Inline job pickup SQL — replaces the gh_pickup_next_job() function call.
 *
 * Matches BOTH 'pending' (legacy/REST-created) AND 'queued' (pg-boss-created)
 * statuses so the legacy poller works regardless of how VALET dispatched the job.
 * VALET's TaskQueueService inserts with status='queued'; the GH API inserts with
 * status='pending' (DB default). Both must be claimable.
 *
 * Uses the same FOR UPDATE SKIP LOCKED + worker_affinity logic as migration 014.
 */
const PICKUP_SQL = `
  WITH next_job AS (
    SELECT id
    FROM gh_automation_jobs
    WHERE status IN ('pending', 'queued')
      AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      AND (
        worker_affinity = 'any'
        OR (worker_affinity = 'preferred'
            AND (target_worker_id IS NULL OR target_worker_id = $1))
        OR (worker_affinity = 'strict' AND target_worker_id = $1)
      )
    ORDER BY
      CASE WHEN target_worker_id = $1 THEN 0 ELSE 1 END ASC,
      priority ASC,
      created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE gh_automation_jobs
  SET status = 'queued',
      worker_id = $1,
      last_heartbeat = NOW(),
      updated_at = NOW()
  FROM next_job
  WHERE gh_automation_jobs.id = next_job.id
  RETURNING gh_automation_jobs.*;
`;

export interface JobPollerOptions {
    supabase: SupabaseClient;
    pgDirect: PgClient;
    workerId: string;
    executor: JobExecutor;
    maxConcurrent: number;
}

export class JobPoller {
    private supabase: SupabaseClient;
    private pgDirect: PgClient;
    private workerId: string;
    private executor: JobExecutor;
    private maxConcurrent: number;
    private activeJobs = 0;
    private running = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private pickupInFlight = false;
    private _currentJobId: string | null = null;

    constructor(opts: JobPollerOptions) {
        this.supabase = opts.supabase;
        this.pgDirect = opts.pgDirect;
        this.workerId = opts.workerId;
        this.executor = opts.executor;
        this.maxConcurrent = opts.maxConcurrent;
    }

    async start(): Promise<void> {
        this.running = true;

        // Subscribe to Postgres NOTIFY for instant job pickup.
        // NOTE: If pgDirect connects through pgbouncer transaction mode,
        // LISTEN state is dropped between transactions. The poll timer
        // below compensates — NOTIFY is a best-effort optimization.
        try {
            await this.pgDirect.query("LISTEN gh_job_created");
            this.pgDirect.on("notification", (_msg: Notification) => {
                if (this.activeJobs < this.maxConcurrent) {
                    this.tryPickup().catch((err) => {
                        logger.warn('Pickup from NOTIFY failed', { error: err instanceof Error ? err.message : String(err) });
                    });
                }
            });
        } catch (err) {
            // LISTEN may fail through transaction-mode pgbouncer — non-fatal
            logger.warn('LISTEN gh_job_created failed (polling will compensate)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // Poll every 5s — primary job discovery mechanism.
        // NOTIFY is unreliable (no trigger fires it; pgbouncer drops LISTEN state).
        this.pollTimer = setInterval(() => {
            if (this.activeJobs < this.maxConcurrent) {
                this.tryPickup().catch((err) => {
                    logger.warn('Poll pickup failed', { error: err instanceof Error ? err.message : String(err) });
                });
            }
        }, POLL_INTERVAL_MS);

        // Also detect and recover stuck jobs on startup
        await this.recoverStuckJobs();

        // Initial pickup attempt
        await this.tryPickup();

        logger.info('JobPoller started', {
            workerId: this.workerId,
            pollIntervalMs: POLL_INTERVAL_MS,
            maxConcurrent: this.maxConcurrent,
        });
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        try {
            await this.pgDirect.query("UNLISTEN gh_job_created");
        } catch {
            // Connection may already be closed
        }

        // Wait for active jobs to drain (with timeout)
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        while (this.activeJobs > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
        }

        // Always release claimed jobs on shutdown, regardless of whether they completed
        // This ensures clean handoff to other workers even if process is force-killed
        if (this.activeJobs > 0) {
            logger.warn('Shutdown with active jobs still running', {
                activeJobs: this.activeJobs,
            });
        }
        await this.releaseClaimedJobs();
    }

    /**
     * Release all jobs claimed by this worker back to the queue.
     * Called during shutdown if jobs haven't completed in time.
     * Public so main.ts can call it directly during force shutdown.
     */
    async releaseClaimedJobs(): Promise<void> {
        try {
            const result = await this.pgDirect.query(
                `
        UPDATE gh_automation_jobs
        SET
          status = 'pending',
          worker_id = NULL,
          error_details = jsonb_build_object(
            'released_by', $1::TEXT,
            'reason', 'worker_shutdown'
          )
        WHERE worker_id = $1
          AND status IN ('queued', 'running')
        RETURNING id
      `,
                [this.workerId]
            );

            if (result.rows && result.rows.length > 0) {
                logger.info('Released jobs back to queue', {
                    count: result.rows.length,
                    jobIds: result.rows.map((j: { id: string }) => j.id),
                });
            }
        } catch (err) {
            logger.error('Failed to release claimed jobs', {
                error: err instanceof Error ? err.message : String(err),
            });
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
     * Atomic job pickup using FOR UPDATE SKIP LOCKED.
     * Multiple workers can safely call this concurrently without contention.
     *
     * Uses inline SQL (PICKUP_SQL) instead of the gh_pickup_next_job() function
     * to match BOTH 'pending' and 'queued' statuses — cross-dispatch-mode compat.
     */
    private async tryPickup(): Promise<void> {
        if (!this.running || this.activeJobs >= this.maxConcurrent) return;
        if (this.pickupInFlight) return; // debounce concurrent pickup calls

        this.pickupInFlight = true;
        try {
            const result = await this.pgDirect.query(PICKUP_SQL, [this.workerId]);

            if (!result.rows || result.rows.length === 0) {
                return; // No jobs available
            }

            const job = result.rows[0];
            if (!job) return; // No jobs available

            this.activeJobs++;
            this._currentJobId = job.id;
            logger.info('Picked up job', {
                jobId: job.id, jobType: job.job_type,
                previousStatus: job.status,
                activeJobs: this.activeJobs, maxConcurrent: this.maxConcurrent,
            });

            // Execute in background -- do NOT await
            this.executor
                .execute(job)
                .catch((err) => {
                    logger.error('Job executor error', {
                        jobId: job.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                })
                .finally(() => {
                    this.activeJobs--;
                    this._currentJobId = null;
                    logger.info('Job finished', {
                        jobId: job.id,
                        activeJobs: this.activeJobs, maxConcurrent: this.maxConcurrent,
                    });
                    // Try to pick up the next job
                    if (this.running && this.activeJobs < this.maxConcurrent) {
                        this.tryPickup().catch((err) => {
                            logger.warn('Post-job pickup failed', { error: err instanceof Error ? err.message : String(err) });
                        });
                    }
                });

            // If we still have capacity, try to pick up more immediately
            if (this.activeJobs < this.maxConcurrent) {
                // Use setImmediate-style to avoid deep recursion
                setTimeout(() => this.tryPickup(), 0);
            }
        } finally {
            this.pickupInFlight = false;
        }
    }

    /**
     * Detect and re-queue jobs that appear stuck (no heartbeat for 2+ minutes).
     * This handles worker crashes where a job was claimed but never completed.
     *
     * EC3: Before re-enqueueing, check if the job has form_submitted events.
     * If it does, mark as completed instead of resetting to pending (prevent
     * re-running a partially completed application). In either case, clear the
     * execution_attempt_id to allow a new worker to claim it.
     */
    private async recoverStuckJobs(): Promise<void> {
        const STUCK_THRESHOLD_SECONDS = 120;

        try {
            // First, find stuck jobs
            const stuckResult = await this.pgDirect.query(
                `
        SELECT id FROM gh_automation_jobs
        WHERE status IN ('queued', 'running')
          AND last_heartbeat < NOW() - INTERVAL '${STUCK_THRESHOLD_SECONDS} seconds'
      `,
            );

            if (!stuckResult.rows || stuckResult.rows.length === 0) {
                return;
            }

            const stuckJobIds = stuckResult.rows.map((j: { id: string }) => j.id);
            logger.info('Found stuck jobs', { count: stuckJobIds.length, jobIds: stuckJobIds });

            const requeued: string[] = [];
            const completedDueToProgress: string[] = [];

            for (const jobId of stuckJobIds) {
                // EC3: Check if the job has any events indicating meaningful progress
                // (form_submitted, or cookbook steps that indicate form-filling occurred)
                const eventsResult = await this.pgDirect.query(
                    `SELECT COUNT(*) as cnt FROM gh_job_events
                     WHERE job_id = $1::UUID AND event_type IN ('form_submitted', 'cookbook_step_completed', 'step_completed')`,
                    [jobId],
                );
                const hasFormSubmitted = parseInt(eventsResult.rows[0]?.cnt || '0', 10) > 0;

                if (hasFormSubmitted) {
                    // Job had meaningful progress — mark completed instead of re-running
                    await this.pgDirect.query(
                        `UPDATE gh_automation_jobs
                         SET status = 'completed',
                             completed_at = NOW(),
                             worker_id = NULL,
                             execution_attempt_id = NULL,
                             result_summary = 'Completed (recovered from stuck state — form was submitted)',
                             error_details = jsonb_build_object(
                               'recovered_by', $1::TEXT,
                               'reason', 'stuck_job_with_progress'
                             )
                         WHERE id = $2::UUID`,
                        [this.workerId, jobId],
                    );
                    completedDueToProgress.push(jobId);
                } else {
                    // No meaningful progress — safe to re-queue
                    await this.pgDirect.query(
                        `UPDATE gh_automation_jobs
                         SET status = 'pending',
                             worker_id = NULL,
                             execution_attempt_id = NULL,
                             error_details = jsonb_build_object(
                               'recovered_by', $1::TEXT,
                               'reason', 'stuck_job_recovery'
                             )
                         WHERE id = $2::UUID`,
                        [this.workerId, jobId],
                    );
                    requeued.push(jobId);
                }
            }

            if (requeued.length > 0) {
                logger.info('Re-queued stuck jobs (no progress)', {
                    count: requeued.length,
                    jobIds: requeued,
                });
            }
            if (completedDueToProgress.length > 0) {
                logger.info('Marked stuck jobs as completed (form was submitted)', {
                    count: completedDueToProgress.length,
                    jobIds: completedDueToProgress,
                });
            }
        } catch (err) {
            logger.error('Stuck job recovery failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
