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
  const supabaseServiceKey = requireEnv('SUPABASE_SERVICE_KEY');
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

  console.log(`[Worker] Connecting to Postgres...`);
  await pgDirect.connect();
  console.log(`[Worker] Postgres connection established`);

  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);

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

  // Start polling
  await poller.start();

  console.log(`[Worker] ${WORKER_ID} running (maxConcurrent=${maxConcurrent})`);
  console.log(`[Worker] Listening for jobs on gh_job_created channel`);
}

main().catch((err) => {
  console.error(`[Worker] Fatal error:`, err);
  process.exit(1);
});
