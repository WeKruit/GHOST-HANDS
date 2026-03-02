/**
 * Worker-side resume coordination logic for Mastra workflows.
 *
 * Implements PRD V5.2 Section 8.3:
 * - Discriminates Mastra resume jobs from legacy jobs
 * - Atomically claims resumes to prevent double-consumption
 * - Reads and clears resolution data (may contain passwords/2FA)
 * - Persists mastra_run_id before first execution
 * - Dispatch mode helpers for phased rollout
 */
import pg from 'pg';

import type { AutomationJob } from '../../workers/taskHandlers/types.js';
import { getLogger } from '../../monitoring/logger.js';

const logger = getLogger({ service: 'resume-coordinator' });

// ---------------------------------------------------------------------------
// 1. Resume Discriminator
// ---------------------------------------------------------------------------

/**
 * Returns true if and only if the job is a Mastra resume:
 * - execution_mode is 'mastra'
 * - metadata.mastra_run_id is a string
 * - metadata.resume_requested is true
 */
export function isMastraResume(job: AutomationJob): boolean {
  return (
    job.execution_mode === 'mastra' &&
    typeof job.metadata?.mastra_run_id === 'string' &&
    job.metadata?.resume_requested === true
  );
}

// ---------------------------------------------------------------------------
// 2. Atomic Resume Claim
// ---------------------------------------------------------------------------

/**
 * Atomically claims a resume to prevent double-consumption.
 *
 * Uses a single UPDATE ... RETURNING to flip resume_requested to false only
 * when the row still matches all preconditions (correct execution_mode,
 * eligible status, matching mastra_run_id, and resume_requested = true).
 *
 * Returns the updated metadata if the claim succeeded, or null if the row
 * was already claimed or preconditions were not met.
 */
export async function claimResume(
  pool: pg.Pool,
  jobId: string,
  mastraRunId: string,
): Promise<Record<string, any> | null> {
  const sql = `
    UPDATE gh_automation_jobs
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{resume_requested}', 'false'::jsonb, true)
    WHERE id = $1::uuid
      AND execution_mode = 'mastra'
      AND status IN ('pending', 'queued')
      AND metadata->>'mastra_run_id' = $2
      AND COALESCE((metadata->>'resume_requested')::boolean, false) = true
    RETURNING metadata;
  `;

  try {
    const { rows } = await pool.query(sql, [jobId, mastraRunId]);

    if (rows.length === 0) {
      logger.debug('Resume claim returned no rows (already claimed or preconditions unmet)', {
        jobId,
        mastraRunId,
      });
      return null;
    }

    logger.info('Resume claimed successfully', { jobId, mastraRunId });
    return rows[0].metadata as Record<string, any>;
  } catch (err) {
    logger.error('Failed to claim resume', {
      jobId,
      mastraRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 3. Read & Clear Resolution Data
// ---------------------------------------------------------------------------

/**
 * Reads the resolution data from interaction_data and immediately clears the
 * sensitive fields (resolution_type, resolution_data, resolved_by, resolved_at).
 *
 * Resolution data may contain passwords, 2FA codes, or other credentials, so
 * it must not persist in the database longer than necessary.
 *
 * Returns parsed resolution or null if no interaction_data exists.
 */
export async function readResolutionData(
  pool: pg.Pool,
  jobId: string,
): Promise<{ resolutionType: string; resolutionData: Record<string, unknown> | null } | null> {
  try {
    // Step 1: Read interaction_data
    const { rows } = await pool.query(
      `SELECT interaction_data FROM gh_automation_jobs WHERE id = $1::UUID`,
      [jobId],
    );

    const interactionData = rows[0]?.interaction_data as Record<string, any> | null;

    if (!interactionData || !interactionData.resolution_type) {
      logger.debug('No resolution data found', { jobId });
      return null;
    }

    const resolutionType: string = interactionData.resolution_type || 'manual';
    const resolutionData: Record<string, unknown> | null =
      interactionData.resolution_data ?? null;

    // Step 2: SECURITY - Clear resolution data from DB immediately after reading.
    // This data may contain passwords, 2FA codes, or other credentials.
    // Must clear ALL sensitive fields — matches factory.ts readAndClearResolutionData.
    await pool.query(
      `UPDATE gh_automation_jobs
       SET interaction_data = interaction_data - 'resolution_type' - 'resolution_data' - 'resolved_by' - 'resolved_at' - 'otp' - 'credentials'
       WHERE id = $1::UUID`,
      [jobId],
    );

    logger.info('Resolution data read and cleared', { jobId, resolutionType });
    return { resolutionType, resolutionData };
  } catch (err) {
    logger.error('Failed to read resolution data', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. Persist Mastra Run ID
// ---------------------------------------------------------------------------

/**
 * Persists the mastra_run_id (and optional extra metadata) in job metadata
 * before first execution.
 *
 * This allows the resume discriminator and claim logic to correlate
 * incoming resume requests with the correct workflow run.
 *
 * @param extraMetadata - Additional keys to merge (e.g. `{ mastra_run_recreated: true }`)
 */
export async function persistMastraRunId(
  pool: pg.Pool,
  jobId: string,
  runId: string,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  const metadataObj: Record<string, unknown> = { mastra_run_id: runId, ...extraMetadata };
  const sql = `
    UPDATE gh_automation_jobs
    SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
        updated_at = NOW()
    WHERE id = $1::uuid
  `;

  try {
    await pool.query(sql, [jobId, JSON.stringify(metadataObj)]);
    logger.info('Persisted mastra_run_id', { jobId, runId, extraMetadata });
  } catch (err) {
    logger.error('Failed to persist mastra_run_id', {
      jobId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5. Dispatch Mode
// ---------------------------------------------------------------------------

/**
 * Returns the current dispatch mode from environment configuration.
 *
 * - 'legacy': Jobs dispatched via LISTEN/NOTIFY (current default)
 * - 'queue': Jobs dispatched via pg-boss queue
 */
export function getDispatchMode(): 'legacy' | 'queue' {
  return process.env.JOB_DISPATCH_MODE === 'queue' ? 'queue' : 'legacy';
}

// ---------------------------------------------------------------------------
// 6. Queue-Mode Resume Support
// ---------------------------------------------------------------------------

/**
 * Whether queue-mode resume is supported.
 *
 * Phase 1: always returns false. Queue-mode resume requires API-side pg-boss
 * enqueue which is not yet implemented. This guard prevents the worker from
 * attempting queue-based resume dispatch prematurely.
 */
export function isQueueModeResumeSupported(): boolean {
  return false;
}
