import { mergeQuestionSnapshot, mergeQuestionState } from './QuestionMerge.js';
import type {
  AnswerDecision,
  ContextEvent,
  ContextReport,
  LogicalPageRecord,
  PageAuditResult,
  PageContextSession,
  PageCoverage,
  PageEntryInput,
  PageFinalizeInput,
  QuestionOutcome,
  QuestionRecord,
  QuestionSnapshot,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function emptyCoverage(): PageCoverage {
  return {
    requiredTotal: 0,
    requiredResolved: 0,
    requiredUnresolved: 0,
    optionalRisky: 0,
    lowConfidenceResolved: 0,
    ambiguousGrouped: 0,
  };
}

function emptyReport(flushStatus: ContextReport['flushStatus'] = 'pending'): ContextReport {
  return {
    pagesVisited: 0,
    requiredUnresolved: [],
    riskyOptionalAnswers: [],
    lowConfidenceAnswers: [],
    ambiguousQuestionGroups: [],
    partialPages: [],
    flushStatus,
  };
}

function pushEvent(
  page: LogicalPageRecord,
  event: Omit<ContextEvent, 'eventId' | 'timestamp' | 'targetPageId'>,
): void {
  page.history.push({
    eventId: crypto.randomUUID(),
    timestamp: nowIso(),
    targetPageId: page.pageId,
    ...event,
  });
}

function findActivePage(session: PageContextSession): LogicalPageRecord | undefined {
  return session.pages.find((page) => page.pageId === session.activePageId);
}

export function createEmptySession(jobId: string, mastraRunId: string): PageContextSession {
  const now = nowIso();
  return {
    jobId,
    mastraRunId,
    startedAt: now,
    updatedAt: now,
    status: 'running',
    pages: [],
    reportDraft: emptyReport(),
    version: 0,
  };
}

export function createPageRecord(input: PageEntryInput): LogicalPageRecord {
  const now = nowIso();
  return {
    pageId: crypto.randomUUID(),
    sequence: input.pageSequence,
    pageStepKey: input.pageStepKey,
    entryFingerprint: input.fingerprint,
    latestFingerprint: input.fingerprint,
    url: input.url,
    pageType: input.pageType,
    pageTitle: input.pageTitle,
    status: 'active',
    enteredAt: now,
    lastSeenAt: now,
    visitCount: 1,
    questions: [],
    actionables: [],
    history: [],
    coverage: emptyCoverage(),
    mergeStats: {
      questionMergeCount: 0,
      resumedCount: 0,
      duplicateQuestionSuppressions: 0,
    },
    domSummary: input.domSummary,
  };
}

export function applyPageEntry(
  session: PageContextSession,
  page: LogicalPageRecord,
): PageContextSession {
  const next = { ...session, pages: [...session.pages] };
  const existingIndex = next.pages.findIndex((entry) => entry.pageId === page.pageId);
  if (existingIndex >= 0) {
    next.pages[existingIndex] = page;
  } else {
    next.pages.push(page);
  }
  next.activePageId = page.pageId;
  next.updatedAt = nowIso();
  next.version += 1;
  return next;
}

export function syncQuestions(
  session: PageContextSession,
  snapshots: QuestionSnapshot[],
): PageContextSession {
  const page = findActivePage(session);
  if (!page) return session;

  const now = nowIso();
  for (const snapshot of snapshots) {
    const questionIndex = page.questions.findIndex(
      (question) => question.questionKey === snapshot.questionKey,
    );
    const merged = mergeQuestionSnapshot(page.questions[questionIndex], snapshot, now);
    if (questionIndex >= 0) {
      page.questions[questionIndex] = merged;
      page.mergeStats.questionMergeCount += 1;
    } else {
      page.questions.push(merged);
    }
  }

  page.questions.sort((a, b) => a.orderIndex - b.orderIndex);
  pushEvent(page, {
    type: 'scan_structured',
    actor: 'dom',
    after: { questionCount: page.questions.length },
  });

  const next = { ...session, updatedAt: now, version: session.version + 1 };
  return next;
}

export function applyAnswerDecisions(
  session: PageContextSession,
  decisions: AnswerDecision[],
): PageContextSession {
  const page = findActivePage(session);
  if (!page) return session;

  for (const decision of decisions) {
    const index = page.questions.findIndex(
      (question) => question.questionKey === decision.questionKey,
    );
    if (index < 0) continue;
    page.questions[index] = mergeQuestionState(page.questions[index], {
      state: 'planned',
      source: decision.source,
      lastAnswer: decision.answer,
      resolutionConfidence: Math.max(
        page.questions[index].resolutionConfidence,
        decision.confidence,
      ),
      lastUpdatedAt: nowIso(),
    });
    pushEvent(page, {
      type: 'answer_planned',
      actor: decision.source === 'magnitude' ? 'magnitude' : 'llm',
      targetQuestionKey: decision.questionKey,
      confidence: decision.confidence,
      after: { answer: decision.answer },
    });
  }

  return { ...session, updatedAt: nowIso(), version: session.version + 1 };
}

export function recordAttempt(
  session: PageContextSession,
  questionKey: string,
  actor: 'dom' | 'magnitude' | 'human',
  notes?: string,
): PageContextSession {
  const page = findActivePage(session);
  if (!page) return session;

  const index = page.questions.findIndex((question) => question.questionKey === questionKey);
  if (index < 0) return session;

  const question = page.questions[index];
  page.questions[index] = mergeQuestionState(question, {
    state: 'attempted',
    source: actor === 'human' ? 'manual' : actor,
    attemptCount: question.attemptCount + 1,
    lastUpdatedAt: nowIso(),
  });
  pushEvent(page, {
    type: 'fill_attempted',
    actor,
    targetQuestionKey: questionKey,
    notes,
  });
  return { ...session, updatedAt: nowIso(), version: session.version + 1 };
}

export function recordOutcome(
  session: PageContextSession,
  outcome: QuestionOutcome,
): PageContextSession {
  const page = findActivePage(session);
  if (!page) return session;

  const index = page.questions.findIndex(
    (question) => question.questionKey === outcome.questionKey,
  );
  if (index < 0) return session;

  const question = page.questions[index];
  const nextState = mergeQuestionState(question, {
    state: outcome.state,
    source: outcome.source,
    currentValue: outcome.currentValue || question.currentValue,
    selectedOptions: outcome.selectedOptions || question.selectedOptions,
    resolutionConfidence: Math.max(question.resolutionConfidence, outcome.confidence || 0),
    verificationCount:
      outcome.state === 'verified'
        ? question.verificationCount + 1
        : question.verificationCount,
    lastUpdatedAt: nowIso(),
  });

  page.questions[index] = nextState;
  const actor =
    outcome.source === 'manual'
      ? 'human'
      : outcome.source === 'llm'
        ? 'llm'
        : outcome.source === 'magnitude'
          ? 'magnitude'
          : 'dom';
  pushEvent(page, {
    type:
      outcome.state === 'verified'
        ? 'fill_verified'
        : outcome.state === 'failed'
          ? 'fill_failed'
          : 'fill_applied',
    actor,
    targetQuestionKey: outcome.questionKey,
    confidence: outcome.confidence,
    after: {
      state: outcome.state,
      value: outcome.currentValue,
    },
  });

  return { ...session, updatedAt: nowIso(), version: session.version + 1 };
}

export function computeCoverage(page: LogicalPageRecord): PageCoverage {
  let requiredTotal = 0;
  let requiredResolved = 0;
  let optionalRisky = 0;
  let lowConfidenceResolved = 0;
  let ambiguousGrouped = 0;

  for (const question of page.questions) {
    const resolved = question.state === 'filled' || question.state === 'verified';
    if (question.required) {
      requiredTotal++;
      if (resolved) {
        requiredResolved++;
      }
    } else if (question.riskLevel !== 'none') {
      optionalRisky++;
    }

    if (question.groupingConfidence < 0.6 || question.warnings.includes('ambiguous_prompt_anchor')) {
      ambiguousGrouped++;
    }
    if (resolved && question.resolutionConfidence > 0 && question.resolutionConfidence < 0.7) {
      lowConfidenceResolved++;
    }
  }

  return {
    requiredTotal,
    requiredResolved,
    requiredUnresolved: Math.max(0, requiredTotal - requiredResolved),
    optionalRisky,
    lowConfidenceResolved,
    ambiguousGrouped,
  };
}

export function auditPage(session: PageContextSession): {
  session: PageContextSession;
  result: PageAuditResult;
} {
  const page = findActivePage(session);
  if (!page) {
    return {
      session,
      result: {
        blockNavigation: false,
        unresolvedRequired: 0,
        riskyOptional: 0,
        lowConfidenceResolved: 0,
        retrySuggested: false,
        summary: 'No active page context.',
        unresolvedQuestionKeys: [],
        riskyQuestionKeys: [],
      },
    };
  }

  page.coverage = computeCoverage(page);
  const unresolvedQuestionKeys = page.questions
    .filter((question) => question.required && page.coverage.requiredUnresolved > 0)
    .filter((question) => question.state !== 'filled' && question.state !== 'verified')
    .map((question) => question.questionKey);
  const riskyQuestionKeys = page.questions
    .filter((question) => !question.required && question.riskLevel !== 'none')
    .map((question) => question.questionKey);

  const result: PageAuditResult = {
    pageId: page.pageId,
    blockNavigation: page.coverage.requiredUnresolved > 0,
    unresolvedRequired: page.coverage.requiredUnresolved,
    riskyOptional: page.coverage.optionalRisky,
    lowConfidenceResolved: page.coverage.lowConfidenceResolved,
    retrySuggested: page.coverage.requiredUnresolved > 0,
    summary:
      page.coverage.requiredUnresolved > 0
        ? `${page.coverage.requiredUnresolved} required question(s) still unresolved.`
        : 'All required questions appear resolved.',
    unresolvedQuestionKeys,
    riskyQuestionKeys,
  };

  pushEvent(page, {
    type: 'page_audited',
    actor: 'system',
    after: { coverage: page.coverage, result },
  });

  const next = { ...session, updatedAt: nowIso(), version: session.version + 1 };
  return { session: next, result };
}

export function finalizeActivePage(
  session: PageContextSession,
  input: PageFinalizeInput = {},
): PageContextSession {
  const page = findActivePage(session);
  if (!page) return session;

  page.coverage = computeCoverage(page);
  page.status =
    input.status ||
    (page.coverage.requiredUnresolved > 0 ? 'partial' : 'completed');
  page.exitedAt = nowIso();
  page.lastSeenAt = page.exitedAt;
  pushEvent(page, {
    type: 'page_finalized',
    actor: 'system',
    after: { status: page.status, coverage: page.coverage },
  });

  return {
    ...session,
    activePageId: undefined,
    updatedAt: nowIso(),
    version: session.version + 1,
  };
}

export function markSessionStatus(
  session: PageContextSession,
  status: PageContextSession['status'],
  pageStatus?: LogicalPageRecord['status'],
): PageContextSession {
  const next = { ...session, status, updatedAt: nowIso(), version: session.version + 1 };
  const page = findActivePage(next);
  if (page && pageStatus) {
    page.status = pageStatus;
    page.lastSeenAt = next.updatedAt;
    pushEvent(page, {
      type: 'status_marked',
      actor: 'system',
      after: { sessionStatus: status, pageStatus },
    });
  }
  return next;
}

export function buildContextReport(
  session: PageContextSession,
  flushStatus: ContextReport['flushStatus'] = 'pending',
): ContextReport {
  const report = emptyReport(flushStatus);
  report.pagesVisited = session.pages.length;

  for (const page of session.pages) {
    const coverage = computeCoverage(page);
    if (page.status !== 'completed' || coverage.requiredUnresolved > 0) {
      report.partialPages.push({
        pageId: page.pageId,
        pageSequence: page.sequence,
        pageType: page.pageType,
        status: page.status,
        requiredUnresolved: coverage.requiredUnresolved,
      });
    }

    for (const question of page.questions) {
      const resolved = question.state === 'filled' || question.state === 'verified';
      if (question.required && !resolved) {
        report.requiredUnresolved.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          pageType: page.pageType,
          promptText: question.promptText,
          questionKey: question.questionKey,
        });
      }

      if (!question.required && question.riskLevel !== 'none') {
        report.riskyOptionalAnswers.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          promptText: question.promptText,
          questionKey: question.questionKey,
          riskLevel: question.riskLevel,
          answer: question.lastAnswer,
        });
      }

      if (resolved && question.resolutionConfidence > 0 && question.resolutionConfidence < 0.7) {
        report.lowConfidenceAnswers.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          promptText: question.promptText,
          questionKey: question.questionKey,
          confidence: question.resolutionConfidence,
          answer: question.lastAnswer,
        });
      }

      if (
        question.groupingConfidence < 0.6 ||
        question.warnings.includes('ambiguous_prompt_anchor')
      ) {
        report.ambiguousQuestionGroups.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          promptText: question.promptText,
          questionKey: question.questionKey,
          warnings: question.warnings,
        });
      }
    }
  }

  return report;
}

export function attachReport(
  session: PageContextSession,
  flushStatus: ContextReport['flushStatus'],
): PageContextSession {
  return {
    ...session,
    reportDraft: buildContextReport(session, flushStatus),
    updatedAt: nowIso(),
    version: session.version + 1,
  };
}
