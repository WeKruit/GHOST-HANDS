#!/usr/bin/env bun
/**
 * Worker launcher — sets env vars BEFORE ESM imports hoist magnitude-core / BAML.
 *
 * ESM static imports execute before module body code, so `process.env.X ??= 'y'`
 * in main.ts runs AFTER magnitude-core's module init reads the env vars.
 * This dynamic import() launcher ensures env vars are set first.
 */
import path from 'node:path';

process.env.BAML_LOG ??= 'off';
process.env.MAGNITUDE_LOG_LEVEL ??= 'warn';

function resolveCliWorkerId(): string | null {
  const arg = process.argv.find((value) => value.startsWith('--worker-id='));
  if (!arg) return null;
  const workerId = arg.split('=').slice(1).join('=').trim();
  return workerId.length > 0 ? workerId : null;
}

function safeWorkerLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function configureLocalWorkerLogFile(): void {
  if (process.env.GH_LOG_FILE === 'false') return;

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (process.env.GH_LOG_FILE !== 'true' && nodeEnv === 'production') return;

  process.env.GH_LOG_FILE ??= 'true';

  const workerId =
    resolveCliWorkerId() ||
    process.env.GH_WORKER_ID ||
    'local';
  const workerLabel = safeWorkerLabel(workerId);

  if (!process.env.GH_LOG_FILE_PATH) {
    process.env.GH_LOG_FILE_PATH = path.resolve(
      process.cwd(),
      'logs',
      `worker-${workerLabel}.latest.log`,
    );
  }

  process.env.GH_ACT_SUMMARY_MIRROR_PATH ??= path.resolve(
    process.cwd(),
    'logs',
    `worker-${workerLabel}.act_summary.latest.json`,
  );

  process.env.GH_LOG_FILE_TRUNCATE ??= 'true';
}

configureLocalWorkerLogFile();

import('./main.js');
