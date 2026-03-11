import type { Page } from 'playwright';
import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { FieldSnapshot, PageDecisionContext } from './types';
import type {
  AXFieldNode,
  DurableFieldRecord,
  MergedControlProvenance,
  MergedFieldMergeResult,
  MergedFieldState,
  MergedPageObservation,
} from './mergedObserverTypes';

// ordinalIndex is now part of AXFieldNode interface

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function comparableFieldFamily(fieldType: string): string {
  switch (fieldType) {
    case 'text':
    case 'email':
    case 'phone':
    case 'password':
    case 'textarea':
    case 'typeahead':
    case 'contenteditable':
      return 'textual';
    case 'select':
    case 'custom_dropdown':
      return 'select';
    case 'radio':
    case 'aria_radio':
    case 'button_group':
      return 'radio';
    case 'checkbox':
      return 'checkbox';
    case 'number':
    case 'date':
      return fieldType;
    default:
      return fieldType;
  }
}

function areCompatibleFieldTypes(domType: string, axType: string): boolean {
  return domType === axType || comparableFieldFamily(domType) === comparableFieldFamily(axType);
}

function normalizeValue(value: string | null | undefined, fieldType: string): string {
  const normalized = normalizeText(value);

  if (comparableFieldFamily(fieldType) === 'checkbox' || comparableFieldFamily(fieldType) === 'radio') {
    if (['true', 'checked', 'on', 'yes', 'selected', '1'].includes(normalized)) return 'checked';
    if (['false', 'unchecked', 'off', 'no', 'unselected', '0', ''].includes(normalized)) return 'unchecked';
    if (normalized === 'mixed') return 'mixed';
  }

  return normalized;
}

function areValuesEquivalentForSelect(domValue: string | null | undefined, axValue: string | null | undefined): boolean {
  const normalizedDom = normalizeText(domValue);
  const normalizedAx = normalizeText(axValue);

  if (!normalizedDom && !normalizedAx) return true;
  if (!normalizedDom || !normalizedAx) return false;

  return normalizedDom === normalizedAx
    || normalizedDom.includes(normalizedAx)
    || normalizedAx.includes(normalizedDom);
}

function containmentOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  return 0;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function buildDiscrepancy(domField: FieldSnapshot, axField: AXFieldNode): MergedControlProvenance['discrepancy'] | undefined {
  const domValue = normalizeValue(domField.currentValue, domField.fieldType);
  const axValue = normalizeValue(axField.value, axField.inferredFieldType);
  const typeMismatch = !areCompatibleFieldTypes(domField.fieldType, axField.inferredFieldType);
  const selectFamily =
    comparableFieldFamily(domField.fieldType) === 'select'
    || comparableFieldFamily(axField.inferredFieldType) === 'select';
  const valueMismatch = selectFamily
    ? !areValuesEquivalentForSelect(domValue, axValue)
    : domValue !== axValue;

  if (!typeMismatch && !valueMismatch) {
    return undefined;
  }

  return {
    domFieldType: domField.fieldType,
    axFieldType: axField.inferredFieldType,
    domValue: domField.currentValue,
    axValue: axField.value,
    domLabel: domField.label,
    axLabel: axField.name,
  };
}

function classifyResolvedValueState(
  actualValue: string,
  required: boolean,
  durableRecord: DurableFieldRecord | null,
): MergedFieldState {
  const durableExpected = normalizeText(
    durableRecord?.expectedValue ?? durableRecord?.lastCommittedValue ?? '',
  );

  if (durableExpected && durableExpected !== actualValue) {
    return 'stale_context_mismatch';
  }

  if (!actualValue || actualValue === 'unchecked') {
    return required ? 'missing_required' : 'empty';
  }

  return 'valid';
}

