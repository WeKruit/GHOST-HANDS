/**
 * Engine module — observation types and runtime components.
 */

export {
  // Observation schemas
  FieldObservationSchema,
  FormObservationSchema,
  ButtonObservationSchema,
  NavObservationSchema,
  PageObservationSchema,
  BlockerTypeSchema,
  BlockerDetectionSchema,
  ObservedElementSchema,

  // Observation types
  type FieldObservation,
  type FormObservation,
  type ButtonObservation,
  type NavObservation,
  type PageObservation,
  type BlockerType,
  type BlockerDetection,
  type ObservedElement,
} from './types';

export { resolveTemplate, resolveOptionalTemplate } from './templateResolver';
export { PageObserver, detectPlatform, generateUrlPattern, detectPageType } from './PageObserver';
