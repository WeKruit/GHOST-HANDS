import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions } from '../../../src/context/QuestionNormalizer';

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
});
