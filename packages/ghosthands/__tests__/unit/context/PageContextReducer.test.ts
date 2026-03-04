import { describe, expect, it } from 'bun:test';
import {
  applyPageEntry,
  auditPage,
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
});
