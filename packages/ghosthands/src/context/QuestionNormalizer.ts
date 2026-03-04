import type {
  AnswerDecision,
  QuestionKey,
  QuestionSnapshot,
  QuestionType,
  QuestionRiskLevel,
} from './types.js';

export interface QuestionNormalizerField {
  id: string;
  name: string;
  type: string;
  section: string;
  required: boolean;
  options?: string[];
  choices?: string[];
}

const MAX_SHORT_OPTION_LABEL_LENGTH = 24;
const DEFAULT_GROUPING_CONFIDENCE = 1;
const GROUPED_CONTROL_CONFIDENCE = 0.95;
const AMBIGUOUS_SINGLE_OPTION_CONFIDENCE = 0.45;
const AMBIGUOUS_CLUSTER_CONFIDENCE = 0.4;

function normalizeText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortOptionLabel(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (normalized.length > MAX_SHORT_OPTION_LABEL_LENGTH) return false;
  return /^(yes|no|n\/a|na|prefer not to say|decline|male|female|other|true|false)$/i.test(
    normalized,
  );
}

function classifyQuestionType(fieldType: string): QuestionType {
  if (fieldType === 'textarea') return 'textarea';
  if (fieldType === 'email') return 'email';
  if (fieldType === 'tel') return 'tel';
  if (fieldType === 'url') return 'url';
  if (fieldType === 'number') return 'number';
  if (fieldType === 'date') return 'date';
  if (fieldType === 'file') return 'file';
  if (fieldType === 'select') return 'select';
  if (fieldType === 'radio' || fieldType === 'radio-group') return 'radio';
  if (fieldType === 'button-group') return 'radio';
  if (fieldType === 'checkbox' || fieldType === 'checkbox-group') return 'checkbox';
  if (fieldType === 'text') return 'text';
  return 'unknown';
}

function buildQuestionKey(
  sectionLabel: string,
  promptText: string,
  questionType: QuestionType,
  optionLabels: string[],
  ordinal?: number,
): QuestionKey {
  const normalizedSection = normalizeText(sectionLabel) || 'root';
  const normalizedPrompt = normalizeText(promptText) || 'unnamed';
  const optionSignature =
    optionLabels
      .map((label) => normalizeText(label))
      .filter(Boolean)
      .slice(0, 3)
      .join('|') || 'no-options';
  const base = `${normalizedSection}::${normalizedPrompt}::${questionType}::${optionSignature}`;
  return ordinal && ordinal > 0 ? `${base}::${ordinal}` : base;
}

function buildSnapshot(
  fields: QuestionNormalizerField[],
  orderIndex: number,
  promptText: string,
  questionType: QuestionType,
  groupingConfidence: number,
  warnings: string[],
  riskLevel: QuestionRiskLevel,
): QuestionSnapshot {
  const fieldIds = fields.map((field) => field.id);
  const sectionLabel = fields.find((field) => field.section)?.section || '';
  const optionLabels = new Set<string>();
  const options: QuestionSnapshot['options'] = [];

  for (const field of fields) {
    const labels =
      field.choices?.length
        ? field.choices
        : field.options?.length
          ? field.options
          : fields.length > 1 && (field.type === 'radio' || field.type === 'checkbox')
            ? [field.name]
            : [];
    for (const label of labels) {
      if (!label || optionLabels.has(label)) continue;
      optionLabels.add(label);
      options.push({ label });
    }
  }

  const questionKey = buildQuestionKey(
    sectionLabel,
    promptText,
    questionType,
    options.map((option) => option.label),
  );

  return {
    questionKey,
    orderIndex,
    promptText,
    normalizedPrompt: normalizeText(promptText),
    sectionLabel: sectionLabel || undefined,
    questionType,
    required: fields.some((field) => field.required),
    groupingConfidence,
    riskLevel,
    warnings,
    fieldIds,
    selectors: [],
    options,
  };
}

