#!/usr/bin/env bun
/**
 * GhostHands Job CLI
 *
 * Manage jobs directly from the terminal — no API server or extra terminal needed.
 * Talks to the database directly.
 *
 * Usage:
 *   bun run job list                    # List active jobs
 *   bun run job status <id>             # Get job details
 *   bun run job cancel <id>             # Cancel a job
 *   bun run job cancel --all            # Cancel all active jobs
 *   bun run job cancel --worker=adam    # Cancel all jobs targeted to adam
 *   bun run job retry <id>              # Retry a failed/cancelled job
 *   bun run job logs <id>               # Show job events
 */

import { Client as PgClient } from "pg";

const CANCELLABLE = ["pending", "queued", "running", "paused"];
const RETRYABLE = ["failed", "cancelled"];

async function getClient(): Promise<PgClient> {
    const dbUrl =
        process.env.DATABASE_URL ||
        process.env.SUPABASE_DIRECT_URL ||
        process.env.DATABASE_DIRECT_URL;
    if (!dbUrl) {
        console.error("Error: DATABASE_URL must be set");
        process.exit(1);
    }
    const c = new PgClient({ connectionString: dbUrl });
    await c.connect();
    return c;
}

function ago(dateStr: string): string {
    const seconds = Math.floor(
        (Date.now() - new Date(dateStr).getTime()) / 1000
    );
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function shortId(id: string): string {
    return id.substring(0, 8);
}

// ── Commands ──

async function listJobs() {
    const c = await getClient();
    const { rows } = await c.query(`
        SELECT id, job_type, status, target_url, target_worker_id, worker_id,
               created_at, started_at, completed_at
        FROM gh_automation_jobs
        ORDER BY
            CASE status
                WHEN 'running' THEN 1
                WHEN 'queued' THEN 2
                WHEN 'pending' THEN 3
                WHEN 'paused' THEN 4
                WHEN 'failed' THEN 5
                WHEN 'completed' THEN 6
                ELSE 7
            END,
            created_at DESC
        LIMIT 20
    `);
    await c.end();

    if (rows.length === 0) {
        console.log("No jobs found.");
        return;
    }

    console.log(
        "STATUS".padEnd(12) +
            "ID".padEnd(10) +
            "TYPE".padEnd(10) +
            "TARGET".padEnd(10) +
            "WORKER".padEnd(12) +
            "AGE".padEnd(10) +
            "URL"
    );
    console.log("-".repeat(90));

    for (const row of rows) {
        const status =
            row.status === "running"
                ? `\x1b[32m${row.status}\x1b[0m`
                : row.status === "failed"
                  ? `\x1b[31m${row.status}\x1b[0m`
                  : row.status === "pending"
                    ? `\x1b[33m${row.status}\x1b[0m`
                    : row.status;

        console.log(
            row.status.padEnd(12) +
                shortId(row.id).padEnd(10) +
                (row.job_type || "").padEnd(10) +
                (row.target_worker_id || "any").padEnd(10) +
                (row.worker_id || "-").padEnd(12) +
                ago(row.created_at).padEnd(10) +
                (row.target_url || "").substring(0, 40)
        );
    }
    console.log(`\n${rows.length} job(s)`);
}

async function jobStatus(jobId: string) {
    const c = await getClient();

    // Support short IDs
    let whereClause = "id = $1::UUID";
    if (jobId.length < 36) {
        whereClause = "id::TEXT LIKE $1 || '%'";
    }

    const { rows } = await c.query(
        `SELECT * FROM gh_automation_jobs WHERE ${whereClause} LIMIT 1`,
        [jobId]
    );
    await c.end();

    if (rows.length === 0) {
        console.error(`Job not found: ${jobId}`);
        process.exit(1);
    }

    const job = rows[0];
    console.log(`Job:      ${job.id}`);
    console.log(`Status:   ${job.status}`);
    console.log(`Type:     ${job.job_type}`);
    console.log(`URL:      ${job.target_url}`);
    console.log(`Task:     ${job.task_description}`);
    console.log(`Worker:   ${job.worker_id || "(none)"}`);
    console.log(`Target:   ${job.target_worker_id || "(any)"}`);
    console.log(`Created:  ${job.created_at}`);
    if (job.started_at) console.log(`Started:  ${job.started_at}`);
    if (job.completed_at) console.log(`Finished: ${job.completed_at}`);
    if (job.started_at && job.completed_at) {
        const dur =
            (new Date(job.completed_at).getTime() -
                new Date(job.started_at).getTime()) /
            1000;
        console.log(`Duration: ${dur}s`);
    }
    if (job.error_code)
        console.log(`Error:    ${job.error_code}`);
    if (job.error_details)
        console.log(
            `Details:  ${JSON.stringify(job.error_details, null, 2)}`
        );
    if (job.result_data)
        console.log(
            `Result:   ${JSON.stringify(job.result_data, null, 2)}`
        );
}

async function cancelJob(args: string[]) {
    const c = await getClient();

    const cancelAll = args.includes("--all");
    const workerArg = args.find((a) => a.startsWith("--worker="));
    const targetWorker = workerArg ? workerArg.split("=")[1] : null;
    const jobId = args.find((a) => !a.startsWith("-"));

    if (!cancelAll && !targetWorker && !jobId) {
        console.error(
            "Usage: bun run job cancel <id> | --all | --worker=<name>"
        );
        process.exit(1);
    }

    let result;

    if (cancelAll) {
        result = await c.query(
            `UPDATE gh_automation_jobs
             SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
             WHERE status = ANY($1::TEXT[])
             RETURNING id, status`,
            [CANCELLABLE]
        );
    } else if (targetWorker) {
        result = await c.query(
            `UPDATE gh_automation_jobs
             SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
             WHERE status = ANY($1::TEXT[])
               AND (target_worker_id = $2 OR worker_id = $2)
             RETURNING id, status`,
            [CANCELLABLE, targetWorker]
        );
    } else {
        // Support short IDs
        let whereClause = "id = $2::UUID";
        if (jobId!.length < 36) {
            whereClause = "id::TEXT LIKE $2 || '%'";
        }
        result = await c.query(
            `UPDATE gh_automation_jobs
             SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
             WHERE status = ANY($1::TEXT[]) AND ${whereClause}
             RETURNING id, status`,
            [CANCELLABLE, jobId]
        );
    }

    await c.end();

    if (result.rows.length === 0) {
        console.log("No cancellable jobs found.");
    } else {
        console.log(`Cancelled ${result.rows.length} job(s):`);
        for (const row of result.rows) {
            console.log(`  ${shortId(row.id)} -> cancelled`);
        }
    }
}

async function retryJob(jobId: string) {
    if (!jobId) {
        console.error("Usage: bun run job retry <id>");
        process.exit(1);
    }

    const c = await getClient();

    let whereClause = "id = $2::UUID";
    if (jobId.length < 36) {
        whereClause = "id::TEXT LIKE $2 || '%'";
    }

    const result = await c.query(
        `UPDATE gh_automation_jobs
         SET status = 'pending', worker_id = NULL,
             error_code = NULL, error_details = NULL,
             started_at = NULL, completed_at = NULL, last_heartbeat = NULL,
             retry_count = retry_count + 1, updated_at = NOW()
         WHERE status = ANY($1::TEXT[]) AND ${whereClause}
         RETURNING id, retry_count`,
        [RETRYABLE, jobId]
    );

    await c.end();

    if (result.rows.length === 0) {
        console.error(
            `Job ${jobId} not found or not retryable (must be failed/cancelled).`
        );
        process.exit(1);
    }

    const row = result.rows[0];
    console.log(
        `Retried ${shortId(row.id)} (attempt ${row.retry_count}) -> pending`
    );
}

async function jobLogs(jobId: string) {
    if (!jobId) {
        console.error("Usage: bun run job logs <id>");
        process.exit(1);
    }

    const c = await getClient();

    // Resolve short ID
    let resolvedId = jobId;
    if (jobId.length < 36) {
        const { rows } = await c.query(
            "SELECT id FROM gh_automation_jobs WHERE id::TEXT LIKE $1 || '%' LIMIT 1",
            [jobId]
        );
        if (rows.length === 0) {
            console.error(`Job not found: ${jobId}`);
            await c.end();
            process.exit(1);
        }
        resolvedId = rows[0].id;
    }

    const { rows } = await c.query(
        `SELECT event_type, message, metadata, created_at
         FROM gh_job_events
         WHERE job_id = $1::UUID
         ORDER BY created_at ASC`,
        [resolvedId]
    );
    await c.end();

    if (rows.length === 0) {
        console.log(`No events for job ${shortId(resolvedId)}`);
        return;
    }

    for (const row of rows) {
        const time = new Date(row.created_at).toLocaleTimeString();
        const msg = row.message || "";
        console.log(`[${time}] ${row.event_type.padEnd(20)} ${msg}`);
    }
    console.log(`\n${rows.length} event(s)`);
}

// ── Main ──

const [command, ...args] = process.argv.slice(2);

switch (command) {
    case "list":
    case "ls":
        await listJobs();
        break;
    case "status":
    case "s":
        if (!args[0]) {
            console.error("Usage: bun run job status <id>");
            process.exit(1);
        }
        await jobStatus(args[0]);
        break;
    case "cancel":
    case "c":
        await cancelJob(args);
        break;
    case "retry":
    case "r":
        await retryJob(args[0]);
        break;
    case "logs":
    case "l":
        await jobLogs(args[0]);
        break;
    default:
        console.log(`GhostHands Job CLI

Usage: bun run job <command> [args]

Commands:
  list                      List recent jobs (alias: ls)
  status <id>               Show job details (alias: s)
  cancel <id>               Cancel a specific job (alias: c)
  cancel --all              Cancel all active jobs
  cancel --worker=<name>    Cancel all jobs for a worker
  retry <id>                Retry a failed/cancelled job (alias: r)
  logs <id>                 Show job event log (alias: l)

Short IDs supported: "bun run job cancel a23c" matches "a23c728e-..."
`);
        break;
}
