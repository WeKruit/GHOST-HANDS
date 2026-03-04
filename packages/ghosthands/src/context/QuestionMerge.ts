import type {
  OptionRecord,
  QuestionRecord,
  QuestionSnapshot,
  QuestionState,
  QuestionRiskLevel,
} from './types.js';

const STATE_PRIORITY: Record<QuestionState, number> = {
  verified: 7,
  filled: 6,
  attempted: 5,
  planned: 4,
  uncertain: 3,
  failed: 2,
  skipped: 1,
  empty: 0,
};

const RISK_PRIORITY: Record<QuestionRiskLevel, number> = {
  none: 0,
  low_confidence: 1,
  optional_risky: 2,
  ambiguous_grouping: 3,
  unresolved_required: 4,
};

function mergeOptions(existing: OptionRecord[], incoming: QuestionSnapshot['options']): OptionRecord[] {
  const byKey = new Map<string, OptionRecord>();
  let nextIndex = existing.length;

  for (const option of existing) {
    byKey.set(option.normalizedLabel, option);
  }

  for (const option of incoming) {
    const normalizedLabel = option.label.trim().toLowerCase();
    const current = byKey.get(normalizedLabel);
    if (current) {
      current.selected = current.selected || option.selected === true;
      current.selector = option.selector || current.selector;
      continue;
    }

    byKey.set(normalizedLabel, {
      optionId: crypto.randomUUID(),
      orderIndex: nextIndex++,
      label: option.label,
      normalizedLabel,
      selector: option.selector,
      selected: option.selected === true,
    });
  }

  return [...byKey.values()].sort((a, b) => a.orderIndex - b.orderIndex);
}

export function mergeQuestionSnapshot(
  existing: QuestionRecord | undefined,
  snapshot: QuestionSnapshot,
  now: string,
): QuestionRecord {
  if (!existing) {
    return {
      questionKey: snapshot.questionKey,
      orderIndex: snapshot.orderIndex,
      promptText: snapshot.promptText,
      normalizedPrompt: snapshot.normalizedPrompt,
      sectionLabel: snapshot.sectionLabel,
      questionType: snapshot.questionType,
      required: snapshot.required,
      groupingConfidence: snapshot.groupingConfidence,
      resolutionConfidence: 0,
      riskLevel: snapshot.riskLevel,
      state: 'empty',
      source: 'dom',
      selectors: [...snapshot.selectors],
      options: mergeOptions([], snapshot.options),
      selectedOptions: [],
      attemptCount: 0,
      verificationCount: 0,
      warnings: [...new Set(snapshot.warnings)],
      fieldIds: [...snapshot.fieldIds],
      lastUpdatedAt: now,
    };
  }

  const nextState =
    STATE_PRIORITY[existing.state] >= STATE_PRIORITY['empty']
      ? existing.state
      : 'empty';

  const promptText =
    snapshot.promptText.trim().length > existing.promptText.trim().length
      ? snapshot.promptText
      : existing.promptText;

  const sectionLabel =
    snapshot.sectionLabel && snapshot.sectionLabel.trim().length > 0
      ? snapshot.sectionLabel
      : existing.sectionLabel;

  const selectors = [...existing.selectors];
  for (const selector of snapshot.selectors) {
    if (selector && !selectors.includes(selector)) {
      selectors.unshift(selector);
    }
  }

  const fieldIds = [...existing.fieldIds];
  for (const fieldId of snapshot.fieldIds) {
    if (fieldId && !fieldIds.includes(fieldId)) {
      fieldIds.push(fieldId);
    }
  }

  const warnings = [...existing.warnings];
  for (const warning of snapshot.warnings) {
    if (warning && !warnings.includes(warning)) {
      warnings.push(warning);
    }
  }

  return {
    ...existing,
    orderIndex: Math.min(existing.orderIndex, snapshot.orderIndex),
    promptText,
    normalizedPrompt: snapshot.normalizedPrompt || existing.normalizedPrompt,
    sectionLabel,
    questionType: snapshot.questionType || existing.questionType,
    required: existing.required || snapshot.required,
    groupingConfidence: Math.max(existing.groupingConfidence, snapshot.groupingConfidence),
    riskLevel:
      RISK_PRIORITY[snapshot.riskLevel] > RISK_PRIORITY[existing.riskLevel]
        ? snapshot.riskLevel
        : existing.riskLevel,
    state: nextState,
    selectors,
    options: mergeOptions(existing.options, snapshot.options),
    warnings,
    fieldIds,
    lastUpdatedAt: now,
  };
}

export function mergeQuestionState(
  question: QuestionRecord,
  update: Partial<QuestionRecord>,
): QuestionRecord {
  const next = { ...question, ...update };

  if (update.state && STATE_PRIORITY[update.state] < STATE_PRIORITY[question.state]) {
    next.state = question.state;
  }

  if (
    update.riskLevel &&
    RISK_PRIORITY[update.riskLevel] < RISK_PRIORITY[question.riskLevel]
  ) {
    next.riskLevel = question.riskLevel;
  }

  if (update.selectors) {
    next.selectors = [...new Set([...update.selectors, ...question.selectors])];
  }

  if (update.fieldIds) {
    next.fieldIds = [...new Set([...question.fieldIds, ...update.fieldIds])];
  }

  if (update.warnings) {
    next.warnings = [...new Set([...question.warnings, ...update.warnings])];
  }

  return next;
}
