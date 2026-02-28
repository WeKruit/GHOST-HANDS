import { SupabaseClient } from '@supabase/supabase-js';
import { getLogger } from '../monitoring/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Quality preset determines per-task LLM budget */
export type QualityPreset = 'speed' | 'balanced' | 'quality';

/** User subscription tier determines monthly budget */
export type BudgetTier = 'free' | 'starter' | 'pro' | 'premium' | 'enterprise';

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  actionCount: number;
  // Mode tracking (Sprint 3)
  mode?: 'cookbook' | 'magnitude' | 'hybrid';
  cookbookSteps: number;
  magnitudeSteps: number;
  // Dual-model cost breakdown (Sprint 4)
  imageCost: number;
  reasoningCost: number;
}

export interface UserUsage {
  userId: string;
  tier: BudgetTier;
  monthlyBudget: number;
  currentMonthCost: number;
  remainingBudget: number;
  jobCount: number;
  periodStart: string;
  periodEnd: string;
}

export interface PreflightResult {
  allowed: boolean;
  reason?: string;
  remainingBudget?: number;
  taskBudget?: number;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly jobId: string,
    public readonly costSnapshot: CostSnapshot,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class ActionLimitExceededError extends Error {
  constructor(
    message: string,
    public readonly jobId: string,
    public readonly actionCount: number,
    public readonly limit: number,
  ) {
    super(message);
    this.name = 'ActionLimitExceededError';
  }
}

// ---------------------------------------------------------------------------
// Budget Configuration
// ---------------------------------------------------------------------------

/** Per-task LLM budget (in USD) by quality preset */
export const TASK_BUDGET: Record<QualityPreset, number> = {
  speed: 0.05,
  balanced: 0.25,
  quality: 0.50,
};

/** Per-job-type budget overrides (in USD) — bypasses quality preset when present */
export const JOB_TYPE_BUDGET_OVERRIDES: Record<string, number> = {
  workday_apply: 2.00,
  smart_apply: 2.00,
};

/** Per-user monthly budget (in USD) by subscription tier */
export const MONTHLY_BUDGET: Record<BudgetTier, number> = {
  free: 0.50,
  starter: 2.00,
  pro: 10.00,
  premium: 25.00,
  enterprise: 100.00,
};

/** Default max actions per job */
export const DEFAULT_MAX_ACTIONS = 50;

/** Per-job-type action limits (override default) */
export const JOB_TYPE_ACTION_LIMITS: Record<string, number> = {
  apply: 50,
  scrape: 30,
  fill_form: 40,
  custom: 50,
  workday_apply: 10000,
  smart_apply: 10000,
};

// ---------------------------------------------------------------------------
// CostTracker - Per-task cost tracking
// ---------------------------------------------------------------------------

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private inputCost = 0;
  private outputCost = 0;
  private actionCount = 0;
  private cookbookSteps = 0;
  private magnitudeSteps = 0;
  private currentMode: CostSnapshot['mode'] = undefined;
  private _imageCost = 0;
  private _reasoningCost = 0;

  private readonly jobId: string;
  private readonly taskBudget: number;
  private readonly actionLimit: number;

  constructor(opts: {
    jobId: string;
    qualityPreset?: QualityPreset;
    jobType?: string;
    maxActions?: number;
  }) {
    this.jobId = opts.jobId;
    // Per-job-type budget overrides take precedence over quality preset
    this.taskBudget =
      (opts.jobType ? JOB_TYPE_BUDGET_OVERRIDES[opts.jobType] : undefined) ??
      TASK_BUDGET[opts.qualityPreset || 'balanced'];
    this.actionLimit =
      opts.maxActions ??
      (opts.jobType ? JOB_TYPE_ACTION_LIMITS[opts.jobType] : undefined) ??
      DEFAULT_MAX_ACTIONS;
  }

