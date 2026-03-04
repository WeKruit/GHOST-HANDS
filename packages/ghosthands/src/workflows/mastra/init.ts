import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { getLogger } from '../../monitoring/logger.js';

const logger = getLogger({ service: 'mastra-init' });

let _mastra: Mastra | null = null;

export interface WorkflowStoreFactory {
  create(): unknown;
}

export interface CreateMastraOptions {
  mode?: 'hosted' | 'desktop';
  storeFactory?: WorkflowStoreFactory;
}

function createDefaultStore(mode: 'hosted' | 'desktop'): unknown | undefined {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DIRECT_URL;

  if (connectionString) {
    return new PostgresStore({ id: 'ghosthands', connectionString });
  }

  if (mode === 'desktop') {
    logger.warn('Mastra initialized without durable storage (desktop fallback mode)');
    return undefined;
  }

  throw new Error(
    'Mastra requires DATABASE_URL or SUPABASE_DIRECT_URL for PostgresStore. ' +
    'Cannot initialize workflow engine without a Postgres connection.',
  );
}

/**
 * Get or create the Mastra singleton instance.
 *
 * Uses PostgresStore for durable workflow snapshots (suspend/resume).
 * Connection string from DATABASE_URL or SUPABASE_DIRECT_URL env vars.
 */
export function createMastra(options: CreateMastraOptions = {}): Mastra {
  if (_mastra) return _mastra;

  const mode = options.mode ?? 'hosted';
  const store = options.storeFactory?.create() ?? createDefaultStore(mode);
  _mastra = store
    ? new Mastra({
        storage: store as any,
      })
    : new Mastra({});

  logger.info('Mastra singleton initialized', { mode, hasStorage: !!store });
  return _mastra;
}

export function getMastra(): Mastra {
  return createMastra();
}

/**
 * Reset the singleton (for testing only).
 */
export function resetMastra(): void {
  _mastra = null;
}
