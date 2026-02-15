#!/usr/bin/env bun
/**
 * Test Worker Shutdown Cleanup
 *
 * This script verifies that the worker properly releases jobs on shutdown.
 *
 * Usage:
 *   cd packages/ghosthands && bun src/scripts/test-shutdown-cleanup.ts
 */

import { Client as PgClient } from "pg";

async function main() {
    const dbUrl =
        process.env.DATABASE_URL ||
        process.env.SUPABASE_DIRECT_URL ||
        process.env.DATABASE_DIRECT_URL;
    if (!dbUrl) {
        console.error("Error: DATABASE_URL must be set");
        process.exit(1);
    }

    const client = new PgClient({ connectionString: dbUrl });
    await client.connect();

    console.log("🧪 Testing Worker Shutdown Cleanup\n");

    try {
        // Check for jobs currently claimed by workers
        const result = await client.query(`
      SELECT id, worker_id, status, last_heartbeat
      FROM gh_automation_jobs
      WHERE status IN ('queued', 'running')
        AND worker_id IS NOT NULL
      ORDER BY last_heartbeat DESC NULLS LAST
    `);

        const jobs = result.rows;

        console.log(
            `📊 Found ${jobs.length} job(s) currently claimed by workers:\n`
        );

        if (jobs.length === 0) {
            console.log("✅ No jobs currently claimed - system is clean!");
        } else {
            for (const job of jobs) {
                const heartbeatAge = job.last_heartbeat
                    ? Math.floor(
                          (Date.now() -
                              new Date(job.last_heartbeat).getTime()) /
                              1000
                      )
                    : null;

                const isStuck = heartbeatAge === null || heartbeatAge > 120;
                const icon = isStuck ? "⚠️" : "✅";

                console.log(`${icon} Job ${job.id}`);
                console.log(`   Worker: ${job.worker_id}`);
                console.log(`   Status: ${job.status}`);
                console.log(
                    `   Last heartbeat: ${
                        heartbeatAge === null ? "never" : `${heartbeatAge}s ago`
                    }`
                );
                console.log();
            }

            // Count stuck vs active
            const stuck = jobs.filter((j) => {
                if (!j.last_heartbeat) return true;
                const age = Math.floor(
                    (Date.now() - new Date(j.last_heartbeat).getTime()) / 1000
                );
                return age > 120;
            });

            console.log(`\n📈 Summary:`);
            console.log(`   Active jobs: ${jobs.length - stuck.length}`);
            console.log(`   Stuck jobs: ${stuck.length}`);

            if (stuck.length > 0) {
                console.log(
                    `\n💡 Run: bun run release-stuck-jobs to clean up stuck jobs`
                );
            }
        }

        console.log("\n🧪 Test Instructions:");
        console.log("   1. Start worker: bun run worker");
        console.log("   2. Submit a job (via API or another terminal)");
        console.log("   3. Wait for worker to pick up the job");
        console.log(
            "   4. Hit Ctrl-C ONCE to shutdown worker (wait, don't double Ctrl-C!)"
        );
        console.log("   5. Run this script again");
        console.log(
            "   6. Expected: Job should be released (worker_id = NULL, status = pending)"
        );
        console.log(
            '   7. Check worker logs for: "[JobPoller] Released X job(s) back to queue"'
        );
    } catch (err) {
        console.error("❌ Error:", err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
