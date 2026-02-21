#!/usr/bin/env node
/**
 * Release ALL claimed jobs and terminate any Postgres sessions from zombie workers.
 * Usage: npx tsx --env-file=.env src/scripts/nuke-workers.ts
 */
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Need DATABASE_DIRECT_URL or DATABASE_URL'); process.exit(1); }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // 1. Release all queued/running jobs back to pending
  const released = await client.query(
    "UPDATE gh_automation_jobs SET status = 'pending', worker_id = NULL WHERE status IN ('queued', 'running') RETURNING id, worker_id"
  );
  console.log(`Released ${released.rowCount} claimed job(s)`);
  for (const row of released.rows) {
    console.log(`  ${row.id} (was worker: ${row.worker_id || 'null'})`);
  }

  // 2. Terminate other Postgres backend connections that are listening on gh_job_created
  //    (this kills the zombie worker's LISTEN connection)
  const killed = await client.query(`
    SELECT pg_terminate_backend(pid), pid, application_name, state, query
    FROM pg_stat_activity
    WHERE pid != pg_backend_pid()
      AND datname = current_database()
      AND query LIKE '%LISTEN%'
  `);
  console.log(`\nTerminated ${killed.rowCount} LISTEN connection(s)`);
  for (const row of killed.rows) {
    console.log(`  pid=${row.pid} state=${row.state} app=${row.application_name}`);
  }

  await client.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
