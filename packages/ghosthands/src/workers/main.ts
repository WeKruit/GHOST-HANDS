import { createClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { JobPoller } from './JobPoller.js';
import { JobExecutor } from './JobExecutor.js';
import { registerBuiltinHandlers } from './taskHandlers/index.js';

/**
 * GhostHands Worker Entry Point
 *
 * Long-running Node.js process that:
 * 1. Connects to Supabase (pooled for queries, direct for LISTEN/NOTIFY)
 * 2. Listens for gh_job_created notifications
 * 3. Polls for pending jobs using FOR UPDATE SKIP LOCKED
 * 4. Executes jobs via BrowserAgent.act()
 * 5. Updates job status and results in the database
 * 6. Sends heartbeats every 30s during execution
 * 7. Exposes a status HTTP server on GH_WORKER_PORT (default 3101)
 *    so VALET/deploy.sh can check if it's safe to restart
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
  console.log(`[Worker] Starting with ID: ${WORKER_ID}`);

  // Register all built-in task handlers
  registerBuiltinHandlers();
  console.log(`[Worker] Task handlers registered`);

  // Validate required environment variables
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY || requireEnv('SUPABASE_SERVICE_KEY');
  // Prefer transaction-mode pooler (port 6543) to avoid session pool limits.
  // LISTEN/NOTIFY won't work through transaction pooler, but fallback polling handles it.
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL || requireEnv('DATABASE_DIRECT_URL');

  // Pooled connection for normal queries (goes through pgbouncer)
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // PostgreSQL connection for job pickup queries and LISTEN/NOTIFY (if session mode)
  // keepAlive prevents Supabase session pooler from dropping idle connections
  const pgDirect = new PgClient({
    connectionString: dbUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  console.log(`[Worker] Connecting to Postgres...`);
  await pgDirect.connect();
  console.log(`[Worker] Postgres connection established`);

  // CONVENTION: Single-task-per-worker. Each worker processes one job at a time.
  // This simplifies concurrency, avoids browser session conflicts, and makes
  // cost tracking + HITL deterministic. Scale horizontally by adding workers.
  const maxConcurrent = 1;

  const executor = new JobExecutor({
    supabase,
    workerId: WORKER_ID,
  });

  const poller = new JobPoller({
    supabase,
    pgDirect,
    workerId: WORKER_ID,
    executor,
    maxConcurrent,
  });

  // Two-phase shutdown handler:
  // - First signal: graceful shutdown (drain active jobs, release claimed jobs)
  // - Second signal: force release jobs and exit immediately
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // Second signal -- force shutdown
      console.log(`[Worker] Received second ${signal}, forcing shutdown...`);
      console.log(`[Worker] Force-releasing claimed jobs...`);
      try {
        await poller.releaseClaimedJobs();
      } catch (err) {
        console.error(`[Worker] Force release failed:`, err);
      }
      try {
        await pgDirect.end();
      } catch {
        // Connection may already be closed
      }
      console.log(`[Worker] ${WORKER_ID} force-killed`);
      process.exit(1);
    }

    shuttingDown = true;
    console.log(`[Worker] Received ${signal}, starting graceful shutdown...`);
    console.log(`[Worker] Press Ctrl-C again to force-kill immediately`);
    console.log(`[Worker] Draining ${poller.activeJobCount} active job(s)...`);

    await poller.stop();
    await deregisterWorker();

    try {
      await pgDirect.end();
    } catch {
      // Connection may already be closed
    }

    console.log(`[Worker] ${WORKER_ID} shut down gracefully`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors to prevent silent crashes
  process.on('unhandledRejection', (reason) => {
    console.error(`[Worker] Unhandled rejection:`, reason);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[Worker] Uncaught exception:`, error);
    // Give time for logs to flush, then exit
    setTimeout(() => process.exit(1), 1000);
  });

  // ── Worker Registry ────────────────────────────────────────────
  // UPSERT into gh_worker_registry so the fleet monitoring endpoint
  // and VALET deregistration know about this worker.
  // Registration MUST succeed before polling starts — if it fails after
  // retries, exit so Docker restarts the container.
  const targetWorkerId = process.env.GH_WORKER_ID || null;
  const ec2InstanceId = process.env.EC2_INSTANCE_ID || 'unknown';
  const ec2Ip = process.env.EC2_IP || 'unknown';

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
      console.log(`[Worker] Registered in gh_worker_registry (status: ${verify.rows[0].status})`);
      break; // Success
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_REGISTRATION_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s
        console.error(`[Worker] Registration attempt ${attempt}/${MAX_REGISTRATION_RETRIES} failed: ${errMsg} — retrying in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        console.error(`[Worker] Registration failed after ${MAX_REGISTRATION_RETRIES} attempts: ${errMsg}`);
        console.error(`[Worker] Cannot start without registry entry — exiting`);
        process.exit(1);
      }
    }
  }

  // Heartbeat every 30s — updates last_heartbeat and current_job_id
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(async () => {
    try {
      await pgDirect.query(`
        UPDATE gh_worker_registry
        SET last_heartbeat = NOW(),
            current_job_id = $2::UUID,
            status = $3
        WHERE worker_id = $1
      `, [WORKER_ID, poller.currentJobId, shuttingDown ? 'draining' : 'active']);
    } catch (err) {
      console.warn(`[Worker] Heartbeat update failed:`, err instanceof Error ? err.message : err);
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
      console.log(`[Worker] Marked offline in gh_worker_registry`);
    } catch (err) {
      console.warn(`[Worker] Failed to deregister:`, err instanceof Error ? err.message : err);
    }
  };

  // Start polling
  await poller.start();

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
            active_jobs: poller.activeJobCount,
            max_concurrent: maxConcurrent,
            is_running: poller.isRunning,
            is_draining: shuttingDown,
            uptime_ms: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          });
        }

        if (url.pathname === '/worker/health') {
          const idle = poller.activeJobCount === 0 && !shuttingDown;
          return Response.json(
            {
              status: idle ? 'idle' : shuttingDown ? 'draining' : 'busy',
              active_jobs: poller.activeJobCount,
              deploy_safe: idle,
            },
            { status: idle ? 200 : 503 },
          );
        }

        if (url.pathname === '/worker/drain' && req.method === 'POST') {
          if (!shuttingDown) {
            console.log(`[Worker] Drain requested via HTTP — stopping job pickup`);
            shuttingDown = true;
            // Update registry status to draining
            pgDirect.query(
              `UPDATE gh_worker_registry SET status = 'draining' WHERE worker_id = $1`,
              [WORKER_ID]
            ).catch(() => {});
            // Stop accepting new jobs but let active ones finish
            poller.stop().then(() => {
              console.log(`[Worker] Drain complete — all jobs finished`);
            });
          }
          return Response.json({
            status: 'draining',
            active_jobs: poller.activeJobCount,
            worker_id: WORKER_ID,
          });
        }

        return Response.json({ error: 'not_found' }, { status: 404 });
      },
    });
    console.log(`[Worker] Status server on port ${workerPort}`);
  }

  console.log(`[Worker] ${WORKER_ID} running (maxConcurrent=${maxConcurrent})`);
  console.log(`[Worker] Listening for jobs on gh_job_created channel`);
}

main().catch((err) => {
  console.error(`[Worker] Fatal error:`, err);
  process.exit(1);
});
