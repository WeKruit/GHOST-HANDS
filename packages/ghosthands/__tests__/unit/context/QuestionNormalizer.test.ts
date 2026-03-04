import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions, reconcileNormalizedQuestions } from '../../../src/context/QuestionNormalizer';
import type { NormalizedQuestionDraft } from '../../../src/context/QuestionNormalizer';

describe('QuestionNormalizer', () => {
  it('keeps a grouped radio question as a single logical question', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-1',
        name: 'Do you need sponsorship?',
        type: 'radio-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].questionType).toBe('radio');
    expect(questions[0].options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('collapses consecutive short option-like radio labels into one ambiguous question', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-2',
        name: 'Yes',
        type: 'radio',
        section: 'Eligibility',
        required: true,
      },
      {
        id: 'ff-3',
        name: 'No',
        type: 'radio',
        section: 'Eligibility',
        required: true,
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].riskLevel).toBe('ambiguous_grouping');
    expect(questions[0].warnings).toContain('ambiguous_prompt_anchor');
    expect(questions[0].options.map((option) => option.label)).toEqual(['Yes', 'No']);
  });

  it('keeps the same logical question key when data-ff ids change across rescans', () => {
    const first = normalizeExtractedQuestions([
      {
        id: 'ff-10',
        name: 'Do you need sponsorship?',
        type: 'radio-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    const second = normalizeExtractedQuestions([
      {
        id: 'ff-99',
        name: 'Do you need sponsorship?',
        type: 'radio-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    expect(first[0].questionKey).toBe(second[0].questionKey);
  });

  it('keeps the same logical question key when a question appears in a later subset scan', () => {
    const fullScan = normalizeExtractedQuestions([
      {
        id: 'ff-20',
        name: 'First name',
        type: 'text',
        section: 'Profile',
        required: true,
      },
      {
        id: 'ff-21',
        name: 'Do you need sponsorship?',
        type: 'radio-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    const subsetScan = normalizeExtractedQuestions([
      {
        id: 'ff-210',
        name: 'Do you need sponsorship?',
        type: 'radio-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    expect(fullScan[1].questionKey).toBe(subsetScan[0].questionKey);
  });

  it('classifies button-group as radio type', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-bg-1',
        name: 'Are you willing to relocate?',
        type: 'button-group',
        section: 'Application Questions',
        required: true,
        choices: ['Yes', 'No'],
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].questionType).toBe('radio');
    expect(questions[0].options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(questions[0].required).toBe(true);
  });

  it('button-group with choices uses grouped control confidence', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-bg-2',
        name: 'Do you need visa sponsorship?',
        type: 'button-group',
        section: 'Eligibility',
        required: false,
        choices: ['Yes', 'No', 'Not sure'],
      },
    ]);

    expect(questions).toHaveLength(1);
    expect(questions[0].groupingConfidence).toBe(0.95);
  });

  it('deduplicates question keys when repeated prompts would collide', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-dup-1',
        name: 'Phone',
        type: 'tel',
        section: 'Contact',
        required: true,
      },
      {
        id: 'ff-dup-2',
        name: 'Phone',
        type: 'tel',
        section: 'Contact',
        required: false,
      },
    ]);

    expect(questions).toHaveLength(2);
    expect(questions[0].questionKey).not.toBe(questions[1].questionKey);
    // Dedup uses fieldIds as suffix (stable regardless of input order)
    expect(questions[0].questionKey).toEndWith('::ff-dup-1');
    expect(questions[1].questionKey).toEndWith('::ff-dup-2');
  });

  it('does not append ordinal to unique question keys', () => {
    const questions = normalizeExtractedQuestions([
      {
        id: 'ff-uniq-1',
        name: 'First name',
        type: 'text',
        section: 'Profile',
        required: true,
      },
      {
        id: 'ff-uniq-2',
        name: 'Last name',
        type: 'text',
        section: 'Profile',
        required: true,
      },
    ]);

    expect(questions).toHaveLength(2);
    // Neither should have ordinal suffix
    for (const q of questions) {
      expect(q.questionKey).not.toMatch(/::\d+$/);
    }
  });

  it('reconciliation ensures every live field ID appears in final snapshots', () => {
    const liveFields = [
      { id: 'f1', name: 'First name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Last name', type: 'text', section: '', required: true },
      { id: 'f3', name: 'Relocate?', type: 'button-group', section: '', required: true, choices: ['Yes', 'No'] },
    ];
    const heuristic = normalizeExtractedQuestions(liveFields);
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Full name', questionType: 'text', required: true, fieldIds: ['f1', 'f2'], options: [], groupingConfidence: 0.9, warnings: [] },
      // f3 is omitted by LLM
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, liveFields);
    const allFieldIds = result.flatMap((q) => q.fieldIds);
    expect(allFieldIds).toContain('f1');
    expect(allFieldIds).toContain('f2');
    expect(allFieldIds).toContain('f3');
  });

  it('reconciliation deduplicates field IDs across LLM drafts', () => {
    const liveFields = [
      { id: 'f1', name: 'First name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Last name', type: 'text', section: '', required: true },
      { id: 'f3', name: 'Email', type: 'email', section: '', required: true },
    ];
    const heuristic = normalizeExtractedQuestions(liveFields);
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Full name', questionType: 'text', required: true, fieldIds: ['f1', 'f2'], options: [], groupingConfidence: 0.9, warnings: [] },
      { promptText: 'Name again', questionType: 'text', required: true, fieldIds: ['f1', 'f3'], options: [], groupingConfidence: 0.8, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, liveFields);

    // First draft gets f1 and f2
    const firstDraft = result.find((q) => q.promptText === 'Full name');
    expect(firstDraft).toBeDefined();
    expect(firstDraft!.fieldIds).toEqual(['f1', 'f2']);

    // Second draft gets only f3 (f1 already claimed by first draft)
    const secondDraft = result.find((q) => q.promptText === 'Name again');
    expect(secondDraft).toBeDefined();
    expect(secondDraft!.fieldIds).toEqual(['f3']);
    expect(secondDraft!.fieldIds).not.toContain('f1');
    expect(secondDraft!.warnings).toContain('duplicate_field_id_skipped');
  });

  it('reconciliation deduplicates colliding question keys with stable within-group counters', () => {
    const liveFields = [
      { id: 'f1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
      { id: 'f2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
      { id: 'f3', name: 'Email', type: 'email', section: 'Contact', required: true },
    ];
    const heuristic = normalizeExtractedQuestions(liveFields);
    // LLM groups both Phone fields into two separate questions with same prompt
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Phone number', questionType: 'tel', required: true, fieldIds: ['f1'], options: [], groupingConfidence: 0.9, warnings: [] },
      { promptText: 'Phone number', questionType: 'tel', required: false, fieldIds: ['f2'], options: [], groupingConfidence: 0.9, warnings: [] },
      { promptText: 'Email address', questionType: 'email', required: true, fieldIds: ['f3'], options: [], groupingConfidence: 0.95, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, liveFields);
    const phoneQuestions = result.filter((q) => q.promptText === 'Phone number');
    expect(phoneQuestions).toHaveLength(2);
    // Keys should be distinct via fieldId-based dedup suffix
    expect(phoneQuestions[0].questionKey).not.toBe(phoneQuestions[1].questionKey);
    // Suffixes should be fieldId-based, not counter-based
    const keys = phoneQuestions.map((q) => q.questionKey).sort();
    expect(keys.some((k) => k.endsWith('::f1'))).toBe(true);
    expect(keys.some((k) => k.endsWith('::f2'))).toBe(true);
  });

  it('reconciliation discards invalid field IDs from LLM drafts', () => {
    const liveFields = [
      { id: 'f1', name: 'Email', type: 'email', section: '', required: true },
    ];
    const heuristic = normalizeExtractedQuestions(liveFields);
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Email', questionType: 'email', required: true, fieldIds: ['f1', 'f999'], options: [], groupingConfidence: 0.8, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, liveFields);
    expect(result).toHaveLength(1);
    expect(result[0].fieldIds).toContain('f1');
    expect(result[0].fieldIds).not.toContain('f999');
    expect(result[0].warnings).toContain('invalid_field_ids_discarded');
  });

  it('reconciliation deduplicates keys that collide between LLM draft and heuristic fallback', () => {
    const liveFields = [
      { id: 'f1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
      { id: 'f2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
    ];
    const heuristic = normalizeExtractedQuestions(liveFields);
    // LLM only covers f1, f2 falls to heuristic fallback — both produce same base key
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Phone', questionType: 'tel', required: true, fieldIds: ['f1'], options: [], groupingConfidence: 0.9, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, liveFields);
    expect(result).toHaveLength(2);
    const allFieldIds = result.flatMap((q) => q.fieldIds);
    expect(allFieldIds).toContain('f1');
    expect(allFieldIds).toContain('f2');
    // Keys must be distinct even though both originate from "Phone"
    expect(result[0].questionKey).not.toBe(result[1].questionKey);
  });

  it('dedup keys are stable when duplicate DOM order reverses', () => {
    const forward = normalizeExtractedQuestions([
      { id: 'ff-phone-1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
      { id: 'ff-phone-2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
    ]);

    const reversed = normalizeExtractedQuestions([
      { id: 'ff-phone-2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
      { id: 'ff-phone-1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
    ]);

    // Both scans should produce the same two keys (just in different order)
    const forwardKeys = forward.map((q) => q.questionKey).sort();
    const reversedKeys = reversed.map((q) => q.questionKey).sort();
    expect(forwardKeys).toEqual(reversedKeys);

    // Each key should map to the same fieldId regardless of input order
    const forwardByKey = new Map(forward.map((q) => [q.questionKey, q]));
    const reversedByKey = new Map(reversed.map((q) => [q.questionKey, q]));
    for (const key of forwardKeys) {
      expect(forwardByKey.get(key)!.fieldIds).toEqual(reversedByKey.get(key)!.fieldIds);
      expect(forwardByKey.get(key)!.required).toBe(reversedByKey.get(key)!.required);
    }
  });

  it('reversed duplicate order does not corrupt merge state', () => {
    const { syncQuestions, createEmptySession, createPageRecord, applyPageEntry } = require('../../../src/context/PageContextReducer');

    // First scan: Phone(required) then Phone(optional)
    const scan1 = normalizeExtractedQuestions([
      { id: 'ff-phone-1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
      { id: 'ff-phone-2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
    ]);

    let session = createEmptySession('job-1', 'run-1');
    const page = createPageRecord({
      pageType: 'form',
      url: 'https://example.com/apply',
      fingerprint: 'fp-1',
      pageStepKey: 'step-1',
      pageSequence: 0,
    });
    session = applyPageEntry(session, page);
    session = syncQuestions(session, scan1);

    const pageBefore = session.pages[0];
    const q1Before = pageBefore.questions.find((q: any) => q.fieldIds.includes('ff-phone-1'));
    const q2Before = pageBefore.questions.find((q: any) => q.fieldIds.includes('ff-phone-2'));
    expect(q1Before.required).toBe(true);
    expect(q2Before.required).toBe(false);

    // Second scan: reversed order
    const scan2 = normalizeExtractedQuestions([
      { id: 'ff-phone-2', name: 'Phone', type: 'tel', section: 'Contact', required: false },
      { id: 'ff-phone-1', name: 'Phone', type: 'tel', section: 'Contact', required: true },
    ]);

    session = syncQuestions(session, scan2);

    const pageAfter = session.pages[0];
    const q1After = pageAfter.questions.find((q: any) => q.fieldIds.includes('ff-phone-1'));
    const q2After = pageAfter.questions.find((q: any) => q.fieldIds.includes('ff-phone-2'));

    // required flags must NOT have cross-contaminated
    expect(q1After.required).toBe(true);
    expect(q2After.required).toBe(false);
    // fieldIds must NOT have been unioned across the two questions
    expect(q1After.fieldIds).toEqual(['ff-phone-1']);
    expect(q2After.fieldIds).toEqual(['ff-phone-2']);
  });
});
