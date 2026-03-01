/**
 * V3ExecutionEngine — Top-level entry point for v3 hybrid execution.
 *
 * Replaces ExecutionEngine (v1) when engine_version=3.
 *
 * Execution modes:
 *   - 'auto'          → cookbook first, then 3-layer orchestrator as fallback (default)
 *   - 'hybrid'        → skip cookbook, go straight to 3-layer orchestrator
 *   - 'ai_only'       → skip cookbook, go straight to 3-layer orchestrator
 *   - 'cookbook_only'  → cookbook only, fail if no manual exists or cookbook fails
 *
 * The SectionOrchestrator handles the observe→match→plan→execute→review loop
 * across all three layers (DOM → Stagehand → Magnitude).
 *
 * Note: 'smart_apply' and 'agent_apply' modes are handled by their respective
 * TaskHandlers (SmartApplyHandler, AgentApplyHandler) in the job executor,
 * not by this engine.
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

/** Execution modes supported by the V3 engine */
export type V3ExecutionMode = 'auto' | 'hybrid' | 'ai_only' | 'cookbook_only';

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
  /** Execution mode — defaults to 'auto' (cookbook → orchestrator) */
  executionMode?: V3ExecutionMode;
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

    // Helper: log without aborting the run on transient failures
    const safeLog = async (eventType: string, metadata: Record<string, unknown>) => {
      try { await params.logEvent(eventType, metadata); } catch { /* swallow */ }
    };

    const mode = params.executionMode ?? 'auto';
    await safeLog('v3_execution_mode', { mode });

    // ── cookbook_only: fail fast if no cookbook ──────────────────────
    if (mode === 'cookbook_only' && !params.cookbook) {
      result.errors.push('cookbook_only mode requested but no cookbook available');
      await safeLog('v3_cookbook_only_no_manual', {});
      return result;
    }

    // ── Skip cookbook for hybrid/ai_only modes ──────────────────────
    const tryCookbook = (mode === 'auto' || mode === 'cookbook_only') && params.cookbook;

    // ── Step 1: Try cookbook replay if available ──────────────────────
    if (tryCookbook) {
      await safeLog('v3_mode_selected', { mode: 'cookbook' });
      params.costTracker?.setMode?.('cookbook');
      params.progress?.setExecutionMode?.('cookbook');

      try {
        const cookbookExecutor = new CookbookExecutorV3({
          adapter: params.adapter,
          logEvent: params.logEvent,
        });

        const userData = params.userProfile as Record<string, string>;
        const cookbookResult = await cookbookExecutor.execute(
          params.page,
          params.cookbook!,
          userData,
        );

        result.cookbookResult = cookbookResult;
        totalCost += cookbookResult.costIncurred;

        // Sync cookbook cost into CostTracker for system-wide tracking
        try {
          if (cookbookResult.costIncurred > 0) {
            params.costTracker.recordTokenUsage({
              inputTokens: 0,
              outputTokens: 0,
              inputCost: cookbookResult.costIncurred,
              outputCost: 0,
            });
          }
          for (let i = 0; i < cookbookResult.actionsAttempted; i++) {
            params.costTracker.recordAction();
          }
        } catch {
          // CostTracker budget/action limit exceeded — cookbook already tracks internally
        }

        if (cookbookResult.success) {
          result.success = true;
          result.mode = 'cookbook';
          result.totalCost = totalCost;
          result.actionsExecuted = cookbookResult.actionsAttempted;
          result.actionsVerified = cookbookResult.actionsSucceeded;
          result.actionsFailed = cookbookResult.actionsFailed;

          await safeLog('v3_cookbook_success', {
            actions_attempted: cookbookResult.actionsAttempted,
            actions_succeeded: cookbookResult.actionsSucceeded,
            actions_failed: cookbookResult.actionsFailed,
            actions_skipped: cookbookResult.actionsSkipped,
            cost: totalCost,
          });

          return result;
        }

        await safeLog('v3_cookbook_failed', {
          reason: cookbookResult.error ?? 'insufficient_success_rate',
          actions_failed: cookbookResult.actionsFailed,
        });

        // cookbook_only: do NOT fall through to orchestrator
        if (mode === 'cookbook_only') {
          result.errors.push('cookbook_only mode: cookbook failed, not escalating');
          result.totalCost = totalCost;
          return result;
        }
      } catch (cookbookErr) {
        // Cookbook failure (including logging errors) should NOT abort the entire run.
        // Fall through to orchestrator (unless cookbook_only mode).
        await safeLog('v3_cookbook_error', {
          error: cookbookErr instanceof Error ? cookbookErr.message : String(cookbookErr),
        });

        if (mode === 'cookbook_only') {
          result.errors.push(`cookbook_only mode: cookbook threw: ${cookbookErr instanceof Error ? cookbookErr.message : String(cookbookErr)}`);
          result.totalCost = totalCost;
          return result;
        }
      }
    }

    // ── Step 2: SectionOrchestrator (3-layer escalation) ────────────
    await safeLog('v3_mode_selected', { mode: 'v3_orchestrator' });
    params.costTracker?.setMode?.('hybrid');
    // ProgressTracker only supports 'cookbook'|'magnitude'; use 'magnitude' as closest match
    params.progress?.setExecutionMode?.('magnitude');

    // Build layer stack
    const layers: LayerHand[] = [new DOMHand()];

    // StagehandHand is optional — enables DOM→Stagehand→Magnitude escalation path.
    // Without it, the orchestrator escalates directly from DOMHand to MagnitudeHand.
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
        info: (msg, meta) => { params.logEvent('v3_info', { message: msg, ...meta }).catch(() => {}); },
        warn: (msg, meta) => { params.logEvent('v3_warn', { message: msg, ...meta }).catch(() => {}); },
        error: (msg, meta) => { params.logEvent('v3_error', { message: msg, ...meta }).catch(() => {}); },
        debug: (msg, meta) => { params.logEvent('v3_debug', { message: msg, ...meta }).catch(() => {}); },
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

      // Sync orchestrator cost into CostTracker for system-wide tracking.
      // Record cost in a single call, then record action count separately.
      // Do NOT call recordModeStep('magnitude') for every action — the orchestrator
      // uses a mix of DOM (free), Stagehand (cheap), and Magnitude (expensive) layers.
      // We don't have per-layer action counts here, so only record the aggregate cost.
      try {
        if (orchResult.totalCost > 0) {
          params.costTracker.recordTokenUsage({
            inputTokens: 0,
            outputTokens: 0,
            inputCost: orchResult.totalCost,
            outputCost: 0,
          });
        }
        for (let i = 0; i < orchResult.actionsExecuted; i++) {
          params.costTracker.recordAction();
        }
      } catch {
        // CostTracker budget/action limit exceeded — orchestrator already handles budget internally
      }

      await safeLog('v3_orchestrator_complete', {
        success: orchResult.success,
        pages: orchResult.pagesProcessed,
        actions_executed: orchResult.actionsExecuted,
        actions_verified: orchResult.actionsVerified,
        total_cost: totalCost,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(errorMsg);
      await safeLog('v3_orchestrator_error', { error: errorMsg });
    }

    result.totalCost = totalCost;
    return result;
  }
}
