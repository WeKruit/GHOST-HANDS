import { describe, expect, it } from 'bun:test';
import { mergeQuestionState } from '../../../src/context/QuestionMerge';
import type { QuestionRecord } from '../../../src/context/types';

function makeQuestion(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    questionKey: 'eligibility::do you need sponsorship?::radio::yes|no',
    orderIndex: 0,
    promptText: 'Do you need sponsorship?',
    normalizedPrompt: 'do you need sponsorship?',
    sectionLabel: 'Eligibility',
    questionType: 'radio',
    required: true,
    groupingConfidence: 0.95,
    resolutionConfidence: 0.9,
    riskLevel: 'none',
    state: 'verified',
    source: 'dom',
    selectors: [],
    options: [],
    selectedOptions: [],
    attemptCount: 1,
    verificationCount: 1,
    warnings: [],
    fieldIds: ['ff-1'],
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('QuestionMerge', () => {
  it('does not downgrade a verified question to failed', () => {
    const question = makeQuestion();
    const merged = mergeQuestionState(question, {
      state: 'failed',
      resolutionConfidence: 0.2,
      source: 'magnitude',
    });

    expect(merged.state).toBe('verified');
    expect(merged.source).toBe('magnitude');
  });
});