  /** Record token usage from an LLM call. Throws BudgetExceededError if over budget. */
  recordTokenUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    inputCost?: number;
    outputCost?: number;
    /** Which model role produced this usage: 'image' or 'reasoning' */
    role?: 'image' | 'reasoning';
  }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.inputCost += usage.inputCost ?? 0;
    this.outputCost += usage.outputCost ?? 0;

    // Track per-role cost breakdown
    const callCost = (usage.inputCost ?? 0) + (usage.outputCost ?? 0);
    if (usage.role === 'image') {
      this._imageCost += callCost;
    } else {
      this._reasoningCost += callCost;
    }

    const totalCost = this.inputCost + this.outputCost;
    if (totalCost > this.taskBudget) {
      throw new BudgetExceededError(
        `Task budget exceeded: $${totalCost.toFixed(4)} > $${this.taskBudget.toFixed(2)} limit`,
        this.jobId,
        this.getSnapshot(),
      );
    }
  }

  /** Record an action. Throws ActionLimitExceededError if over limit. */
  recordAction(): void {
    this.actionCount++;
    if (this.actionCount > this.actionLimit) {
      throw new ActionLimitExceededError(
        `Action limit exceeded: ${this.actionCount} > ${this.actionLimit}`,
        this.jobId,
        this.actionCount,
        this.actionLimit,
      );
    }
  }

  /** Return a frozen snapshot of current cost state. */
  getSnapshot(): CostSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      inputCost: this.inputCost,
      outputCost: this.outputCost,
      totalCost: this.inputCost + this.outputCost,
      actionCount: this.actionCount,
      mode: this.currentMode,
      cookbookSteps: this.cookbookSteps,
      magnitudeSteps: this.magnitudeSteps,
      imageCost: this._imageCost,
      reasoningCost: this._reasoningCost,
    };
  }

  /** Record a step in the given mode. */
  recordModeStep(mode: 'cookbook' | 'magnitude'): void {
    if (mode === 'cookbook') {
      this.cookbookSteps++;
    } else {
      this.magnitudeSteps++;
    }
  }

  /** Set the current execution mode. */
  setMode(mode: 'cookbook' | 'magnitude' | 'hybrid'): void {
    this.currentMode = mode;
  }

  /** The dollar budget for this task. */
  getTaskBudget(): number {
    return this.taskBudget;
  }

  /** The action limit for this task. */
  getActionLimit(): number {
    return this.actionLimit;
  }

  /** How much budget remains for this task. */
  getRemainingBudget(): number {
    return Math.max(0, this.taskBudget - (this.inputCost + this.outputCost));
  }
}

// ---------------------------------------------------------------------------
// CostControlService - Per-user monthly budget + DB integration
// ---------------------------------------------------------------------------

