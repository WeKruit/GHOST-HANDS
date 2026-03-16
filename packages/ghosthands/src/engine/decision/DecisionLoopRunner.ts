import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { PageContextService } from '../../context/PageContextService.js';
import type { ContextEvent, QuestionRecord } from '../../context/types.js';
import type { CostTracker } from '../../workers/costControl';
import type { AnthropicClientConfig } from '../../workers/taskHandlers/types';
import type { Page } from 'playwright';
import { writeInferenceOutput } from '../../monitoring/logger.js';
import { detectPlatform } from '../PageObserver';
import { ActionExecutor } from './actionExecutor';
import { PageDecisionEngine } from './PageDecisionEngine';
import { PageSnapshotBuilder } from './pageSnapshotBuilder';
import {
  applyPlatformCredentialToProfile,
  getPlatformAuthContext,
  resolvePlatformAuthContext,
  setPlatformAuthContext,
  type PlatformAuthContext,
} from '../../workers/platformAuthRuntime.js';
import { MAX_ITERATIONS, checkTermination } from './terminationDetector';
import type { DurableFieldRecord, MergedPageObservation } from './mergedObserverTypes';
import { questionStateToMergedState } from './mergedObserverTypes';
import { stableFieldKey } from './observerMerger';
import type {
  ActionHistoryEntry,
  DecisionAction,
  DecisionLoopState,
  ExecutorResult,
  FieldSnapshot,
} from './types';
import { DecisionLoopStateSchema } from './types';

const ACTION_HISTORY_LIMIT = 25;
const SENSITIVE_PROFILE_KEY = /password|secret|token|cookie|session|credential|auth|api[-_]?key/i;

type ProgressEvent = {
  type: string;
  message: string;
  iteration: number;
};

type PostActionState =
  | 'transitioned'
  | 'same_page_with_controls'
  | 'parser_empty'
  | 'dom_parse_miss'
  | 'unknown_pending';

type PostActionStabilization = {
  state: PostActionState;
  snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>;
  quickControlCount: number;
  adapterObservedCount: number;
};

