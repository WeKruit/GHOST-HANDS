import { describe, expect, it } from 'bun:test';
import {
  applyAnswerDecisions,
  applyPageEntry,
  auditPage,
  buildContextReport,
  computeSnapshotCounts,
  createEmptySession,
  createPageRecord,
  finalizeActivePage,
  recordOutcome,
  syncQuestions,
} from '../../../src/context/PageContextReducer';
import type { QuestionSnapshot } from '../../../src/context/types';

function makeSnapshot(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    questionKey: 'eligibility::sponsorship::radio::ff-1',
    orderIndex: 0,
    promptText: 'Do you need sponsorship?',
    normalizedPrompt: 'do you need sponsorship?',
    sectionLabel: 'Eligibility',
    questionType: 'radio',
    required: true,
    groupingConfidence: 0.9,
    riskLevel: 'none',
    warnings: [],
    fieldIds: ['ff-1'],
    selectors: [],
    options: [{ label: 'Yes' }, { label: 'No' }],
    ...overrides,
  };
}

describe('PageContextReducer', () => {
  it('merges repeated scans into one question record instead of duplicating', () => {
    const base = createEmptySession('job-1', 'run-1');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'fp-1',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [makeSnapshot()]);
    session = syncQuestions(session, [
      makeSnapshot({
        promptText: 'Do you need sponsorship now or in the future?',
        normalizedPrompt: 'do you need sponsorship now or in the future?',
        groupingConfidence: 0.95,
      }),
    ]);

    expect(session.pages[0].questions).toHaveLength(1);
    expect(session.pages[0].questions[0].promptText).toBe(
      'Do you need sponsorship now or in the future?',
    );
    expect(session.pages[0].questions[0].groupingConfidence).toBe(0.95);
  });

  it('does not mutate the previous session snapshot when syncing questions', () => {
    const base = createEmptySession('job-immut', 'run-immut');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'fp-immut',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    const sessionBeforeSync = applyPageEntry(base, page);
    const sessionAfterSync = syncQuestions(sessionBeforeSync, [makeSnapshot()]);

    expect(sessionBeforeSync.pages[0].questions).toHaveLength(0);
    expect(sessionAfterSync.pages[0].questions).toHaveLength(1);
  });

  it('blocks navigation when required questions remain unresolved', () => {
    const base = createEmptySession('job-2', 'run-2');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'fp-2',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [makeSnapshot()]);

    const audited = auditPage(session);

    expect(audited.result.blockNavigation).toBe(true);
    expect(audited.result.unresolvedRequired).toBe(1);
    expect(audited.result.unresolvedQuestionKeys).toEqual([
      'eligibility::sponsorship::radio::ff-1',
    ]);
  });

  it('finalizes the prior page before switching active pages', () => {
    const base = createEmptySession('job-3', 'run-3');
    const firstPage = createPageRecord({
      pageType: 'job_listing',
      pageTitle: 'Listing',
      url: 'https://example.com/jobs/1',
      fingerprint: 'listing-fp',
      pageStepKey: 'job_listing::listing',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, firstPage);
    session = finalizeActivePage(session);

    const secondPage = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/jobs/1/apply',
      fingerprint: 'questions-fp',
      pageStepKey: 'questions::eligibility',
      pageSequence: 2,
    });
    session = applyPageEntry(session, secondPage);

    expect(session.pages[0].status).toBe('completed');
    expect(session.pages[0].exitedAt).toBeTruthy();
    expect(session.activePageId).toBe(session.pages[1].pageId);
  });

  it('stores answerMode from answer decision on question record', () => {
    const base = createEmptySession('job-am', 'run-am');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'EEO',
      url: 'https://example.com/apply',
      fingerprint: 'fp-am',
      pageStepKey: 'questions::eeo',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [makeSnapshot()]);
    session = applyAnswerDecisions(session, [
      {
        questionKey: 'eligibility::sponsorship::radio::ff-1',
        answer: 'No',
        confidence: 0.95,
        source: 'llm',
        answerMode: 'profile_backed',
      },
    ]);

    expect(session.pages[0].questions[0].answerMode).toBe('profile_backed');
    expect(session.pages[0].questions[0].lastAnswer).toBe('No');
  });

  it('does not retire questions during incremental (non-full) sync', () => {
    const base = createEmptySession('job-incr', 'run-incr');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-incr',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    // Full sync with two questions
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    expect(session.pages[0].questions).toHaveLength(2);

    // Incremental sync with only ff-2 — ff-1's question should NOT be retired
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ]);

    const q1 = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(q1).toBeDefined();
    expect(q1!.state).not.toBe('skipped');
  });

  it('retires questions whose fieldIds disappear on full sync', () => {
    const base = createEmptySession('job-retire', 'run-retire');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-retire',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    // Full sync with only ff-2 — ff-1's question should be retired
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    const q1 = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(q1).toBeDefined();
    expect(q1!.state).toBe('skipped');
    expect(q1!.warnings).toContain('retired_missing_from_dom');
  });

  it('un-retires a question when its fieldIds reappear in a later sync', () => {
    const base = createEmptySession('job-unretire', 'run-unretire');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-unretire',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    // Full sync drops ff-1
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    const retired = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(retired!.state).toBe('skipped');

    // Incremental sync brings ff-1 back
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
    ]);

    const unretired = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(unretired!.state).toBe('empty');
    expect(unretired!.warnings).not.toContain('retired_missing_from_dom');
  });

  it('protects filled questions from retirement during full sync', () => {
    const base = createEmptySession('job-fill-prot', 'run-fill-prot');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-fill-prot',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    // Simulate answer planning + DOM write success (sets state to 'filled')
    session = applyAnswerDecisions(session, [
      { questionKey: 'q::a::text::no-options', answer: 'John', confidence: 0.95, source: 'llm' },
    ]);
    // applyAnswerDecisions sets 'planned'; simulate DOM write success
    const q1Pre = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    if (q1Pre) q1Pre.state = 'filled';

    // Full sync drops ff-1 — filled question should survive
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    const q1 = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(q1).toBeDefined();
    expect(q1!.state).toBe('filled');
    expect(q1!.warnings).not.toContain('retired_missing_from_dom');
  });

  it('protects planned questions from retirement during full sync', () => {
    const base = createEmptySession('job-plan-prot', 'run-plan-prot');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-plan-prot',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    // Plan an answer for the first question (sets state to 'planned')
    session = applyAnswerDecisions(session, [
      { questionKey: 'q::a::text::no-options', answer: 'John', confidence: 0.95, source: 'llm' },
    ]);
    // Manually set state to 'planned' to simulate answer planning without DOM write
    const q1Before = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    if (q1Before) q1Before.state = 'planned';

    // Full sync drops ff-1 — planned question should survive
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    const q1 = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(q1).toBeDefined();
    expect(q1!.state).toBe('planned');
    expect(q1!.warnings).not.toContain('retired_missing_from_dom');
  });

  it('buildContextReport excludes retired questions from requiredUnresolved', () => {
    const base = createEmptySession('job-report-retire', 'run-report-retire');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-report-retire',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text', required: true }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text', required: true }),
    ], { isFullSync: true });

    // Full sync drops ff-1 — retires it
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text', required: true }),
    ], { isFullSync: true });

    const report = buildContextReport(session);
    // Retired question should NOT appear in requiredUnresolved
    const keys = report.requiredUnresolved.map((r) => r.questionKey);
    expect(keys).not.toContain('q::a::text::no-options');
    // Non-retired unresolved question should still appear
    expect(keys).toContain('q::b::text::no-options');
  });

  it('retires attempted (non-protected) questions when their fields disappear on full sync', () => {
    const base = createEmptySession('job-attempt-retire', 'run-attempt-retire');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Mixed',
      url: 'https://example.com/apply',
      fingerprint: 'fp-attempt-retire',
      pageStepKey: 'questions::mixed',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['ff-1'], promptText: 'First name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    // Simulate an attempted fill (state transitions: empty → planned → attempted)
    session = applyAnswerDecisions(session, [
      { questionKey: 'q::a::text::no-options', answer: 'John', confidence: 0.95, source: 'llm' },
    ]);
    // Manually transition past planned to 'attempted' (simulating a DOM write attempt)
    const q1Pre = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    if (q1Pre) (q1Pre as any).state = 'attempted';

    // Full sync drops ff-1 — attempted question should be RETIRED (not protected)
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['ff-2'], promptText: 'Last name', questionType: 'text' }),
    ], { isFullSync: true });

    const q1 = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    expect(q1).toBeDefined();
    expect(q1!.state).toBe('skipped');
    expect(q1!.warnings).toContain('retired_missing_from_dom');
  });

  it('includes best_effort_guess answers in bestEffortGuesses report', () => {
    const base = createEmptySession('job-beg', 'run-beg');
    const page = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Demographics',
      url: 'https://example.com/apply',
      fingerprint: 'fp-beg',
      pageStepKey: 'questions::demographics',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [makeSnapshot({ questionKey: 'demo::gender::select::male|female' })]);
    session = applyAnswerDecisions(session, [
      {
        questionKey: 'demo::gender::select::male|female',
        answer: 'Prefer not to say',
        confidence: 0.5,
        source: 'llm',
        answerMode: 'best_effort_guess',
      },
    ]);

    const report = buildContextReport(session);
    expect(report.bestEffortGuesses).toHaveLength(1);
    expect(report.bestEffortGuesses[0].questionKey).toBe('demo::gender::select::male|female');
    expect(report.bestEffortGuesses[0].answerMode).toBe('best_effort_guess');
  });

  it('computeSnapshotCounts returns counts-only progress snapshots with real page fields', () => {
    const base = createEmptySession('job-snapshot', 'run-snapshot');
    const firstPage = createPageRecord({
      pageType: 'questions',
      pageTitle: 'Eligibility',
      url: 'https://example.com/apply',
      fingerprint: 'fp-snapshot-1',
      pageStepKey: 'questions::eligibility',
      pageSequence: 1,
    });

    let session = applyPageEntry(base, firstPage);
    session = syncQuestions(session, [
      makeSnapshot({
        questionKey: 'q::required::text::ff-1',
        fieldIds: ['ff-1'],
        promptText: 'First name',
        questionType: 'text',
        required: true,
      }),
      makeSnapshot({
        questionKey: 'q::optional::radio::ff-2',
        fieldIds: ['ff-2'],
        promptText: 'Are you willing to relocate?',
        questionType: 'radio',
        required: false,
        riskLevel: 'optional_risky',
      }),
      makeSnapshot({
        questionKey: 'q::guess::select::ff-3',
        fieldIds: ['ff-3'],
        promptText: 'Gender',
        questionType: 'select',
        required: false,
        groupingConfidence: 0.4,
        warnings: ['ambiguous_prompt_anchor'],
      }),
    ], { isFullSync: true });
    session = applyAnswerDecisions(session, [
      {
        questionKey: 'q::guess::select::ff-3',
        answer: 'Prefer not to say',
        confidence: 0.4,
        source: 'llm',
        answerMode: 'best_effort_guess',
      },
    ]);
    session = recordOutcome(session, {
      questionKey: 'q::guess::select::ff-3',
      state: 'verified',
      currentValue: 'Prefer not to say',
      confidence: 0.4,
      source: 'llm',
    });
    session = finalizeActivePage(session);

    const secondPage = createPageRecord({
      pageType: 'review',
      pageTitle: 'Review',
      url: 'https://example.com/apply/review',
      fingerprint: 'fp-snapshot-2',
      pageStepKey: 'review::final',
      pageSequence: 2,
    });
    session = applyPageEntry(session, secondPage);
    session = finalizeActivePage(session);

    const snapshot = computeSnapshotCounts(session);

    expect(snapshot.pagesVisited).toBe(2);
    expect(snapshot.requiredUnresolvedCount).toBe(1);
    expect(snapshot.riskyOptionalCount).toBe(1);
    expect(snapshot.lowConfidenceCount).toBe(1);
    expect(snapshot.ambiguousGroupCount).toBe(1);
    expect(snapshot.bestEffortGuessCount).toBe(1);
    expect(snapshot.partialPages).toEqual([
      {
        pageId: session.pages[0].pageId,
        pageSequence: 1,
        status: 'partial',
        requiredUnresolved: 1,
      },
    ]);
    expect('pageType' in snapshot.partialPages[0]!).toBe(false);
    expect(snapshot.flushStatus).toBe('pending');
  });

  it('overlap consolidation: rerun regrouping with shared fieldIds does not leave duplicate live records', () => {
    // Regression test for the exact scenario reproduced:
    // syncQuestions(full old key) → syncQuestions(incremental new key with overlapping fieldIds) → syncQuestions(full remapped old key)
    // This previously ended with two live records for the same field set.
    const base = createEmptySession('job-overlap', 'run-overlap');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-overlap',
      pageStepKey: 'step-overlap',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);

    // Step 1: Initial full sync — two questions, each owns one fieldId
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::name::text::no-options', fieldIds: ['f1'], orderIndex: 0, promptText: 'Name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::phone::tel::no-options', fieldIds: ['f2'], orderIndex: 1, promptText: 'Phone', questionType: 'tel' }),
    ], { isFullSync: true });

    expect(session.pages[0].questions.filter((q) => q.state !== 'skipped')).toHaveLength(2);

    // Step 2: Incremental sync — a new question arrives that groups f2 + f3 (f2 overlaps)
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::contact::tel::no-options', fieldIds: ['f2', 'f3'], orderIndex: 2, promptText: 'Contact', questionType: 'tel' }),
    ]);

    // Step 3: Full sync — the original questions come back with f1, f2, f3 all present
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::name::text::no-options', fieldIds: ['f1'], orderIndex: 0, promptText: 'Name', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::phone::tel::no-options', fieldIds: ['f2'], orderIndex: 1, promptText: 'Phone', questionType: 'tel' }),
      makeSnapshot({ questionKey: 'q::contact::tel::no-options', fieldIds: ['f3'], orderIndex: 2, promptText: 'Contact', questionType: 'tel' }),
    ], { isFullSync: true });

    const live = session.pages[0].questions.filter((q) => q.state !== 'skipped');
    // Each fieldId must appear exactly once across all live questions
    const allFieldIds = live.flatMap((q) => q.fieldIds);
    const uniqueFieldIds = new Set(allFieldIds);
    expect(allFieldIds.length).toBe(uniqueFieldIds.size); // no duplicates

    // All three fieldIds must still be covered
    expect(uniqueFieldIds.has('f1')).toBe(true);
    expect(uniqueFieldIds.has('f2')).toBe(true);
    expect(uniqueFieldIds.has('f3')).toBe(true);

    // No two live questions should own the same fieldId
    const fieldOwners = new Map<string, string>();
    for (const q of live) {
      for (const fid of q.fieldIds) {
        expect(fieldOwners.has(fid)).toBe(false);
        fieldOwners.set(fid, q.questionKey);
      }
    }
  });

  it('overlap consolidation: first question by orderIndex wins shared fieldIds', () => {
    const base = createEmptySession('job-overlap-order', 'run-overlap-order');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-overlap-order',
      pageStepKey: 'step-overlap-order',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);

    // Two questions both claim f1 — first by orderIndex should win
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['f1', 'f2'], orderIndex: 0, promptText: 'A', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['f1', 'f3'], orderIndex: 1, promptText: 'B', questionType: 'text' }),
    ], { isFullSync: true });

    const qA = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    const qB = session.pages[0].questions.find((q) => q.questionKey === 'q::b::text::no-options');

    expect(qA).toBeDefined();
    expect(qB).toBeDefined();

    // A (orderIndex 0) keeps f1
    expect(qA!.fieldIds).toContain('f1');
    // B has f1 stripped, keeps only f3
    expect(qB!.fieldIds).not.toContain('f1');
    expect(qB!.fieldIds).toContain('f3');
    expect(qB!.warnings).toContain('overlap_fieldids_stripped');
  });

  it('overlap consolidation: question with all fieldIds stripped is retired', () => {
    const base = createEmptySession('job-overlap-retire', 'run-overlap-retire');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-overlap-retire',
      pageStepKey: 'step-overlap-retire',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);

    // Q-B only has f1, which is also owned by Q-A (lower orderIndex) — Q-B should be fully stripped and retired
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['f1'], orderIndex: 0, promptText: 'A', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['f1'], orderIndex: 1, promptText: 'B', questionType: 'text' }),
    ], { isFullSync: true });

    const qB = session.pages[0].questions.find((q) => q.questionKey === 'q::b::text::no-options');
    expect(qB).toBeDefined();
    expect(qB!.fieldIds).toEqual([]);
    expect(qB!.state).toBe('skipped');
    expect(qB!.warnings).toContain('overlap_fieldids_stripped');
    expect(qB!.warnings).toContain('retired_missing_from_dom');
  });

  it('overlap consolidation: filled question keeps fieldId over lower-orderIndex empty question', () => {
    const base = createEmptySession('job-prot-overlap', 'run-prot-overlap');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-prot-overlap',
      pageStepKey: 'step-prot-overlap',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);

    // Initial sync: Q-B owns f1 and is filled
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['f1', 'f2'], orderIndex: 1, promptText: 'B', questionType: 'text' }),
    ], { isFullSync: true });
    // Mark Q-B as filled
    const qBPre = session.pages[0].questions.find((q) => q.questionKey === 'q::b::text::no-options');
    if (qBPre) qBPre.state = 'filled';

    // Full sync: Q-A (lower orderIndex) also claims f1
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['f1'], orderIndex: 0, promptText: 'A', questionType: 'text' }),
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['f1', 'f2'], orderIndex: 1, promptText: 'B', questionType: 'text' }),
    ], { isFullSync: true });

    const qA = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    const qB = session.pages[0].questions.find((q) => q.questionKey === 'q::b::text::no-options');

    // B is filled — it should keep f1 despite having higher orderIndex
    expect(qB!.fieldIds).toContain('f1');
    expect(qB!.state).toBe('filled');
    // A (empty, lower orderIndex) should NOT steal f1 from filled B
    expect(qA!.fieldIds).not.toContain('f1');
    expect(qA!.warnings).toContain('overlap_fieldids_stripped');
  });

  it('overlap consolidation: verified question keeps fieldId over lower-orderIndex planned question', () => {
    const base = createEmptySession('job-verified-priority', 'run-verified-priority');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-verified-priority',
      pageStepKey: 'step-verified-priority',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);
    session = syncQuestions(session, [
      makeSnapshot({
        questionKey: 'q::planned::text::no-options',
        fieldIds: ['f1'],
        orderIndex: 0,
        promptText: 'Planned first',
        questionType: 'text',
      }),
      makeSnapshot({
        questionKey: 'q::verified::text::no-options',
        fieldIds: ['f1'],
        orderIndex: 1,
        promptText: 'Verified second',
        questionType: 'text',
      }),
    ], { isFullSync: true });

    const planned = session.pages[0].questions.find(
      (q) => q.questionKey === 'q::planned::text::no-options',
    );
    const verified = session.pages[0].questions.find(
      (q) => q.questionKey === 'q::verified::text::no-options',
    );
    if (!planned || !verified) throw new Error('expected both overlap questions');

    planned.state = 'planned';
    verified.state = 'verified';

    session = syncQuestions(session, [
      makeSnapshot({
        questionKey: 'q::planned::text::no-options',
        fieldIds: ['f1'],
        orderIndex: 0,
        promptText: 'Planned first',
        questionType: 'text',
      }),
      makeSnapshot({
        questionKey: 'q::verified::text::no-options',
        fieldIds: ['f1'],
        orderIndex: 1,
        promptText: 'Verified second',
        questionType: 'text',
      }),
    ], { isFullSync: true });

    const plannedAfter = session.pages[0].questions.find(
      (q) => q.questionKey === 'q::planned::text::no-options',
    );
    const verifiedAfter = session.pages[0].questions.find(
      (q) => q.questionKey === 'q::verified::text::no-options',
    );
    if (!plannedAfter || !verifiedAfter) throw new Error('expected both overlap questions after sync');

    expect(verifiedAfter.fieldIds).toContain('f1');
    expect(verifiedAfter.state).toBe('verified');
    expect(plannedAfter.fieldIds).not.toContain('f1');
    expect(plannedAfter.warnings).toContain('overlap_fieldids_stripped');
  });

  it('overlap consolidation: incremental sync also deduplicates overlapping fieldIds', () => {
    const base = createEmptySession('job-incr-overlap', 'run-incr-overlap');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-incr-overlap',
      pageStepKey: 'step-incr-overlap',
      pageSequence: 0,
    });

    let session = applyPageEntry(base, page);

    // Full sync: Q-A owns f1
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::a::text::no-options', fieldIds: ['f1'], orderIndex: 0, promptText: 'A', questionType: 'text' }),
    ], { isFullSync: true });

    // Incremental sync: Q-B also claims f1 + f2
    session = syncQuestions(session, [
      makeSnapshot({ questionKey: 'q::b::text::no-options', fieldIds: ['f1', 'f2'], orderIndex: 1, promptText: 'B', questionType: 'text' }),
    ]);

    const qA = session.pages[0].questions.find((q) => q.questionKey === 'q::a::text::no-options');
    const qB = session.pages[0].questions.find((q) => q.questionKey === 'q::b::text::no-options');

    // f1 should only be owned by Q-A (lower orderIndex), not Q-B
    expect(qA!.fieldIds).toContain('f1');
    expect(qB!.fieldIds).not.toContain('f1');
    expect(qB!.fieldIds).toContain('f2');

    // No two live questions should share a fieldId
    const live = session.pages[0].questions.filter((q) => q.state !== 'skipped');
    const allFieldIds = live.flatMap((q) => q.fieldIds);
    expect(allFieldIds.length).toBe(new Set(allFieldIds).size);
  });
});
