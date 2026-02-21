/**
 * Workday application handler module.
 *
 * Re-exports the WorkdayApplyHandler class and related types for use
 * by the task handler registry and other consumers.
 */

export { WorkdayApplyHandler } from './handler.js';
export type { WorkdayUserProfile } from './workdayTypes.js';
export {
  WorkdayAddressSchema,
  WorkdayEducationSchema,
  WorkdayExperienceSchema,
  WorkdayUserProfileSchema,
} from './workdayTypes.js';