type SnapshotRecovery = {
  snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>;
  recovered: boolean;
  reason?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string | undefined | null): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function inferDomainFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizePlatformHint(explicitPlatform: string | undefined | null, url: string): string {
  const hinted = normalizeText(explicitPlatform);
  const detected = detectPlatform(url);

  if (detected !== 'other') return detected;
  if (!hinted || hinted === 'other' || hinted === 'generic' || hinted === 'unknown') {
    return 'other';
  }
  return explicitPlatform ?? 'other';
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function normalizeQuestionType(value: string | undefined | null): string {
  switch ((value || '').trim().toLowerCase()) {
    case 'tel':
      return 'phone';
    case 'radio-group':
    case 'aria_radio':
    case 'button-group':
      return 'radio';
    case 'checkbox-group':
    case 'toggle':
      return 'checkbox';
    default:
      return (value || '').trim().toLowerCase();
  }
}

function recordActorFromEvent(
  actor: ContextEvent['actor'] | undefined,
): DurableFieldRecord['lastActor'] {
  if (actor === 'dom' || actor === 'magnitude' || actor === 'human') return actor;
  return null;
}

function buildDurableStateHistory(
  history: ContextEvent[],
): DurableFieldRecord['stateHistory'] {
  const transitions: DurableFieldRecord['stateHistory'] = [];
  let previousState: ReturnType<typeof questionStateToMergedState> | null = null;

  for (const event of history) {
    const nextQuestionState = typeof event.after?.state === 'string'
      ? event.after.state
      : null;
    if (!nextQuestionState) continue;

    const nextState = questionStateToMergedState(nextQuestionState as any);
    if (previousState && previousState !== nextState) {
      transitions.push({
        from: previousState,
        to: nextState,
        actor: event.actor,
        timestamp: event.timestamp,
      });
    }
    previousState = nextState;
  }

  return transitions.slice(-5);
}

function questionRecordToDurableField(
  question: QuestionRecord,
  history: ContextEvent[],
): DurableFieldRecord {
  const questionHistory = history.filter((event) => event.targetQuestionKey === question.questionKey);
  const lastEvent = questionHistory[questionHistory.length - 1];

  return {
    fieldKey: question.questionKey,
    lastMergedState: questionStateToMergedState(question.state),
    lastProvenance: question.observerProvenance
      ? {
          sources: [...question.observerProvenance.sources],
          concordant: question.observerProvenance.concordant,
        }
      : {
          sources: ['dom'],
          concordant: null,
        },
    lastActor: question.lastActor ?? recordActorFromEvent(lastEvent?.actor),
    lastActorTimestamp: lastEvent?.timestamp ?? question.lastUpdatedAt ?? null,
    fillAttemptCount: question.attemptCount,
    magnitudeAttemptCount: questionHistory.filter(
      (event) => event.actor === 'magnitude' && event.type === 'fill_attempted',
    ).length,
    lastCommittedValue: question.currentValue ?? question.lastAnswer ?? null,
    expectedValue: question.lastAnswer ?? null,
    sectionFingerprint: question.sectionFingerprint ?? null,
    stateHistory: buildDurableStateHistory(questionHistory),
  };
}

function questionMatchesField(
  question: QuestionRecord,
  field: FieldSnapshot,
): boolean {
  if (question.selectors.includes(field.selector)) return true;

  const questionLabel = normalizeText(question.promptText || question.normalizedPrompt);
  const fieldLabel = normalizeText(field.label);
  if (!questionLabel || !fieldLabel) return false;

  if (normalizeQuestionType(question.questionType) !== normalizeQuestionType(field.fieldType)) {
    return false;
  }

  return (
    questionLabel === fieldLabel ||
    questionLabel.includes(fieldLabel) ||
    fieldLabel.includes(questionLabel)
  );
}

function hasVisiblePasswordFields(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>): number {
  return snapshot.fields.filter((field) => field.isVisible && field.fieldType === 'password').length;
}

function hasConfirmPasswordField(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>): boolean {
  return snapshot.fields.some((field) => {
    if (!field.isVisible || field.fieldType !== 'password') return false;
    return /confirm|verify|re-enter/i.test(field.label);
  });
}

function hasHeading(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>, pattern: RegExp): boolean {
  return snapshot.headings.some((heading) => pattern.test(heading));
}

function hasButton(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>, pattern: RegExp): boolean {
  return snapshot.buttons.some((button) => pattern.test(button.text));
}

function looksLikeApplicationStep(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>): boolean {
  const hasAuthHeading = hasHeading(snapshot, /create account|sign in|log in|verification|start your application/i);
  const hasAuthButton = hasButton(snapshot, /create account|sign in|log in|apply manually/i);
  if (hasAuthHeading || hasAuthButton || hasVisiblePasswordFields(snapshot) > 0) return false;

  if (/questions|review|submitted|confirmation/i.test(snapshot.pageType)) return true;
  if (hasHeading(snapshot, /my information|my experience|application questions|review|legal name|address|email address|phone/i)) {
    return true;
  }
  if (hasButton(snapshot, /save and continue|next|review|submit application/i)) {
    return true;
  }
  return false;
}

function isWorkdayAuthSnapshot(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>): boolean {
  if (snapshot.platform !== 'workday') return false;
  if (looksLikeApplicationStep(snapshot)) return false;
  if (/\/login\b|\/apply\/applymanually\b/i.test(snapshot.url)) return true;
  if (hasVisiblePasswordFields(snapshot) > 0) return true;
  if (hasHeading(snapshot, /create account|sign in|start your application/i)) return true;
  if (hasButton(snapshot, /create account|sign in|apply manually/i)) return true;
  return false;
}

function isAuthSnapshot(snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>): boolean {
  if (looksLikeApplicationStep(snapshot)) return false;
  if (isWorkdayAuthSnapshot(snapshot)) return true;
  if (/account|login|sign_in|verification/i.test(snapshot.pageType)) return true;
  if (snapshot.blocker.detected && /login|verification|auth/i.test(snapshot.blocker.type ?? '')) return true;
  if (hasVisiblePasswordFields(snapshot) > 0) return true;
  if (hasHeading(snapshot, /create account|sign in|log in|verification/i)) return true;
  return false;
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
  private readonly fullPageSnapshotBuilder: PageSnapshotBuilder;
  private readonly decisionEngine: PageDecisionEngine;
  private readonly actionExecutor: ActionExecutor;
  private readonly profileSummary: string;
  private readonly previousActionHistory: ActionHistoryEntry[];
  private readonly previousIteration: number;
  private readonly jobId?: string;
  private readonly userId?: string;
  private readonly pageContext?: PageContextService;
  private readonly callbackUrl?: string | null;
  private readonly runtimeBaseUrl?: string | null;
  private readonly anthropicConfig?: AnthropicClientConfig;
  private readonly resumePath?: string | null;

  constructor(config: {
    page: Page;
    adapter: BrowserAutomationAdapter;
    profile: Record<string, any>;
    platform: string;
    budgetUsd: number;
    costTracker?: CostTracker;
    anthropicConfig?: AnthropicClientConfig;
    model?: string;
    jobId?: string;
    userId?: string;
    onProgress?: (event: { type: string; message: string; iteration: number }) => void;
    maxIterations?: number;
    previousActionHistory?: ActionHistoryEntry[];
    previousIteration?: number;
    pageContext?: PageContextService;
    callbackUrl?: string | null;
    runtimeBaseUrl?: string | null;
    resumePath?: string | null;
  }) {
    this.page = config.page;
    this.adapter = config.adapter;
    this.profile = config.profile;
    this.platform = normalizePlatformHint(config.platform, config.page.url());
    this.budgetUsd = config.budgetUsd;
    this.costTracker = config.costTracker;
    this.onProgress = config.onProgress;
    this.maxIterations = Math.max(1, Math.min(config.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS));
    this.snapshotBuilder = new PageSnapshotBuilder(this.platform, true, 'current_view', this.adapter);
    this.fullPageSnapshotBuilder = new PageSnapshotBuilder(this.platform, false, 'full_page_audit', this.adapter);
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
    this.actionExecutor = new ActionExecutor(config.page, config.adapter, {
      platform: this.platform,
      profile: config.profile,
      jobId: config.jobId,
      userId: config.userId,
      callbackUrl: config.callbackUrl,
      runtimeBaseUrl: config.runtimeBaseUrl,
      anthropicClientConfig: config.anthropicConfig,
      resumePath: config.resumePath,
      pageContext: config.pageContext,
    });
    this.profileSummary = summarizeProfile(config.profile);
    this.previousActionHistory = config.previousActionHistory ?? [];
    this.previousIteration = config.previousIteration ?? 0;
    this.jobId = config.jobId;
    this.userId = config.userId;
    this.pageContext = config.pageContext;
    this.callbackUrl = config.callbackUrl ?? null;
    this.runtimeBaseUrl = config.runtimeBaseUrl ?? null;
    this.anthropicConfig = config.anthropicConfig;
    this.resumePath = config.resumePath ?? null;
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
    let pendingSnapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>> | null = null;

    try {
      while (loopState.terminalState === 'running') {
        loopState.iteration += 1;
        this.emit({
          type: 'observe',
          iteration: loopState.iteration,
          message: 'Building page snapshot.',
        });

        const rawSnapshot = pendingSnapshot ?? await this.snapshotBuilder.buildSnapshot(this.page, loopState.actionHistory);
        pendingSnapshot = null;
        const recovery = await this.recoverSnapshotIfParseMiss(rawSnapshot, loopState.actionHistory);
        const snapshot = recovery.snapshot;
        const durableFields = await this.loadDurableFieldRecords(snapshot.fields);
        const merged = await this.snapshotBuilder.buildMergedSnapshot(
          this.page,
          loopState.actionHistory,
          durableFields,
          undefined,
          snapshot,
          this.adapter,
        );
        const decisionSnapshot = merged.snapshot;
        const authContext = await this.ensurePlatformAuthContext(decisionSnapshot);
        if (recovery.recovered) {
          const recoveryLine = `[decision-loop] snapshot-recover iteration=${loopState.iteration} jobId=${this.jobId ?? ''} reason=${recovery.reason ?? 'unknown'} url=${decisionSnapshot.url} fields=${decisionSnapshot.fields.length} buttons=${decisionSnapshot.buttons.length} fingerprintFields=${decisionSnapshot.fingerprint.fieldCount}`;
          console.log(recoveryLine);
          writeInferenceOutput(`${recoveryLine}\n`);
        }
        const observationLine = `[decision-loop] observation iteration=${loopState.iteration} jobId=${this.jobId ?? ''} platform=${decisionSnapshot.platform} pageType=${decisionSnapshot.pageType} url=${decisionSnapshot.url} fields=${decisionSnapshot.fields.length} buttons=${decisionSnapshot.buttons.length} samePageCount=${loopState.samePageCount} disagreements=${merged.hasDisagreements}`;
        console.log(observationLine);
        writeInferenceOutput(`${observationLine}\n`);
        loopState.previousPageFingerprint = loopState.currentPageFingerprint;
        loopState.currentPageFingerprint = decisionSnapshot.fingerprint.hash;
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
          message: `Deciding next action for ${decisionSnapshot.pageType} page.`,
        });

        const decisionResult = await this.decisionEngine.decide(
          decisionSnapshot,
          this.profileSummary,
          this.platform,
        );
        // Cost is tracked by CostTracker via onTokenUsage callback (decision calls)
        // and adapter tokensUsed events (Stagehand/Magnitude calls).

        const guardedDecision = this.applyGuardrails(decisionResult, decisionSnapshot, authContext);
        const decisionLine = `[decision-loop] decision iteration=${loopState.iteration} jobId=${this.jobId ?? ''} action=${guardedDecision.action} target=${guardedDecision.target ?? ''} confidence=${guardedDecision.confidence.toFixed(2)} reason=${guardedDecision.reasoning}`;
        console.log(decisionLine);
        writeInferenceOutput(`${decisionLine}\n`);
        this.emit({
          type: 'decision',
          iteration: loopState.iteration,
          message: `Decision: ${guardedDecision.action}${guardedDecision.target ? ` (${guardedDecision.target})` : ''}`,
        });

        const executorResult = await this.actionExecutor.execute(guardedDecision, decisionSnapshot);
        const resultLine = `[decision-loop] action-result iteration=${loopState.iteration} jobId=${this.jobId ?? ''} status=${executorResult.status} layer=${executorResult.layer ?? 'none'} navigated=${executorResult.pageNavigated} error=${executorResult.error ?? ''} summary=${executorResult.summary}`;
        console.log(resultLine);
        writeInferenceOutput(`${resultLine}\n`);
        await this.commitActionOutcome(guardedDecision, merged, executorResult);

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
          pageFingerprint: decisionSnapshot.fingerprint.hash,
          timestamp: Date.now(),
        };
        loopState.actionHistory = [...loopState.actionHistory, historyEntry].slice(-ACTION_HISTORY_LIMIT);

        const terminalExecutorFailure =
          executorResult.status === 'action_failed_terminal'
            ? {
                type: (
                  guardedDecision.action === 'login' ||
                  guardedDecision.action === 'create_account' ||
                  guardedDecision.action === 'enter_verification'
                    ? 'review_page'
                    : 'error'
                ) as 'review_page' | 'error',
                reason: executorResult.error || executorResult.summary,
              }
            : null;

        const configuredMaxIterationReached = loopState.iteration >= this.maxIterations;
        const termination = terminalExecutorFailure ?? (configuredMaxIterationReached
          ? {
            type: 'max_iterations' as const,
            reason: `Reached configured max iteration limit (${this.maxIterations}).`,
          }
          : checkTermination(guardedDecision, loopState, this.budgetUsd)
        );

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
              type: decisionSnapshot.blocker.type ?? 'unknown',
              confidence: decisionSnapshot.blocker.confidence,
              pageUrl: decisionSnapshot.url,
            };
          }
          this.emit({
            type: 'termination',
            iteration: loopState.iteration,
            message: termination.reason,
          });
          break;
        }

        const stabilization = await this.postActionStabilize(
          decisionSnapshot,
          guardedDecision,
          executorResult,
          loopState.actionHistory,
        );
        if (stabilization) {
          const stabilizeLine =
            `[decision-loop] stabilize iteration=${loopState.iteration} jobId=${this.jobId ?? ''} ` +
            `state=${stabilization.state} url=${stabilization.snapshot.url} ` +
            `fields=${stabilization.snapshot.fields.length} buttons=${stabilization.snapshot.buttons.length} ` +
            `quickControls=${stabilization.quickControlCount} adapterObserved=${stabilization.adapterObservedCount}`;
          console.log(stabilizeLine);
          writeInferenceOutput(`${stabilizeLine}\n`);
          pendingSnapshot = stabilization.snapshot;
        } else {
          await this.page.waitForLoadState('domcontentloaded', { timeout: executorResult.pageNavigated ? 4000 : 1500 }).catch(() => {});
          await sleep(executorResult.pageNavigated ? 1500 : 600);
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

  private async loadDurableFieldRecords(
    fields: FieldSnapshot[] = [],
  ): Promise<Map<string, DurableFieldRecord>> {
    if (!this.pageContext || fields.length === 0) {
      return new Map();
    }

    const session = await this.pageContext.getSession().catch(() => null);
    const lastPage = session && session.pages.length > 0
      ? session.pages[session.pages.length - 1]
      : undefined;
    const activePage = session?.pages.find((page) => page.pageId === session.activePageId)
      ?? lastPage;
    if (!activePage) {
      return new Map();
    }

    const durableRecords = new Map<string, DurableFieldRecord>();
    const usedQuestionKeys = new Set<string>();

    for (const field of fields) {
      const directSelectorMatch = activePage.questions.find((question) =>
        !usedQuestionKeys.has(question.questionKey) && question.selectors.includes(field.selector),
      );
      const fallbackMatch = directSelectorMatch ?? activePage.questions.find((question) =>
        !usedQuestionKeys.has(question.questionKey) && questionMatchesField(question, field),
      );
      if (!fallbackMatch) continue;

      usedQuestionKeys.add(fallbackMatch.questionKey);
      durableRecords.set(
        stableFieldKey(field),
        questionRecordToDurableField(fallbackMatch, activePage.history),
      );
    }

    return durableRecords;
  }

  private async commitActionOutcome(
    action: DecisionAction,
    merged: MergedPageObservation,
    result: ExecutorResult,
  ): Promise<void> {
    if (!this.pageContext) return;

    try {
      await this.pageContext.annotateActivePage(
        {
          decisionLoop: {
            action: action.action,
            actionStatus: result.status,
            layer: result.layer,
            pageNavigated: result.pageNavigated,
            fieldsObserved: merged.snapshot.fields.length,
            fieldsMerged: merged.fieldMergeResults.size,
            fieldsAttempted: result.fieldsAttempted,
            fieldsFilled: result.fieldsFilled,
            observationConfidence: merged.observationConfidence,
            hasDisagreements: merged.hasDisagreements,
            stagehandInvoked: merged.stagehandInvoked,
          },
        },
        'Decision loop merged observer commit',
        result.layer === 'magnitude' ? 'magnitude' : 'mastra',
      );

      if (result.status !== 'action_succeeded') return;

      if (action.action === 'click_next' || action.action === 'click_apply') {
        await this.pageContext.finalizeActivePage();
      } else if (action.action === 'mark_complete') {
        await this.pageContext.finalizeActivePage({ status: 'completed' });
      } else if (action.action === 'report_blocked') {
        await this.pageContext.finalizeActivePage({ status: 'blocked' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[decision-loop] pageContext commit failed: ${message}`);
    }
  }

  private async postActionStabilize(
    previousSnapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
    decision: DecisionAction,
    executorResult: ExecutorResult,
    actionHistory: ActionHistoryEntry[],
  ): Promise<PostActionStabilization | null> {
    if (!this.shouldStabilize(decision.action)) return null;

    const delays = executorResult.pageNavigated ? [300, 900, 1800] : [200, 500, 1000];
    let lastSnapshot = previousSnapshot;

    for (const delayMs of delays) {
      await this.page.waitForLoadState('domcontentloaded', { timeout: delayMs + 800 }).catch(() => {});
      await sleep(delayMs);

      const snapshot = await this.snapshotBuilder.buildSnapshot(this.page, actionHistory);
      lastSnapshot = snapshot;
      const state = this.classifyPostActionState(previousSnapshot, snapshot, executorResult);
      if (state === 'dom_parse_miss') {
        return {
          state,
          snapshot: await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory),
          quickControlCount: 0,
          adapterObservedCount: 0,
        };
      }

      if (state !== 'parser_empty' && state !== 'unknown_pending') {
        return {
          state,
          snapshot,
          quickControlCount: 0,
          adapterObservedCount: 0,
        };
      }
    }

    const quickControlCount = await this.countVisibleControlsInCurrentView();
    if (quickControlCount > 0) {
      return {
        state: 'dom_parse_miss',
        snapshot: await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory),
        quickControlCount,
        adapterObservedCount: 0,
      };
    }

    const adapterObserved = await this.observeVisibleControlsWithAdapter();
    if (adapterObserved > 0) {
      return {
        state: 'dom_parse_miss',
        snapshot: await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory),
        quickControlCount,
        adapterObservedCount: adapterObserved,
      };
    }

    return {
      state: 'parser_empty',
      snapshot: lastSnapshot,
      quickControlCount,
      adapterObservedCount: adapterObserved,
    };
  }

  private shouldStabilize(action: DecisionAction['action']): boolean {
    return [
      'click_next',
      'click_apply',
      'dismiss_popup',
      'login',
      'create_account',
      'enter_verification',
      'expand_repeaters',
    ].includes(action);
  }

  private classifyPostActionState(
    previousSnapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
    nextSnapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
    executorResult: ExecutorResult,
  ): PostActionState {
    const hasVisibleControls =
      nextSnapshot.fields.length > 0 ||
      nextSnapshot.buttons.length > 0;
    const hasDomFingerprintControls = nextSnapshot.fingerprint.fieldCount > 0;

    if (
      executorResult.pageNavigated ||
      previousSnapshot.url !== nextSnapshot.url ||
      previousSnapshot.pageType !== nextSnapshot.pageType ||
      previousSnapshot.fingerprint.hash !== nextSnapshot.fingerprint.hash
    ) {
      if (hasVisibleControls) return 'transitioned';
      if (hasDomFingerprintControls) return 'dom_parse_miss';
      return 'unknown_pending';
    }

    if (hasVisibleControls) {
      return 'same_page_with_controls';
    }

    if (hasDomFingerprintControls) {
      return 'dom_parse_miss';
    }

    return 'parser_empty';
  }

  private async recoverSnapshotIfParseMiss(
    snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
    actionHistory: ActionHistoryEntry[],
  ): Promise<SnapshotRecovery> {
    const visibleControls = snapshot.fields.length + snapshot.buttons.length;
    if (visibleControls > 0) {
      return { snapshot, recovered: false };
    }

    const quickControlCount = await this.countVisibleControlsInCurrentView();
    if (quickControlCount > 0) {
      const recoveredSnapshot = await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory);
      return {
        snapshot: recoveredSnapshot,
        recovered: true,
        reason: 'quick_dom_controls',
      };
    }

    const adapterObserved = await this.observeVisibleControlsWithAdapter();
    if (adapterObserved > 0) {
      const recoveredSnapshot = await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory);
      return {
        snapshot: recoveredSnapshot,
        recovered: true,
        reason: 'adapter_observe_controls',
      };
    }

    if (snapshot.fingerprint.fieldCount <= 0) {
      return { snapshot, recovered: false };
    }

    const recoveredSnapshot = await this.fullPageSnapshotBuilder.buildSnapshot(this.page, actionHistory);
    return {
      snapshot: recoveredSnapshot,
      recovered: true,
      reason: 'dom_parse_miss',
    };
  }

  private async countVisibleControlsInCurrentView(): Promise<number> {
    return this.page.evaluate(() => {
      const ff = (window as Window & { __ff?: any }).__ff;
      const selectors = [
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'button',
        '[role="button"]',
        '[role="combobox"]',
        '[role="checkbox"]',
      ].join(', ');

      const nodes: HTMLElement[] = ff?.queryAll?.(selectors) ?? Array.from(document.querySelectorAll<HTMLElement>(selectors));
      let count = 0;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          node.getAttribute('aria-hidden') !== 'true'
        ) {
          count++;
        }
      }
      return count;
    }).catch(() => 0);
  }

  private async observeVisibleControlsWithAdapter(): Promise<number> {
    if (!this.adapter.observe) return 0;
    try {
      const observed = await this.adapter.observe(
        'Inspect only the currently visible page view. Count visible form fields, buttons, comboboxes, checkboxes, and submit controls without clicking anything.',
      );
      return observed?.length ?? 0;
    } catch {
      return 0;
    }
  }

  private async ensurePlatformAuthContext(
    snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
  ): Promise<PlatformAuthContext | null> {
    if (!this.userId || !isAuthSnapshot(snapshot)) {
      return getPlatformAuthContext(this.profile, {
        sourceUrl: snapshot.url,
        platform: snapshot.platform,
      });
    }

    const existing = getPlatformAuthContext(this.profile, {
      sourceUrl: snapshot.url,
      platform: snapshot.platform,
    });
    if (existing) return existing;

    const resolved = await resolvePlatformAuthContext({
      userId: this.userId,
      sourceUrl: snapshot.url,
      platformHint: snapshot.platform,
      runtimeBaseUrl: this.runtimeBaseUrl,
      callbackUrl: this.callbackUrl,
    });
    if (!resolved) return null;

    const normalized = setPlatformAuthContext(this.profile, resolved);
    applyPlatformCredentialToProfile(
      this.profile,
      normalized.existingCredential,
      normalized.sharedApplicationPassword,
    );

    const resolveLine =
      `[decision-loop] auth-context-resolved iteration=${this.previousIteration + 1} jobId=${this.jobId ?? ''} ` +
      `platform=${normalized.platform} domain=${normalized.domain ?? ''} authMode=${normalized.authMode} ` +
      `credentialExists=${normalized.credentialExists}`;
    console.log(resolveLine);
    writeInferenceOutput(`${resolveLine}\n`);
    return normalized;
  }

  private applyGuardrails(
    decision: DecisionAction,
    snapshot: Awaited<ReturnType<PageSnapshotBuilder['buildSnapshot']>>,
    authContext: PlatformAuthContext | null,
  ): DecisionAction {
    if (snapshot.blocker.detected && snapshot.blocker.type === 'captcha') {
      return {
        action: 'report_blocked',
        reasoning: `${decision.reasoning} Guardrail override: CAPTCHA or human-verification challenge detected.`,
        confidence: Math.max(decision.confidence, snapshot.blocker.confidence),
      };
    }

    if (snapshot.platform === 'workday' && hasButton(snapshot, /apply manually/i)) {
      return {
        action: 'click_apply',
        target: snapshot.buttons.find((button) => /apply manually/i.test(button.text))?.text ?? 'Apply Manually',
        reasoning: `${decision.reasoning} Guardrail override: the Workday start-application modal is visible, so click "Apply Manually" via DOM before any field filling.`,
        confidence: Math.max(decision.confidence, 0.98),
      };
    }

    if (isAuthSnapshot(snapshot)) {
      const forceNativeLogin =
        Boolean(authContext?.forceSignIn) ||
        Boolean((this.profile as any)._forceNativeLoginAfterAccountCreation);
      const forceCreateAccount =
        authContext?.authMode === 'create_account' ||
        Boolean((this.profile as any)._workdayForceAccountCreation);
      const credentialPresent =
        Boolean(authContext?.credentialExists) ||
        Boolean(authContext?.existingCredential) ||
        Boolean(authContext?.generatedCredential);
      const passwordFieldCount = hasVisiblePasswordFields(snapshot);
      const confirmPasswordVisible = hasConfirmPasswordField(snapshot);
      const looksLikeCreateAccount =
        confirmPasswordVisible ||
        hasHeading(snapshot, /create account|start your application/i) ||
        hasButton(snapshot, /create account/i);
      const looksLikeLogin =
        passwordFieldCount > 0 &&
        (hasHeading(snapshot, /sign in|log in/i) || hasButton(snapshot, /sign in|log in/i));

      if (snapshot.blocker.type === 'verification') {
        return {
          action: 'stop_for_review',
          reasoning: `${decision.reasoning} Guardrail override: verification indicators are visible on the auth page, so pause for review instead of guessing through verification.`,
          confidence: Math.max(decision.confidence, 0.95),
        };
      }

      if (forceNativeLogin) {
        return {
          action: 'login',
          reasoning: `${decision.reasoning} Guardrail override: a platform credential was resolved or just created for this auth domain, so continue with sign-in only.`,
          confidence: Math.max(decision.confidence, 0.98),
        };
      }

      if (forceCreateAccount) {
        return {
          action: 'create_account',
          reasoning: `${decision.reasoning} Guardrail override: no persisted credential exists for this auth domain, so stay on account creation.`,
          confidence: Math.max(decision.confidence, 0.98),
        };
      }

      if (looksLikeCreateAccount && !credentialPresent) {
        return {
          action: 'create_account',
          reasoning: `${decision.reasoning} Guardrail override: create-account fields are visible and no credential exists for this auth domain.`,
          confidence: Math.max(decision.confidence, 0.96),
        };
      }

      if ((looksLikeLogin || credentialPresent) && passwordFieldCount > 0) {
        return {
          action: credentialPresent ? 'login' : 'create_account',
          reasoning: `${decision.reasoning} Guardrail override: this auth page must stay on the native ${credentialPresent ? 'login' : 'account-creation'} path for the resolved platform/domain.`,
          confidence: Math.max(decision.confidence, 0.94),
        };
      }
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
