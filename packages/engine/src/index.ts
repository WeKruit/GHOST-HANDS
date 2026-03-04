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

// ── v3 supporting types & classes (used by Desktop App adapter) ──────
export { CostTracker } from '../../ghosthands/src/workers/costControl';
export type { AutomationJob } from '../../ghosthands/src/workers/taskHandlers/types';
export type { BrowserAutomationAdapter, AdapterEvent } from '../../ghosthands/src/adapters/types';

// ── Blocker detection ────────────────────────────────────────────────
export { BlockerDetector } from '../../ghosthands/src/detection/BlockerDetector';
export type { BlockerType, BlockerResult, DetectionSource } from '../../ghosthands/src/detection/BlockerDetector';

// ── HITL adapter + types ─────────────────────────────────────────────
export type {
  HitlCapableAdapter,
  ResolutionContext,
  ObservationResult,
  ObservationBlocker,
  BlockerCategory,
} from '../../ghosthands/src/adapters/types';

// ── Logger (so consumers can initialize with workerId before calling handlers)
export { getLogger, Logger } from '../../ghosthands/src/monitoring/logger';
export type { LoggerOptions } from '../../ghosthands/src/monitoring/logger';

// ── Sign-in handlers ─────────────────────────────────────────────────
export { handleGoogleSignIn } from '../../ghosthands/src/workers/taskHandlers/workday/googleSignIn';
export {
  handleLogin,
  handleVerificationCode,
  handlePhone2FA,
  handleAccountCreation,
} from '../../ghosthands/src/workers/taskHandlers/workday/pageHandlers';

// ── SmartApply orchestration loop ──────────────────────────────────
export { SmartApplyHandler } from '../../ghosthands/src/workers/taskHandlers/smartApplyHandler';

// ── Platform configuration system ──────────────────────────────────
export type { PlatformConfig, PageType, ScannedField, ScanResult }
  from '../../ghosthands/src/workers/taskHandlers/platforms/types';
export type { PageState as SmartApplyPageState }
  from '../../ghosthands/src/workers/taskHandlers/platforms/types';
export { detectPlatformFromUrl, getPlatformConfig }
  from '../../ghosthands/src/workers/taskHandlers/platforms/index';

// ── Form filling ───────────────────────────────────────────────────
export { fillFormOnPage, buildProfileText }
  from '../../ghosthands/src/workers/taskHandlers/formFiller';
export type { FillResult }
  from '../../ghosthands/src/workers/taskHandlers/formFiller';

// ── Task handler types (needed for SmartApplyHandler.execute ctx) ──
export type { TaskContext, TaskResult, TaskHandler }
  from '../../ghosthands/src/workers/taskHandlers/types';

// ── Workday types (needed by handler consumers) ──────────────────────
export type { WorkdayUserProfile } from '../../ghosthands/src/workers/taskHandlers/workday/workdayTypes';
export type { PageState as WorkdayPageState } from '../../ghosthands/src/workers/taskHandlers/workday/constants';

// ── Mastra workflow orchestration ──────────────────────────────────
export { buildApplyWorkflow } from '../../ghosthands/src/workflows/mastra/applyWorkflow';
export { getMastra, resetMastra } from '../../ghosthands/src/workflows/mastra/init';
export {
  isMastraResume,
  claimResume,
  readResolutionData,
  persistMastraRunId,
  getDispatchMode,
  isQueueModeResumeSupported,
} from '../../ghosthands/src/workflows/mastra/resumeCoordinator';
export {
  workflowState,
  blockerResumeSchema,
  FORBIDDEN_SCHEMA_KEYS,
} from '../../ghosthands/src/workflows/mastra/types';
export type {
  WorkflowState,
  BlockerResumeData,
  RuntimeContext,
} from '../../ghosthands/src/workflows/mastra/types';
export { buildSteps } from '../../ghosthands/src/workflows/mastra/steps/factory';

// ── Full module namespace exports (lazy-loaded) ─────────────────────
// These namespaces are lazy-loaded via getters so that requiring the main
// entry point doesn't crash when optional peer dependencies (hono, pg,
// pg-boss, ioredis, etc.) are not installed. Each module is only loaded
// when its namespace property is first accessed.

import type * as _api from '../../ghosthands/src/api';
import type * as _client from '../../ghosthands/src/client';
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

export const api: typeof _api = undefined!;
export const client: typeof _client = undefined!;
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
