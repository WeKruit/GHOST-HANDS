import { z } from 'zod';

// --- Create Job ---

export const CreateJobSchema = z.object({
  user_id: z.string().uuid().optional(),
  job_type: z.string().min(1).max(50),
  target_url: z.string().url().max(2048),
  task_description: z.string().min(1).max(1000),
  input_data: z.object({
    resume_path: z.string().max(500).optional(),
    resume_id: z.string().uuid().optional(),
    user_data: z.object({
      first_name: z.string().max(100),
      last_name: z.string().max(100),
      email: z.string().email().max(200),
      phone: z.string().max(30).optional(),
      linkedin_url: z.string().url().max(500).optional(),
    }).passthrough().optional(),
    tier: z.enum(['free', 'starter', 'pro', 'premium']).optional(),
    platform: z.enum([
      'linkedin', 'greenhouse', 'lever', 'workday',
      'icims', 'taleo', 'smartrecruiters', 'other',
    ]).optional(),
    qa_overrides: z.record(z.string(), z.string()).optional(),
  }).default({}),
  priority: z.number().int().min(1).max(10).default(5),
  scheduled_at: z.string().datetime().nullable().optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
  timeout_seconds: z.number().int().min(30).max(1800).default(300),
  tags: z.array(z.string().max(50)).max(20).default([]),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

// --- Batch Create Jobs ---

export const BatchCreateJobsSchema = z.object({
  jobs: z.array(CreateJobSchema).min(1).max(50),
  defaults: z.object({
    priority: z.number().int().min(1).max(10).optional(),
    max_retries: z.number().int().min(0).max(10).optional(),
    timeout_seconds: z.number().int().min(30).max(1800).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).optional(),
});

export type BatchCreateJobsInput = z.infer<typeof BatchCreateJobsSchema>;

// --- List Jobs Query ---

export const ListJobsQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  status: z.string().optional(), // comma-separated: "running,pending"
  job_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().default('created_at:desc'),
});

export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// --- Get Events Query ---

export const GetEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type GetEventsQuery = z.infer<typeof GetEventsQuerySchema>;

// --- Job ID Param ---

export const JobIdParamSchema = z.object({
  id: z.string().uuid(),
});

// --- Valid statuses ---

export const JOB_STATUSES = [
  'pending', 'queued', 'running', 'paused',
  'completed', 'failed', 'cancelled', 'expired',
] as const;

export type JobStatus = typeof JOB_STATUSES[number];

export const CANCELLABLE_STATUSES: JobStatus[] = ['pending', 'queued', 'running', 'paused'];
export const RETRYABLE_STATUSES: JobStatus[] = ['failed', 'cancelled'];
