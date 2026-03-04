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
  if (normalized.length > 24) return false;
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
  if (fieldType === 'checkbox' || fieldType === 'checkbox-group') return 'checkbox';
  if (fieldType === 'text') return 'text';
  return 'unknown';
}

function buildQuestionKey(
  sectionLabel: string,
  promptText: string,
  questionType: QuestionType,
  ordinalCluster: number,
  optionLabels: string[],
): QuestionKey {
  const normalizedSection = normalizeText(sectionLabel) || 'root';
  const normalizedPrompt = normalizeText(promptText) || 'unnamed';
  const optionSignature =
    optionLabels
      .map((label) => normalizeText(label))
      .filter(Boolean)
      .slice(0, 3)
      .join('|') || 'no-options';
  return `${normalizedSection}::${normalizedPrompt}::${questionType}::ord-${ordinalCluster}::${optionSignature}`;
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
    const labels = field.choices?.length ? field.choices : field.options?.length ? field.options : [];
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
    orderIndex,
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
  let groupingConfidence = 1;
  let riskLevel: QuestionRiskLevel = 'none';
  let promptText = field.name || 'Unlabeled question';

  if ((questionType === 'radio' || questionType === 'checkbox') && isShortOptionLabel(promptText)) {
    groupingConfidence = 0.45;
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
    0.4,
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

    if (field.choices?.length && (field.type === 'radio-group' || field.type === 'checkbox-group')) {
      questions.push(
        buildSnapshot(
          [field],
          index,
          field.name || 'Grouped question',
          classifyQuestionType(field.type),
          0.95,
          [],
          'none',
        ),
      );
      continue;
    }

    questions.push(buildSingleFieldSnapshot(field, index));
  }

  return questions;
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
