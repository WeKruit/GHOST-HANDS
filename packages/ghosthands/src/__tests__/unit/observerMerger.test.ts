import { describe, expect, it } from 'vitest';
import {
  classifyMergedState,
  matchAXToDOMField,
  mergeObservations,
  stableFieldKey,
} from '../../engine/decision/observerMerger.js';
import type { AXFieldNode, DurableFieldRecord } from '../../engine/decision/mergedObserverTypes.js';
import type { FieldSnapshot, PageDecisionContext } from '../../engine/decision/types.js';

function makeField(overrides: Partial<FieldSnapshot> = {}): FieldSnapshot {
  return {
    id: overrides.id ?? 'field-0',
    selector: overrides.selector ?? '#field-0',
    label: overrides.label ?? 'Field 0',
    fieldType: overrides.fieldType ?? 'text',
    ordinalIndex: overrides.ordinalIndex ?? 0,
    isRequired: overrides.isRequired ?? false,
    isVisible: overrides.isVisible ?? true,
    isDisabled: overrides.isDisabled ?? false,
    isEmpty: overrides.isEmpty ?? !(overrides.currentValue ?? ''),
    currentValue: overrides.currentValue ?? '',
    options: overrides.options,
    groupKey: overrides.groupKey,
  };
}

function makeAXField(overrides: Partial<AXFieldNode> = {}): AXFieldNode {
  return {
    role: overrides.role ?? 'textbox',
    name: overrides.name ?? 'Field 0',
    description: overrides.description ?? '',
    value: overrides.value ?? '',
    required: overrides.required ?? false,
    disabled: overrides.disabled ?? false,
    focused: overrides.focused ?? false,
    options: overrides.options ?? [],
    expanded: overrides.expanded ?? null,
    checked: overrides.checked ?? null,
    inferredFieldType: overrides.inferredFieldType ?? 'text',
    depth: overrides.depth ?? 1,
    sectionName: overrides.sectionName ?? null,
    ordinalIndex: overrides.ordinalIndex ?? 0,
  };
}

function makeSnapshot(fields: FieldSnapshot[]): PageDecisionContext {
  return {
    url: 'https://example.com/apply',
    title: 'Apply',
    platform: 'generic',
    pageType: 'form',
    headings: ['Apply'],
    fields,
    buttons: [],
    stepContext: null,
    repeaters: [],
    fingerprint: {
      heading: 'Apply',
      fieldCount: fields.length,
      filledCount: fields.filter((field) => !field.isEmpty).length,
      activeStep: 'Step 1',
      hash: 'abc123',
    },
    blocker: {
      detected: false,
      type: null,
      confidence: 0,
    },
    actionHistory: [],
    guardrailHints: [],
    observationConfidence: 0.9,
    observedAt: 1_742_000_000_000,
  };
}

describe('matchAXToDOMField', () => {
  it('prefers ordinal matches before label heuristics', () => {
    const domFields = [
      makeField({
        id: 'dom-0',
        selector: '#country',
        label: 'Country',
        fieldType: 'select',
        ordinalIndex: 0,
      }),
      makeField({
        id: 'dom-1',
        selector: '#state',
        label: 'State',
        fieldType: 'select',
        ordinalIndex: 1,
      }),
    ];
    const axField = makeAXField({
      name: 'Province / State',
      value: '',
      inferredFieldType: 'custom_dropdown',
      ordinalIndex: 1,
    });

    expect(matchAXToDOMField(axField, domFields, new Set())).toBe('dom-1');
  });
});

describe('classifyMergedState', () => {
  it('returns valid when DOM and AX are concordant', () => {
    const domField = makeField({
      fieldType: 'select',
      label: 'State',
      currentValue: 'California',
      isEmpty: false,
      isRequired: true,
    });
    const axField = makeAXField({
      role: 'combobox',
      name: 'State',
      value: 'California',
      required: true,
      inferredFieldType: 'custom_dropdown',
    });

    expect(classifyMergedState(domField, axField, null)).toBe('valid');
  });

  it('returns ambiguous_observer_mismatch when DOM and AX disagree', () => {
    const domField = makeField({
      fieldType: 'select',
      label: 'State',
      currentValue: 'California',
      isEmpty: false,
      isRequired: true,
    });
    const axField = makeAXField({
      role: 'combobox',
      name: 'State',
      value: 'Texas',
      required: true,
      inferredFieldType: 'custom_dropdown',
    });

    expect(classifyMergedState(domField, axField, null)).toBe('ambiguous_observer_mismatch');
  });
});