function buildSingleFieldSnapshot(
  field: QuestionNormalizerField,
  orderIndex: number,
): QuestionSnapshot {
  const questionType = classifyQuestionType(field.type);
  const warnings: string[] = [];
  let groupingConfidence = DEFAULT_GROUPING_CONFIDENCE;
  let riskLevel: QuestionRiskLevel = 'none';
  let promptText = field.name || 'Unlabeled question';

  if ((questionType === 'radio' || questionType === 'checkbox') && isShortOptionLabel(promptText)) {
    groupingConfidence = AMBIGUOUS_SINGLE_OPTION_CONFIDENCE;
    riskLevel = 'ambiguous_grouping';
    warnings.push('ambiguous_prompt_anchor');
  }

  return buildSnapshot(
    [field],
    orderIndex,
    promptText,
    questionType,
    groupingConfidence,
    warnings,
    riskLevel,
  );
}

function consumeAmbiguousOptionCluster(
  fields: QuestionNormalizerField[],
  startIndex: number,
): { snapshot: QuestionSnapshot; nextIndex: number } | null {
  const first = fields[startIndex];
  if (!first) return null;
  if (!(first.type === 'radio' || first.type === 'checkbox')) return null;
  if (!isShortOptionLabel(first.name)) return null;

  const cluster: QuestionNormalizerField[] = [first];
  let nextIndex = startIndex + 1;
  while (nextIndex < fields.length) {
    const candidate = fields[nextIndex];
    if (!candidate) break;
    if (candidate.section !== first.section) break;
    if (candidate.type !== first.type) break;
    if (!isShortOptionLabel(candidate.name)) break;
    cluster.push(candidate);
    nextIndex++;
  }

  if (cluster.length < 2) return null;

  const promptText = `${first.section || 'Question'} options`;
  const snapshot = buildSnapshot(
    cluster,
    startIndex,
    promptText,
    first.type === 'checkbox' ? 'checkbox' : 'radio',
    AMBIGUOUS_CLUSTER_CONFIDENCE,
    ['ambiguous_prompt_anchor'],
    'ambiguous_grouping',
  );

  snapshot.options = cluster.map((field, idx) => ({
    label: field.name,
    selector: undefined,
    selected: false,
  }));

  return { snapshot, nextIndex };
}

export function normalizeExtractedQuestions(
  fields: QuestionNormalizerField[],
): QuestionSnapshot[] {
  const questions: QuestionSnapshot[] = [];

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;

    const clustered = consumeAmbiguousOptionCluster(fields, index);
    if (clustered) {
      questions.push(clustered.snapshot);
      index = clustered.nextIndex - 1;
      continue;
    }

    if (field.choices?.length && (field.type === 'radio-group' || field.type === 'checkbox-group' || field.type === 'button-group')) {
      questions.push(
        buildSnapshot(
          [field],
          index,
          field.name || 'Grouped question',
          classifyQuestionType(field.type),
          GROUPED_CONTROL_CONFIDENCE,
          [],
          'none',
        ),
      );
      continue;
    }

    questions.push(buildSingleFieldSnapshot(field, index));
  }

  return deduplicateQuestionKeys(questions);
}

function deduplicateQuestionKeys(questions: QuestionSnapshot[]): QuestionSnapshot[] {
  const keyCounts = new Map<string, number>();
  for (const q of questions) {
    keyCounts.set(q.questionKey, (keyCounts.get(q.questionKey) || 0) + 1);
  }
  // Only process keys that appear more than once
  const ordinals = new Map<string, number>();
  return questions.map((q) => {
    if ((keyCounts.get(q.questionKey) || 0) <= 1) return q;
    const ordinal = ordinals.get(q.questionKey) || 0;
    ordinals.set(q.questionKey, ordinal + 1);
    return { ...q, questionKey: `${q.questionKey}::${ordinal}` };
  });
}

