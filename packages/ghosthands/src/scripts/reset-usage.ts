#!/usr/bin/env node
/**
 * Reset monthly usage for all users (for testing).
 * Usage: npx tsx --env-file=.env src/scripts/reset-usage.ts
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
    "UPDATE gh_user_usage SET total_cost_usd = 0, total_input_tokens = 0, total_output_tokens = 0, job_count = 0 RETURNING user_id, tier, period_start"
  );

  if (result.rowCount === 0) {
    console.log('No usage rows found.');
  } else {
    console.log(`Reset usage for ${result.rowCount} user(s):`);
    for (const row of result.rows) {
      console.log(`  user=${row.user_id} tier=${row.tier} period=${row.period_start}`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
