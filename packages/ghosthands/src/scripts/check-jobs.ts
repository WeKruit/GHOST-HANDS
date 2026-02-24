#!/usr/bin/env node
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_DIRECT_URL or DATABASE_URL must be set');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Check for active/stuck jobs
  const active = await client.query(
    "SELECT id, status, worker_id FROM gh_automation_jobs WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC"
  );
  console.log(`=== Active/stuck jobs: ${active.rowCount} ===`);
  for (const row of active.rows) {
    console.log(`  ${row.id} | status=${row.status} | worker=${row.worker_id}`);
  }

  // Check recent jobs for error details
  const recent = await client.query(
    "SELECT id, status, worker_id, error_details, created_at FROM gh_automation_jobs ORDER BY created_at DESC LIMIT 5"
  );
  console.log(`\n=== 5 most recent jobs ===`);
  for (const row of recent.rows) {
    console.log(`  ${row.id} | status=${row.status} | worker=${row.worker_id || 'none'}`);
    if (row.error_details) {
      console.log(`    error: ${JSON.stringify(row.error_details)}`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
