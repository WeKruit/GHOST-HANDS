import {
  applyAnswerDecisions,
  applyPageEntry,
  annotateActivePage as reduceAnnotateActivePage,
  attachReport,
  auditPage,
  createEmptySession,
  createPageRecord,
  finalizeActivePage as reduceFinalizeActivePage,
  markSessionStatus,
  recordAttempt,
  recordOutcome,
  syncQuestions as reduceSyncQuestions,
} from './PageContextReducer.js';
import { RedisPageContextStore } from './RedisPageContextStore.js';
import { SupabasePageContextFlusher } from './SupabasePageContextFlusher.js';
import { getLogger } from '../monitoring/logger.js';

const logger = getLogger({ service: 'page-context' });
import type {
  AnswerDecision,
  ContextReport,
  PageAuditResult,
  PageContextSession,
  PageEntryInput,
  PageFinalizeInput,
  QuestionOutcome,
  QuestionSnapshot,
} from './types.js';

const RESUME_SAME_STEP_MIN_FINGERPRINT_SIMILARITY = 0.7;
const RESUME_SAME_PATH_MIN_FINGERPRINT_SIMILARITY = 0.85;
const RESUME_SAME_TITLE_MIN_FINGERPRINT_SIMILARITY = 0.85;

function normalizeTitle(value: string | undefined): string {
  return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function urlPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function fingerprintSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aTokens = new Set(a.split(/[^a-zA-Z0-9]+/).filter(Boolean));
  const bTokens = new Set(b.split(/[^a-zA-Z0-9]+/).filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++;
  }

  return (intersection * 2) / (aTokens.size + bTokens.size);
}

function cloneResumedPage(
  page: PageContextSession['pages'][number],
  input: PageEntryInput,
): PageContextSession['pages'][number] {
  return {
    ...page,
    pageTitle: input.pageTitle || page.pageTitle,
    url: input.url,
    latestFingerprint: input.fingerprint,
    lastSeenAt: new Date().toISOString(),
    visitCount: page.visitCount + 1,
    domSummary: input.domSummary || page.domSummary,
    metadata: page.metadata ? { ...page.metadata } : undefined,
    questions: page.questions.map((question) => ({
      ...question,
      selectors: [...question.selectors],
      options: question.options.map((option) => ({ ...option })),
      selectedOptions: [...question.selectedOptions],
      warnings: [...question.warnings],
      fieldIds: [...question.fieldIds],
    })),
    actionables: page.actionables.map((actionable) => ({ ...actionable })),
    history: page.history.map((event) => ({
      ...event,
      before: event.before ? { ...event.before } : undefined,
      after: event.after ? { ...event.after } : undefined,
    })),
    coverage: { ...page.coverage },
    mergeStats: {
      ...page.mergeStats,
      resumedCount: page.mergeStats.resumedCount + 1,
    },
  };
}

export interface PageContextService {
  initializeRun(mastraRunId: string): Promise<void>;
  enterOrResumePage(input: PageEntryInput): Promise<void>;
  syncQuestions(snapshots: QuestionSnapshot[], opts?: { isFullSync?: boolean }): Promise<void>;
  recordAnswerPlan(decisions: AnswerDecision[]): Promise<void>;
  recordFieldAttempt(
    questionKey: string,
    actor: 'dom' | 'magnitude' | 'human',
    notes?: string,
  ): Promise<void>;
  recordFieldResult(outcome: QuestionOutcome): Promise<void>;
  auditBeforeAdvance(): Promise<PageAuditResult>;
  annotateActivePage(
    metadata: Record<string, unknown>,
    notes?: string,
    actor?: 'system' | 'dom' | 'llm' | 'magnitude' | 'human' | 'mastra',
  ): Promise<void>;
  finalizeActivePage(input?: PageFinalizeInput): Promise<void>;
  markAwaitingReview(): Promise<void>;
  markFailed(): Promise<void>;
  markFlushPending(error: string): Promise<void>;
  getContextReport(flushStatus?: ContextReport['flushStatus']): Promise<ContextReport>;
  flushToSupabase(): Promise<ContextReport>;
  /** Return the raw session snapshot (for report extraction). */
  getSession(): Promise<PageContextSession | null>;
  /** Synchronous session access for real-time progress snapshots. */
  getSessionSync(): PageContextSession | null;
}

export class LivePageContextService implements PageContextService {
  private session: PageContextSession | null = null;
  private mastraRunId: string | null = null;
  private conflictCount = 0;

  constructor(
    private readonly jobId: string,
    private readonly store: RedisPageContextStore,
    private readonly flusher: SupabasePageContextFlusher,
    private readonly keepDebugRetention = false,
  ) {}

  async initializeRun(mastraRunId: string): Promise<void> {
    this.mastraRunId = mastraRunId;
    const existing = await this.store.read(mastraRunId);
    this.session = existing || createEmptySession(this.jobId, mastraRunId);
    if (!existing) {
      await this.persistCurrent();
    }
  }

  async enterOrResumePage(input: PageEntryInput): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    const activePage = session.pages.find((page) => page.pageId === session.activePageId);
    const samePath = activePage ? urlPathname(activePage.url) === urlPathname(input.url) : false;
    const sameType = activePage ? activePage.pageType === input.pageType : false;
    const sameStep = activePage ? activePage.pageStepKey === input.pageStepKey : false;
    const similarFingerprint = activePage
      ? fingerprintSimilarity(activePage.latestFingerprint, input.fingerprint)
      : 0;
    const sameTitle =
      activePage && normalizeTitle(activePage.pageTitle) === normalizeTitle(input.pageTitle);
    const shouldResume =
      !!activePage &&
      sameType &&
      ((sameStep && similarFingerprint >= RESUME_SAME_STEP_MIN_FINGERPRINT_SIMILARITY) ||
        (samePath && similarFingerprint >= RESUME_SAME_PATH_MIN_FINGERPRINT_SIMILARITY) ||
        (sameTitle && similarFingerprint >= RESUME_SAME_TITLE_MIN_FINGERPRINT_SIMILARITY));

