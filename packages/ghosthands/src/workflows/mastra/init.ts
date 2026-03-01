import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { getLogger } from '../../monitoring/logger.js';

const logger = getLogger({ service: 'mastra-init' });

let _mastra: Mastra | null = null;

/**
 * Get or create the Mastra singleton instance.
 *
 * Uses PostgresStore for durable workflow snapshots (suspend/resume).
 * Connection string from DATABASE_URL or SUPABASE_DIRECT_URL env vars.
 */
export function getMastra(): Mastra {
  if (_mastra) return _mastra;

  const connectionString =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DIRECT_URL;

  if (!connectionString) {
    throw new Error(
      'Mastra requires DATABASE_URL or SUPABASE_DIRECT_URL for PostgresStore. ' +
      'Cannot initialize workflow engine without a Postgres connection.',
    );
  }

  const store = new PostgresStore({ id: 'ghosthands', connectionString });

  _mastra = new Mastra({
    storage: store,
  });

  logger.info('Mastra singleton initialized with PostgresStore');
  return _mastra;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetMastra(): void {
  _mastra = null;
}
