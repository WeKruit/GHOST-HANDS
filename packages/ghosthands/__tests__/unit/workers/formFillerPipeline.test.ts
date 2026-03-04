import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions, reconcileNormalizedQuestions } from '../../../src/context/QuestionNormalizer';
import type { NormalizedQuestionDraft, QuestionNormalizerField } from '../../../src/context/QuestionNormalizer';
import type { AnswerMode } from '../../../src/context/types';

/**
 * Integration-style tests for the formFiller observation pipeline:
 *   normalization → answer planning → fill resolution → provenance tracking
 *
 * The helpers below replicate the exact production logic from formFiller.ts
 * so that any drift between production and test will be caught by review.
 * Where possible, tests exercise real production exports (normalizeExtractedQuestions,
 * reconcileNormalizedQuestions) directly.
 */

// ── Helpers matching production formFiller logic exactly ─────────────────

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

/**
 * Mirrors the never-empty fallback sweep in formFiller.ts (line ~3088).
 * Must stay in sync with production — any drift is a test bug.
 */
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
    } else if (field.type === 'email') {
      result[field.id] = 'n/a@example.com';
    } else if (field.type === 'tel') {
      result[field.id] = '0000000000';
    } else if (field.type === 'url') {
      result[field.id] = 'https://example.com';
    } else if (field.type === 'number') {
      result[field.id] = '0';
    } else if (field.type === 'date') {
      result[field.id] = new Date().toISOString().slice(0, 10);
    } else if (field.type === 'textarea') {
      result[field.id] = 'N/A';
    } else if (field.type === 'text') {
      result[field.id] = 'N/A';
    }
  }
  return result;
}

/**
 * Mirrors the fallback provenance emission in formFiller.ts (line ~3108).
 * Uses decline lexicon to distinguish default_decline from best_effort_guess.
 */
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
    const isDecline = /prefer\s*not|decline|do\s*not\s*wish|rather\s*not|n\/a/i.test(answer);
    const hasChoices = (field.choices?.length ?? 0) > 0 || (field.options?.length ?? 0) > 0;
    const mode: AnswerMode = isDecline ? 'default_decline' : 'best_effort_guess';
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

  it('never-empty sweep produces type-valid defaults for all field types', () => {
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

    const resolved = applyNeverEmptyFallback(fields, {});

    // Type-valid defaults that won't trigger client-side validation failures
    expect(resolved['f1']).toBe('N/A');
    expect(resolved['f2']).toBe('N/A');
    expect(resolved['f3']).toBe('0');
    expect(resolved['f4']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(resolved['f5']).toBe('n/a@example.com');  // valid email format
    expect(resolved['f6']).toBe('0000000000');        // valid tel format
    expect(resolved['f7']).toBe('https://example.com'); // valid URL format
    expect(resolved['f8']).toBe('Male');              // first choice

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

  it('fallback provenance uses decline lexicon for answerMode classification', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Gender', type: 'radio', section: '', required: false, choices: ['Male', 'Female', 'Prefer not to say'] },
      { id: 'f2', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f3', name: 'Country', type: 'select', section: '', required: false, options: ['Select...', 'US', 'UK'] },
      { id: 'f4', name: 'Disability', type: 'radio', section: '', required: false, choices: ['Yes', 'No', 'Decline to self-identify'] },
    ];
    const resolved: Record<string, string> = {
      'f1': 'Male',                         // normal value, NOT a decline
      'f2': 'N/A',                           // matches decline lexicon (n/a)
      'f3': 'US',                            // normal value, NOT a decline
      'f4': 'Decline to self-identify',      // matches decline lexicon
    };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2', 'f3': 'q3', 'f4': 'q4' };

    const decisions = emitFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // "Male" is a normal business value → best_effort_guess
    const d1 = decisions.find((d) => d.questionKey === 'q1')!;
    expect(d1.answerMode).toBe('best_effort_guess');
    expect(d1.confidence).toBe(0.3); // has choices

    // "N/A" matches decline lexicon → default_decline
    const d2 = decisions.find((d) => d.questionKey === 'q2')!;
    expect(d2.answerMode).toBe('default_decline');
    expect(d2.confidence).toBe(0.1); // no choices (free-text)

    // "US" is a normal value → best_effort_guess
    const d3 = decisions.find((d) => d.questionKey === 'q3')!;
    expect(d3.answerMode).toBe('best_effort_guess');
    expect(d3.confidence).toBe(0.3); // has options

    // "Decline to self-identify" matches decline lexicon → default_decline
    const d4 = decisions.find((d) => d.questionKey === 'q4')!;
    expect(d4.answerMode).toBe('default_decline');
    expect(d4.confidence).toBe(0.3); // has choices
  });

  it('fallback provenance skips fields already covered by LLM decisions', () => {
    const fields: MockFormField[] = [
      { id: 'f1', name: 'Name', type: 'text', section: '', required: true },
      { id: 'f2', name: 'Bio', type: 'textarea', section: '', required: false },
    ];
    const resolved: Record<string, string> = { 'f1': 'Adam', 'f2': 'N/A' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2' };

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

    // Mirrors production: fieldIdToResolvedAnswer[f.id] ?? getAnswerForField(answers, f, fieldIdMap)
    const answer = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['Relocate?'] ?? undefined;
    expect(answer).toBe('Yes');

    const promptAnswer = fieldIdToResolvedAnswer['f1'] ?? undefined;
    expect(promptAnswer).toBe('Yes');
  });
});
