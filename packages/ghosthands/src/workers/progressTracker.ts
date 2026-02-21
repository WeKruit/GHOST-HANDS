import { SupabaseClient } from '@supabase/supabase-js';
import type Redis from 'ioredis';
import { xaddEvent, setStreamTTL } from '../lib/redis-streams.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'progress-tracker' });

// ---------------------------------------------------------------------------
// Progress lifecycle steps for a job application flow
// ---------------------------------------------------------------------------

export const ProgressStep = {
  QUEUED: 'queued',
  INITIALIZING: 'initializing',
  NAVIGATING: 'navigating',
  ANALYZING_PAGE: 'analyzing_page',
  FILLING_FORM: 'filling_form',
  UPLOADING_RESUME: 'uploading_resume',
  ANSWERING_QUESTIONS: 'answering_questions',
  REVIEWING: 'reviewing',
  SUBMITTING: 'submitting',
  EXTRACTING_RESULTS: 'extracting_results',
  AWAITING_USER_REVIEW: 'awaiting_user_review',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type ProgressStep = (typeof ProgressStep)[keyof typeof ProgressStep];

// Ordered steps for percentage calculation
const STEP_ORDER: ProgressStep[] = [
  ProgressStep.QUEUED,
  ProgressStep.INITIALIZING,
  ProgressStep.NAVIGATING,
  ProgressStep.ANALYZING_PAGE,
  ProgressStep.FILLING_FORM,
  ProgressStep.UPLOADING_RESUME,
  ProgressStep.ANSWERING_QUESTIONS,
  ProgressStep.REVIEWING,
  ProgressStep.SUBMITTING,
  ProgressStep.EXTRACTING_RESULTS,
  ProgressStep.AWAITING_USER_REVIEW,
  ProgressStep.COMPLETED,
];

// Human-readable descriptions for each step
const STEP_DESCRIPTIONS: Record<ProgressStep, string> = {
  [ProgressStep.QUEUED]: 'Waiting in queue',
  [ProgressStep.INITIALIZING]: 'Starting browser agent',
  [ProgressStep.NAVIGATING]: 'Navigating to application page',
  [ProgressStep.ANALYZING_PAGE]: 'Analyzing page structure',
  [ProgressStep.FILLING_FORM]: 'Filling out form fields',
  [ProgressStep.UPLOADING_RESUME]: 'Uploading resume',
  [ProgressStep.ANSWERING_QUESTIONS]: 'Answering screening questions',
  [ProgressStep.REVIEWING]: 'Reviewing submission',
  [ProgressStep.SUBMITTING]: 'Submitting application',
  [ProgressStep.EXTRACTING_RESULTS]: 'Extracting confirmation details',
  [ProgressStep.AWAITING_USER_REVIEW]: 'Waiting for user to review and submit',
  [ProgressStep.COMPLETED]: 'Application complete',
  [ProgressStep.FAILED]: 'Job failed',
};

// ---------------------------------------------------------------------------
// Progress event data stored in gh_job_events.metadata JSONB
// ---------------------------------------------------------------------------

export interface ProgressEventData {
  step: ProgressStep;
  progress_pct: number;
  description: string;
  action_index: number;
  total_actions_estimate: number;
  current_action?: string;
  started_at: string;
  elapsed_ms: number;
  eta_ms: number | null;
  // Mode tracking (Sprint 3)
  execution_mode?: 'cookbook' | 'magnitude';
  manual_id?: string;
  step_cost_cents?: number;
}

// ---------------------------------------------------------------------------
// Action-to-step heuristic mapping
// ---------------------------------------------------------------------------

/** Map an action variant string to the best-guess progress step. */
function inferStepFromAction(
  actionVariant: string,
  currentStep: ProgressStep,
  thought?: string,
): ProgressStep {
  const v = actionVariant.toLowerCase();
  const t = (thought ?? '').toLowerCase();

  // Resume/file upload detection
  if (v === 'upload' || t.includes('resume') || t.includes('upload') || t.includes('attach')) {
    return ProgressStep.UPLOADING_RESUME;
  }

  // Submit detection
  if (t.includes('submit') || t.includes('confirm')) {
    return ProgressStep.SUBMITTING;
  }

  // Screening question detection
  if (t.includes('question') || t.includes('screening') || t.includes('answer')) {
    return ProgressStep.ANSWERING_QUESTIONS;
  }

  // Review detection
  if (t.includes('review') || t.includes('verify') || t.includes('check')) {
    return ProgressStep.REVIEWING;
  }

  // Navigation
  if (v === 'goto' || v === 'navigate' || t.includes('navigate') || t.includes('go to')) {
    return ProgressStep.NAVIGATING;
  }

  // Form-filling actions
  if (v === 'type' || v === 'click' || v === 'select' || v === 'scroll') {
    // If we're already past form filling, don't regress
    const currentIdx = STEP_ORDER.indexOf(currentStep);
    const fillIdx = STEP_ORDER.indexOf(ProgressStep.FILLING_FORM);
    if (currentIdx < fillIdx) {
      return ProgressStep.FILLING_FORM;
    }
  }

  return currentStep;
}

// ---------------------------------------------------------------------------
// ProgressTracker
// ---------------------------------------------------------------------------

export interface ProgressTrackerOptions {
  jobId: string;
  supabase: SupabaseClient;
  workerId: string;
  /** Total actions to estimate for percentage (from action_limit or default). */
  estimatedTotalActions?: number;
  /** Minimum interval between DB writes (ms). Prevents flooding. Default: 2000 */
  throttleMs?: number;
  /** Optional Redis client for real-time streaming via Redis Streams. */
  redis?: Redis;
}

export class ProgressTracker {
  private jobId: string;
  private supabase: SupabaseClient;
  private workerId: string;
  private estimatedTotalActions: number;
  private throttleMs: number;
  private redis: Redis | null;

  private currentStep: ProgressStep = ProgressStep.QUEUED;
  private actionIndex = 0;
  private startedAt: number = Date.now();
  private lastEmitTime = 0;
  private latestThought: string | undefined;
  private pendingEmit: ProgressEventData | null = null;
  private executionMode?: 'cookbook' | 'magnitude';
  private manualId?: string;

  constructor(opts: ProgressTrackerOptions) {
    this.jobId = opts.jobId;
    this.supabase = opts.supabase;
    this.workerId = opts.workerId;
    this.estimatedTotalActions = opts.estimatedTotalActions ?? 30;
    this.throttleMs = opts.throttleMs ?? 2000;
    this.redis = opts.redis ?? null;
  }

  /** Set the current step explicitly (for lifecycle transitions). */
  async setStep(step: ProgressStep): Promise<void> {
    this.currentStep = step;
    await this.emit();
  }

  /** Record a thought from the agent (used for heuristic step inference). */
  recordThought(thought: string): void {
    this.latestThought = thought;
  }

  /** Set the current execution mode for progress events. */
  setExecutionMode(mode: 'cookbook' | 'magnitude', manualId?: string): void {
    this.executionMode = mode;
    this.manualId = manualId;
  }

  /** Called when an action starts. Infers the step and emits progress. */
  async onActionStarted(actionVariant: string): Promise<void> {
    this.actionIndex++;
    const inferred = inferStepFromAction(actionVariant, this.currentStep, this.latestThought);
    if (STEP_ORDER.indexOf(inferred) > STEP_ORDER.indexOf(this.currentStep)) {
      this.currentStep = inferred;
    }
    await this.emitThrottled();
  }

  /** Called when an action completes. */
  async onActionDone(_actionVariant: string): Promise<void> {
    await this.emitThrottled();
  }

  /** Get the current progress percentage (0-100). */
  getProgressPct(): number {
    if (this.currentStep === ProgressStep.COMPLETED) return 100;
    if (this.currentStep === ProgressStep.FAILED) return this.calculatePct();

    return this.calculatePct();
  }

  /** Build the current progress snapshot. */
  getSnapshot(): ProgressEventData {
    const now = Date.now();
    const elapsedMs = now - this.startedAt;

    return {
      step: this.currentStep,
      progress_pct: this.getProgressPct(),
      description: STEP_DESCRIPTIONS[this.currentStep],
      action_index: this.actionIndex,
      total_actions_estimate: this.estimatedTotalActions,
      current_action: this.latestThought,
      started_at: new Date(this.startedAt).toISOString(),
      elapsed_ms: elapsedMs,
      eta_ms: this.estimateEta(elapsedMs),
      ...(this.executionMode && { execution_mode: this.executionMode }),
      ...(this.manualId && { manual_id: this.manualId }),
    };
  }

  // -- Internal --

  private calculatePct(): number {
    // Blend step-based progress (60% weight) with action-based progress (40% weight)
    const stepIdx = STEP_ORDER.indexOf(this.currentStep);
    const stepPct = stepIdx >= 0 ? (stepIdx / (STEP_ORDER.length - 1)) * 100 : 0;
    const actionPct = Math.min(100, (this.actionIndex / this.estimatedTotalActions) * 100);

    return Math.min(99, Math.round(stepPct * 0.6 + actionPct * 0.4));
  }

  private estimateEta(elapsedMs: number): number | null {
    if (this.actionIndex < 2) return null; // Not enough data
    const pct = this.getProgressPct();
    if (pct <= 0) return null;

    const totalEstimateMs = (elapsedMs / pct) * 100;
    const remainingMs = totalEstimateMs - elapsedMs;
    return Math.max(0, Math.round(remainingMs));
  }

  /** Emit progress immediately. */
  private async emit(): Promise<void> {
    const snapshot = this.getSnapshot();
    this.lastEmitTime = Date.now();
    this.pendingEmit = null;

    // 1. Publish to Redis Streams for real-time SSE consumption (fast path)
    if (this.redis) {
      try {
        await xaddEvent(this.redis, this.jobId, {
          ...snapshot,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        // Redis publish failure should never block job execution
        logger.child({ jobId: this.jobId }).warn('Redis Stream publish failed', { error: String(err) });
      }
    }

    // 2. Write to gh_job_events (audit trail — permanent record)
    try {
      await this.supabase.from('gh_job_events').insert({
        job_id: this.jobId,
        event_type: 'progress_update',
        metadata: snapshot,
        actor: this.workerId,
      });
    } catch (err) {
      // Progress logging should never crash the job
      logger.child({ jobId: this.jobId }).warn('Event write failed', { error: String(err) });
    }

    // NOTE: Previously also updated gh_automation_jobs.metadata.progress here,
    // but this was duplicate storage. gh_job_events is now the single source
    // of truth for progress data (WEK-71 progress dedup).
  }

  /** Emit progress, but throttled to avoid DB write storms. */
  private async emitThrottled(): Promise<void> {
    const now = Date.now();
    const snapshot = this.getSnapshot();

    if (now - this.lastEmitTime >= this.throttleMs) {
      await this.emit();
    } else {
      // Store latest so the next emit gets the freshest data
      this.pendingEmit = snapshot;
    }
  }

  /** Flush any pending throttled emit. Call on job completion/failure. */
  async flush(): Promise<void> {
    if (this.pendingEmit) {
      await this.emit();
    }

    // Set a 24-hour TTL on the Redis stream so it auto-cleans after retention period
    if (this.redis) {
      try {
        await setStreamTTL(this.redis, this.jobId, 86400);
      } catch (err) {
        logger.child({ jobId: this.jobId }).warn('Failed to set stream TTL', { error: String(err) });
      }
    }
  }
}