export function buildAnswerDecisionsFromFieldAnswers(
  questions: QuestionSnapshot[],
  fieldIdToAnswer: Record<string, string>,
  source: AnswerDecision['source'],
): AnswerDecision[] {
  const decisions: AnswerDecision[] = [];

  for (const question of questions) {
    const answer = question.fieldIds
      .map((fieldId) => fieldIdToAnswer[fieldId])
      .find((value) => typeof value === 'string' && value.length > 0);
    if (!answer) continue;

    decisions.push({
      questionKey: question.questionKey,
      answer,
      confidence: question.groupingConfidence,
      source,
    });
  }

  return decisions;
}

export interface NormalizedQuestionDraft {
  promptText: string;
  questionType: string;
  required: boolean;
  fieldIds: string[];
  options: string[];
  groupingConfidence: number;
  warnings: string[];
}

export function reconcileNormalizedQuestions(
  heuristicSnapshots: QuestionSnapshot[],
  llmDrafts: NormalizedQuestionDraft[],
  liveFields: QuestionNormalizerField[],
): QuestionSnapshot[] {
  const liveFieldIds = new Set(liveFields.map((f) => f.id));
  const liveFieldMap = new Map(liveFields.map((f) => [f.id, f]));
  const coveredFieldIds = new Set<string>();
  const results: QuestionSnapshot[] = [];
  let orderIndex = 0;

  for (const draft of llmDrafts) {
    const duplicateFieldIds = draft.fieldIds.filter((id) => coveredFieldIds.has(id));
    const validFieldIds = draft.fieldIds.filter((id) => liveFieldIds.has(id) && !coveredFieldIds.has(id));
    const invalidCount = draft.fieldIds.length - validFieldIds.length - duplicateFieldIds.length;

    if (validFieldIds.length === 0) {
      continue;
    }

    const warnings = [...draft.warnings];
    if (invalidCount > 0) {
      warnings.push('invalid_field_ids_discarded');
    }
    if (duplicateFieldIds.length > 0) {
      warnings.push('duplicate_field_id_skipped');
    }

    const fields = validFieldIds
      .map((id) => liveFieldMap.get(id))
      .filter((f): f is QuestionNormalizerField => f !== undefined);

    const questionType = classifyQuestionType(draft.questionType);
    const snapshot = buildSnapshot(
      fields,
      orderIndex++,
      draft.promptText,
      questionType,
      draft.groupingConfidence,
      warnings,
      'none',
    );
    // LLM required flag takes precedence over heuristic extraction
    if (draft.required && !snapshot.required) {
      snapshot.required = true;
    }

    for (const id of validFieldIds) {
      coveredFieldIds.add(id);
    }

    results.push(snapshot);
  }

  const uncoveredFieldIds = [...liveFieldIds].filter((id) => !coveredFieldIds.has(id));

  for (const fieldId of uncoveredFieldIds) {
    const heuristicMatch = heuristicSnapshots.find((s) => s.fieldIds.includes(fieldId));

    if (heuristicMatch) {
      const uncoveredFromHeuristic = heuristicMatch.fieldIds.filter(
        (id) => !coveredFieldIds.has(id) && liveFieldIds.has(id),
      );
      if (uncoveredFromHeuristic.length === 0) continue;

      const fields = uncoveredFromHeuristic
        .map((id) => liveFieldMap.get(id))
        .filter((f): f is QuestionNormalizerField => f !== undefined);

      const snapshot = buildSnapshot(
        fields,
        orderIndex++,
        heuristicMatch.promptText,
        heuristicMatch.questionType,
        heuristicMatch.groupingConfidence,
        [...heuristicMatch.warnings],
        heuristicMatch.riskLevel,
      );

      for (const id of uncoveredFromHeuristic) {
        coveredFieldIds.add(id);
      }

      results.push(snapshot);
    } else {
      const field = liveFieldMap.get(fieldId);
      if (!field) continue;

      const snapshot = buildSingleFieldSnapshot(field, orderIndex++);
      snapshot.warnings.push('llm_omitted_fallback');
      coveredFieldIds.add(fieldId);
      results.push(snapshot);
    }
  }

  results.sort((a, b) => a.orderIndex - b.orderIndex);
  return results;
}
