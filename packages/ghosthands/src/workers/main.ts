import { createClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { PgBoss } from 'pg-boss';
import Redis from 'ioredis';
import { AutoScalingClient, CompleteLifecycleActionCommand } from '@aws-sdk/client-auto-scaling';
import { JobPoller } from './JobPoller.js';
import { PgBossConsumer } from './PgBossConsumer.js';
import { JobExecutor } from './JobExecutor.js';
import { registerBuiltinHandlers } from './taskHandlers/index.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'Worker' });

/**
 * Fetch the EC2 instance ID from the Instance Metadata Service (IMDSv2).
 * Returns the instance ID string, or falls back to EC2_INSTANCE_ID env var / 'unknown'.
 */
async function fetchEc2InstanceId(): Promise<string> {
  try {
    // IMDSv2: get token first
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(1000),
    });
    const token = await tokenRes.text();

    const idRes = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1000),
    });
    return await idRes.text();
  } catch {
    return process.env.EC2_INSTANCE_ID || 'unknown';
  }
}

/**
 * Complete an ASG lifecycle action to signal that this instance is ready
 * to be terminated. Called during graceful shutdown when ASG_NAME is set.
 */
async function completeLifecycleAction(instanceId: string): Promise<void> {
  const asgName = process.env.AWS_ASG_NAME;
  const hookName = process.env.AWS_LIFECYCLE_HOOK_NAME || 'ghosthands-drain-hook';

  if (!asgName || instanceId === 'unknown') return;

  try {
    const client = new AutoScalingClient({ region: process.env.AWS_REGION || 'us-east-1' });
    await client.send(new CompleteLifecycleActionCommand({
      AutoScalingGroupName: asgName,
      LifecycleHookName: hookName,
      InstanceId: instanceId,
      LifecycleActionResult: 'CONTINUE',
    }));
    logger.info('Completed lifecycle action', { instanceId });
  } catch (err) {
    logger.warn('Failed to complete lifecycle action', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * GhostHands Worker Entry Point
 *
 * Long-running Node.js process that:
 * 1. Connects to Supabase (pooled for queries, direct for LISTEN/NOTIFY)
 * 2. Picks up jobs via pg-boss queue (queue mode) or LISTEN/NOTIFY polling (legacy mode)
 * 3. Executes jobs via BrowserAgent.act()
 * 4. Updates job status and results in the database
 * 5. Sends heartbeats every 30s during execution
 * 6. Exposes a status HTTP server on GH_WORKER_PORT (default 3101)
 *    so VALET/deploy.sh can check if it's safe to restart
 *
 * Job dispatch mode (JOB_DISPATCH_MODE env var):
 *   queue  → pg-boss consumer (new, requires VALET to enqueue via TaskQueueService)
 *   legacy → JobPoller with LISTEN/NOTIFY + polling (default)
 */

function parseWorkerId(): string {
  const arg = process.argv.find((a) => a.startsWith('--worker-id='));
  if (arg) {
    const id = arg.split('=')[1];
    if (!id) {
      throw new Error('--worker-id requires a value (e.g. --worker-id=adam)');
    }
    return id;
  }
  // Environment variable for Docker/EC2 deployments (set via .env)
  if (process.env.GH_WORKER_ID) {
    return process.env.GH_WORKER_ID;
  }
  return `worker-${process.env.FLY_REGION || process.env.NODE_ENV || 'local'}-${Date.now()}`;
}

const WORKER_ID = parseWorkerId();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const dispatchMode = process.env.JOB_DISPATCH_MODE === 'queue' ? 'queue' : 'legacy';
  logger.info('Starting worker', { workerId: WORKER_ID, dispatchMode });

  // Register all built-in task handlers
  registerBuiltinHandlers();
  logger.info('Task handlers registered');

  // Validate required environment variables
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseServiceKey) {
    throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY');
  }
  // Prefer transaction-mode pooler (port 6543) to avoid session pool limits.
  // LISTEN/NOTIFY won't work through transaction pooler, but fallback polling handles it.
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL || requireEnv('DATABASE_DIRECT_URL');

  // Pooled connection for normal queries (goes through pgbouncer)
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // PostgreSQL connection for job pickup queries and LISTEN/NOTIFY (if session mode)
  const pgDirect = new PgClient({
    connectionString: dbUrl,
  });

  logger.info('Connecting to Postgres');
  await pgDirect.connect();
  logger.info('Postgres connection established');

  // CONVENTION: Single-task-per-worker. Each worker processes one job at a time.
  // This simplifies concurrency, avoids browser session conflicts, and makes
  // cost tracking + HITL deterministic. Scale horizontally by adding workers.
  const maxConcurrent = 1;

  // ── Redis for real-time progress streaming ─────────────────────
  // Optional: if REDIS_URL is set, ProgressTracker publishes to Redis Streams
  // for consumption by VALET SSE endpoint. Falls back to DB-only if not configured.
  let redis: Redis | undefined;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        ...(redisUrl.startsWith('rediss://') && { tls: {} }),
      });
      await redis.connect();
      logger.info('Redis connected for real-time streaming');
    } catch (err) {
      logger.warn('Redis connection failed — progress will use DB only', { error: err instanceof Error ? err.message : String(err) });
      redis = undefined;
    }
  } else {
    logger.info('No REDIS_URL configured — progress will use DB only');
  }

  const executor = new JobExecutor({
    supabase,
    workerId: WORKER_ID,
    ...(redis && { redis }),
  });

  // ── Dispatch mode: pg-boss queue vs legacy LISTEN/NOTIFY poller ──
  let boss: PgBoss | undefined;
  let poller: JobPoller | undefined;
  let consumer: PgBossConsumer | undefined;

  // Unified interface so shutdown, heartbeat, and HTTP server work with both modes.
  const getActiveJobCount = (): number =>
    consumer ? consumer.activeJobCount : poller ? poller.activeJobCount : 0;
  const getIsRunning = (): boolean =>
    consumer ? consumer.isRunning : poller ? poller.isRunning : false;
  const getCurrentJobId = (): string | null =>
    consumer ? consumer.currentJobId : poller ? poller.currentJobId : null;
  const releaseJobs = async (): Promise<void> => {
    if (consumer) await consumer.releaseClaimedJobs();
    else if (poller) await poller.releaseClaimedJobs();
  };
  const stopJobProcessor = async (): Promise<void> => {
    if (consumer) await consumer.stop();
    else if (poller) await poller.stop();
  };

  // Separate flags:
  //   draining — set by /worker/drain HTTP endpoint (stop accepting new jobs)
  //   shuttingDown — set by SIGTERM/SIGINT signal handler (full shutdown)
  // This prevents the drain endpoint from causing SIGTERM to force-kill immediately.
  let draining = false;
  let shuttingDown = false;

  // Declare early so shutdown closure can reference it safely (avoids TDZ if
  // SIGTERM arrives while fetchEc2InstanceId() is still in-flight).
  let ec2InstanceId: string = 'unknown';

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // Second signal -- force shutdown
      logger.warn('Received second signal, forcing shutdown', { signal, workerId: WORKER_ID });
      logger.info('Force-releasing claimed jobs');
      try {
        await releaseJobs();
      } catch (err) {
        logger.error('Force release failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (boss) {
        try { await boss.stop({ graceful: false }); } catch { /* ignore */ }
      }
      try {
        await pgDirect.end();
      } catch {
        // Connection may already be closed
      }
      logger.info('Worker force-killed', { workerId: WORKER_ID });
      process.exit(1);
    }

    shuttingDown = true;
    logger.info('Starting graceful shutdown', { signal, workerId: WORKER_ID, activeJobs: getActiveJobCount() });

    await stopJobProcessor();
    if (boss) {
      try { await boss.stop({ graceful: true, timeout: 10_000 }); } catch { /* ignore */ }
    }
    await deregisterWorker();

    // Complete ASG lifecycle action if configured (signals ASG that
    // this instance is ready to be terminated)
    await completeLifecycleAction(ec2InstanceId);

    // Close Redis connection
    if (redis) {
      try {
        await redis.quit();
        logger.info('Redis connection closed');
      } catch {
        // Connection may already be closed
      }
    }

    try {
      await pgDirect.end();
    } catch {
      // Connection may already be closed
    }

    logger.info('Worker shut down gracefully', { workerId: WORKER_ID });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors to prevent silent crashes
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error instanceof Error ? error.message : String(error) });
    // Give time for logs to flush, then exit
    setTimeout(() => process.exit(1), 1000);
  });

  // ── EC2 Instance Metadata ────────────────────────────────────────
  // Auto-detect EC2 instance ID from the metadata service (IMDSv2).
  // Falls back to EC2_INSTANCE_ID env var or 'unknown' for local dev.
  ec2InstanceId = await fetchEc2InstanceId();
  const ec2Ip = process.env.EC2_IP || 'unknown';

  // ── Worker Registry ────────────────────────────────────────────
  // UPSERT into gh_worker_registry so the fleet monitoring endpoint
  // and VALET deregistration know about this worker.
  // Registration MUST succeed before polling starts — if it fails after
  // retries, exit so Docker restarts the container.
  const targetWorkerId = process.env.GH_WORKER_ID || null;

  const MAX_REGISTRATION_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_REGISTRATION_RETRIES; attempt++) {
    try {
      await pgDirect.query(`
        INSERT INTO gh_worker_registry (worker_id, status, target_worker_id, ec2_instance_id, ec2_ip, registered_at, last_heartbeat)
        VALUES ($1, 'active', $2, $3, $4, NOW(), NOW())
        ON CONFLICT (worker_id) DO UPDATE SET
          status = 'active',
          target_worker_id = COALESCE($2, gh_worker_registry.target_worker_id),
          ec2_instance_id = COALESCE($3, gh_worker_registry.ec2_instance_id),
          ec2_ip = COALESCE($4, gh_worker_registry.ec2_ip),
          last_heartbeat = NOW()
      `, [WORKER_ID, targetWorkerId, ec2InstanceId, ec2Ip]);

      // Verify the registration actually persisted
      const verify = await pgDirect.query(
        'SELECT worker_id, status FROM gh_worker_registry WHERE worker_id = $1',
        [WORKER_ID]
      );
      if (!verify.rows[0]) {
        throw new Error(`Worker registration verification failed for ${WORKER_ID}`);
      }
      logger.info('Registered in gh_worker_registry', { status: verify.rows[0].status, workerId: WORKER_ID });
      break; // Success
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_REGISTRATION_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s
        logger.error('Registration attempt failed', {
          attempt,
          maxAttempts: MAX_REGISTRATION_RETRIES,
          error: errMsg,
          retryInMs: backoffMs,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        logger.error('Registration failed after all retries', {
          attempts: MAX_REGISTRATION_RETRIES,
          error: errMsg,
        });
        process.exit(1);
      }
    }
  }

  // Heartbeat every 30s — updates last_heartbeat and current_job_id
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(async () => {
    try {
      const heartbeatStatus = shuttingDown ? 'draining' : draining ? 'draining' : 'active';
      await pgDirect.query(`
        UPDATE gh_worker_registry
        SET last_heartbeat = NOW(),
            current_job_id = $2::UUID,
            status = $3
        WHERE worker_id = $1
      `, [WORKER_ID, getCurrentJobId(), heartbeatStatus]);
    } catch (err) {
      logger.warn('Heartbeat update failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Helper to mark worker offline in registry
  const deregisterWorker = async (): Promise<void> => {
    clearInterval(heartbeatTimer);
    try {
      await pgDirect.query(`
        UPDATE gh_worker_registry
        SET status = 'offline', current_job_id = NULL, last_heartbeat = NOW()
        WHERE worker_id = $1
      `, [WORKER_ID]);
      logger.info('Marked offline in gh_worker_registry', { workerId: WORKER_ID });
    } catch (err) {
      logger.warn('Failed to deregister', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  // ── Start job processor ──────────────────────────────────────────
  if (dispatchMode === 'queue') {
    // pg-boss needs session-mode Postgres (direct URL, not pgbouncer)
    const directUrl = process.env.DATABASE_DIRECT_URL || process.env.SUPABASE_DIRECT_URL || dbUrl;
    boss = new PgBoss({
      connectionString: directUrl,
      schema: 'pgboss',
    });

    boss.on('error', (err: Error) => {
      logger.error('pg-boss error', { error: err.message });
    });

    logger.info('Starting pg-boss...');
    await boss.start();
    logger.info('pg-boss started');

    consumer = new PgBossConsumer({
      boss,
      pgDirect,
      workerId: WORKER_ID,
      executor,
    });
    await consumer.start();
  } else {
    // Legacy LISTEN/NOTIFY + polling mode
    poller = new JobPoller({
      supabase,
      pgDirect,
      workerId: WORKER_ID,
      executor,
      maxConcurrent,
    });
    await poller.start();
  }

  // ── Worker Status HTTP Server ──────────────────────────────────────
  // Lightweight HTTP endpoint so VALET / deploy.sh can check worker state
  // before initiating a deploy. Runs on GH_WORKER_PORT (default 3101).
  //
  // Endpoints:
  //   GET /worker/status  — worker state (active jobs, draining, uptime)
  //   GET /worker/health  — 200 if idle & ready, 503 if busy or draining
  //   POST /worker/drain  — stop accepting new jobs, wait for active to finish
  const workerPort = parseInt(process.env.GH_WORKER_PORT || '3101', 10);
  const startTime = Date.now();

  if (typeof Bun !== 'undefined') {
    Bun.serve({
      port: workerPort,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/worker/status') {
          return Response.json({
            worker_id: WORKER_ID,
            ec2_instance_id: ec2InstanceId,
            ec2_ip: ec2Ip,
            active_jobs: getActiveJobCount(),
            max_concurrent: maxConcurrent,
            is_running: getIsRunning(),
            is_draining: draining || shuttingDown,
            dispatch_mode: dispatchMode,
            asg_name: process.env.AWS_ASG_NAME || null,
            uptime_ms: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          });
        }

        if (url.pathname === '/worker/health') {
          const isDraining = draining || shuttingDown;
          const idle = getActiveJobCount() === 0 && !isDraining;
          return Response.json(
            {
              status: idle ? 'idle' : isDraining ? 'draining' : 'busy',
              active_jobs: getActiveJobCount(),
              deploy_safe: idle,
            },
            { status: idle ? 200 : 503 },
          );
        }

        if (url.pathname === '/worker/drain' && req.method === 'POST') {
          if (!draining) {
            logger.info('Drain requested via HTTP — stopping job pickup', { workerId: WORKER_ID });
            draining = true;
            // Update registry status to draining
            pgDirect.query(
              `UPDATE gh_worker_registry SET status = 'draining' WHERE worker_id = $1`,
              [WORKER_ID]
            ).catch(() => {});
            // Stop accepting new jobs but let active ones finish
            stopJobProcessor().then(() => {
              logger.info('Drain complete — all jobs finished', { workerId: WORKER_ID });
            });
          }
          return Response.json({
            status: 'draining',
            active_jobs: getActiveJobCount(),
            worker_id: WORKER_ID,
          });
        }

        return Response.json({ error: 'not_found' }, { status: 404 });
      },
    });
    logger.info('Status server started', { port: workerPort });
  }

  logger.info('Worker running', {
    workerId: WORKER_ID,
    maxConcurrent,
    dispatchMode,
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

export { fetchEc2InstanceId, completeLifecycleAction };
