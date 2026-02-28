import { z } from 'zod';

// --- Sub-schemas ---

export const EducationSchema = z.object({
  institution: z.string().max(200),
  degree: z.string().max(100),
  field: z.string().max(100).optional(),
  graduation_year: z.number().int().min(1950).max(2040).optional(),
});

export const WorkHistorySchema = z.object({
  company: z.string().max(200),
  title: z.string().max(200),
  start_date: z.string().max(20).optional(),
  end_date: z.string().max(20).optional(),
  description: z.string().max(2000).optional(),
});

export const LocationSchema = z.object({
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
});

export const ResumeRefSchema = z.object({
  storage_path: z.string().max(500).optional(),
  s3_key: z.string().max(500).optional(),
  download_url: z.string().url().max(2048).optional(),
}).refine(
  (data) => data.storage_path || data.s3_key || data.download_url,
  { message: 'At least one resume source (storage_path, s3_key, or download_url) is required' }
);

export const ProfileSchema = z.object({
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  email: z.string().email().max(200),
  phone: z.string().max(30).optional(),
  linkedin_url: z.string().url().max(500).optional(),
  portfolio_url: z.string().url().max(500).optional(),
  location: LocationSchema.optional(),
  work_authorization: z.string().max(100).optional(),
  salary_expectation: z.string().max(100).optional(),
  years_of_experience: z.number().int().min(0).max(70).optional(),
  education: z.array(EducationSchema).max(10).optional(),
  work_history: z.array(WorkHistorySchema).max(20).optional(),
  skills: z.array(z.string().max(100)).max(100).optional(),
});

// --- VALET Apply Request ---

export const ValetApplySchema = z.object({
  valet_task_id: z.string().max(255),
  valet_user_id: z.string().uuid(),
  target_url: z.string().url().max(2048),
  platform: z.enum([
    'greenhouse', 'workday', 'linkedin', 'lever',
    'icims', 'taleo', 'smartrecruiters', 'other',
  ]).optional(),
  resume: ResumeRefSchema.optional(),
  profile: ProfileSchema,
  qa_answers: z.record(z.string(), z.string()).optional(),
  callback_url: z.string().url().max(2048).optional(),
  quality: z.enum(['speed', 'balanced', 'quality']).default('balanced'),
  priority: z.number().int().min(1).max(10).default(5),
  timeout_seconds: z.number().int().min(30).max(1800).default(300),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
  target_worker_id: z.string().max(100).nullable().optional(),
  worker_affinity: z.enum(['strict', 'preferred', 'any']).default('preferred'),
  model: z.string().max(100).optional().describe('LLM model alias (e.g. "qwen-72b", "deepseek-chat", "claude-sonnet")'),
  image_model: z.string().max(100).optional().describe('Separate model for vision/screenshot analysis'),
  execution_mode: z.enum(['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply']).default('auto'),
});

export type ValetApplyInput = z.infer<typeof ValetApplySchema>;

// --- VALET Generic Task Request ---

export const ValetTaskSchema = z.object({
  valet_task_id: z.string().max(255),
  valet_user_id: z.string().uuid(),
  job_type: z.string().min(1).max(50),
  target_url: z.string().url().max(2048),
  task_description: z.string().min(1).max(1000),
  input_data: z.record(z.unknown()).default({}),
  callback_url: z.string().url().max(2048).optional(),
  quality: z.enum(['speed', 'balanced', 'quality']).default('balanced'),
  priority: z.number().int().min(1).max(10).default(5),
  timeout_seconds: z.number().int().min(30).max(1800).default(300),
  idempotency_key: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).default({}),
  target_worker_id: z.string().max(100).nullable().optional(),
  worker_affinity: z.enum(['strict', 'preferred', 'any']).default('preferred'),
  model: z.string().max(100).optional().describe('LLM model alias (e.g. "qwen-72b", "deepseek-chat", "claude-sonnet")'),
  image_model: z.string().max(100).optional().describe('Separate model for vision/screenshot analysis'),
  execution_mode: z.enum(['auto', 'ai_only', 'cookbook_only', 'hybrid', 'smart_apply', 'agent_apply']).default('auto'),
});

export type ValetTaskInput = z.infer<typeof ValetTaskSchema>;

// --- VALET Resume Request ---

export const ValetResumeSchema = z.object({
  resolved_by: z.enum(['human', 'system']).default('human'),
  resolution_notes: z.string().max(500).optional(),
  resolution_type: z.enum(['manual', 'code_entry', 'credentials', 'skip']).optional(),
  resolution_data: z.record(z.unknown()).optional(),
});

export type ValetResumeInput = z.infer<typeof ValetResumeSchema>;

// --- VALET Session Management ---

export const ValetSessionDeleteSchema = z.object({
  domain: z.string().max(255).optional(),
});

export type ValetSessionDeleteInput = z.infer<typeof ValetSessionDeleteSchema>;

// --- VALET Worker Deregistration ---

export const ValetDeregisterSchema = z.object({
  target_worker_id: z.string().min(1).max(255),
  reason: z.string().max(500).optional(),
  cancel_active_jobs: z.boolean().default(false),
  drain_timeout_seconds: z.number().int().min(0).max(300).optional(),
});

export type ValetDeregisterInput = z.infer<typeof ValetDeregisterSchema>;
