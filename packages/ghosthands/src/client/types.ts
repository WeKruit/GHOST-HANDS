import { z } from 'zod';

// --------------------------------------------------------------------------
// Job status enum matching the gh_automation_jobs state machine (doc-12 S3.2)
// --------------------------------------------------------------------------
export const JobStatus = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
  JobStatus.EXPIRED,
]);

export const CANCELLABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  JobStatus.PENDING,
  JobStatus.QUEUED,
  JobStatus.RUNNING,
  JobStatus.PAUSED,
]);

// --------------------------------------------------------------------------
// Job types
// --------------------------------------------------------------------------
export const JobType = {
  APPLY: 'apply',
  SCRAPE: 'scrape',
  FILL_FORM: 'fill_form',
  CUSTOM: 'custom',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];

// --------------------------------------------------------------------------
// Platform enum (auto-detected from URL when not provided)
// --------------------------------------------------------------------------
export const Platform = {
  LINKEDIN: 'linkedin',
  GREENHOUSE: 'greenhouse',
  LEVER: 'lever',
  WORKDAY: 'workday',
  ICIMS: 'icims',
  TALEO: 'taleo',
  SMARTRECRUITERS: 'smartrecruiters',
  OTHER: 'other',
} as const;

export type Platform = (typeof Platform)[keyof typeof Platform];

