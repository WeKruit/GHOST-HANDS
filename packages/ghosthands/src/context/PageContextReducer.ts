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

const SENSITIVE_FIELD_RE = /password|passwd|pwd|secret|token|otp|ssn|credit.?card|cvv|pin|social.?security/i;

export function redactSensitiveValue(fieldNameOrPrompt: string, value: string): string {
  if (SENSITIVE_FIELD_RE.test(fieldNameOrPrompt)) {
    return '[REDACTED]';
  }
  return value;
}

const MAX_PAGE_HISTORY_EVENTS = 200;
const AMBIGUOUS_GROUPING_THRESHOLD = 0.6;
const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function createEmptyCoverage(): PageCoverage {
  return {
    requiredTotal: 0,
    requiredResolved: 0,
    requiredUnresolved: 0,
    optionalRisky: 0,
    lowConfidenceResolved: 0,
    ambiguousGrouped: 0,
  };
}

export function createEmptyContextReport(
  flushStatus: ContextReport['flushStatus'] = 'pending',
  flushError?: string,
): ContextReport {
  return {
    pagesVisited: 0,
    requiredUnresolved: [],
    riskyOptionalAnswers: [],
    lowConfidenceAnswers: [],
    ambiguousQuestionGroups: [],
    bestEffortGuesses: [],
    partialPages: [],
    flushStatus,
    ...(flushError ? { flushError } : {}),
  };
}

function clonePage(page: LogicalPageRecord): LogicalPageRecord {
  return {
    ...page,
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
    mergeStats: { ...page.mergeStats },
  };
}

function cloneReport(report: ContextReport): ContextReport {
  return {
    ...report,
    requiredUnresolved: [...report.requiredUnresolved],
    riskyOptionalAnswers: [...report.riskyOptionalAnswers],
    lowConfidenceAnswers: [...report.lowConfidenceAnswers],
    ambiguousQuestionGroups: [...report.ambiguousQuestionGroups],
    bestEffortGuesses: [...report.bestEffortGuesses],
    partialPages: [...report.partialPages],
  };
}

