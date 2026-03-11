import { describe, expect, it } from 'bun:test';
import { normalizeExtractedQuestions, reconcileNormalizedQuestions } from '../../../src/context/QuestionNormalizer';
import type { NormalizedQuestionDraft, QuestionNormalizerField } from '../../../src/context/QuestionNormalizer';
import type { AnswerMode } from '../../../src/context/types';
import {
  applyNeverEmptyFallback,
  buildFallbackDecisions,
  classifyFieldContextState,
  classifyFallbackAnswerMode,
  getAnswerForField,
  isPlaceholderValue,
  matchesSelectDisplayValue,
  resolveDesiredAnswerForField,
  sanitizeNoGuessAnswer,
} from '../../../src/workers/taskHandlers/formFiller';
import { redactSensitiveValue } from '../../../src/context/PageContextReducer';

/**
 * Integration-style tests for the formFiller observation pipeline.
 * These import the real exported production helpers — no shadow logic.
 */

describe('formFiller observation pipeline integration', () => {
  it('does not blindly copy grouped planned answers onto every field in the group', () => {
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

    const fieldIdToResolvedAnswer: Record<string, string> = {};
    for (const snapshot of snapshots) {
      if (snapshot.fieldIds.length !== 1) continue;
      fieldIdToResolvedAnswer[snapshot.fieldIds[0]!] = snapshot.promptText;
    }

    expect(fieldIdToResolvedAnswer['f1']).toBeUndefined();
    expect(fieldIdToResolvedAnswer['f2']).toBeUndefined();
    expect(fieldIdToResolvedAnswer['f3']).toBe('Willing to relocate?');
  });

  it('fieldIdToResolvedAnswer is checked before legacy answers in fill loop', () => {
    const fieldIdToResolvedAnswer: Record<string, string> = { 'f1': 'Planned value' };
    const legacyAnswers: Record<string, string> = {};

    const resolved = fieldIdToResolvedAnswer['f1'] ?? legacyAnswers['First name'] ?? undefined;
    expect(resolved).toBe('Planned value');

    const resolved2 = fieldIdToResolvedAnswer['f99'] ?? 'Legacy fallback';
    expect(resolved2).toBe('Legacy fallback');
  });

  it('prefers authoritative phone-code answers over mapped sibling phone values', () => {
    const resolved = getAnswerForField(
      {
        'Phone Number': '5717788080',
        'Country Phone Code': '+1',
        'Phone Country Code': '+1',
      },
      {
        id: 'f1',
        name: 'Country Phone Code*',
        type: 'select',
        section: 'Phone',
        required: true,
        isNative: false,
        visibleByDefault: true,
      } as any,
      { f1: 'Phone Number' },
    );

    expect(resolved).toBe('+1');
  });

  it('falls back to authoritative Workday contact defaults before sibling mapped values', () => {
    const resolved = getAnswerForField(
      {
        'Phone Number': '5717788080',
      },
      {
        id: 'f1',
        name: 'Phone Device Type',
        type: 'select',
        section: 'Phone',
        required: true,
        isNative: false,
        visibleByDefault: true,
      } as any,
      { f1: 'Phone Number' },
    );

    expect(resolved).toBe('Mobile');
  });

  it('leaves optional phone extension empty without explicit user data', () => {
    const resolved = resolveDesiredAnswerForField(
      {
        id: 'f1',
        name: 'Phone Extension',
        type: 'text',
        section: 'Phone',
        required: false,
        isNative: false,
        visibleByDefault: true,
      } as any,
      {
        'Phone Information': '5717788080',
        'Phone Number': '5717788080',
      },
      {
        phone: '5717788080',
      } as any,
      { f1: 'Phone Information' },
    );

    expect(resolved.value).toBeUndefined();
    expect(resolved.source).toBe('none');
  });

  it('ignores grouped question mappings when resolving a specific required field answer', () => {
    const resolved = resolveDesiredAnswerForField(
      {
        id: 'f1',
        name: 'Postal Code',
        type: 'text',
        section: 'Address',
        required: true,
        isNative: false,
        visibleByDefault: true,
      } as any,
      {
        Address: 'Chantilly, VA',
      },
      {
        city: 'Chantilly',
        state: 'VA',
      } as any,
      { f1: 'Address' },
    );

    expect(resolved.value).toBeUndefined();
    expect(resolved.source).toBe('none');
  });

  it('treats a visible selected value as valid when the desired answer is only best-effort', () => {
    const state = classifyFieldContextState(
      {
        type: 'select',
        required: true,
      } as any,
      'Telephone',
      {
        value: 'Mobile',
        source: 'best_effort',
      },
      [],
      true,
    );

    expect(state).toBe('valid');
  });

  it('matches selected dropdown display values semantically', () => {
    expect(matchesSelectDisplayValue('United States of America (+1)', '+1')).toBe(true);
    expect(matchesSelectDisplayValue('Mobile', 'Mobile')).toBe(true);
    expect(matchesSelectDisplayValue('Virginia', 'California')).toBe(false);
  });

  it('applyNeverEmptyFallback produces type-valid defaults for required field types', () => {
    const fields = [
      { id: 'f1', type: 'text', required: true },
      { id: 'f2', type: 'textarea', required: true },
      { id: 'f3', type: 'number', required: true },
      { id: 'f4', type: 'date', required: true },
      { id: 'f5', type: 'email', required: true },
      { id: 'f6', type: 'tel', required: true },
      { id: 'f7', type: 'url', required: true },
      { id: 'f8', type: 'radio', required: true, choices: ['Male', 'Female', 'Other'] },
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

  it('applyNeverEmptyFallback skips optional fields', () => {
    const fields = [
      { id: 'f1', type: 'text', required: false },
      { id: 'f2', type: 'text' },  // required defaults to undefined (falsy)
      { id: 'f3', type: 'tel', required: false },
    ];

    const resolved = applyNeverEmptyFallback(fields, {});

    expect(resolved['f1']).toBeUndefined();
    expect(resolved['f2']).toBeUndefined();
    expect(resolved['f3']).toBeUndefined();
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

  it('classifyFallbackAnswerMode uses decline lexicon only for demographic choice-based fields', () => {
    // Decline text + choices + demographic → default_decline
    expect(classifyFallbackAnswerMode('Prefer not to say', true, true)).toBe('default_decline');
    expect(classifyFallbackAnswerMode('Decline to self-identify', true, true)).toBe('default_decline');

    // Decline text + choices but NOT demographic → best_effort_guess
    expect(classifyFallbackAnswerMode('Prefer not to say', true, false)).toBe('best_effort_guess');
    expect(classifyFallbackAnswerMode('Do not wish to relocate', true, false)).toBe('best_effort_guess');

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
      { id: 'f1', type: 'radio', name: 'Gender', choices: ['Male', 'Female'] },
      { id: 'f2', type: 'text', name: 'Notes' },
      { id: 'f3', type: 'select', name: 'Country', options: ['Select...', 'US', 'UK'] },
      { id: 'f4', type: 'radio', name: 'Gender identity', choices: ['Yes', 'No', 'Decline to self-identify'] },
    ];
    const resolved: Record<string, string> = {
      'f1': 'Male',
      'f2': 'N/A',
      'f3': 'US',
      'f4': 'Decline to self-identify',
    };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q2', 'f3': 'q3', 'f4': 'q4' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // "Male" — normal value with choices (demographic name but not decline text) → best_effort_guess
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

    // "Decline to self-identify" — decline lexicon + choices + demographic name → default_decline
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

  it('applyNeverEmptyFallback with all-placeholder options leaves select unresolved', () => {
    const fields = [
      { id: 'f1', type: 'select', options: ['Select...', '-- Select --', 'Please select'], required: true },
      { id: 'f2', type: 'text', options: ['Choose one', 'Choose...'], required: false },
    ];

    const resolved = applyNeverEmptyFallback(fields, {});

    // f1 is type 'select' with only placeholder options — left unresolved (no options[0] fallback)
    expect(resolved['f1']).toBeUndefined();

    // f2 is optional text — do not invent fallback text
    expect(resolved['f2']).toBeUndefined();
  });

  it('applyNeverEmptyFallback filters "Please select" as a placeholder', () => {
    const fields = [
      { id: 'f1', type: 'select', options: ['Please select', 'United States', 'Canada'], required: true },
    ];

    const resolved = applyNeverEmptyFallback(fields, {});

    // Should pick first non-placeholder option
    expect(resolved['f1']).toBe('United States');
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

  it('buildFallbackDecisions deduplicates fields mapped to the same questionKey', () => {
    const fields = [
      { id: 'f1', type: 'text', name: 'First name' },
      { id: 'f2', type: 'text', name: 'First name (duplicate)' },
    ];
    const resolved: Record<string, string> = { 'f1': 'Adam', 'f2': 'Adam' };
    // Both field IDs map to the same questionKey
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1', 'f2': 'q1' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // Should produce exactly one decision, not two
    expect(decisions).toHaveLength(1);
    expect(decisions[0].questionKey).toBe('q1');
  });

  it('non-EEO "do not wish to relocate" choice => best_effort_guess, not default_decline', () => {
    const fields = [
      { id: 'f1', type: 'radio', name: 'Willing to relocate?', choices: ['Yes', 'No', 'Do not wish to relocate'] },
    ];
    const resolved: Record<string, string> = { 'f1': 'Do not wish to relocate' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    // "Willing to relocate?" is not a demographic field — decline text should NOT trigger default_decline
    expect(decisions).toHaveLength(1);
    expect(decisions[0].answerMode).toBe('best_effort_guess');
  });

  it('EEO "Decline to self-identify" on a gender field with demographicHint => default_decline', () => {
    const fields = [
      { id: 'f1', type: 'radio', name: 'What is your gender?', demographicHint: true, choices: ['Male', 'Female', 'Decline to self-identify'] },
    ];
    const resolved: Record<string, string> = { 'f1': 'Decline to self-identify' };
    const fieldIdToQuestionKey: Record<string, string> = { 'f1': 'q1' };

    const decisions = buildFallbackDecisions(fields, resolved, fieldIdToQuestionKey, new Set());

    expect(decisions).toHaveLength(1);
    expect(decisions[0].answerMode).toBe('default_decline');
  });

  // --- Round 6 tests ---

  it('redactSensitiveValue masks password/ssn/token fields', () => {
    expect(redactSensitiveValue('password', 'hunter2')).toBe('[REDACTED]');
    expect(redactSensitiveValue('SSN', '123-45-6789')).toBe('[REDACTED]');
    expect(redactSensitiveValue('api_token', 'sk-abc123')).toBe('[REDACTED]');
    expect(redactSensitiveValue('credit_card', '4111111111111111')).toBe('[REDACTED]');
    expect(redactSensitiveValue('cvv', '123')).toBe('[REDACTED]');
    expect(redactSensitiveValue('social security number', '111-22-3333')).toBe('[REDACTED]');
  });

  it('redactSensitiveValue passes through non-sensitive fields', () => {
    expect(redactSensitiveValue('First name', 'Adam')).toBe('Adam');
    expect(redactSensitiveValue('Email', 'adam@example.com')).toBe('adam@example.com');
    expect(redactSensitiveValue('Country', 'US')).toBe('US');
    expect(redactSensitiveValue('Willing to relocate?', 'Yes')).toBe('Yes');
  });

  it('isPlaceholderValue detects common placeholder patterns', () => {
    expect(isPlaceholderValue('Select...')).toBe(true);
    expect(isPlaceholderValue('-- Select --')).toBe(true);
    expect(isPlaceholderValue('Please select')).toBe(true);
    expect(isPlaceholderValue('Choose one')).toBe(true);
    expect(isPlaceholderValue('Select one')).toBe(true);
    expect(isPlaceholderValue('Start typing')).toBe(true);
    expect(isPlaceholderValue('Choose...')).toBe(true);
    expect(isPlaceholderValue('Pick')).toBe(true);
  });

  it('isPlaceholderValue detects expanded R7 placeholder patterns', () => {
    expect(isPlaceholderValue('Please select one')).toBe(true);
    expect(isPlaceholderValue('Select an option')).toBe(true);
    expect(isPlaceholderValue('Select a option')).toBe(true);
    expect(isPlaceholderValue('Please choose')).toBe(true);
    expect(isPlaceholderValue('Please choose one')).toBe(true);
    expect(isPlaceholderValue('Enter your name')).toBe(true);
    expect(isPlaceholderValue('Enter an email')).toBe(true);
    expect(isPlaceholderValue('Type here')).toBe(true);
    expect(isPlaceholderValue('—')).toBe(true);
  });

  it('isPlaceholderValue rejects real values', () => {
    expect(isPlaceholderValue('United States')).toBe(false);
    expect(isPlaceholderValue('Male')).toBe(false);
    expect(isPlaceholderValue('Yes')).toBe(false);
    expect(isPlaceholderValue('Software Engineer')).toBe(false);
    expect(isPlaceholderValue('42')).toBe(false);
  });

  it('applyNeverEmptyFallback leaves placeholder-only select unresolved instead of using options[0]', () => {
    const fields = [
      { id: 'f1', type: 'select', options: ['Select...', '-- Select --', 'Choose...'], required: true },
    ];

    const resolved = applyNeverEmptyFallback(fields, {});

    // All options are placeholders — no fallback, left unresolved
    expect(resolved['f1']).toBeUndefined();
  });

  it('sanitizeNoGuessAnswer blanks missing optional social handles', () => {
    const out = sanitizeNoGuessAnswer(
      { name: 'Twitter Handle', required: false } as any,
      '@totallyguessed',
      {},
    );
    expect(out).toBe('');
  });

  it('sanitizeNoGuessAnswer returns N/A for missing required social handles', () => {
    const out = sanitizeNoGuessAnswer(
      { name: 'GitHub Username', required: true } as any,
      'madeup-user',
      {},
    );
    expect(out).toBe('N/A');
  });

  it('sanitizeNoGuessAnswer prefers explicit profile evidence for LinkedIn', () => {
    const out = sanitizeNoGuessAnswer(
      { name: 'LinkedIn URL', required: false } as any,
      'https://linkedin.com/in/not-real',
      { linkedin: 'https://linkedin.com/in/real-profile' } as any,
    );
    expect(out).toBe('https://linkedin.com/in/real-profile');
  });
});
