#!/usr/bin/env bun
/**
 * Release Stuck Jobs Script
 *
 * Manually release jobs that are stuck in 'queued' or 'running' state
 * with stale worker_ids (no heartbeat for 2+ minutes).
 *
 * Usage:
 *   bun src/scripts/release-stuck-jobs.ts
 */

import { Client as PgClient } from "pg";

async function main() {
    const dbUrl =
        process.env.DATABASE_URL ||
        process.env.SUPABASE_DIRECT_URL ||
        process.env.DATABASE_DIRECT_URL;
    if (!dbUrl) {
        console.error(
            "Error: DATABASE_URL, SUPABASE_DIRECT_URL, or DATABASE_DIRECT_URL must be set"
        );
        process.exit(1);
    }

    const client = new PgClient({ connectionString: dbUrl });
    await client.connect();

    console.log("Checking for stuck jobs...");

    try {
        const result = await client.query(`
      UPDATE gh_automation_jobs
      SET
        status = 'pending',
        worker_id = NULL,
        error_details = jsonb_build_object(
          'released_by', 'manual-script',
          'reason', 'stuck_job_manual_recovery',
          'released_at', NOW()::TEXT
        )
      WHERE status IN ('queued', 'running')
        AND (
          last_heartbeat < NOW() - INTERVAL '120 seconds'
          OR last_heartbeat IS NULL
        )
      RETURNING id, job_type, worker_id, status, last_heartbeat
    `);

        if (result.rows.length === 0) {
            console.log("✓ No stuck jobs found");
        } else {
            console.log(`✓ Released ${result.rows.length} stuck job(s):\n`);
            for (const job of result.rows) {
                console.log(
                    `  - ${job.id} (${job.job_type}) - was assigned to ${
                        job.worker_id || "unknown"
                    }`
                );
            }
        }
    } catch (err) {
        console.error("Failed to release stuck jobs:", err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