function cloneSession(session: PageContextSession): PageContextSession {
  return {
    ...session,
    pages: session.pages.map(clonePage),
    reportDraft: cloneReport(session.reportDraft),
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
  if (page.history.length > MAX_PAGE_HISTORY_EVENTS) {
    page.history.splice(0, page.history.length - MAX_PAGE_HISTORY_EVENTS);
  }
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
    reportDraft: createEmptyContextReport(),
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
    coverage: createEmptyCoverage(),
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
  const next = cloneSession(session);
  const existingIndex = next.pages.findIndex((entry) => entry.pageId === page.pageId);
  if (existingIndex >= 0) {
    next.pages[existingIndex] = clonePage(page);
  } else {
    next.pages.push(clonePage(page));
  }
  next.activePageId = page.pageId;
  next.updatedAt = nowIso();
  next.version += 1;
  return next;
}

export function syncQuestions(
  session: PageContextSession,
  snapshots: QuestionSnapshot[],
  opts?: { isFullSync?: boolean },
): PageContextSession {
  const next = cloneSession(session);
  const page = findActivePage(next);
  if (!page) return session;

  const now = nowIso();
  const incomingFieldIds = new Set(snapshots.flatMap((s) => s.fieldIds));

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

  // Un-retire questions whose fieldIds reappear in the incoming set
  for (const question of page.questions) {
    if (question.state !== 'skipped' || !question.warnings.includes('retired_missing_from_dom')) continue;
    if (question.fieldIds.some((id) => incomingFieldIds.has(id))) {
      question.state = 'empty';
      question.warnings = question.warnings.filter((w) => w !== 'retired_missing_from_dom');
    }
  }

  // Only retire on full-page syncs — partial (rerun) syncs contain just new fields.
  // Only retire questions that haven't progressed past planning — preserve filled/verified/attempted progress.
  const RETIRABLE_STATES = new Set(['empty', 'planned']);
  if (opts?.isFullSync) {
    for (const question of page.questions) {
      if (question.state === 'skipped') continue;
      if (!RETIRABLE_STATES.has(question.state)) continue;
      const allFieldsMissing = question.fieldIds.length > 0
        && question.fieldIds.every((id) => !incomingFieldIds.has(id));
      if (allFieldsMissing) {
        question.state = 'skipped';
        if (!question.warnings.includes('retired_missing_from_dom')) {
          question.warnings.push('retired_missing_from_dom');
        }
      }
    }
  }

  page.questions.sort((a, b) => a.orderIndex - b.orderIndex);
  pushEvent(page, {
    type: 'scan_structured',
    actor: 'dom',
    after: { questionCount: page.questions.length },
  });
  page.coverage = computeCoverage(page);

  next.updatedAt = now;
  next.version = session.version + 1;
  return next;
}

export function applyAnswerDecisions(
  session: PageContextSession,
  decisions: AnswerDecision[],
): PageContextSession {
  const next = cloneSession(session);
  const page = findActivePage(next);
  if (!page) return session;

  for (const decision of decisions) {
    const index = page.questions.findIndex(
      (question) => question.questionKey === decision.questionKey,
    );
    if (index < 0) continue;
    const promptText = page.questions[index].promptText || '';
    const safeAnswer = redactSensitiveValue(promptText, decision.answer);
    page.questions[index] = mergeQuestionState(page.questions[index], {
      state: 'planned',
      source: decision.source,
      lastAnswer: safeAnswer,
      answerMode: decision.answerMode,
      resolutionConfidence: Math.max(
        page.questions[index].resolutionConfidence,
        decision.confidence,
      ),
      lastUpdatedAt: nowIso(),
    });
    // Map source directly to actor — don't default everything to 'llm'
    const actor = decision.source === 'dom' ? 'dom'
      : decision.source === 'magnitude' ? 'magnitude'
      : decision.source === 'llm' ? 'llm'
      : (decision.source as string) || 'llm';
    pushEvent(page, {
      type: 'answer_planned',
      actor: actor as ContextEvent['actor'],
      targetQuestionKey: decision.questionKey,
      confidence: decision.confidence,
      after: { answer: safeAnswer },
    });
  }

  page.coverage = computeCoverage(page);
  next.updatedAt = nowIso();
  next.version = session.version + 1;
  return next;
}

export function recordAttempt(
  session: PageContextSession,
  questionKey: string,
  actor: 'dom' | 'magnitude' | 'human',
  notes?: string,
): PageContextSession {
  const next = cloneSession(session);
  const page = findActivePage(next);
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
  page.coverage = computeCoverage(page);
  next.updatedAt = nowIso();
  next.version = session.version + 1;
  return next;
}

export function recordOutcome(
  session: PageContextSession,
  outcome: QuestionOutcome,
): PageContextSession {
  const next = cloneSession(session);
  const page = findActivePage(next);
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
  page.coverage = computeCoverage(page);

  next.updatedAt = nowIso();
  next.version = session.version + 1;
  return next;
}

export function computeCoverage(page: LogicalPageRecord): PageCoverage {
  let requiredTotal = 0;
  let requiredResolved = 0;
  let optionalRisky = 0;
  let lowConfidenceResolved = 0;
  let ambiguousGrouped = 0;

  for (const question of page.questions) {
    // Retired/skipped questions don't count towards coverage
    if (question.state === 'skipped' && question.warnings.includes('retired_missing_from_dom')) continue;
    const resolved = question.state === 'filled' || question.state === 'verified';
    if (question.required) {
      requiredTotal++;
      if (resolved) {
        requiredResolved++;
      }
    } else if (question.riskLevel !== 'none') {
      optionalRisky++;
    }

    if (
      question.groupingConfidence < AMBIGUOUS_GROUPING_THRESHOLD ||
      question.warnings.includes('ambiguous_prompt_anchor')
    ) {
      ambiguousGrouped++;
    }
    if (
      resolved &&
      question.resolutionConfidence > 0 &&
      question.resolutionConfidence < LOW_CONFIDENCE_THRESHOLD
    ) {
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
  const next = cloneSession(session);
  const page = findActivePage(next);
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
  const isRetired = (q: QuestionRecord) => q.state === 'skipped' && q.warnings.includes('retired_missing_from_dom');
  const unresolvedQuestionKeys = page.questions
    .filter((question) => question.required && !isRetired(question))
    .filter((question) => question.state !== 'filled' && question.state !== 'verified')
    .map((question) => question.questionKey);
  const riskyQuestionKeys = page.questions
    .filter((question) => !question.required && question.riskLevel !== 'none' && !isRetired(question))
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

  next.updatedAt = nowIso();
  next.version = session.version + 1;
  return { session: next, result };
}

export function finalizeActivePage(
  session: PageContextSession,
  input: PageFinalizeInput = {},
): PageContextSession {
  const next = cloneSession(session);
  const page = findActivePage(next);
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

  next.activePageId = undefined;
  next.updatedAt = nowIso();
  next.version = session.version + 1;
  return next;
}

export function markSessionStatus(
  session: PageContextSession,
  status: PageContextSession['status'],
  pageStatus?: LogicalPageRecord['status'],
): PageContextSession {
  const next = cloneSession(session);
  next.status = status;
  next.updatedAt = nowIso();
  next.version = session.version + 1;
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
  flushError?: string,
): ContextReport {
  const report = createEmptyContextReport(flushStatus, flushError);
  report.pagesVisited = session.pages.length;

  for (const page of session.pages) {
    const coverage = page.coverage;
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
          answer: redactSensitiveValue(question.promptText, question.lastAnswer || ''),
        });
      }

      if (
        resolved &&
        question.resolutionConfidence > 0 &&
        question.resolutionConfidence < LOW_CONFIDENCE_THRESHOLD
      ) {
        report.lowConfidenceAnswers.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          promptText: question.promptText,
          questionKey: question.questionKey,
          confidence: question.resolutionConfidence,
          answer: redactSensitiveValue(question.promptText, question.lastAnswer || ''),
        });
      }

      if (
        question.groupingConfidence < AMBIGUOUS_GROUPING_THRESHOLD ||
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

      if (question.answerMode === 'best_effort_guess' || question.answerMode === 'default_decline') {
        report.bestEffortGuesses.push({
          pageId: page.pageId,
          pageSequence: page.sequence,
          questionKey: question.questionKey,
          promptText: question.promptText,
          answer: redactSensitiveValue(question.promptText, question.lastAnswer || ''),
          answerMode: question.answerMode,
        });
      }
    }
  }

  return report;
}

export function attachReport(
  session: PageContextSession,
  flushStatus: ContextReport['flushStatus'],
  flushError?: string,
): PageContextSession {
  return {
    ...cloneSession(session),
    reportDraft: buildContextReport(session, flushStatus, flushError),
    updatedAt: nowIso(),
    version: session.version + 1,
  };
}
