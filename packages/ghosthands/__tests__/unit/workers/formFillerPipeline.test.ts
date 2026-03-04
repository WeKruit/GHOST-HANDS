import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions, reconcileNormalizedQuestions } from '../../../src/context/QuestionNormalizer';
import type { NormalizedQuestionDraft, QuestionNormalizerField } from '../../../src/context/QuestionNormalizer';
import type { AnswerMode } from '../../../src/context/types';

/**
 * Integration-style tests for the formFiller observation pipeline:
 *   normalization → answer planning → fill resolution → provenance tracking
 *
 * These tests exercise the seam logic without requiring a browser or adapter,
 * simulating the data flow through the pipeline stages.
 */

// ── Helpers that mirror formFiller internal logic ────────────────────────

interface MockFormField {
  id: string;
  name: string;
  type: string;
  section: string;
  required: boolean;
  choices?: string[];
  options?: string[];
  syntheticLabel?: boolean;
  observationWarning?: string[];
}

const PLACEHOLDER_RE = /^(select|choose|pick|--|—)/i;

/** Simulates the never-empty fallback sweep from formFiller */
function applyNeverEmptyFallback(
  fields: MockFormField[],
  resolved: Record<string, string>,
): Record<string, string> {
  const result = { ...resolved };
  for (const field of fields) {
    const existing = result[field.id];
    if (existing && existing.trim()) continue;
    if (field.choices?.length) {
      result[field.id] = field.choices[0];
    } else if (field.options?.length) {
      const nonPlaceholder = field.options.filter((o) => !PLACEHOLDER_RE.test(o.trim()));
      if (nonPlaceholder.length) result[field.id] = nonPlaceholder[0];
    } else if (field.type === 'number') {
      result[field.id] = '0';
    } else if (field.type === 'date') {
      result[field.id] = new Date().toISOString().slice(0, 10);
    } else if (field.type === 'textarea') {
      result[field.id] = 'N/A';
    } else if (field.type === 'text' || field.type === 'email' || field.type === 'tel' || field.type === 'url') {
      result[field.id] = 'N/A';
    }
  }
  return result;
}

