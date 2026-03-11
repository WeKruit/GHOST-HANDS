import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowserAutomationAdapter, HitlCapableAdapter } from '../../adapters/types.js';
import type { PageContextService } from '../../context/PageContextService.js';
import type { CostTracker } from '../../workers/costControl.js';
import type { ProgressTracker } from '../../workers/progressTracker.js';
import type { EmailVerificationService } from '../../workers/emailVerification/types.js';
import type { TaskHandler, AutomationJob, AnthropicClientConfig } from '../../workers/taskHandlers/types.js';

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

  // Decision loop state (only present when using page_decision_loop step)
  decisionLoop: z.object({
    iteration: z.number().int().nonnegative().default(0),
    pagesProcessed: z.number().int().nonnegative().default(0),
    currentPageFingerprint: z.string().nullable().default(null),
    previousPageFingerprint: z.string().nullable().default(null),
    samePageCount: z.number().int().nonnegative().default(0),
    actionHistory: z.array(z.object({
      iteration: z.number(),
      action: z.string(),
      target: z.string(),
      result: z.enum(['success', 'partial', 'failed', 'skipped']),
      layer: z.enum(['dom', 'stagehand', 'magnitude']).nullable(),
      costUsd: z.number(),
      durationMs: z.number(),
      fieldsAttempted: z.number().optional(),
      fieldsFilled: z.number().optional(),
      pageFingerprint: z.string(),
      timestamp: z.number(),
    })).default([]),
    loopCostUsd: z.number().default(0),
    terminalState: z.enum([
      'running', 'confirmation', 'review_page', 'submitted',
      'stuck', 'budget_exceeded', 'error', 'max_iterations',
    ]).default('running'),
    terminationReason: z.string().nullable().default(null),
  }).optional(),
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
  /** LLM client config for the decision engine (VALET proxy baseURL + managed grant). */
  llmClientConfig?: {
    anthropic?: AnthropicClientConfig;
  };
  /** Block handler execution until human completes a manual action (email verification, etc.) */
  waitForManualAction?: (options: {
    type: string;
    description: string;
    timeoutSeconds?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<{ resumed: boolean }>;
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
