/**
 * @wekruit/ghosthands-engine — Job application automation engine.
 *
 * Public API for the GH-Desktop-App. The desktop app imports from this
 * package instead of copying engine files directly.
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