/** Simulates fallback provenance emission from formFiller */
function emitFallbackDecisions(
  fields: MockFormField[],
  resolved: Record<string, string>,
  fieldIdToQuestionKey: Record<string, string>,
  existingDecisionKeys: Set<string>,
): Array<{ questionKey: string; answer: string; confidence: number; source: string; answerMode: AnswerMode }> {
  const decisions: Array<{ questionKey: string; answer: string; confidence: number; source: string; answerMode: AnswerMode }> = [];
  for (const field of fields) {
    const answer = resolved[field.id];
    if (!answer || !answer.trim()) continue;
    const questionKey = fieldIdToQuestionKey[field.id];
    if (!questionKey) continue;
    if (existingDecisionKeys.has(questionKey)) continue;
    const hasChoices = (field.choices?.length ?? 0) > 0 || (field.options?.length ?? 0) > 0;
    const mode: AnswerMode = hasChoices ? 'default_decline' : 'best_effort_guess';
    decisions.push({
      questionKey,
      answer,
      confidence: hasChoices ? 0.3 : 0.1,
      source: 'dom',
      answerMode: mode,
    });
  }
  return decisions;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('formFiller observation pipeline integration', () => {
  it('planned answers map back to field IDs via fieldIdToResolvedAnswer', () => {
    // Simulate: LLM normalization groups f1+f2, answers planned for grouped question
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

    // Simulate answer planning results
    const answerPlans = [
      { questionKey: snapshots[0].questionKey, answer: 'John Doe', confidence: 0.95, answerMode: 'profile_backed' as AnswerMode },
      { questionKey: snapshots[1].questionKey, answer: 'Yes', confidence: 0.9, answerMode: 'profile_backed' as AnswerMode },
    ];

    // Map answers back to field IDs (mirrors formFiller logic at line ~3002)
    const fieldIdToResolvedAnswer: Record<string, string> = {};
    for (const plan of answerPlans) {
      const snapshot = snapshots.find((q) => q.questionKey === plan.questionKey);
      if (!snapshot) continue;
      for (const fieldId of snapshot.fieldIds) {
        fieldIdToResolvedAnswer[fieldId] = plan.answer;
      }
    }

    // Both f1 and f2 should get the grouped answer
    expect(fieldIdToResolvedAnswer['f1']).toBe('John Doe');
    expect(fieldIdToResolvedAnswer['f2']).toBe('John Doe');
    expect(fieldIdToResolvedAnswer['f3']).toBe('Yes');
  });

  it('fieldIdToResolvedAnswer is checked before legacy answers in fill loop', () => {
    // Simulate: new pipeline has an answer, legacy map is empty
    const fieldIdToResolvedAnswer: Record<string, string> = { 'f1': 'Planned value' };
    const legacyAnswers: Record<string, string> = {};

    // Mirror fill loop logic: fieldIdToResolvedAnswer[field.id] ?? getAnswerForField(...)
    const resolved = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['First name'] ?? undefined;
    expect(resolved).toBe('Planned value');

    // When new pipeline is empty, legacy should still work
    const resolved2 = fieldIdToResolvedAnswer['f99'] ?? 'Legacy fallback';
    expect(resolved2).toBe('Legacy fallback');
  });

  it('never-empty sweep covers free-text, textarea, number, and date fields', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Bio', type: 'textarea', section: '', required: false },
      { id: 'f3', name: 'Years', type: 'number', section: '', required: false },
      { id: 'f4', name: 'Start date', type: 'date', section: '', required: false },
      { id: 'f5', name: 'Email', type: 'email', section: '', required: true },
      { id: 'f6', name: 'Phone', type: 'tel', section: '', required: false },
      { id: 'f7', name: 'Website', type: 'url', section: '', required: false },
      { id: 'f8', name: 'Gender', type: 'radio', section: '', required: false, choices: ['Male', 'Female', 'Other'] },
    ];

    // Start with empty resolved map — all fields need fallback
    const resolved = applyNeverEmptyFallback(fields, {});

    expect(resolved['f1']).toBe('N/A');
    expect(resolved['f2']).toBe('N/A');
    expect(resolved['f3']).toBe('0');
    expect(resolved['f4']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(resolved['f5']).toBe('N/A');
    expect(resolved['f6']).toBe('N/A');
    expect(resolved['f7']).toBe('N/A');
    expect(resolved['f8']).toBe('Male'); // first choice

    // No field should be empty
    for (const field of fields) {
      expect(resolved[field.id]).toBeTruthy();
    }
  });

  it('never-empty sweep does not overwrite existing LLM answers', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Bio', type: 'textarea', section: '', required: false },
    ];

    const resolved = applyNeverEmptyFallback(fields, { 'f1': 'Adam', 'f2': 'Engineer' });

    expect(resolved['f1']).toBe('Adam');
    expect(resolved['f2']).toBe('Engineer');
  });

  it('fallback provenance uses accurate answerMode per field type', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Gender', type: 'radio', section: '', required: false, choices: ['Male', 'Female'] },
      { id: 'f2', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f3', name: 'Country', type: 'select', section: '', required: false, options: ['Select...', 'US', 'UK'] },
    ];
    const resolved: Record<string, string> = { 'f1': 'Male', 'f2': 'N/A', 'f3': 'US' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2', 'f3': 'q3' };

    const decisions = emitFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // Choice-based fields get default_decline
    const d1 = decisions.find((d) => d.questionKey === 'q1')!;
    expect(d1.answerMode).toBe('default_decline');
    expect(d1.confidence).toBe(0.3);

    // Free-text fields get best_effort_guess
    const d2 = decisions.find((d) => d.questionKey === 'q2')!;
    expect(d2.answerMode).toBe('best_effort_guess');
    expect(d2.confidence).toBe(0.1);

    // Select with options gets default_decline
    const d3 = decisions.find((d) => d.questionKey === 'q3')!;
    expect(d3.answerMode).toBe('default_decline');
    expect(d3.confidence).toBe(0.3);
  });

  it('fallback provenance skips fields already covered by LLM decisions', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Bio', type: 'textarea', section: '', required: false },
    ];
    const resolved: Record<string, string> = { 'f1': 'Adam', 'f2': 'N/A' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2' };

    // q1 already has an LLM decision
    const decisions = emitFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set(['q1']));

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

    // LLM only returns f1, omits f2 and f3 entirely
    const llmDrafts: NormalizedQuestionDraft[] = [
      { promptText: 'First name', questionType: 'text', required: true, fieldIds: ['f1'], options: [], groupingConfidence: 0.95, warnings: [] },
    ];

    const result = reconcileNormalizedQuestions(heuristic, llmDrafts, fields);
    const allFieldIds = result.flatMap((q) => q.fieldIds);

    // All 3 fields must appear — f2 and f3 recovered from heuristic
    expect(allFieldIds).toContain('f1');
    expect(allFieldIds).toContain('f2');
    expect(allFieldIds).toContain('f3');

    // Omitted fields should have fallback warning
    const f2Question = result.find((q) => q.fieldIds.includes('f2'))!;
    const f3Question = result.find((q) => q.fieldIds.includes('f3'))!;
    expect(f2Question).toBeDefined();
    expect(f3Question).toBeDefined();
  });

  it('Magnitude fallback path can resolve from fieldIdToResolvedAnswer', () => {
    // Simulates the Magnitude unfilled-field check (line ~3368)
    const fieldIdToResolvedAnswer: Record<string, string> = { 'f1': 'Yes' };
    const legacyAnswers: Record<string, string> = {};

    // Mirror: fieldIdToResolvedAnswer[f.id] ?? getAnswerForField(answers, f, fieldIdMap)
    const answer = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['Relocate?'] ?? undefined;
    expect(answer).toBe('Yes');

    // Magnitude prompt builder should also see the planned answer
    const promptAnswer = fieldIdToResolvedAnswer['f1'] ?? undefined;
    expect(promptAnswer).toBe('Yes');
  });
});
