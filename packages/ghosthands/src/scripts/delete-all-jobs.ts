#!/usr/bin/env bun
/**
 * Delete All Jobs Script
 *
 * Deletes all jobs from the gh_automation_jobs table.
 * Use with caution - this is destructive!
 *
 * Usage:
 *   cd packages/ghosthands && bun src/scripts/delete-all-jobs.ts
 *   cd packages/ghosthands && bun src/scripts/delete-all-jobs.ts --status=failed
 *   cd packages/ghosthands && bun src/scripts/delete-all-jobs.ts --status=pending,queued
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

    // Parse --status flag
    const statusArg = process.argv.find((arg) => arg.startsWith("--status="));
    const statuses = statusArg
        ? statusArg
              .split("=")[1]
              .split(",")
              .map((s) => s.trim())
        : null;

    const client = new PgClient({ connectionString: dbUrl });
    await client.connect();

    try {
        if (statuses) {
            console.log(
                `🗑️  Deleting jobs with status: ${statuses.join(", ")}...\n`
            );

            const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
            const result = await client.query(
                `DELETE FROM gh_automation_jobs 
         WHERE status IN (${placeholders})
         RETURNING id, job_type, status`,
                statuses
            );

            if (result.rows.length === 0) {
                console.log("✅ No jobs found with those statuses");
            } else {
                console.log(`✅ Deleted ${result.rows.length} job(s):\n`);
                const byStatus: Record<string, number> = {};
                for (const job of result.rows) {
                    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
                }
                for (const [status, count] of Object.entries(byStatus)) {
                    console.log(`   ${status}: ${count}`);
                }
            }
        } else {
            console.log("🗑️  Deleting ALL jobs...\n");

            // First count them
            const countResult = await client.query(
                "SELECT COUNT(*) as count FROM gh_automation_jobs"
            );
            const total = parseInt(countResult.rows[0].count);

            if (total === 0) {
                console.log("✅ No jobs to delete");
                return;
            }

            console.log(
                `⚠️  About to delete ${total} job(s). This cannot be undone!`
            );
            console.log(
                "   Press Ctrl-C to cancel, or wait 3 seconds to proceed...\n"
            );

            await new Promise((resolve) => setTimeout(resolve, 3000));

            const result = await client.query(`
        DELETE FROM gh_automation_jobs 
        RETURNING status
      `);

            const byStatus: Record<string, number> = {};
            for (const job of result.rows) {
                byStatus[job.status] = (byStatus[job.status] || 0) + 1;
            }

            console.log(`✅ Deleted ${result.rows.length} job(s):\n`);
            for (const [status, count] of Object.entries(byStatus)) {
                console.log(`   ${status}: ${count}`);
            }
        }

        // Also clean up job events
        console.log("\n🧹 Cleaning up orphaned job events...");
        const eventsResult = await client.query(`
      DELETE FROM gh_job_events 
      WHERE job_id NOT IN (SELECT id FROM gh_automation_jobs)
    `);
        console.log(
            `   Deleted ${eventsResult.rowCount || 0} orphaned event(s)`
        );
    } catch (err) {
        console.error("❌ Error:", err);
        process.exit(1);
    } finally {
        await client.end();
    }

    console.log("\n✨ Done!");
}

main();
