import {
  applyAnswerDecisions,
  applyPageEntry,
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

export interface PageContextService {
  initializeRun(mastraRunId: string): Promise<void>;
  enterOrResumePage(input: PageEntryInput): Promise<void>;
  syncQuestions(snapshots: QuestionSnapshot[]): Promise<void>;
  recordAnswerPlan(decisions: AnswerDecision[]): Promise<void>;
  recordFieldAttempt(
    questionKey: string,
    actor: 'dom' | 'magnitude' | 'human',
    notes?: string,
  ): Promise<void>;
  recordFieldResult(outcome: QuestionOutcome): Promise<void>;
  auditBeforeAdvance(): Promise<PageAuditResult>;
  finalizeActivePage(input?: PageFinalizeInput): Promise<void>;
  markAwaitingReview(): Promise<void>;
  markFailed(): Promise<void>;
  markFlushPending(error: string): Promise<void>;
  getContextReport(flushStatus?: ContextReport['flushStatus']): Promise<ContextReport>;
  flushToSupabase(): Promise<ContextReport>;
}

export class LivePageContextService implements PageContextService {
  private session: PageContextSession | null = null;
  private mastraRunId: string | null = null;

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
    const activePage = session.pages.find((page) => page.pageId === session.activePageId);
    const samePath = activePage ? urlPathname(activePage.url) === urlPathname(input.url) : false;
    const sameType = activePage ? activePage.pageType === input.pageType : false;
    const sameStep = activePage ? activePage.pageStepKey === input.pageStepKey : false;
    const similarFingerprint = activePage
      ? fingerprintSimilarity(activePage.latestFingerprint, input.fingerprint)
      : 0;
    const sameTitle =
      activePage && normalizeTitle(activePage.pageTitle) === normalizeTitle(input.pageTitle);

    let nextSession = session;
    let nextPage = activePage;
    if (activePage && sameType && sameStep) {
      nextPage = {
        ...activePage,
        latestFingerprint: input.fingerprint,
        lastSeenAt: new Date().toISOString(),
        visitCount: activePage.visitCount + 1,
        pageTitle: input.pageTitle || activePage.pageTitle,
        url: input.url,
        domSummary: input.domSummary || activePage.domSummary,
      };
      nextPage.mergeStats.resumedCount += 1;
    } else if (activePage && sameType && samePath && similarFingerprint >= 0.85) {
      nextPage = {
        ...activePage,
        latestFingerprint: input.fingerprint,
        lastSeenAt: new Date().toISOString(),
        visitCount: activePage.visitCount + 1,
        pageTitle: input.pageTitle || activePage.pageTitle,
        url: input.url,
        domSummary: input.domSummary || activePage.domSummary,
      };
      nextPage.mergeStats.resumedCount += 1;
    } else if (activePage && sameType && sameTitle) {
      nextPage = {
        ...activePage,
        latestFingerprint: input.fingerprint,
        lastSeenAt: new Date().toISOString(),
        visitCount: activePage.visitCount + 1,
        pageTitle: input.pageTitle || activePage.pageTitle,
        url: input.url,
        domSummary: input.domSummary || activePage.domSummary,
      };
      nextPage.mergeStats.resumedCount += 1;
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

    this.session = applyPageEntry(nextSession, nextPage);
    await this.persistCurrent();
  }

  async syncQuestions(snapshots: QuestionSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    const session = await this.ensureSession();
    this.session = reduceSyncQuestions(session, snapshots);
    await this.persistCurrent();
  }

  async recordAnswerPlan(decisions: AnswerDecision[]): Promise<void> {
    if (decisions.length === 0) return;
    const session = await this.ensureSession();
    this.session = applyAnswerDecisions(session, decisions);
    await this.persistCurrent();
  }

  async recordFieldAttempt(
    questionKey: string,
    actor: 'dom' | 'magnitude' | 'human',
    notes?: string,
  ): Promise<void> {
    const session = await this.ensureSession();
    this.session = recordAttempt(session, questionKey, actor, notes);
    await this.persistCurrent();
  }

  async recordFieldResult(outcome: QuestionOutcome): Promise<void> {
    const session = await this.ensureSession();
    this.session = recordOutcome(session, outcome);
    await this.persistCurrent();
  }

  async auditBeforeAdvance(): Promise<PageAuditResult> {
    const session = await this.ensureSession();
    const result = auditPage(session);
    this.session = result.session;
    await this.persistCurrent();
    return result.result;
  }

  async finalizeActivePage(input?: PageFinalizeInput): Promise<void> {
    const session = await this.ensureSession();
    this.session = reduceFinalizeActivePage(session, input);
    await this.persistCurrent();
  }

  async markAwaitingReview(): Promise<void> {
    const session = await this.ensureSession();
    this.session = markSessionStatus(session, 'awaiting_review', 'awaiting_review');
    await this.persistCurrent();
  }

  async markFailed(): Promise<void> {
    const session = await this.ensureSession();
    this.session = markSessionStatus(session, 'failed', 'failed');
    await this.persistCurrent();
  }

  async markFlushPending(_error: string): Promise<void> {
    const session = await this.ensureSession();
    this.session = attachReport(session, 'pending');
    await this.persistCurrent();
  }

  async getContextReport(
    flushStatus: ContextReport['flushStatus'] = 'pending',
  ): Promise<ContextReport> {
    const session = await this.ensureSession();
    const next = attachReport(session, flushStatus);
    this.session = next;
    await this.persistCurrent();
    return next.reportDraft;
  }

  async flushToSupabase(): Promise<ContextReport> {
    const session = await this.ensureSession();
    const report = await this.flusher.flush(session);
    this.session = attachReport(session, 'flushed');
    await this.persistCurrent();
    await this.store.retain(this.session, this.keepDebugRetention);
    return report;
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

  private async persistCurrent(): Promise<void> {
    const current = this.session;
    if (!current) return;

    const expectedVersion = current.version - 1;
    const firstAttempt = await this.store.write(current, expectedVersion >= 0 ? expectedVersion : undefined);
    if (firstAttempt.saved) return;

    const latest = firstAttempt.current;
    if (!latest) {
      await this.store.write(current);
      return;
    }

    // Re-apply the newest in-memory session after a single optimistic retry.
    // The worker is single-job, so this is enough for suspend/resume races.
    this.session = {
      ...current,
      version: latest.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.write(this.session);
  }
}
