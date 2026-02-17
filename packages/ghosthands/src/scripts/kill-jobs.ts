#!/usr/bin/env node
/**
 * Kill all non-terminal jobs in the database.
 * Usage: npx tsx --env-file=.env src/scripts/kill-jobs.ts
 */
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_DIRECT_URL or DATABASE_URL must be set');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const result = await client.query(
    "UPDATE gh_automation_jobs SET status = 'failed' WHERE status NOT IN ('completed', 'failed') RETURNING id, status"
  );

  if (result.rowCount === 0) {
    console.log('No active jobs found — queue is already clean.');
  } else {
    console.log(`Killed ${result.rowCount} job(s):`);
    for (const row of result.rows) {
      console.log(`  ${row.id}`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
