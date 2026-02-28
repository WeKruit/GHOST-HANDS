/**
 * V3ExecutionEngine — Top-level entry point for v3 hybrid execution.
 *
 * Replaces ExecutionEngine (v1) when engine_version=3.
 *
 * Flow:
 *   1. Try CookbookExecutorV3 (DOM-first replay) — nearly free
 *   2. On failure → SectionOrchestrator (3-layer escalation)
 *   3. Record successful runs for future cookbook replay
 *
 * The SectionOrchestrator handles the observe→match→plan→execute→review loop
 * across all three layers (DOM → Stagehand → Magnitude).
 */

import { SectionOrchestrator, type OrchestratorResult } from './SectionOrchestrator';
import { CookbookExecutorV3, type CookbookV3Result } from './CookbookExecutorV3';
import { LayerHand } from './LayerHand';
import { DOMHand } from './layers/DOMHand';
import { StagehandHand } from './layers/StagehandHand';
import { MagnitudeHand } from './layers/MagnitudeHand';
import type {
  LayerContext,
  CookbookPageEntry,
} from './types';
import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { AutomationJob } from '../../workers/taskHandlers/types';
import type { CostTracker } from '../../workers/costControl';
import type { ProgressTracker } from '../../workers/progressTracker';

// ── Types ────────────────────────────────────────────────────────────────

export interface V3ExecutionResult {
  success: boolean;
  mode: 'cookbook' | 'v3_orchestrator' | 'magnitude';
  totalCost: number;
  pagesProcessed: number;
  actionsExecuted: number;
  actionsVerified: number;
  actionsFailed: number;
  cookbookResult?: CookbookV3Result;
  orchestratorResult?: OrchestratorResult;
  errors: string[];
}

export interface V3ExecutionParams {
  job: AutomationJob;
  adapter: BrowserAutomationAdapter;
  page: import('playwright').Page;
  costTracker: CostTracker;
  progress: ProgressTracker;
  logEvent: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
  userProfile: Record<string, unknown>;
  platformHint?: string;
  cookbook?: CookbookPageEntry;
  budgetUsd?: number;
  /** Optional secondary adapter for Stagehand layer */
  stagehandAdapter?: BrowserAutomationAdapter;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_USD = 0.50;

// ── Implementation ──────────────────────────────────────────────────────

export class V3ExecutionEngine {
  private logEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;

  /**
   * Execute a job using the v3 three-layer engine.
   */
  async execute(params: V3ExecutionParams): Promise<V3ExecutionResult> {
    this.logEvent = params.logEvent;
    const budget = params.budgetUsd ?? DEFAULT_BUDGET_USD;
    let totalCost = 0;

    const result: V3ExecutionResult = {
      success: false,
      mode: 'v3_orchestrator',
      totalCost: 0,
      pagesProcessed: 0,
      actionsExecuted: 0,
      actionsVerified: 0,
      actionsFailed: 0,
      errors: [],
    };

    // ── Step 1: Try cookbook replay if available ──────────────────────
    if (params.cookbook) {
      await params.logEvent('v3_mode_selected', { mode: 'cookbook' });
      params.costTracker?.setMode?.('cookbook');
      params.progress?.setExecutionMode?.('cookbook');

      const cookbookExecutor = new CookbookExecutorV3({
        adapter: params.adapter,
        logEvent: params.logEvent,
      });

      const userData = params.userProfile as Record<string, string>;
      const cookbookResult = await cookbookExecutor.execute(
        params.page,
        params.cookbook,
        userData,
      );

      result.cookbookResult = cookbookResult;
      totalCost += cookbookResult.costIncurred;

      if (cookbookResult.success) {
        result.success = true;
        result.mode = 'cookbook';
        result.totalCost = totalCost;
        result.actionsExecuted = cookbookResult.actionsAttempted;
        result.actionsVerified = cookbookResult.actionsSucceeded;

        await params.logEvent('v3_cookbook_success', {
          actions_attempted: cookbookResult.actionsAttempted,
          actions_succeeded: cookbookResult.actionsSucceeded,
          cost: totalCost,
        });

        return result;
      }

      await params.logEvent('v3_cookbook_failed', {
        reason: cookbookResult.error ?? 'insufficient_success_rate',
        actions_failed: cookbookResult.actionsFailed,
      });
    }

    // ── Step 2: SectionOrchestrator (3-layer escalation) ────────────
    await params.logEvent('v3_mode_selected', { mode: 'v3_orchestrator' });
    params.costTracker?.setMode?.('hybrid' as any);
    params.progress?.setExecutionMode?.('hybrid' as any);

    // Build layer stack
    const layers: LayerHand[] = [new DOMHand()];

    if (params.stagehandAdapter) {
      layers.push(new StagehandHand(params.stagehandAdapter));
    }

    layers.push(new MagnitudeHand(params.adapter));

    const orchestrator = new SectionOrchestrator(layers);

    const ctx: LayerContext = {
      page: params.page,
      userProfile: params.userProfile,
      jobId: params.job.id,
      budgetRemaining: budget - totalCost,
      totalCost,
      platformHint: params.platformHint,
      cookbook: params.cookbook,
      logger: {
        info: (msg, meta) => params.logEvent('v3_info', { message: msg, ...meta }),
        warn: (msg, meta) => params.logEvent('v3_warn', { message: msg, ...meta }),
        error: (msg, meta) => params.logEvent('v3_error', { message: msg, ...meta }),
        debug: (msg, meta) => params.logEvent('v3_debug', { message: msg, ...meta }),
      },
    };

    try {
      const orchResult = await orchestrator.run(ctx);
      result.orchestratorResult = orchResult;
      result.success = orchResult.success;
      result.pagesProcessed = orchResult.pagesProcessed;
      result.actionsExecuted = orchResult.actionsExecuted;
      result.actionsVerified = orchResult.actionsVerified;
      result.actionsFailed = orchResult.actionsFailed;
      result.errors = orchResult.errors;
      totalCost += orchResult.totalCost;

      await params.logEvent('v3_orchestrator_complete', {
        success: orchResult.success,
        pages: orchResult.pagesProcessed,
        actions_executed: orchResult.actionsExecuted,
        actions_verified: orchResult.actionsVerified,
        total_cost: totalCost,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(errorMsg);
      await params.logEvent('v3_orchestrator_error', { error: errorMsg });
    }

    result.totalCost = totalCost;
    return result;
  }
}