// --------------------------------------------------------------------------
// Subscription tier
// --------------------------------------------------------------------------
export const Tier = {
  FREE: 'free',
  STARTER: 'starter',
  PRO: 'pro',
  PREMIUM: 'premium',
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

// --------------------------------------------------------------------------
// Zod schemas (validated on API ingress before DB insertion)
// --------------------------------------------------------------------------
export const UserDataSchema = z.object({
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  email: z.string().email().max(200),
  phone: z.string().max(30).optional(),
  linkedin_url: z.string().url().max(500).optional(),
}).passthrough();

export const InputDataSchema = z.object({
  resume_path: z.string().max(500).optional(),
  resume_id: z.string().uuid().optional(),
  user_data: UserDataSchema.optional(),
  tier: z.enum(['free', 'starter', 'pro', 'premium']).optional(),
  platform: z.enum([
    'linkedin', 'greenhouse', 'lever', 'workday',
    'icims', 'taleo', 'smartrecruiters', 'other',
  ]).optional(),
  qa_overrides: z.record(z.string(), z.string()).optional(),
}).default({});

export const CreateJobSchema = z.object({
  job_type: z.enum(['apply', 'scrape', 'fill_form', 'custom']),
  target_url: z.string().url().max(2048),
  task_description: z.string().min(1).max(1000),
  input_data: InputDataSchema,
  priority: z.number().int().min(1).max(10).default(5),
  scheduled_at: z.string().datetime().nullable().optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_seconds: z.number().int().min(30).max(3600).default(1800),
  tags: z.array(z.string().max(50)).max(20).default([]),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
  /** Route job to a specific worker. NULL = any worker can pick it up. */
  target_worker_id: z.string().max(100).nullable().optional(),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

// --------------------------------------------------------------------------
// Row-level types matching gh_automation_jobs table (doc-12 S3.1)
// --------------------------------------------------------------------------
export interface AutomationJob {
  id: string;
  idempotency_key: string | null;
  user_id: string;
  created_by: string;
  job_type: JobType;
  target_url: string;
  task_description: string;
  input_data: Record<string, unknown>;
  priority: number;
  scheduled_at: string | null;
  max_retries: number;
  retry_count: number;
  timeout_seconds: number;
  status: JobStatus;
  status_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat: string | null;
  worker_id: string | null;
  manual_id: string | null;
  target_worker_id: string | null;
  engine_type: string | null;
  result_data: Record<string, unknown> | null;
  result_summary: string | null;
  error_code: string | null;
  error_details: Record<string, unknown> | null;
  screenshot_urls: string[];
  artifact_urls: string[];
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

// --------------------------------------------------------------------------
// Lightweight status payload (GET /jobs/:id/status)
// --------------------------------------------------------------------------
export interface JobStatusResponse {
  id: string;
  status: JobStatus;
  status_message: string | null;
  progress_pct: number | null;
  started_at: string | null;
  last_heartbeat: string | null;
  estimated_completion: string | null;
}

// --------------------------------------------------------------------------
// Job event (gh_job_events table)
// --------------------------------------------------------------------------
export interface JobEvent {
  id: string;
  job_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
  actor: string;
  created_at: string;
}

// --------------------------------------------------------------------------
// Paginated list response
// --------------------------------------------------------------------------
export interface PaginatedJobs {
  jobs: AutomationJob[];
  total: number;
  limit: number;
  offset: number;
}

// --------------------------------------------------------------------------
// Create-job params (snake_case -- matches REST API / Zod schema directly)
// --------------------------------------------------------------------------
export interface CreateJobParams {
  type?: JobType;
  job_type?: JobType;
  user_id?: string;
  target_url: string;
  task_description: string;
  input_data?: {
    resume_path?: string;
    resume_id?: string;
    platform?: Platform;
    job_url?: string;
    user_data?: {
      first_name?: string;
      last_name?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      linkedin_url?: string;
      [key: string]: unknown;
    };
    tier?: Tier;
    qa_overrides?: Record<string, string>;
    [key: string]: unknown;
  };
  priority?: number;
  scheduled_at?: string | null;
  max_retries?: number;
  timeout_seconds?: number;
  tags?: string[];
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  /** Route to a specific worker. Omit or null = any worker. */
  target_worker_id?: string | null;
}

// --------------------------------------------------------------------------
// Create-job options (camelCase convenience interface)
// --------------------------------------------------------------------------
export interface CreateJobOptions {
  jobType: JobType;
  targetUrl: string;
  taskDescription: string;
  inputData?: {
    resumePath?: string;
    resumeId?: string;
    userData?: {
      first_name: string;
      last_name: string;
      email: string;
      phone?: string;
      linkedin_url?: string;
      [key: string]: unknown;
    };
    tier?: Tier;
    platform?: Platform;
    qaOverrides?: Record<string, string>;
  };
  priority?: number;
  scheduledAt?: string | null;
  maxRetries?: number;
  timeoutSeconds?: number;
  tags?: string[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Route to a specific worker. Omit or null = any worker. */
  targetWorkerId?: string | null;
}

// --------------------------------------------------------------------------
// List-jobs filters
// --------------------------------------------------------------------------
export interface ListJobsFilters {
  status?: JobStatus[];
  jobType?: JobType;
  limit?: number;
  offset?: number;
  sort?: string;
}

// --------------------------------------------------------------------------
// Batch create
// --------------------------------------------------------------------------
export interface BatchCreateResult {
  created: Array<{ id: string; status: JobStatus }>;
  errors: Array<{ index: number; error: string }>;
}

// --------------------------------------------------------------------------
// Client configuration
// --------------------------------------------------------------------------

/**
 * REST API mode: client talks to the GhostHands Hono API via HTTP.
 * Use this from VALET or any external service.
 */
export interface ApiClientConfig {
  mode?: 'api';
  /** Base URL of the GhostHands API, e.g. "https://gh.wekruit.com/api/v1/gh" */
  apiUrl: string;
  /** Service key sent as X-GH-Service-Key header (server-to-server auth) */
  apiKey: string;
  /**
   * Optional: Supabase connection for Realtime subscriptions.
   * If omitted, subscribeToJobStatus/waitForCompletion are unavailable
   * and pollForCompletion must be used instead.
   */
  supabaseUrl?: string;
  supabaseKey?: string;
}

/**
 * Direct DB mode: client talks to Supabase directly (Channel 1).
 * Use this when you have a service_role key and want to skip the API layer.
 */
export interface DbClientConfig {
  mode: 'db';
  supabaseUrl: string;
  supabaseKey: string;
}

export type GhostHandsClientConfig = ApiClientConfig | DbClientConfig;

// --------------------------------------------------------------------------
// Error types
// --------------------------------------------------------------------------
export class GhostHandsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GhostHandsError';
  }
}

export class JobNotFoundError extends GhostHandsError {
  constructor(jobId: string) {
    super(`Job ${jobId} not found`, 'job_not_found', 404);
    this.name = 'JobNotFoundError';
  }
}

export class DuplicateIdempotencyKeyError extends GhostHandsError {
  constructor(
    public readonly existingJobId: string,
    public readonly existingStatus: JobStatus,
  ) {
    super(
      `Duplicate idempotency key — existing job ${existingJobId} is ${existingStatus}`,
      'duplicate_idempotency_key',
      409,
    );
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

export class JobNotCancellableError extends GhostHandsError {
  constructor(jobId: string, currentStatus: JobStatus) {
    super(
      `Job ${jobId} cannot be cancelled (current status: ${currentStatus})`,
      'job_not_cancellable',
      409,
    );
    this.name = 'JobNotCancellableError';
  }
}
