import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowserAutomationAdapter, HitlCapableAdapter } from '../../adapters/types.js';
import type { PageContextService } from '../../context/PageContextService.js';
import type { CostTracker } from '../../workers/costControl.js';
import type { ProgressTracker } from '../../workers/progressTracker.js';
import type { EmailVerificationService } from '../../workers/emailVerification/types.js';
import type { TaskHandler, AutomationJob } from '../../workers/taskHandlers/types.js';

// ---------------------------------------------------------------------------
// Serializable Workflow State (persisted by Mastra in PostgresStore)
// ---------------------------------------------------------------------------

export const workflowState = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
  targetUrl: z.string().url(),
  platform: z.string().default('other'),
  qualityPreset: z.enum(['speed', 'balanced', 'quality']),
  budgetUsd: z.number(),

  handler: z.object({
    attempted: z.boolean().default(false),
    success: z.boolean().default(false),
    taskResult: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).optional(),
      error: z.string().optional(),
      screenshotUrl: z.string().optional(),
      keepBrowserOpen: z.boolean().optional(),
      awaitingUserReview: z.boolean().optional(),
    }).nullable().default(null),
  }),

  hitl: z.object({
    blocked: z.boolean().default(false),
    blockerType: z.string().nullable().default(null),
    resumeNonce: z.string().nullable().default(null),
    checkpoint: z.string().nullable().default(null),
    attemptsByType: z.record(z.number().int().nonnegative()).optional(),
    lastDecision: z.enum([
      'IMMEDIATE_HITL',
      'PAUSE_FOR_USER',
      'AUTO_RECOVER',
      'RETRY_NO_HITL',
      'NO_ACTION',
    ]).nullable().optional(),
  }),

  metrics: z.object({
    costUsd: z.number().default(0),
    pagesProcessed: z.number().default(0),
  }),

  status: z.enum([
    'running',
    'suspended',
    'awaiting_review',
    'completed',
    'failed',
  ]).default('running'),
});

export type WorkflowState = z.infer<typeof workflowState>;

// ---------------------------------------------------------------------------
// Runtime Context (closure-injected, NEVER serialized into workflow schemas)
// ---------------------------------------------------------------------------

export interface RuntimeContext {
  job: AutomationJob;
  handler: TaskHandler;
  adapter: HitlCapableAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  credentials: Record<string, string> | null;
  dataPrompt: string;
  resumeFilePath: string | null;
  emailVerification?: EmailVerificationService;
  pageContext: PageContextService;
  supabase: SupabaseClient;
  logEvent: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
  workerId: string;
  uploadScreenshot?: (jobId: string, name: string, buffer: Buffer) => Promise<string>;
  /** Block handler execution until human completes a manual action (email verification, etc.) */
  waitForManualAction?: (options: {
    type: string;
    description: string;
    timeoutSeconds?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<{
    resumed: boolean;
    /** Resolution data from VALET (e.g. user-provided answers for open_question) */
    resolutionData?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Resume schema for check_blockers_checkpoint step
// ---------------------------------------------------------------------------

export const blockerResumeSchema = z.object({
  resolutionType: z.enum(['manual', 'code_entry', 'credentials', 'skip']),
  resumeNonce: z.string().uuid(),
});

export type BlockerResumeData = z.infer<typeof blockerResumeSchema>;

// ---------------------------------------------------------------------------
// Forbidden keys in workflow schemas (security guard)
// ---------------------------------------------------------------------------

export const FORBIDDEN_SCHEMA_KEYS = [
  'password',
  'resolution_data',
  'otp',
  'credential',
  'secret',
  'token',
] as const;