export function matchAXToDOMField(
  axField: AXFieldNode,
  domFields: FieldSnapshot[],
  alreadyMatched: Set<string>,
): string | null {
  const axLabel = normalizeText(axField.name);
  const axOrdinal = axField.ordinalIndex;
  const availableFields = domFields.filter((field) => !alreadyMatched.has(field.id));

  const compatibleFields = availableFields.filter((field) =>
    areCompatibleFieldTypes(field.fieldType, axField.inferredFieldType),
  );

  if (typeof axOrdinal === 'number') {
    const ordinalMatch = compatibleFields.find((field) => field.ordinalIndex === axOrdinal);
    if (ordinalMatch) {
      return ordinalMatch.id;
    }
  }

  const exactLabelMatch = compatibleFields.find((field) => normalizeText(field.label) === axLabel);
  if (exactLabelMatch) {
    return exactLabelMatch.id;
  }

  let containmentMatch: FieldSnapshot | null = null;
  let bestContainmentScore = 0;
  for (const field of compatibleFields) {
    const overlap = containmentOverlap(normalizeText(field.label), axLabel);
    if (overlap >= 0.8 && overlap > bestContainmentScore) {
      bestContainmentScore = overlap;
      containmentMatch = field;
    }
  }
  if (containmentMatch) {
    return containmentMatch.id;
  }

  let fuzzyMatch: FieldSnapshot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const field of compatibleFields) {
    const distance = levenshteinDistance(normalizeText(field.label), axLabel);
    if (distance <= 3 && distance < bestDistance) {
      bestDistance = distance;
      fuzzyMatch = field;
    }
  }
  if (fuzzyMatch) {
    return fuzzyMatch.id;
  }

  if (typeof axOrdinal === 'number') {
    let nearestMatch: FieldSnapshot | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const field of compatibleFields) {
      const distance = Math.abs(field.ordinalIndex - axOrdinal);
      if (distance <= 1 && distance < nearestDistance) {
        nearestDistance = distance;
        nearestMatch = field;
      }
    }
    if (nearestMatch) {
      return nearestMatch.id;
    }
  }

  return null;
}

export function classifyMergedState(
  domField: FieldSnapshot,
  axField: AXFieldNode | null,
  durableRecord: DurableFieldRecord | null,
): MergedFieldState {
  if (axField && !areCompatibleFieldTypes(domField.fieldType, axField.inferredFieldType)) {
    return 'ambiguous_observer_mismatch';
  }

  if (axField) {
    const domValue = normalizeValue(domField.currentValue, domField.fieldType);
    const axValue = normalizeValue(axField.value, axField.inferredFieldType);
    const selectFamily =
      comparableFieldFamily(domField.fieldType) === 'select'
      || comparableFieldFamily(axField.inferredFieldType) === 'select';
    const valuesMatch = selectFamily
      ? areValuesEquivalentForSelect(domValue, axValue)
      : domValue === axValue;
    if (!valuesMatch) {
      return 'ambiguous_observer_mismatch';
    }
  }

  return classifyResolvedValueState(
    normalizeValue(domField.currentValue, domField.fieldType),
    domField.isRequired || axField?.required === true,
    durableRecord,
  );
}

export function stableFieldKey(field: FieldSnapshot): string {
  return `${field.fieldType}:${field.ordinalIndex}:${hashString(field.selector)}`;
}

