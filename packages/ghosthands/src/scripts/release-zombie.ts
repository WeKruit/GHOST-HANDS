#!/usr/bin/env node
/**
 * Release all jobs claimed by zombie workers (not the current worker).
 * Usage: npx tsx --env-file=.env src/scripts/release-zombie.ts
 */
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Need DATABASE_DIRECT_URL or DATABASE_URL'); process.exit(1); }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Release all non-terminal jobs back to pending
  const result = await client.query(
    "UPDATE gh_automation_jobs SET status = 'pending', worker_id = NULL WHERE status IN ('queued', 'running') RETURNING id, worker_id"
  );

  if (result.rowCount === 0) {
    console.log('No stuck jobs found.');
  } else {
    console.log(`Released ${result.rowCount} job(s):`);
    for (const row of result.rows) {
      console.log(`  ${row.id} (was claimed by ${row.worker_id})`);
    }
  }

  await client.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
