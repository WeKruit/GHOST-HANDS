import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  applyAnswerDecisions,
  applyPageEntry,
  createEmptySession,
  createPageRecord,
  finalizeActivePage,
  recordOutcome,
  syncQuestions,
} from '../../../src/context/PageContextReducer.js';
import type { PageContextSession, QuestionSnapshot } from '../../../src/context/types.js';
import { ProgressTracker } from '../../../src/workers/progressTracker.js';

function makeSnapshot(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    questionKey: 'q::required::text::ff-1',
    orderIndex: 0,
    promptText: 'First name',
    normalizedPrompt: 'first name',
    sectionLabel: 'Profile',
    questionType: 'text',
    required: true,
    groupingConfidence: 0.9,
    riskLevel: 'none',
    warnings: [],
    fieldIds: ['ff-1'],
    selectors: [],
    options: [],
    ...overrides,
  };
}

function buildSession(): PageContextSession {
  const base = createEmptySession('job-progress-snapshot', 'run-progress-snapshot');
  const page = createPageRecord({
    pageType: 'questions',
    pageTitle: 'Eligibility',
    url: 'https://example.com/apply',
    fingerprint: 'fp-progress-snapshot',
    pageStepKey: 'questions::eligibility',
    pageSequence: 1,
  });

  let session = applyPageEntry(base, page);
  session = syncQuestions(session, [
    makeSnapshot(),
    makeSnapshot({
      questionKey: 'q::guess::select::ff-2',
      orderIndex: 1,
      promptText: 'Gender',
      normalizedPrompt: 'gender',
      questionType: 'select',
      required: false,
      groupingConfidence: 0.4,
      warnings: ['ambiguous_prompt_anchor'],
      fieldIds: ['ff-2'],
    }),
  ], { isFullSync: true });
  session = applyAnswerDecisions(session, [
    {
      questionKey: 'q::guess::select::ff-2',
      answer: 'Prefer not to say',
      confidence: 0.4,
      source: 'llm',
      answerMode: 'best_effort_guess',
    },
  ]);
  session = recordOutcome(session, {
    questionKey: 'q::guess::select::ff-2',
    state: 'verified',
    currentValue: 'Prefer not to say',
    confidence: 0.4,
    source: 'llm',
  });
  session = finalizeActivePage(session);

  return session;
}

function createMockSupabase() {
  return {
    from: () => ({
      insert: mock(() => ({ error: null })),
    }),
  };
}

function createMockRedis() {
  return {
    xadd: mock(async () => 'ok'),
    expire: mock(async () => 1),
  };
}

describe('ProgressTracker context snapshots', () => {
  let session: PageContextSession;

  beforeEach(() => {
    session = buildSession();
  });

  test('getSnapshot includes context_report_snapshot when a page context reader is attached', () => {
    const tracker = new ProgressTracker({
      jobId: 'job-progress-snapshot',
      supabase: createMockSupabase() as any,
      workerId: 'worker-1',
      pageContext: {
        getSessionSync: () => session,
      },
    });

    const snapshot = tracker.getSnapshot();

    expect(snapshot.context_report_snapshot).toBeDefined();
    expect(snapshot.context_report_snapshot?.pagesVisited).toBe(1);
    expect(snapshot.context_report_snapshot?.requiredUnresolvedCount).toBe(1);
    expect(snapshot.context_report_snapshot?.lowConfidenceCount).toBe(1);
    expect(snapshot.context_report_snapshot?.ambiguousGroupCount).toBe(1);
    expect(snapshot.context_report_snapshot?.bestEffortGuessCount).toBe(1);
  });

  test('Redis stream payload serializes context_report_snapshot as JSON', async () => {
    const redis = createMockRedis();
    const tracker = new ProgressTracker({
      jobId: 'job-progress-snapshot',
      supabase: createMockSupabase() as any,
      workerId: 'worker-1',
      redis: redis as any,
      pageContext: {
        getSessionSync: () => session,
      },
    });

    await tracker.setStep('navigating');

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const xaddArgs = (redis.xadd as any).mock.calls[0] as string[];
    const fields = xaddArgs.slice(5);
    const snapshotIndex = fields.indexOf('context_report_snapshot');
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);

    const serialized = fields[snapshotIndex + 1];
    expect(typeof serialized).toBe('string');
    expect(JSON.parse(serialized)).toEqual(tracker.getSnapshot().context_report_snapshot);
  });

  test('flush clears the page context reader to avoid future ghost snapshots', async () => {
    const tracker = new ProgressTracker({
      jobId: 'job-progress-snapshot',
      supabase: createMockSupabase() as any,
      workerId: 'worker-1',
      pageContext: {
        getSessionSync: () => session,
      },
    });

    expect(tracker.getSnapshot().context_report_snapshot).toBeDefined();

    await tracker.flush();

    expect(tracker.getSnapshot().context_report_snapshot).toBeUndefined();
  });
});
