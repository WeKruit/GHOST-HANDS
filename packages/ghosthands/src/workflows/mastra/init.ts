import { Mastra } from '@mastra/core';
import { PostgresStore } from '@mastra/pg';
import { getLogger } from '../../monitoring/logger.js';

const logger = getLogger({ service: 'mastra-init' });

let _mastra: Mastra | null = null;
let _mastraConfigKey: string | null = null;

type MastraInitOptions = ConstructorParameters<typeof Mastra>[0];
type MastraStorage = MastraInitOptions extends { storage?: infer T } ? T : never;

export interface WorkflowStoreFactory {
  create(): MastraStorage | undefined;
}

export interface CreateMastraOptions {
  mode?: 'hosted' | 'desktop';
  storeFactory?: WorkflowStoreFactory;
}

function hasHostedConnectionString(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL);
}

function createDefaultStore(mode: 'hosted' | 'desktop'): MastraStorage | undefined {
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

function configKey(options: CreateMastraOptions): string {
  return JSON.stringify({
    mode: options.mode ?? 'hosted',
    hasStoreFactory: !!options.storeFactory,
  });
}

/**
 * Get or create the Mastra singleton instance.
 *
 * Uses PostgresStore for durable workflow snapshots (suspend/resume).
 * Connection string from DATABASE_URL or SUPABASE_DIRECT_URL env vars.
 */
export function createMastra(options: CreateMastraOptions = {}): Mastra {
  const nextConfigKey = configKey(options);
  if (_mastra) {
    if (_mastraConfigKey && _mastraConfigKey !== nextConfigKey) {
      throw new Error(
        `Mastra is already initialized with ${_mastraConfigKey}. Reset before reinitializing with ${nextConfigKey}.`,
      );
    }
    return _mastra;
  }

  const mode = options.mode ?? 'hosted';
  const store = options.storeFactory?.create() ?? createDefaultStore(mode);
  _mastra = store ? new Mastra({ storage: store }) : new Mastra({});
  _mastraConfigKey = nextConfigKey;

  logger.info('Mastra singleton initialized', { mode, hasStorage: !!store });
  return _mastra;
}

export function getMastra(): Mastra {
  if (_mastra) return _mastra;
  return createMastra({
    mode: hasHostedConnectionString() ? 'hosted' : 'desktop',
  });
}

/**
 * Reset the singleton (for testing only).
 */
export function resetMastra(): void {
  _mastra = null;
  _mastraConfigKey = null;
}
