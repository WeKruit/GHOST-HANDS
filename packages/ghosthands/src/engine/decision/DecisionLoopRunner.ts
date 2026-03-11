import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { CostTracker } from '../../workers/costControl';
import type { AnthropicClientConfig } from '../../workers/taskHandlers/types';
import type { Page } from 'playwright';
import { ActionExecutor } from './actionExecutor';
import { PageDecisionEngine } from './PageDecisionEngine';
import { PageSnapshotBuilder } from './pageSnapshotBuilder';
import { MAX_ITERATIONS, checkTermination } from './terminationDetector';
import type {
  ActionHistoryEntry,
  DecisionAction,
  DecisionLoopState,
  ExecutorResult,
} from './types';
import { DecisionLoopStateSchema } from './types';

const ACTION_HISTORY_LIMIT = 25;
const SENSITIVE_PROFILE_KEY = /password|secret|token|cookie|session|credential|auth|api[-_]?key/i;

type ProgressEvent = {
  type: string;
  message: string;
  iteration: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string | undefined | null): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function summarizeProfile(profile: Record<string, any>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(profile || {})) {
    if (!key || key.startsWith('_') || SENSITIVE_PROFILE_KEY.test(key)) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      lines.push(`${key}: ${trimmed.slice(0, 240)}`);
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }

    if (Array.isArray(value)) {
      const rendered = value
        .map((entry) => {
          if (typeof entry === 'string') return entry.trim();
          if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
          if (entry && typeof entry === 'object') {
            return JSON.stringify(redactSensitiveObject(entry)).slice(0, 200);
          }
          return '';
        })
        .filter(Boolean)
        .slice(0, 6)
        .join('; ');
      if (rendered) lines.push(`${key}: ${rendered}`);
      continue;
    }

    if (typeof value === 'object') {
      const redacted = JSON.stringify(redactSensitiveObject(value)).slice(0, 300);
      if (redacted && redacted !== '{}') lines.push(`${key}: ${redacted}`);
    }
  }

  return lines.join('\n').slice(0, 4000);
}

function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveObject(entry));
  }

  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PROFILE_KEY.test(key)) continue;
    output[key] = redactSensitiveObject(entry);
  }
  return output;
}

function deriveActionResult(decision: DecisionAction, executorResult: ExecutorResult): ActionHistoryEntry['result'] {
  if (
    decision.action === 'stop_for_review' ||
    decision.action === 'mark_complete' ||
    decision.action === 'report_blocked'
  ) {
    return 'skipped';
  }

  if (executorResult.status === 'action_succeeded') {
    if (
      executorResult.fieldsAttempted > 0 &&
      executorResult.fieldsFilled > 0 &&
      executorResult.fieldsFilled < executorResult.fieldsAttempted
    ) {
      return 'partial';
    }
    return 'success';
  }

  if (executorResult.status === 'needs_review') return 'skipped';
  return 'failed';
}

export class DecisionLoopRunner {
  private readonly page: Page;
  private readonly adapter: BrowserAutomationAdapter;
  private readonly profile: Record<string, any>;
  private readonly platform: string;
  private readonly budgetUsd: number;
  private readonly costTracker?: CostTracker;
  private readonly onProgress?: (event: ProgressEvent) => void;
  private readonly maxIterations: number;
  private readonly snapshotBuilder: PageSnapshotBuilder;
  private readonly decisionEngine: PageDecisionEngine;
  private readonly actionExecutor: ActionExecutor;
  private readonly profileSummary: string;
  private readonly previousActionHistory: ActionHistoryEntry[];
  private readonly previousIteration: number;

