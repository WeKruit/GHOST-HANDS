export { GhostHandsClient } from './GhostHandsClient';
export { RealtimeSubscriber } from './realtimeSubscriber';
export type { JobSubscription, SubscribeToJobOptions, SubscribeToUserJobsOptions } from './realtimeSubscriber';
export {
  // Enums / constants
  JobStatus,
  JobType,
  Platform,
  Tier,
  TERMINAL_STATUSES,
  CANCELLABLE_STATUSES,

  // Zod schemas
  CreateJobSchema,
  InputDataSchema,
  UserDataSchema,

  // Error classes
  GhostHandsError,
  JobNotFoundError,
  DuplicateIdempotencyKeyError,
  JobNotCancellableError,
} from './types';
export type {
  ApiClientConfig,
  AutomationJob,
  BatchCreateResult,
  CreateJobInput,
  CreateJobOptions,
  CreateJobParams,
  DbClientConfig,
  GhostHandsClientConfig,
  JobEvent,
  JobStatusResponse,
  ListJobsFilters,
  PaginatedJobs,
} from './types';
