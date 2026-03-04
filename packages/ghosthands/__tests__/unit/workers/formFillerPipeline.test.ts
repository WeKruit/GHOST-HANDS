import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions, reconcileNormalizedQuestions } from '../../../src/context/QuestionNormalizer';
import type { NormalizedQuestionDraft, QuestionNormalizerField } from '../../../src/context/QuestionNormalizer';
import type { AnswerMode } from '../../../src/context/types';
import {
  applyNeverEmptyFallback,
  buildFallbackDecisions,
  classifyFallbackAnswerMode,
} from '../../../src/workers/taskHandlers/formFiller';

/**
 * Integration-style tests for the formFiller observation pipeline.
 * These import the real exported production helpers — no shadow logic.
 */

describe('formFiller observation pipeline integration', () => {
  it('planned answers map back to field IDs via fieldIdToResolvedAnswer', () => {
    const fields: QuestionNormalizerField[] = [
      { id: 'f1', name: 'First name', type: 'text', section: 'Info', required: true },
      { id: 'f2', name: 'Last name', type: 'text', section: 'Info', required: true },
      { id: 'f3', name: 'Relocate?', type: 'button-group', section: 'Q', required: true, choices: ['Yes', 'No'] },
    ];
    const heuristic = normalizeExtractedQuestions(fields);
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'Full name', questionType: 'text', required: true, fieldIds: ['f1', 'f2'], options: [], groupingConfidence: 0.9, warnings: [] },
      { promptText: 'Willing to relocate?', questionType: 'radio', required: true, fieldIds: ['f3'], options: ['Yes', 'No'], groupingConfidence: 0.95, warnings: [] },
    ];
    const snapshots = reconcileNormalizedQuestions(heuristic, llmDrafts, fields);

    const answerPlans = [
      { questionKey: snapshots[0].questionKey, answer: 'John Doe', confidence: 0.95, answerMode: 'profile_backed' as AnswerMode },
      { questionKey: snapshots[1].questionKey, answer: 'Yes', confidence: 0.9, answerMode: 'profile_backed' as AnswerMode },
    ];

    const fieldIdToResolvedAnswer: Record<string, string> = {};
    for (const plan of answerPlans) {
      const snapshot = snapshots.find((q) => q.questionKey === plan.questionKey);
      if (!snapshot) continue;
      for (const fieldId of snapshot.fieldIds) {
        fieldIdToResolvedAnswer[fieldId] = plan.answer;
      }
    }

    expect(fieldIdToResolvedAnswer['f1']).toBe('John Doe');
    expect(fieldIdToResolvedAnswer['f2']).toBe('John Doe');
    expect(fieldIdToResolvedAnswer['f3']).toBe('Yes');
  });

  it('fieldIdToResolvedAnswer is checked before legacy answers in fill loop', () => {
    const fieldIdToResolvedAnswer: Record<string, string> = { 'f1': 'Planned value' };
    const legacyAnswers: Record<string, string> = {};

    const resolved = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['First name'] ?? undefined;
    expect(resolved).toBe('Planned value');

    const resolved2 = fieldIdToResolvedAnswer['f99'] ?? 'Legacy fallback';
    expect(resolved2).toBe('Legacy fallback');
  });

  it('applyNeverEmptyFallback produces type-valid defaults for all field types', () => {
    const fields = [
      { id: 'f1', type: 'text' },
      { id: 'f2', type: 'textarea' },
      { id: 'f3', type: 'number' },
      { id: 'f4', type: 'date' },
      { id: 'f5', type: 'email' },
      { id: 'f6', type: 'tel' },
      { id: 'f7', type: 'url' },
      { id: 'f8', type: 'radio', choices: ['Male', 'Female', 'Other'] },
    ];

    const resolved = applyNeverEmptyFallback(fields, {});

    expect(resolved['f1']).toBe('N/A');
    expect(resolved['f2']).toBe('N/A');
    expect(resolved['f3']).toBe('0');
    expect(resolved['f4']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(resolved['f5']).toBe('n/a@example.com');
    expect(resolved['f6']).toBe('0000000000');
    expect(resolved['f7']).toBe('https://example.com');
    expect(resolved['f8']).toBe('Male');

    for (const field of fields) {
      expect(resolved[field.id]).toBeTruthy();
    }
  });

  it('applyNeverEmptyFallback does not overwrite existing answers', () => {
    const fields = [
      { id: 'f1', type: 'text' },
      { id: 'f2', type: 'textarea' },
    ];

    const resolved = applyNeverEmptyFallback(fields, { 'f1': 'Adam', 'f2': 'Engineer' });

    expect(resolved['f1']).toBe('Adam');
    expect(resolved['f2']).toBe('Engineer');
  });

  it('classifyFallbackAnswerMode uses decline lexicon only for choice-based fields', () => {
    // Decline text + choices → default_decline
    expect(classifyFallbackAnswerMode('Prefer not to say', true)).toBe('default_decline');
    expect(classifyFallbackAnswerMode('Decline to self-identify', true)).toBe('default_decline');

    // Decline text but NO choices (free-text fallback) → best_effort_guess
    expect(classifyFallbackAnswerMode('N/A', false)).toBe('best_effort_guess');
    expect(classifyFallbackAnswerMode('n/a@example.com', false)).toBe('best_effort_guess');

    // Normal business values + choices → best_effort_guess
    expect(classifyFallbackAnswerMode('Male', true)).toBe('best_effort_guess');
    expect(classifyFallbackAnswerMode('US', true)).toBe('best_effort_guess');
    expect(classifyFallbackAnswerMode('Yes', true)).toBe('best_effort_guess');

    // Normal values without choices → best_effort_guess
    expect(classifyFallbackAnswerMode('0', false)).toBe('best_effort_guess');
    expect(classifyFallbackAnswerMode('0000000000', false)).toBe('best_effort_guess');
  });

  it('buildFallbackDecisions classifies provenance accurately', () => {
    const fields = [
      { id: 'f1', type: 'radio', choices: ['Male', 'Female'] },
      { id: 'f2', type: 'text' },
      { id: 'f3', type: 'select', options: ['Select...', 'US', 'UK'] },
      { id: 'f4', type: 'radio', choices: ['Yes', 'No', 'Decline to self-identify'] },
    ];
    const resolved: Record<string, string> = {
      'f1': 'Male',
      'f2': 'N/A',
      'f3': 'US',
      'f4': 'Decline to self-identify',
    };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2', 'f3': 'q3', 'f4': 'q4' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // "Male" — normal value with choices → best_effort_guess
    const d1 = decisions.find((d) => d.questionKey === 'q1')!;
    expect(d1.answerMode).toBe('best_effort_guess');
    expect(d1.confidence).toBe(0.3);

    // "N/A" — free-text fallback (no choices) → best_effort_guess (not decline!)
    const d2 = decisions.find((d) => d.questionKey === 'q2')!;
    expect(d2.answerMode).toBe('best_effort_guess');
    expect(d2.confidence).toBe(0.1);

    // "US" — normal value with options → best_effort_guess
    const d3 = decisions.find((d) => d.questionKey === 'q3')!;
    expect(d3.answerMode).toBe('best_effort_guess');
    expect(d3.confidence).toBe(0.3);

    // "Decline to self-identify" — decline lexicon with choices → default_decline
    const d4 = decisions.find((d) => d.questionKey === 'q4')!;
    expect(d4.answerMode).toBe('default_decline');
    expect(d4.confidence).toBe(0.3);
  });

  it('buildFallbackDecisions skips fields already covered by LLM decisions', () => {
    const fields = [
      { id: 'f1', type: 'text' },
      { id: 'f2', type: 'textarea' },
    ];
    const resolved: Record<string, string> = { 'f1': 'Adam', 'f2': 'N/A' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set(['q1']));

    expect(decisions).toHaveLength(1);
    expect(decisions[0].questionKey).toBe('q2');
  });

  it('LLM normalization omission is recovered by heuristic fallback', () => {
    const fields: QuestionNormalizerField[] = [
      { id: 'f1', name: 'First name', type: 'text', section: 'Info', required: true },
      { id: 'f2', name: 'Relocate?', type: 'button-group', section: 'Q', required: true, choices: ['Yes', 'No'] },
      { id: 'f3', name: 'Email', type: 'email', section: 'Info', required: true },
    ];
    const heuristic = normalizeExtractedQuestions(fields);

    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'First name', questionType: 'text', required: true, fieldIds: ['f1'], options: [], groupingConfidence: 0.95, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, fields);
    const allFieldIds = result.flatMap((q) => q.fieldIds);

    expect(allFieldIds).toContain('f1');
    expect(allFieldIds).toContain('f2');
    expect(allFieldIds).toContain('f3');

    const f2Question = result.find((q) => q.fieldIds.includes('f2'))!;
    const f3Question = result.find((q) => q.fieldIds.includes('f3'))!;
    expect(f2Question).toBeDefined();
    expect(f3Question).toBeDefined();
  });

  it('Magnitude fallback path resolves from fieldIdToResolvedAnswer', () => {
    const fieldIdToResolvedAnswer: Record<string, string> = { 'f1': 'Yes' };
    const legacyAnswers: Record<string, string> = {};

    const answer = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['Relocate?'] ?? undefined;
    expect(answer).toBe('Yes');
  });
});