describe('stableFieldKey', () => {
  it('is deterministic for the same field and changes with selector/ordinal', () => {
    const field = makeField({
      id: 'dom-0',
      selector: '#email',
      label: 'Email',
      fieldType: 'email',
      ordinalIndex: 2,
    });

    expect(stableFieldKey(field)).toBe(stableFieldKey({ ...field }));
    expect(stableFieldKey(field)).not.toBe(
      stableFieldKey({ ...field, selector: '#email-confirm' }),
    );
    expect(stableFieldKey(field)).not.toBe(
      stableFieldKey({ ...field, ordinalIndex: 3 }),
    );
  });
});

describe('mergeObservations', () => {
  it('merges DOM and AX fields into concordant, dom-only, and ax-only buckets', async () => {
    const firstName = makeField({
      id: 'dom-first',
      selector: '#first-name',
      label: 'First Name',
      fieldType: 'text',
      ordinalIndex: 0,
      currentValue: 'Ada',
      isEmpty: false,
    });
    const state = makeField({
      id: 'dom-state',
      selector: '#state',
      label: 'State',
      fieldType: 'select',
      ordinalIndex: 1,
      currentValue: 'California',
      isEmpty: false,
      isRequired: true,
      options: ['California', 'Texas'],
    });
    const email = makeField({
      id: 'dom-email',
      selector: '#email',
      label: 'Email',
      fieldType: 'email',
      ordinalIndex: 2,
      currentValue: '',
      isEmpty: true,
      isRequired: false,
    });

    const durableRecord: DurableFieldRecord = {
      fieldKey: stableFieldKey(state),
      lastMergedState: 'valid',
      lastProvenance: { sources: ['dom', 'ax'], concordant: true },
      lastActor: 'dom',
      lastActorTimestamp: '2026-03-11T12:00:00.000Z',
      fillAttemptCount: 1,
      magnitudeAttemptCount: 0,
      lastCommittedValue: 'California',
      expectedValue: 'California',
      sectionFingerprint: 'sec-1',
      stateHistory: [],
    };

    const observation = await mergeObservations(
      makeSnapshot([firstName, state, email]),
      [
        makeAXField({
          role: 'textbox',
          name: 'First Name',
          value: 'Ada',
          inferredFieldType: 'text',
          ordinalIndex: 0,
        }),
        makeAXField({
          role: 'combobox',
          name: 'State',
          value: 'California',
          required: true,
          inferredFieldType: 'custom_dropdown',
          options: ['California', 'Texas'],
          ordinalIndex: 1,
        }),
        makeAXField({
          role: 'combobox',
          name: 'Work Authorization',
          value: 'Yes',
          required: true,
          inferredFieldType: 'custom_dropdown',
          options: ['Yes', 'No'],
          ordinalIndex: 7,
        }),
      ],
      new Map([[stableFieldKey(state), durableRecord]]),
    );

    const firstNameMerge = observation.fieldMergeResults.get(stableFieldKey(firstName));
    const stateMerge = observation.fieldMergeResults.get(stableFieldKey(state));
    const emailMerge = observation.fieldMergeResults.get(stableFieldKey(email));

    expect(firstNameMerge?.provenance.concordant).toBe(true);
    expect(firstNameMerge?.resolvedLabel).toBe('First Name');

    expect(stateMerge?.mergedState).toBe('valid');
    expect(stateMerge?.provenance.sources).toEqual(['dom', 'ax']);
    expect(stateMerge?.resolvedRequired).toBe(true);

    expect(emailMerge?.provenance.sources).toEqual(['dom']);
    expect(observation.domOnlyFieldIds).toEqual(['dom-email']);

    expect(observation.axOnlyFields).toHaveLength(1);
    expect(observation.axOnlyFields[0]?.name).toBe('Work Authorization');
    expect(observation.hasDisagreements).toBe(false);
    expect(observation.stagehandInvoked).toBe(false);
  });
});