  constructor(config: {
    page: Page;
    adapter: BrowserAutomationAdapter;
    profile: Record<string, any>;
    platform: string;
    budgetUsd: number;
    costTracker?: CostTracker;
    anthropicConfig?: AnthropicClientConfig;
    model?: string;
    onProgress?: (event: { type: string; message: string; iteration: number }) => void;
    maxIterations?: number;
    previousActionHistory?: ActionHistoryEntry[];
    previousIteration?: number;
  }) {
    this.page = config.page;
    this.adapter = config.adapter;
    this.profile = config.profile;
    this.platform = config.platform;
    this.budgetUsd = config.budgetUsd;
    this.costTracker = config.costTracker;
    this.onProgress = config.onProgress;
    this.maxIterations = Math.max(1, Math.min(config.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS));
    this.snapshotBuilder = new PageSnapshotBuilder(config.platform);
    this.decisionEngine = new PageDecisionEngine({
      anthropicConfig: config.anthropicConfig,
      model: config.model,
      onTokenUsage: config.costTracker
        ? (usage) => {
            config.costTracker!.recordTokenUsage({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          }
        : undefined,
    });
    this.actionExecutor = new ActionExecutor(config.page, config.adapter);
    this.profileSummary = summarizeProfile(config.profile);
    this.previousActionHistory = config.previousActionHistory ?? [];
    this.previousIteration = config.previousIteration ?? 0;
  }

  async run(): Promise<DecisionLoopState & {
    blockerDetected?: { type: string; confidence: number; pageUrl: string };
  }> {
    const loopState: DecisionLoopState = DecisionLoopStateSchema.parse({
      iteration: this.previousIteration,
      pagesProcessed: 0,
      currentPageFingerprint: null,
      previousPageFingerprint: null,
      samePageCount: 0,
      actionHistory: this.previousActionHistory.slice(-ACTION_HISTORY_LIMIT),
      loopCostUsd: 0,
      terminalState: 'running',
      terminationReason: null,
    });

    let blockerDetected: { type: string; confidence: number; pageUrl: string } | undefined;

    try {
      while (loopState.terminalState === 'running') {
        loopState.iteration += 1;
        this.emit({
          type: 'observe',
          iteration: loopState.iteration,
          message: 'Building page snapshot.',
        });

        let snapshot = await this.snapshotBuilder.buildSnapshot(this.page, loopState.actionHistory);
        if (snapshot.fields.length === 0 && snapshot.buttons.length === 0 && loopState.iteration > 0) {
          await new Promise((r) => setTimeout(r, 2000));
          await this.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          const retrySnapshot = await this.snapshotBuilder.buildSnapshot(this.page, loopState.actionHistory);
          if (retrySnapshot.fields.length > 0 || retrySnapshot.buttons.length > 0) {
            snapshot = retrySnapshot;
            this.emit({
              type: 'observe',
              iteration: loopState.iteration,
              message: `[decision-loop] re-observation recovered: fields=${snapshot.fields.length} buttons=${snapshot.buttons.length}`,
            });
          }
        }
        loopState.previousPageFingerprint = loopState.currentPageFingerprint;
        loopState.currentPageFingerprint = snapshot.fingerprint.hash;
        const pageChanged = loopState.previousPageFingerprint !== loopState.currentPageFingerprint;
        if (pageChanged || !loopState.previousPageFingerprint) {
          loopState.pagesProcessed += 1;
        }
        loopState.samePageCount = !pageChanged && loopState.previousPageFingerprint
          ? loopState.samePageCount + 1
          : 0;

        this.emit({
          type: 'decide',
          iteration: loopState.iteration,
          message: `Deciding next action for ${snapshot.pageType} page.`,
        });

        const decisionResult = await this.decisionEngine.decide(
          snapshot,
          this.profileSummary,
          this.platform,
        );
        // Cost is tracked by CostTracker via onTokenUsage callback (decision calls)
        // and adapter tokensUsed events (Stagehand/Magnitude calls).

        const guardedDecision = this.applyGuardrails(decisionResult, snapshot);
        this.emit({
          type: 'decision',
          iteration: loopState.iteration,
          message: `Decision: ${guardedDecision.action}${guardedDecision.target ? ` (${guardedDecision.target})` : ''}`,
        });

        const executorResult = await this.actionExecutor.execute(guardedDecision, snapshot);

        // Sync loopCostUsd from CostTracker if available (real costs),
        // otherwise it stays at 0 (costs still tracked externally).
        if (this.costTracker) {
          loopState.loopCostUsd = this.costTracker.getSnapshot().totalCost;
        }

        const historyEntry: ActionHistoryEntry = {
          iteration: loopState.iteration,
          action: guardedDecision.action,
          target: guardedDecision.target || '',
          result: deriveActionResult(guardedDecision, executorResult),
          layer: executorResult.layer,
          costUsd: 0, // Real cost tracked by CostTracker, not per-action estimates
          durationMs: decisionResult.durationMs + executorResult.durationMs,
          fieldsAttempted: executorResult.fieldsAttempted,
          fieldsFilled: executorResult.fieldsFilled,
          pageFingerprint: snapshot.fingerprint.hash,
          timestamp: Date.now(),
        };
        loopState.actionHistory = [...loopState.actionHistory, historyEntry].slice(-ACTION_HISTORY_LIMIT);

        const configuredMaxIterationReached = loopState.iteration >= this.maxIterations;
        const termination = configuredMaxIterationReached
          ? {
            type: 'max_iterations' as const,
            reason: `Reached configured max iteration limit (${this.maxIterations}).`,
          }
          : checkTermination(guardedDecision, loopState, this.budgetUsd);

        this.emit({
          type: 'action',
          iteration: loopState.iteration,
          message: executorResult.summary,
        });

        if (termination) {
          loopState.terminalState = termination.type;
          loopState.terminationReason = termination.reason;
          if (termination.type === 'blocked') {
            blockerDetected = {
              type: snapshot.blocker.type ?? 'unknown',
              confidence: snapshot.blocker.confidence,
              pageUrl: snapshot.url,
            };
          }
          this.emit({
            type: 'termination',
            iteration: loopState.iteration,
            message: termination.reason,
          });
          break;
        }

        if (executorResult.pageNavigated) {
          await this.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
          await sleep(2000);
        }
        if (executorResult.pageNavigated || executorResult.status === 'action_succeeded') {
          await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        }
      }
    } catch (error) {
      loopState.terminalState = 'error';
      loopState.terminationReason = error instanceof Error ? error.message : String(error);
      this.emit({
        type: 'error',
        iteration: loopState.iteration,
        message: loopState.terminationReason,
      });
    }

    loopState.terminationReason = loopState.terminationReason || 'Decision loop exited without a termination reason.';
    return {
      ...DecisionLoopStateSchema.parse(loopState),
      ...(blockerDetected ? { blockerDetected } : {}),
    };
  }

  private emit(event: ProgressEvent): void {
    this.onProgress?.(event);
  }

  private applyGuardrails(
    decision: DecisionAction,
    snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
  ): DecisionAction {
    if (snapshot.blocker.detected && snapshot.blocker.type === 'captcha') {
      return {
        action: 'report_blocked',
        reasoning: `${decision.reasoning} Guardrail override: CAPTCHA or human-verification challenge detected.`,
        confidence: Math.max(decision.confidence, snapshot.blocker.confidence),
      };
    }

    if (snapshot.pageType === 'confirmation') {
      return {
        action: 'mark_complete',
        reasoning: `${decision.reasoning} Guardrail override: confirmation page detected.`,
        confidence: Math.max(decision.confidence, 0.95),
      };
    }

    const emptyVisibleFields = snapshot.fields.filter(
      (field) => field.isVisible && !field.isDisabled && field.isEmpty,
    );
    const looksLikeReviewPage =
      /review/i.test(snapshot.pageType) ||
      (
        emptyVisibleFields.length === 0 &&
        snapshot.buttons.some((button) => /submit/i.test(button.text))
      );

    if (looksLikeReviewPage && decision.action !== 'stop_for_review' && decision.action !== 'mark_complete') {
      return {
        action: 'stop_for_review',
        reasoning: `${decision.reasoning} Guardrail override: review-like page detected; do not click submit.`,
        confidence: Math.max(decision.confidence, 0.9),
      };
    }

    if (
      (decision.action === 'click_next' || decision.action === 'click_apply') &&
      emptyVisibleFields.length > 0 &&
      !/login|verification|account/.test(snapshot.pageType)
    ) {
      return {
        action: 'fill_form',
        reasoning: `${decision.reasoning} Guardrail override: editable empty fields remain visible, so filling is safer than navigating.`,
        confidence: Math.max(decision.confidence, 0.85),
        fieldsToFill: emptyVisibleFields.slice(0, 15).map((field) => field.label),
      };
    }

    if (decision.action === 'click_apply') {
      const targetText = normalizeText(decision.target);
      const dangerousButton = snapshot.buttons.find((button) =>
        /submit|finish|send application/i.test(button.text) &&
        (!targetText ||
          normalizeText(button.text).includes(targetText) ||
          normalizeText(button.selector).includes(targetText)),
      );
      if (dangerousButton) {
        return {
          action: 'stop_for_review',
          reasoning: `${decision.reasoning} Guardrail override: resolved apply target appears to be a final submission button.`,
          confidence: Math.max(decision.confidence, 0.95),
        };
      }
    }

    return decision;
  }
}