    let nextSession = session;
    let nextPage = activePage;
    if (shouldResume && activePage) {
      nextPage = cloneResumedPage(activePage, input);
    } else {
      if (activePage) {
        nextSession = reduceFinalizeActivePage(session);
      }
      nextPage = createPageRecord(input);
    }

    nextPage.history.push({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'page_entered',
      actor: 'system',
      targetPageId: nextPage.pageId,
      after: {
        pageType: nextPage.pageType,
        pageStepKey: nextPage.pageStepKey,
        visitCount: nextPage.visitCount,
      },
    });
    // Apply the same history cap as pushEvent to prevent unbounded growth
    const MAX_HISTORY = 200;
    if (nextPage.history.length > MAX_HISTORY) {
      nextPage.history.splice(0, nextPage.history.length - MAX_HISTORY);
    }

    this.session = applyPageEntry(nextSession, nextPage);
    await this.persistCurrent(baseVersion);
  }

  async syncQuestions(snapshots: QuestionSnapshot[], opts?: { isFullSync?: boolean }): Promise<void> {
    if (snapshots.length === 0) return;
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = reduceSyncQuestions(session, snapshots, opts);
    await this.persistCurrent(baseVersion);
  }

  async recordAnswerPlan(decisions: AnswerDecision[]): Promise<void> {
    if (decisions.length === 0) return;
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = applyAnswerDecisions(session, decisions);
    await this.persistCurrent(baseVersion);
  }

  async recordFieldAttempt(
    questionKey: string,
    actor: 'dom' | 'magnitude' | 'human',
    notes?: string,
  ): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = recordAttempt(session, questionKey, actor, notes);
    await this.persistCurrent(baseVersion);
  }

  async recordFieldResult(outcome: QuestionOutcome): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = recordOutcome(session, outcome);
    await this.persistCurrent(baseVersion);
  }

  async auditBeforeAdvance(): Promise<PageAuditResult> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    const result = auditPage(session);
    this.session = result.session;
    await this.persistCurrent(baseVersion);
    return result.result;
  }

  async annotateActivePage(
    metadata: Record<string, unknown>,
    notes?: string,
    actor: 'system' | 'dom' | 'llm' | 'magnitude' | 'human' | 'mastra' = 'system',
  ): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = reduceAnnotateActivePage(session, metadata, notes, actor);
    await this.persistCurrent(baseVersion);
  }

  async finalizeActivePage(input?: PageFinalizeInput): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = reduceFinalizeActivePage(session, input);
    await this.persistCurrent(baseVersion);
  }

  async markAwaitingReview(): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = markSessionStatus(session, 'awaiting_review', 'awaiting_review');
    await this.persistCurrent(baseVersion);
  }

  async markFailed(): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = markSessionStatus(session, 'failed', 'failed');
    await this.persistCurrent(baseVersion);
  }

  async markFlushPending(error: string): Promise<void> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    this.session = attachReport(session, 'pending', error);
    await this.persistCurrent(baseVersion);
  }

  async getContextReport(
    flushStatus: ContextReport['flushStatus'] = 'pending',
  ): Promise<ContextReport> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    const next = attachReport(
      session,
      flushStatus,
      flushStatus === 'pending' ? session.reportDraft.flushError : undefined,
    );
    this.session = next;
    await this.persistCurrent(baseVersion);
    return next.reportDraft;
  }

  async flushToSupabase(): Promise<ContextReport> {
    const session = await this.ensureSession();
    const baseVersion = session.version;
    const report = await this.flusher.flush(session);
    this.session = attachReport(session, 'flushed');
    await this.persistCurrent(baseVersion);
    await this.store.retain(this.session, this.keepDebugRetention);
    return report;
  }

  async getSession(): Promise<PageContextSession | null> {
    return this.session;
  }

  getSessionSync(): PageContextSession | null {
    return this.session ?? null;
  }

  private async ensureSession(): Promise<PageContextSession> {
    if (this.session) return this.session;
    if (!this.mastraRunId) {
      throw new Error('PageContextService used before initializeRun()');
    }
    const existing = await this.store.read(this.mastraRunId);
    this.session = existing || createEmptySession(this.jobId, this.mastraRunId);
    return this.session;
  }

  private async persistCurrent(expectedVersion?: number): Promise<void> {
    const current = this.session;
    if (!current) return;

    const firstAttempt = await this.store.write(
      current,
      typeof expectedVersion === 'number' ? expectedVersion : undefined,
    );
    if (firstAttempt.saved) return;

    // Conflict: adopt the persisted state to avoid overwriting concurrent writes.
    // Our local mutations are lost, but this is safer than blindly overwriting
    // another writer's state with our stale snapshot.
    this.conflictCount += 1;
    const latest = firstAttempt.current;
    const latestVersion = typeof latest?.version === 'number' ? latest.version : 'unknown';
    const expectedLabel =
      typeof expectedVersion === 'number' ? String(expectedVersion) : 'none';
    logger.warn(`Optimistic write conflict #${this.conflictCount}; adopting persisted state`, {
      jobId: this.jobId,
      mastraRunId: this.mastraRunId ?? 'uninitialized',
      expectedVersion: expectedLabel,
      localVersion: current.version,
      persistedVersion: latestVersion,
      conflictCount: this.conflictCount,
    });
    if (latest) {
      this.session = latest;
    }
  }
}
