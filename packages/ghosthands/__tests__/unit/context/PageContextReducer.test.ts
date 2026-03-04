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
