#!/usr/bin/env node
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Need DATABASE_DIRECT_URL or DATABASE_URL'); process.exit(1); }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Update tier to starter and reset usage
  const result = await client.query(
    "UPDATE gh_user_usage SET tier = 'starter', total_cost_usd = 0, total_input_tokens = 0, total_output_tokens = 0, job_count = 0 RETURNING user_id, tier, total_cost_usd"
  );

  for (const row of result.rows) {
    console.log(`Updated: user=${row.user_id} tier=${row.tier} cost=$${row.total_cost_usd}`);
  }

  if (result.rowCount === 0) {
    console.log('No usage rows found to update.');
  }

  await client.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
