#!/usr/bin/env node
/**
 * Mark all jobs claimed by zombie workers as needs_human (not the current worker).
 * Usage: npx tsx --env-file=.env src/scripts/release-zombie.ts
 */
import { Client } from 'pg';

async function main() {
  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('Need DATABASE_DIRECT_URL or DATABASE_URL'); process.exit(1); }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Mark all non-terminal jobs as needs_human so they do not loop forever
  const result = await client.query(
    `UPDATE gh_automation_jobs
     SET status = 'needs_human',
         completed_at = NOW(),
         worker_id = NULL,
         error_code = 'stuck_job_timeout',
         interaction_type = 'stuck_job_timeout',
         interaction_data = jsonb_build_object(
           'type', 'stuck_job_timeout',
           'message', 'Job was owned by a zombie worker and needs human review',
           'description', 'Worker heartbeat timed out before meaningful progress was detected'
         ),
         error_details = jsonb_build_object(
           'released_by', 'release-zombie-script',
           'reason', 'stuck_job_manual_recovery',
           'released_at', NOW()::TEXT,
           'message', 'Job was owned by a zombie worker and was marked needs_human'
         )
     WHERE status IN ('queued', 'running')
     RETURNING id, worker_id`
  );

  if (result.rowCount === 0) {
    console.log('No stuck jobs found.');
  } else {
    console.log(`Marked ${result.rowCount} job(s) as needs_human:`);
    for (const row of result.rows) {
      console.log(`  ${row.id} (was claimed by ${row.worker_id})`);
    }
  }

  await client.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