export async function mergeObservations(
  domSnapshot: PageDecisionContext,
  axFields: AXFieldNode[],
  durableContext: Map<string, DurableFieldRecord>,
  tiebreakerFn?: (
    page: Page,
    adapter: BrowserAutomationAdapter,
    field: FieldSnapshot,
    axField: AXFieldNode,
  ) => Promise<{
    fieldType: string;
    currentValue: string;
    label: string;
    confidence: number;
  }>,
  /** Page instance for tiebreaker — required when tiebreakerFn is provided */
  page?: Page,
  /** Adapter instance for tiebreaker — required when tiebreakerFn is provided */
  adapter?: BrowserAutomationAdapter,
): Promise<MergedPageObservation> {
  const startedAt = Date.now();
  const matchedDomIds = new Set<string>();
  const matchedAxIndices = new Set<number>();
  const matchedAxByDomId = new Map<string, AXFieldNode>();
  const fieldMergeResults = new Map<string, MergedFieldMergeResult>();

  axFields.forEach((field, index) => {
    if (typeof field.ordinalIndex !== 'number') {
      (field as { ordinalIndex: number }).ordinalIndex = index;
    }
    const domFieldId = matchAXToDOMField(field, domSnapshot.fields, matchedDomIds);
    if (domFieldId) {
      matchedDomIds.add(domFieldId);
      matchedAxIndices.add(index);
      matchedAxByDomId.set(domFieldId, field);
    }
  });

  const domOnlyFieldIds: string[] = [];

  for (const domField of domSnapshot.fields) {
    const axField = matchedAxByDomId.get(domField.id) ?? null;
    const fieldKey = stableFieldKey(domField);
    const durableRecord = durableContext.get(fieldKey) ?? null;
    const discrepancy = axField ? buildDiscrepancy(domField, axField) : undefined;
    const provenance: MergedControlProvenance = axField
      ? {
          sources: ['dom', 'ax'],
          concordant: discrepancy ? false : true,
          ...(discrepancy ? { discrepancy } : {}),
        }
      : {
          sources: ['dom'],
          concordant: null,
        };

    const mergedState = classifyMergedState(domField, axField, durableRecord);
    const result: MergedFieldMergeResult = {
      fieldKey,
      domField,
      axField,
      provenance,
      mergedState,
      resolvedValue: domField.currentValue,
      resolvedLabel: (axField?.name || domField.label || '').trim(),
      resolvedRequired: domField.isRequired || axField?.required === true,
    };

    if (!axField) {
      domOnlyFieldIds.push(domField.id);
    }

    fieldMergeResults.set(fieldKey, result);
  }

  let stagehandInvoked = false;

  if (tiebreakerFn) {
    const disagreements = Array.from(fieldMergeResults.values()).filter(
      (result) =>
        result.domField &&
        result.axField &&
        result.resolvedRequired &&
        result.mergedState === 'ambiguous_observer_mismatch',
    ).slice(0, 3);

    for (const disagreement of disagreements) {
      try {
        if (!page || !adapter) {
          break; // Cannot invoke tiebreaker without page and adapter
        }
        const verdict = await tiebreakerFn(
          page,
          adapter,
          disagreement.domField!,
          disagreement.axField!,
        );
        stagehandInvoked = true;
        if (!disagreement.provenance.sources.includes('stagehand')) {
          disagreement.provenance.sources.push('stagehand');
        }
        disagreement.provenance.stagehandVerdict = verdict;
        disagreement.resolvedValue = verdict.currentValue;
        disagreement.resolvedLabel = (verdict.label || disagreement.resolvedLabel).trim();

        const verdictValue = normalizeValue(
          verdict.currentValue,
          verdict.fieldType || disagreement.domField!.fieldType,
        );
        disagreement.mergedState = classifyResolvedValueState(
          verdictValue,
          disagreement.resolvedRequired,
          durableContext.get(disagreement.fieldKey) ?? null,
        );
      } catch {
        disagreement.mergedState = 'ambiguous_observer_mismatch';
      }
    }
  }

  const axOnlyFields = axFields.filter((_, index) => !matchedAxIndices.has(index));
  const hasDisagreements = Array.from(fieldMergeResults.values()).some(
    (result) => result.mergedState === 'ambiguous_observer_mismatch',
  );

  const domCoverage =
    domSnapshot.fields.length === 0
      ? (axFields.length === 0 ? 1 : 0.75)
      : (domSnapshot.fields.length - domOnlyFieldIds.length) / domSnapshot.fields.length;
  const axCoverage =
    axFields.length === 0
      ? 0.5
      : (axFields.length - axOnlyFields.length) / axFields.length;
  const observationConfidence = Math.max(
    0,
    Math.min(
      1,
      (domSnapshot.observationConfidence + domCoverage + axCoverage) / 3 +
        (stagehandInvoked ? 0.05 : 0),
    ),
  );

  return {
    snapshot: {
      ...domSnapshot,
      observationConfidence,
    },
    axFields,
    fieldMergeResults,
    axOnlyFields,
    domOnlyFieldIds,
    observationConfidence,
    hasDisagreements,
    stagehandInvoked,
    observationDurationMs: Date.now() - startedAt,
  };
}
