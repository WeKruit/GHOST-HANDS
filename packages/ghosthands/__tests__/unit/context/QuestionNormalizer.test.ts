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
});
