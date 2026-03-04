import { describe, expect, it } from 'bun:test';
import {
  applyAnswerDecisions,
  applyPageEntry,
  auditPage,
  buildContextReport,
  createEmptySession,
  createPageRecord,
  finalizeActivePage,
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
});
