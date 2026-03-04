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

function isHostedWorker(): boolean {
  return !!(
    process.env.AWS_ASG_NAME ||
    process.env.EC2_INSTANCE_ID ||
    process.env.NODE_ENV === 'production'
  );
}

function hasHostedConnectionString(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DIRECT_URL);
}

function createDefaultStore(mode: 'hosted' | 'desktop'): MastraStorage | undefined {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DIRECT_URL;

  if (connectionString) {
    return new PostgresStore({ id: 'ghosthands', connectionString }) as MastraStorage;
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

/**
 * Get or lazily create the Mastra singleton.
 *
 * - **Hosted workers** (EC2 / production): throws a P0-level error when the
 *   database connection string is missing — this is a deployment misconfiguration.
 * - **Desktop workers**: logs a warning and returns `null` — desktop mode does
 *   not require Mastra/Postgres workflows.
 */
export function getMastra(): Mastra | null {
  if (_mastra) return _mastra;

  const hosted = isHostedWorker();

  if (!hasHostedConnectionString() && !hosted) {
    logger.warn(
      'getMastra(): no DATABASE_URL / SUPABASE_DIRECT_URL — returning null (desktop mode)',
    );
    return null;
  }

  if (!hasHostedConnectionString() && hosted) {
    throw new Error(
      '[P0] HOSTED WORKER MISSING DATABASE CONNECTION\n' +
      '─────────────────────────────────────────────\n' +
      'getMastra() was called on a hosted worker (EC2/production) but neither\n' +
      'DATABASE_URL nor SUPABASE_DIRECT_URL is set.\n\n' +
      'Remediation steps:\n' +
      '  1. Check the env_file / docker-compose env section on this instance\n' +
      '  2. Verify Infisical / AWS Secrets Manager has the DATABASE_URL secret\n' +
      '  3. Re-deploy the worker: `deploy.sh` or trigger CD pipeline\n' +
      '  4. If this is intentional, unset AWS_ASG_NAME and EC2_INSTANCE_ID\n' +
      '     to run in desktop mode.\n',
    );
  }

  return createMastra({
    mode: hosted ? 'hosted' : 'desktop',
  });
}

/**
 * Reset the singleton (for testing only).
 */
export function resetMastra(): void {
  _mastra = null;
  _mastraConfigKey = null;
}
