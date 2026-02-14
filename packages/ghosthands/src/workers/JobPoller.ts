import { SupabaseClient } from '@supabase/supabase-js';
import { Client as PgClient, Notification } from 'pg';
import { JobExecutor } from './JobExecutor.js';

const POLL_INTERVAL_MS = 5_000;
const DRAIN_TIMEOUT_MS = 30_000;

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

  constructor(opts: JobPollerOptions) {
    this.supabase = opts.supabase;
    this.pgDirect = opts.pgDirect;
    this.workerId = opts.workerId;
    this.executor = opts.executor;
    this.maxConcurrent = opts.maxConcurrent;
  }

  async start(): Promise<void> {
    this.running = true;

    // Subscribe to Postgres NOTIFY for instant job pickup
    await this.pgDirect.query('LISTEN gh_job_created');
    this.pgDirect.on('notification', (_msg: Notification) => {
      if (this.activeJobs < this.maxConcurrent) {
        this.tryPickup();
      }
    });

    // Fallback polling in case NOTIFY is missed (e.g. network blip)
    this.pollTimer = setInterval(() => {
      if (this.activeJobs < this.maxConcurrent) {
        this.tryPickup();
      }
    }, POLL_INTERVAL_MS);

    // Also detect and recover stuck jobs on startup
    await this.recoverStuckJobs();

    // Initial pickup attempt
    await this.tryPickup();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    try {
      await this.pgDirect.query('UNLISTEN gh_job_created');
    } catch {
      // Connection may already be closed
    }

    // Wait for active jobs to drain (with timeout)
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (this.activeJobs > 0) {
      console.warn(`[JobPoller] Shutdown with ${this.activeJobs} active jobs still running`);
    }
  }

  get activeJobCount(): number {
    return this.activeJobs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Atomic job pickup using FOR UPDATE SKIP LOCKED via Postgres function.
   * Multiple workers can safely call this concurrently without contention.
   */
  private async tryPickup(): Promise<void> {
    if (!this.running || this.activeJobs >= this.maxConcurrent) return;
    if (this.pickupInFlight) return; // debounce concurrent pickup calls

    this.pickupInFlight = true;
    try {
      const { data: jobs, error } = await this.supabase.rpc(
        'gh_pickup_next_job',
        { p_worker_id: this.workerId }
      );

      if (error) {
        console.error(`[JobPoller] Pickup error:`, error.message);
        return;
      }

      // gh_pickup_next_job returns SETOF, so data is an array
      const job = Array.isArray(jobs) ? jobs[0] : jobs;
      if (!job) return; // No jobs available

      this.activeJobs++;
      console.log(`[JobPoller] Picked up job ${job.id} (type=${job.job_type}, active=${this.activeJobs}/${this.maxConcurrent})`);

      // Execute in background -- do NOT await
      this.executor
        .execute(job)
        .catch((err) => {
          console.error(`[JobPoller] Job ${job.id} executor error:`, err);
        })
        .finally(() => {
          this.activeJobs--;
          console.log(`[JobPoller] Job ${job.id} finished (active=${this.activeJobs}/${this.maxConcurrent})`);
          // Try to pick up the next job
          if (this.running && this.activeJobs < this.maxConcurrent) {
            this.tryPickup();
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
   */
  private async recoverStuckJobs(): Promise<void> {
    const STUCK_THRESHOLD_SECONDS = 120;

    try {
      const { data, error } = await this.supabase
        .from('gh_automation_jobs')
        .update({
          status: 'pending',
          worker_id: null,
          error_details: { recovered_by: this.workerId, reason: 'stuck_job_recovery' },
        })
        .in('status', ['queued', 'running'])
        .lt('last_heartbeat', new Date(Date.now() - STUCK_THRESHOLD_SECONDS * 1000).toISOString())
        .select('id');

      if (error) {
        console.error('[JobPoller] Stuck job recovery error:', error.message);
        return;
      }

      if (data && data.length > 0) {
        console.log(`[JobPoller] Recovered ${data.length} stuck job(s): ${data.map((j: { id: string }) => j.id).join(', ')}`);
      }
    } catch (err) {
      console.error('[JobPoller] Stuck job recovery failed:', err);
    }
  }
}
