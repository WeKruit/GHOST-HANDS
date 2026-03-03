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

// ── Workday types (needed by handler consumers) ──────────────────────
export type { WorkdayUserProfile } from '../../ghosthands/src/workers/taskHandlers/workday/workdayTypes';
export type { PageState as WorkdayPageState } from '../../ghosthands/src/workers/taskHandlers/workday/constants';
