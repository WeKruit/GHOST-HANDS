/**
 * @wekruit/ghosthands-engine — Job application automation engine.
 *
 * Public API for the GH-Desktop-App.
 * The desktop app imports from this package instead of copying engine files directly.
 *
 * @packageDocumentation
 */

// ── High-level API ────────────────────────────────────────────────────
export { runApplication, cancelApplication } from './runApplication';

// ── Types ─────────────────────────────────────────────────────────────
export type {
  EngineConfig,
  EngineProfile,
  EducationEntry,
  ExperienceEntry,
  RunParams,
  RunResult,
  ProgressEvent,
  ManualStore,
  ActionManual,
  ManualStep,
  ManualSource,
  LocatorDescriptor,
  LogEventCallback,
} from './types';

// ── Schemas ───────────────────────────────────────────────────────────
export {
  ActionManualSchema,
  ManualStepSchema,
  ManualSourceSchema,
  LocatorDescriptorSchema,
} from './types';

// ── Cookbook execution ─────────────────────────────────────────────────
export { CookbookExecutor, type ExecuteAllResult, type ExecuteStepResult, type CookbookExecutorOptions } from './CookbookExecutor';
export { LocatorResolver, type ResolveResult, type LocatorResolverOptions } from './LocatorResolver';
export { resolveTemplate, resolveOptionalTemplate } from './templateResolver';
export { detectPlatform, generateUrlPattern } from './platformDetector';

// ── v3 engine ────────────────────────────────────────────────────────
export * as v3 from '../../ghosthands/src/engine/v3';

// ── Full module namespace exports (lazy-loaded) ─────────────────────
// These namespaces are lazy-loaded via getters so that requiring the main
// entry point doesn't crash when modules have internal import resolution
// issues at eager-load time. Each module is only loaded when its namespace
// property is first accessed.

import type * as _api from '../../ghosthands/src/api';
import type * as _client from '../../ghosthands/src/client';
import type * as _context from '../../ghosthands/src/context';
import type * as _db from '../../ghosthands/src/db';
import type * as _security from '../../ghosthands/src/security';
import type * as _sessions from '../../ghosthands/src/sessions';
import type * as _adapters from '../../ghosthands/src/adapters';
import type * as _workers from '../../ghosthands/src/workers';
import type * as _events from '../../ghosthands/src/events';
import type * as _lib from '../../ghosthands/src/lib';
import type * as _config from '../../ghosthands/src/config';
import type * as _connectors from '../../ghosthands/src/connectors';
import type * as _monitoring from '../../ghosthands/src/monitoring';
import type * as _detection from '../../ghosthands/src/detection';
import type * as _workflows from '../../ghosthands/src/workflows/mastra';

export const api: typeof _api = undefined!;
export const client: typeof _client = undefined!;
export const context: typeof _context = undefined!;
export const db: typeof _db = undefined!;
export const security: typeof _security = undefined!;
export const sessions: typeof _sessions = undefined!;
export const adapters: typeof _adapters = undefined!;
export const workers: typeof _workers = undefined!;
export const events: typeof _events = undefined!;
export const lib: typeof _lib = undefined!;
export const config: typeof _config = undefined!;
export const connectors: typeof _connectors = undefined!;
export const monitoring: typeof _monitoring = undefined!;
export const detection: typeof _detection = undefined!;
export const workflows: typeof _workflows = undefined!;

// Runtime: replace placeholder values with lazy getters
const _ns = module.exports;
function _lazyNs(name: string, path: string) {
  let mod: any;
  Object.defineProperty(_ns, name, {
    get() { if (!mod) mod = require(path); return mod; },
    enumerable: true,
    configurable: true,
  });
}
_lazyNs('api', '../../ghosthands/src/api');
_lazyNs('client', '../../ghosthands/src/client');
_lazyNs('context', '../../ghosthands/src/context');
_lazyNs('db', '../../ghosthands/src/db');
_lazyNs('security', '../../ghosthands/src/security');
_lazyNs('sessions', '../../ghosthands/src/sessions');
_lazyNs('adapters', '../../ghosthands/src/adapters');
_lazyNs('workers', '../../ghosthands/src/workers');
_lazyNs('events', '../../ghosthands/src/events');
_lazyNs('lib', '../../ghosthands/src/lib');
_lazyNs('config', '../../ghosthands/src/config');
_lazyNs('connectors', '../../ghosthands/src/connectors');
_lazyNs('monitoring', '../../ghosthands/src/monitoring');
_lazyNs('detection', '../../ghosthands/src/detection');
_lazyNs('workflows', '../../ghosthands/src/workflows/mastra');
