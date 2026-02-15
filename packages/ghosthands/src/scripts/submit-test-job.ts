#!/usr/bin/env bun
/**
 * Submit Test Job Script
 *
 * Creates a test job directly in the database for testing worker functionality.
 *
 * Usage:
 *   cd packages/ghosthands && bun src/scripts/submit-test-job.ts
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

    console.log("📝 Creating test job...\n");

    try {
        const result = await client.query(
            `
      INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority
      ) VALUES (
        'apply',
        'https://www.google.com',
        'Search for "GhostHands browser automation" and report the first result title',
        $1::jsonb,
        $2,
        'pending',
        120, 1, 1
      )
      RETURNING id, status, target_url, task_description
    `,
            [
                JSON.stringify({
                    user_data: {
                        first_name: "Test",
                        last_name: "User",
                        email: "test@example.com",
                    },
                }),
                "00000000-0000-0000-0000-000000000001", // test user UUID
            ]
        );

        const job = result.rows[0];
        console.log("✅ Test job created!\n");
        console.log(`   Job ID: ${job.id}`);
        console.log(`   Status: ${job.status}`);
        console.log(`   URL:    ${job.target_url}`);
        console.log(`   Task:   ${job.task_description}`);
        console.log(
            "\n👀 Watch your worker terminal - it should pick this up within 5 seconds."
        );
    } catch (err) {
        console.error("❌ Error creating job:", err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
