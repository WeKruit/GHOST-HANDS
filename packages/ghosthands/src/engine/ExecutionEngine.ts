/**
 * ExecutionEngine — Orchestrates mode selection between cookbook replay and
 * Magnitude LLM-driven execution.
 *
 * Decision logic:
 * 1. Look up a matching manual via ManualStore
 * 2. If manual exists with health_score > 0.3: try CookbookExecutor
 * 3. On cookbook success: record success, return result
 * 4. On cookbook failure: record failure, signal fallback to Magnitude
 * 5. If no manual or health too low: signal Magnitude mode immediately
 */

import type { ManualStore } from './ManualStore';
import type { CookbookExecutor } from './CookbookExecutor';
import type { ActionManual } from './types';
import type { AutomationJob } from '../workers/taskHandlers/types';
import type { BrowserAutomationAdapter } from '../adapters/types';
import type { CostTracker } from '../workers/costControl';
import type { ProgressTracker } from '../workers/progressTracker';
import { detectPlatform } from './PageObserver';

// ── Types ────────────────────────────────────────────────────────────────

export interface ExecutionEngineOptions {
  manualStore: ManualStore;
  cookbookExecutor: CookbookExecutor;
}

export interface ExecutionResult {
  success: boolean;
  mode: 'cookbook' | 'magnitude';
  result?: Record<string, any>;
  error?: string;
  manualId?: string;
  cookbookSteps: number;
  magnitudeSteps: number;
}

export interface ExecutionParams {
  job: AutomationJob;
  adapter: BrowserAutomationAdapter;
  costTracker: CostTracker;
  progress: ProgressTracker;
  logEvent: (eventType: string, metadata: Record<string, any>) => Promise<void>;
  /** Local file path to downloaded resume, passed through to cookbook steps */
  resumeFilePath?: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────

const MIN_HEALTH_THRESHOLD = 0.3;

// ── Implementation ──────────────────────────────────────────────────────

export class ExecutionEngine {
  private manualStore: ManualStore;
  private cookbookExecutor: CookbookExecutor;

  constructor(options: ExecutionEngineOptions) {
    this.manualStore = options.manualStore;
    this.cookbookExecutor = options.cookbookExecutor;
  }

  /**
   * Attempt cookbook-first execution for a job.
   *
   * Returns an ExecutionResult indicating whether the cookbook path succeeded
   * or whether the caller should fall back to Magnitude.
   */
  async execute(params: ExecutionParams): Promise<ExecutionResult> {
    const { job, adapter, costTracker, progress, logEvent } = params;

    // Detect platform from target URL
    const platform = detectPlatform(job.target_url);

    // Look up a matching manual
    const manual = await this.manualStore.lookup(
      job.target_url,
      job.job_type,
      platform,
    );

    if (manual) {
      await logEvent('manual_found', {
        manual_id: manual.id,
        health_score: manual.health_score,
        url_pattern: manual.url_pattern,
      });
    }

    // No manual found — go straight to Magnitude
    if (!manual) {
      await logEvent('mode_selected', {
        mode: 'magnitude',
        reason: 'no_manual_found',
      });

      // Notify cost/progress trackers if they support mode awareness
      costTracker?.setMode?.('magnitude');
      progress?.setExecutionMode?.('magnitude');

      return {
        success: false,
        mode: 'magnitude',
        cookbookSteps: 0,
        magnitudeSteps: 0,
      };
    }

    // Manual health too low — skip cookbook
    if (manual.health_score <= MIN_HEALTH_THRESHOLD) {
      await logEvent('mode_selected', {
        mode: 'magnitude',
        manual_id: manual.id,
        reason: `health_too_low: ${manual.health_score}`,
      });

      costTracker?.setMode?.('magnitude');
      progress?.setExecutionMode?.('magnitude');

      return {
        success: false,
        mode: 'magnitude',
        manualId: manual.id,
        cookbookSteps: 0,
        magnitudeSteps: 0,
      };
    }

    // Try cookbook execution
    await logEvent('mode_selected', {
      mode: 'cookbook',
      manual_id: manual.id,
      reason: 'manual_found_with_good_health',
    });

    costTracker?.setMode?.('cookbook');
    progress?.setExecutionMode?.('cookbook');

    const userData = (job.input_data?.user_data as Record<string, string>) || {};

    try {
      const cookbookResult = await this.cookbookExecutor.executeAll(
        adapter.page,
        manual,
        userData,
      );

      if (cookbookResult.success) {
        await this.manualStore.recordSuccess(manual.id);

        return {
          success: true,
          mode: 'cookbook',
          manualId: manual.id,
          cookbookSteps: cookbookResult.stepsCompleted,
          magnitudeSteps: 0,
        };
      }

      // Cookbook failed — record failure and signal fallback
      await this.manualStore.recordFailure(manual.id);

      await logEvent('mode_switched', {
        from_mode: 'cookbook',
        to_mode: 'magnitude',
        reason: cookbookResult.error || 'cookbook_step_failed',
      });

      costTracker?.setMode?.('magnitude');
      progress?.setExecutionMode?.('magnitude');

      return {
        success: false,
        mode: 'magnitude',
        manualId: manual.id,
        error: cookbookResult.error,
        cookbookSteps: cookbookResult.stepsCompleted,
        magnitudeSteps: 0,
      };
    } catch (err: any) {
      // Unexpected error during cookbook execution
      await this.manualStore.recordFailure(manual.id);

      await logEvent('mode_switched', {
        from_mode: 'cookbook',
        to_mode: 'magnitude',
        reason: `cookbook_error: ${err.message}`,
      });

      costTracker?.setMode?.('magnitude');
      progress?.setExecutionMode?.('magnitude');

      return {
        success: false,
        mode: 'magnitude',
        manualId: manual.id,
        error: err.message,
        cookbookSteps: 0,
        magnitudeSteps: 0,
      };
    }
  }
}
