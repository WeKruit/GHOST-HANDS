/**
 * Engine module — cookbook foundation types and runtime components.
 */

export {
  // Schemas
  LocatorDescriptorSchema,
  ManualStepSchema,
  ManualSourceSchema,
  ActionManualSchema,
  FieldObservationSchema,
  FormObservationSchema,
  ButtonObservationSchema,
  NavObservationSchema,
  PageObservationSchema,
  BlockerTypeSchema,
  BlockerDetectionSchema,
  ObservedElementSchema,

  // Types
  type LocatorDescriptor,
  type ManualStep,
  type ManualSource,
  type ActionManual,
  type FieldObservation,
  type FormObservation,
  type ButtonObservation,
  type NavObservation,
  type PageObservation,
  type BlockerType,
  type BlockerDetection,
  type ObservedElement,
} from './types';

export { LocatorResolver, type ResolveResult, type LocatorResolverOptions } from './LocatorResolver';
export { CookbookExecutor, type ExecuteAllResult, type ExecuteStepResult, type CookbookExecutorOptions } from './CookbookExecutor';
export { resolveTemplate, resolveOptionalTemplate } from './templateResolver';
export { ManualStore, type SaveFromTraceMetadata, type SaveFromActionBookMetadata } from './ManualStore';
export { PageObserver, detectPlatform, generateUrlPattern, detectPageType } from './PageObserver';
export { seedFromActionBook, type SeedOptions } from './actionBookSeeder';