export class CostControlService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  // ── Pre-flight check ────────────────────────────────────────────────

  /**
   * Check if a user has sufficient budget remaining before starting a job.
   * Returns { allowed: true } if the job can proceed, or { allowed: false, reason }
   * if the user is over budget.
   */
  async preflightBudgetCheck(
    userId: string,
    qualityPreset: QualityPreset = 'balanced',
    jobType?: string,
  ): Promise<PreflightResult> {
    const usage = await this.getUserUsage(userId);
    // Use per-job-type budget override if available, otherwise fall back to quality preset
    const taskBudget =
      (jobType ? JOB_TYPE_BUDGET_OVERRIDES[jobType] : undefined) ??
      TASK_BUDGET[qualityPreset];

    if (usage.remainingBudget < taskBudget) {
      return {
        allowed: false,
        reason: `Insufficient monthly budget. Remaining: $${usage.remainingBudget.toFixed(2)}, task requires: $${taskBudget.toFixed(2)}`,
        remainingBudget: usage.remainingBudget,
        taskBudget,
      };
    }

    return {
      allowed: true,
      remainingBudget: usage.remainingBudget,
      taskBudget,
    };
  }

  // ── User usage retrieval ────────────────────────────────────────────

  /**
   * Get the current month's usage for a user.
   * Creates the usage row if it does not exist.
   */
  async getUserUsage(userId: string): Promise<UserUsage> {
    const { periodStart, periodEnd } = getCurrentBillingPeriod();

    // Try to read existing row
    const { data: existing } = await this.supabase
      .from('gh_user_usage')
      .select('*')
      .eq('user_id', userId)
      .eq('period_start', periodStart)
      .single();

    if (existing) {
      const monthlyBudget = MONTHLY_BUDGET[existing.tier as BudgetTier] ?? MONTHLY_BUDGET.free;
      return {
        userId,
        tier: existing.tier as BudgetTier,
        monthlyBudget,
        currentMonthCost: existing.total_cost_usd,
        remainingBudget: Math.max(0, monthlyBudget - existing.total_cost_usd),
        jobCount: existing.job_count,
        periodStart,
        periodEnd,
      };
    }

    // Fetch user tier from profiles table (best-effort fallback to 'free')
    const tier = await this.resolveUserTier(userId);
    const monthlyBudget = MONTHLY_BUDGET[tier];

    // Insert a fresh usage row for this billing period
    await this.supabase.from('gh_user_usage').upsert(
      {
        user_id: userId,
        tier,
        period_start: periodStart,
        period_end: periodEnd,
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        job_count: 0,
      },
      { onConflict: 'user_id,period_start' },
    );

    return {
      userId,
      tier,
      monthlyBudget,
      currentMonthCost: 0,
      remainingBudget: monthlyBudget,
      jobCount: 0,
      periodStart,
      periodEnd,
    };
  }

  // ── Post-job cost recording ─────────────────────────────────────────

  /**
   * After a job completes (or fails), record its cost against the user's
   * monthly usage and log a cost event.
   *
   * Uses a Postgres RPC function (gh_increment_user_usage) to atomically
   * increment the usage row. This avoids the read-then-write race condition
   * that can occur when two workers finish at the same time: both would read
   * the same total, add their cost client-side, and write back -- causing
   * one update to be lost.
   *
   * The RPC uses INSERT ... ON CONFLICT DO UPDATE SET col = col + delta,
   * which is atomic at the SQL level and safe under concurrent access.
   */
  async recordJobCost(
    userId: string,
    jobId: string,
    cost: CostSnapshot,
  ): Promise<void> {
    const { periodStart, periodEnd } = getCurrentBillingPeriod();
    const tier = await this.resolveUserTier(userId);

    // Atomic increment via Postgres RPC -- no read-then-write race
    const { error: rpcError } = await this.supabase.rpc('gh_increment_user_usage', {
      p_user_id: userId,
      p_tier: tier,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_cost_usd: cost.totalCost,
      p_input_tokens: cost.inputTokens,
      p_output_tokens: cost.outputTokens,
      p_job_count: 1,
    });

    if (rpcError) {
      getLogger().error('Atomic usage increment failed', { userId, error: rpcError.message });
      throw new Error(`Failed to record job cost: ${rpcError.message}`);
    }

    // Log cost event in gh_job_events
    await this.supabase.from('gh_job_events').insert({
      job_id: jobId,
      event_type: 'cost_recorded',
      metadata: {
        input_tokens: cost.inputTokens,
        output_tokens: cost.outputTokens,
        input_cost: cost.inputCost,
        output_cost: cost.outputCost,
        total_cost: cost.totalCost,
        action_count: cost.actionCount,
      },
      actor: 'cost_control',
    });
  }

  // ── Tier resolution ─────────────────────────────────────────────────

  private async resolveUserTier(userId: string): Promise<BudgetTier> {
    try {
      const { data } = await this.supabase
        .from('profiles')
        .select('subscription_tier')
        .eq('id', userId)
        .single();

      if (data?.subscription_tier && data.subscription_tier in MONTHLY_BUDGET) {
        return data.subscription_tier as BudgetTier;
      }
    } catch {
      // profiles table may not exist or user may not have a row
    }
    return 'free';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the current calendar-month billing period boundaries. */
function getCurrentBillingPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const periodStart = new Date(Date.UTC(year, month, 1)).toISOString();
  const periodEnd = new Date(Date.UTC(year, month + 1, 1)).toISOString();

  return { periodStart, periodEnd };
}

/**
 * Resolve a quality preset from job metadata / input_data.
 * Falls back to 'balanced' if not specified or unrecognised.
 */
export function resolveQualityPreset(
  inputData: Record<string, any>,
  metadata?: Record<string, any>,
): QualityPreset {
  const raw =
    metadata?.quality_preset ??
    inputData?.quality_preset ??
    inputData?.tier;

  // Map tier names to quality presets
  const TIER_TO_PRESET: Record<string, QualityPreset> = {
    speed: 'speed',
    free: 'speed',
    starter: 'balanced',
    balanced: 'balanced',
    pro: 'quality',
    quality: 'quality',
    premium: 'quality',
  };

  if (typeof raw === 'string' && raw in TIER_TO_PRESET) {
    return TIER_TO_PRESET[raw];
  }

  return 'balanced';
}

// ---------------------------------------------------------------------------
// Exports summary
// ---------------------------------------------------------------------------
// CostTracker         - per-task token/cost/action tracking with hard limits
// CostControlService  - per-user monthly budgets, DB integration, pre-flight checks
// BudgetExceededError  - thrown when a task exceeds its LLM cost budget
// ActionLimitExceededError - thrown when a task exceeds its action limit
// resolveQualityPreset - derive quality preset from job input_data / metadata
