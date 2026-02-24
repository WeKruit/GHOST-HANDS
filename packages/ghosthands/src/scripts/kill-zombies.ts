#!/usr/bin/env node
/**
 * Kill zombie workers — both Postgres LISTEN connections and stuck jobs.
 *
 * What this does:
 *   1. Shows all active Postgres connections to your database (so you can see who's connected)
 *   2. Terminates any LISTEN connections (zombie workers holding Postgres LISTEN channels)
 *   3. Releases all queued/running jobs back to "pending" (so your real worker can pick them up)
 *   4. Shows a summary of recent jobs so you can verify the state
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/kill-zombies.ts
 */
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Need DATABASE_DIRECT_URL or DATABASE_URL in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  console.log('=== ZOMBIE WORKER HUNTER ===\n');

  // ── 1. Show all active connections ────────────────────────────────
  const connections = await client.query(`
    SELECT pid, application_name, state, query, client_addr,
           now() - backend_start AS uptime
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid != pg_backend_pid()
    ORDER BY backend_start
  `);

  console.log(`Active DB connections: ${connections.rowCount}`);
  for (const row of connections.rows) {
    const query = (row.query || '').substring(0, 60).replace(/\n/g, ' ');
    console.log(`  pid=${row.pid}  app=${row.application_name || '?'}  state=${row.state}  query="${query}..."`);
  }

  // ── 2. Kill LISTEN connections (zombie workers) ───────────────────
  const listeners = await client.query(`
    SELECT pg_terminate_backend(pid), pid, application_name, state, query,
           now() - backend_start AS uptime
    FROM pg_stat_activity
    WHERE pid != pg_backend_pid()
      AND datname = current_database()
      AND (query LIKE '%LISTEN%' OR query LIKE '%gh_job%')
  `);

  console.log(`\nKilled ${listeners.rowCount} LISTEN/worker connection(s)`);
  for (const row of listeners.rows) {
    console.log(`  pid=${row.pid}  app=${row.application_name}  state=${row.state}  uptime=${row.uptime}`);
  }

  // ── 3. Release stuck jobs ─────────────────────────────────────────
  const released = await client.query(`
    UPDATE gh_automation_jobs
    SET status = 'pending', worker_id = NULL
    WHERE status IN ('queued', 'running')
    RETURNING id, worker_id, job_type, status
  `);

  console.log(`\nReleased ${released.rowCount} stuck job(s)`);
  for (const row of released.rows) {
    console.log(`  ${row.id}  type=${row.job_type}  was_worker=${row.worker_id || 'null'}`);
  }

  // ── 4. Show recent jobs for verification ──────────────────────────
  const recent = await client.query(`
    SELECT id, job_type, status, worker_id,
           created_at, updated_at,
           CASE WHEN error_details IS NOT NULL
                THEN substring(error_details::text from 1 for 80)
                ELSE NULL END AS error_preview
    FROM gh_automation_jobs
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log(`\nRecent jobs (last 5):`);
  for (const row of recent.rows) {
    const err = row.error_preview ? `  err="${row.error_preview}"` : '';
    console.log(`  ${row.id}  ${row.job_type}  status=${row.status}  worker=${row.worker_id || 'none'}${err}`);
  }

  // ── 5. Final connection count ─────────────────────────────────────
  const remaining = await client.query(`
    SELECT count(*) AS cnt
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid != pg_backend_pid()
  `);

  console.log(`\nRemaining DB connections: ${remaining.rows[0].cnt}`);
  console.log('\n=== DONE ===');

  await client.end();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
