import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PageContextService } from '../../context/PageContextService.js';
import type { CostTracker } from '../costControl.js';
import type { ProgressTracker } from '../progressTracker.js';
import type { EmailVerificationService } from '../emailVerification/types.js';

/** Job record as fetched from gh_automation_jobs */
export interface AutomationJob {
  id: string;
  job_type: string;
  target_url: string;
  task_description: string;
  input_data: Record<string, any>;
  user_id: string;
  timeout_seconds: number;
  max_retries: number;
  retry_count: number;
  metadata: Record<string, any>;
  priority: number;
  tags: string[];
  callback_url?: string | null;
  valet_task_id?: string | null;
  resume_ref?: Record<string, any> | null;
  execution_mode?: string;
  image_model?: string;
}

export interface TaskHandler {
  /** Job type this handler processes (matches job_type column) */
  readonly type: string;
  /** Human-readable description */
  readonly description: string;
  /** Execute the task */
  execute(ctx: TaskContext): Promise<TaskResult>;
  /** Optional input validation before execution */
  validate?(inputData: Record<string, any>): ValidationResult;
}

export interface TaskContext {
  job: AutomationJob;
  adapter: BrowserAutomationAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  credentials: Record<string, string> | null;
  dataPrompt: string;
  /** Local file path to the downloaded resume, if a resume_ref was provided */
  resumeFilePath?: string | null;
  /** Optional email verification automation service (per-user Gmail API). */
  emailVerification?: EmailVerificationService;
  /** Structured job-event logger injected by JobExecutor. */
  logEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Per-run page context tracker used by the Mastra apply flow. */
  pageContext?: PageContextService;
  /** Block handler execution until human completes a manual action (email verification, manual sign-in, etc.) */
  waitForManualAction?: (options: {
    type: string;
    description: string;
    timeoutSeconds?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<{ resumed: boolean }>;
}

export interface TaskResult {
  success: boolean;
  data?: Record<string, any>;
  error?: string;
  screenshotUrl?: string;
  /** When true, the browser stays open after handler completes (for manual takeover). */
  keepBrowserOpen?: boolean;
  /** When true, the job is paused at the review page awaiting user submission. */
  awaitingUserReview?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
