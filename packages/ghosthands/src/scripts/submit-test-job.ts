#!/usr/bin/env bun
/**
 * Submit Test Job Script
 *
 * Creates a test job directly in the database for testing worker functionality.
 *
 * Usage:
 *   bun src/scripts/submit-test-job.ts                        # any worker picks it up
 *   bun src/scripts/submit-test-job.ts --worker-id=adam       # only worker "adam" picks it up
 */

import { Client as PgClient } from "pg";

function parseTargetWorkerId(): string | null {
    const arg = process.argv.find((a) => a.startsWith("--worker-id="));
    if (arg) {
        const id = arg.split("=")[1];
        if (!id) {
            console.error("--worker-id requires a value (e.g. --worker-id=adam)");
            process.exit(1);
        }
        return id;
    }
    return null;
}

async function main() {
    const dbUrl =
        process.env.DATABASE_URL ||
        process.env.SUPABASE_DIRECT_URL ||
        process.env.DATABASE_DIRECT_URL;
    if (!dbUrl) {
        console.error("Error: DATABASE_URL must be set");
        process.exit(1);
    }

    const targetWorkerId = parseTargetWorkerId();
    const client = new PgClient({ connectionString: dbUrl });
    await client.connect();

    console.log("Creating test job...\n");

    try {
        const result = await client.query(
            `
      INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority,
        target_worker_id
      ) VALUES (
        'custom',
        'https://www.google.com',
        'Search for "GhostHands browser automation" and report the first result title',
        $1::jsonb,
        $2,
        'pending',
        300, 1, 1,
        $3
      )
      RETURNING id, status, target_url, task_description, target_worker_id
    `,
            [
                JSON.stringify({}),
                process.env.GH_TEST_USER_ID || "00000000-0000-0000-0000-000000000001",
                targetWorkerId,
            ]
        );

        const job = result.rows[0];
        console.log("Test job created!\n");
        console.log(`   Job ID:  ${job.id}`);
        console.log(`   Status:  ${job.status}`);
        console.log(`   URL:     ${job.target_url}`);
        console.log(`   Task:    ${job.task_description}`);
        if (job.target_worker_id) {
            console.log(`   Target:  ${job.target_worker_id} (only this worker will pick it up)`);
        } else {
            console.log(`   Target:  any worker`);
        }
        console.log(
            "\nWatch your worker terminal - it should pick this up within 5 seconds."
        );
    } catch (err) {
        console.error("Error creating job:", err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
