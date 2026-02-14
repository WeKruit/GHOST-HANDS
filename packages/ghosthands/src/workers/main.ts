import { createClient } from '@supabase/supabase-js';
import { Client as PgClient } from 'pg';
import { JobPoller } from './JobPoller.js';
import { JobExecutor } from './JobExecutor.js';

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

const WORKER_ID = `worker-${process.env.FLY_REGION || process.env.NODE_ENV || 'local'}-${Date.now()}`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  console.log(`[Worker] Starting ${WORKER_ID}...`);

  // Validate required environment variables
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseServiceKey = requireEnv('SUPABASE_SERVICE_KEY');
  const directUrl = requireEnv('SUPABASE_DIRECT_URL');

  // Pooled connection for normal queries (goes through pgbouncer)
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // Direct connection for LISTEN/NOTIFY (must bypass pgbouncer)
  const pgDirect = new PgClient({
    connectionString: directUrl,
  });

  console.log(`[Worker] Connecting to Postgres (direct)...`);
  await pgDirect.connect();
  console.log(`[Worker] Postgres direct connection established`);

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

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Worker] Received ${signal}, starting graceful shutdown...`);
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
