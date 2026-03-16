# Merged Observer + Durable Context: Architectural Contracts

**Status:** DEFINE phase output -- ready for implementation
**Date:** 2026-03-11
**Scope:** Type definitions, AX tree extraction, observer merge, durable context wiring, Magnitude gating

---

## Table of Contents

1. [Layer 1: New Type Definitions](#layer-1-new-type-definitions)
2. [Layer 2: AX Tree Extraction Strategy](#layer-2-ax-tree-extraction-strategy)
3. [Layer 3: Observer Merge Algorithm](#layer-3-observer-merge-algorithm)
4. [Layer 4: Durable Context Wiring](#layer-4-durable-context-wiring)
5. [Layer 5: Magnitude Gate Contract](#layer-5-magnitude-gate-contract)
6. [Layer 6: Select/Dropdown State Model](#layer-6-selectdropdown-state-model)
7. [File Change Summary](#file-change-summary)

---

## Layer 1: New Type Definitions

### File: `packages/ghosthands/src/engine/decision/mergedObserverTypes.ts` (NEW)

This is a new file. All merged-observer types live here to avoid polluting the existing
`decision/types.ts` (Zod schemas for workflow state) or `context/types.ts` (durable context).

```typescript
// ── Provenance ───────────────────────────────────────────────

/**
 * Which observer(s) independently discovered this control.
 * A field seen by both DOM and AX has provenance ['dom', 'ax'].
 * When Stagehand is invoked as tiebreaker, it gets added.
 */
export type ObserverSource = 'dom' | 'ax' | 'stagehand';

export interface MergedControlProvenance {
  /** Which observers saw this control (at least one entry). */
  sources: ObserverSource[];

  /**
   * True when DOM and AX agree on field type AND current value.
   * False when they disagree on either. null when only one observer saw the field.
   */
  concordant: boolean | null;

  /**
   * When concordant is false, describes the nature of the disagreement.
   * Only populated on mismatch.
   */
  discrepancy?: {
    domFieldType?: string;
    axFieldType?: string;
    domValue?: string;
    axValue?: string;
    domLabel?: string;
    axLabel?: string;
  };

  /** If Stagehand was invoked as tiebreaker, its verdict. */
  stagehandVerdict?: {
    fieldType: string;
    currentValue: string;
    label: string;
    confidence: number;
  };
}


// ── Merged Field State ───────────────────────────────────────

/**
 * Extended field state that includes observer-level disagreements.
 * Superset of the existing FieldContextState in formFiller.ts.
 */
export type MergedFieldState =
  | 'valid'                        // Both observers agree field has correct value
  | 'empty'                        // Field exists, no value
  | 'missing_required'             // Required field with no value
  | 'invalid_after_fill'           // Value was written but post-fill verification failed
  | 'ambiguous_observer_mismatch'  // DOM and AX disagree on value or type
  | 'stale_context_mismatch'       // Durable context has a value but DOM shows different
  | 'wrong_value'                  // Has a value but it's incorrect per profile
  | 'skipped_optional'             // Optional field intentionally left empty
  | 'pending_stagehand'            // Awaiting Stagehand tiebreaker
  | 'unresolvable';                // All tiers failed, no further escalation possible


// ── AX Field Node ────────────────────────────────────────────

/**
 * A single interactive field extracted from the Playwright accessibility tree.
 * This is the AX-side analog of FieldSnapshot (DOM-side).
 */
export interface AXFieldNode {
  /** Accessibility role (e.g. 'textbox', 'combobox', 'checkbox', 'radio', 'spinbutton') */
  role: string;

  /** Accessible name (computed from aria-label, label association, content) */
  name: string;

  /** Accessible description (aria-describedby, title attribute) */
  description: string;

  /** Current value as reported by the accessibility tree */
  value: string;

  /** Whether the node is marked required (aria-required) */
  required: boolean;

  /** Whether the node is disabled */
  disabled: boolean;

  /** Whether the node is focused */
  focused: boolean;

  /**
   * For combobox/listbox: the available options visible in the AX tree.
   * May be incomplete for virtualized lists.
   */
  options: string[];

  /** Whether a combobox/listbox has an expanded popup */
  expanded: boolean | null;

  /**
   * Checked state for checkboxes/radios.
   * 'true' | 'false' | 'mixed' | null (non-checkbox)
   */
  checked: string | null;

  /**
   * The mapped FieldType after normalization.
   * Derived from AX role -> FieldType mapping.
   */
  inferredFieldType: import('../v3/v2types').FieldType;

  /**
   * Depth in the AX tree (0 = root). Used for section grouping.
   */
  depth: number;

  /**
   * The nearest ancestor with role 'group' or 'region', used for section inference.
   */
  sectionName: string | null;
}


// ── Durable Field Record ─────────────────────────────────────

/**
 * What the durable PageContextService stores per stable field key.
 * This extends QuestionRecord with cross-observation provenance.
 * It is NOT a replacement for QuestionRecord -- it is an enrichment
 * layer that rides alongside QuestionRecord in PageContextService.
 */
export interface DurableFieldRecord {
  /** Stable field key (same as QuestionRecord.questionKey) */
  fieldKey: string;

  /** The merged observation state after last observation cycle */
  lastMergedState: MergedFieldState;

  /** Provenance from the last observation cycle */
  lastProvenance: MergedControlProvenance;

  /** Which actor last modified this field ('dom' | 'stagehand' | 'magnitude' | 'human') */
  lastActor: 'dom' | 'stagehand' | 'magnitude' | 'human' | null;

  /** Timestamp of last actor's modification */
  lastActorTimestamp: string | null;

  /** How many times fill has been attempted on this field */
  fillAttemptCount: number;

  /** How many times Magnitude specifically has been invoked for this field */
  magnitudeAttemptCount: number;

  /** The value that was last committed (after verification) */
  lastCommittedValue: string | null;

  /** The value durable context expected (from profile/LLM answer) */
  expectedValue: string | null;

  /**
   * Section fingerprint: a stable hash of the section heading + field order
   * within that section. Used to detect when the DOM has restructured (e.g.
   * repeater expansion) without a full page navigation.
   */
  sectionFingerprint: string | null;

  /** History of state transitions (capped at last 5) */
  stateHistory: Array<{
    from: MergedFieldState;
    to: MergedFieldState;
    actor: string;
    timestamp: string;
  }>;
}


// ── Merged Page Observation ──────────────────────────────────

/**
 * The unified output of the merged observer pipeline.
 * Produced by PageSnapshotBuilder.buildMergedSnapshot().
 * Consumed by DecisionLoopRunner and formFiller.
 */
export interface MergedPageObservation {
  /** Standard PageDecisionContext (unchanged, for LLM consumption) */
  snapshot: import('./types').PageDecisionContext;

  /** AX-extracted fields (raw, before merge) */
  axFields: AXFieldNode[];

  /** Per-field merge results keyed by stable field key */
  fieldMergeResults: Map<string, MergedFieldMergeResult>;

  /** Fields that only AX saw (not in DOM scan) */
  axOnlyFields: AXFieldNode[];

  /** Fields that only DOM saw (not in AX tree) */
  domOnlyFieldIds: string[];

  /** Overall observation confidence (0-1) */
  observationConfidence: number;

  /** Whether any field has ambiguous_observer_mismatch */
  hasDisagreements: boolean;

  /** Whether Stagehand was invoked as tiebreaker */
  stagehandInvoked: boolean;

  /** Wall-clock time for the merged observation (ms) */
  observationDurationMs: number;
}

export interface MergedFieldMergeResult {
  /** Stable field key */
  fieldKey: string;

  /** The DOM-side FieldSnapshot (null if AX-only) */
  domField: import('./types').FieldSnapshot | null;

  /** The AX-side AXFieldNode (null if DOM-only) */
  axField: AXFieldNode | null;

  /** Provenance record */
  provenance: MergedControlProvenance;

  /** Merged state after comparing DOM + AX + durable context */
  mergedState: MergedFieldState;

  /**
   * The "best" current value after merge.
   * When observers agree: the shared value.
   * When they disagree: Stagehand verdict if available, else DOM value (DOM is source of truth for fills).
   */
  resolvedValue: string;

  /**
   * The "best" label after merge.
   * Prefers AX name (more semantically correct) over DOM label when both exist.
   */
  resolvedLabel: string;

  /** Merged required flag (true if either observer says required) */
  resolvedRequired: boolean;
}


// ── Select State Model ───────────────────────────────────────

/**
 * Generic select/dropdown state model that consolidates the 6+ duplicated
 * dropdown implementations. Used for both native <select> and custom dropdowns.
 */
export interface SelectStateModel {
  /** Stable field key for the select control */
  fieldKey: string;

  /** Whether this is a native <select> or custom dropdown/combobox */
  variant: 'native_select' | 'custom_dropdown' | 'typeahead' | 'aria_listbox' | 'button_group';

  /** All discovered options */
  options: SelectOption[];

  /** Currently selected option(s) */
  selectedOptions: string[];

  /** Whether multiple selection is supported */
  isMultiSelect: boolean;

  /** Whether the dropdown is currently expanded */
  isExpanded: boolean;

  /** The trigger element selector (what you click to open) */
  triggerSelector: string;

  /** The listbox/menu container selector (where options appear) */
  listboxSelector: string | null;

  /** Whether options are virtualized (only partially in DOM) */
  isVirtualized: boolean;

  /** Last time options were discovered */
  discoveredAt: number;
}

export interface SelectOption {
  /** Display text */
  label: string;

  /** Normalized label for fuzzy matching */
  normalizedLabel: string;

  /** The value attribute (for native select) or data attribute */
  value: string;

  /** Whether this is a placeholder/default option */
  isPlaceholder: boolean;

  /** Whether this option is disabled */
  disabled: boolean;

  /** For hierarchical options: full path (e.g. "Category > SubOption") */
  hierarchyPath: string | null;

  /** Selector to click this specific option (for custom dropdowns) */
  optionSelector: string | null;
}
```

### File: `packages/ghosthands/src/context/types.ts` (MODIFY)

Extend `QuestionRecord` with three new optional fields. These are additive -- no existing
fields change, no existing consumers break.

```typescript
// Add to QuestionRecord interface (after line 138, before closing brace):

  /**
   * Which actor last modified this field.
   * Added by merged observer; null for legacy flows.
   */
  lastActor?: 'dom' | 'stagehand' | 'magnitude' | 'human' | null;

  /**
   * Stable hash of the section heading + field order within that section.
   * Used to detect DOM restructuring (repeater expansion) without full navigation.
   */
  sectionFingerprint?: string | null;

  /**
   * Provenance from the merged observer (which observation systems saw this field).
   * Only present when the merged observer pipeline is active.
   */
  observerProvenance?: {
    sources: Array<'dom' | 'ax' | 'stagehand'>;
    concordant: boolean | null;
  };
```

These three fields are optional to maintain backward compatibility with the existing
`PageContextReducer`, `QuestionMerge`, and `NoopPageContextService` code paths.

---

## Layer 2: AX Tree Extraction Strategy

### File: `packages/ghosthands/src/engine/decision/axTreeExtractor.ts` (NEW)

**Purpose:** Extract interactive fields from the Playwright accessibility tree and normalize
them into `AXFieldNode[]`.

#### Function signatures:

```typescript
import type { Page } from 'playwright';
import type { AXFieldNode } from './mergedObserverTypes';

/**
 * Captures the full Playwright accessibility snapshot and extracts all
 * interactive fields as flat AXFieldNode[].
 *
 * Uses `page.accessibility.snapshot({ interestingOnly: false })` to get the
 * complete tree including non-interactive containers (needed for section grouping).
 *
 * @param page  Playwright Page instance
 * @returns Flat array of interactive AX field nodes, ordered by depth-first traversal
 */
export async function extractAXFields(page: Page): Promise<AXFieldNode[]>;

/**
 * Maps an AX role string to the closest FieldType from v2types.
 * Returns 'unknown' for roles that don't map to form fields.
 *
 * Mapping:
 *   'textbox'        -> 'text' (or 'email'/'phone' if name contains hint)
 *   'combobox'       -> 'custom_dropdown'
 *   'listbox'        -> 'select'
 *   'checkbox'       -> 'checkbox'
 *   'radio'          -> 'radio'
 *   'spinbutton'     -> 'number'
 *   'slider'         -> 'number'
 *   'searchbox'      -> 'typeahead'
 *   'switch'         -> 'checkbox'
 *   All others       -> 'unknown' (filtered out)
 */
export function mapAXRoleToFieldType(
  role: string,
  name: string,
): import('../v3/v2types').FieldType;

/**
 * Walks the AX tree recursively, collecting nodes with interactive roles.
 * Tracks depth and nearest group/region ancestor for section inference.
 *
 * @param node     Current AX node from Playwright snapshot
 * @param depth    Current depth in tree
 * @param section  Nearest ancestor group/region name
 * @param results  Accumulator array (mutated)
 */
export function flattenAXTree(
  node: PlaywrightAXNode,
  depth: number,
  section: string | null,
  results: AXFieldNode[],
): void;
```

#### Playwright AX Node shape (from Playwright's API):

```typescript
// This is Playwright's own type; we do NOT redefine it.
// Reference: page.accessibility.snapshot() returns:
interface PlaywrightAXNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  keyshortcuts?: string;
  roledescription?: string;
  valuetext?: string;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  checked?: 'true' | 'false' | 'mixed';
  pressed?: 'true' | 'false' | 'mixed';
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  children?: PlaywrightAXNode[];
}
```

#### Key design decisions:

1. **`interestingOnly: false`** -- We need the full tree so we can traverse group/region
   ancestors for section inference. `interestingOnly: true` strips containers.

2. **Interactive roles filter** -- Only these roles produce `AXFieldNode` entries:
   `textbox`, `combobox`, `listbox`, `checkbox`, `radio`, `spinbutton`, `slider`,
   `searchbox`, `switch`. All others (button, link, heading, etc.) are traversed
   for context but not emitted.

3. **Section inference** -- As we walk the tree depth-first, we track the nearest
   ancestor with role `group`, `region`, `form`, or `landmark`. Its `name` becomes
   `sectionName` on the emitted `AXFieldNode`. This gives us section grouping without
   DOM parsing.

4. **Options extraction** -- For combobox/listbox nodes, child nodes with role `option`
   are collected into the `options` array. If `expanded` is false and no options are
   visible, `options` is empty (we do NOT force-expand dropdowns from AX -- that's DOM's job).

5. **Value normalization** -- `node.value` and `node.valuetext` are both checked.
   For checkboxes: `node.checked` is mapped to `'checked'`/`'unchecked'`.
   For everything else: `value || valuetext || ''`.

6. **Performance budget** -- `page.accessibility.snapshot()` typically takes 50-150ms.
   This is run in parallel with the DOM scanner (not sequentially).

---

## Layer 3: Observer Merge Algorithm

### File: `packages/ghosthands/src/engine/decision/observerMerger.ts` (NEW)

**Purpose:** Take DOM fields + AX fields, produce `MergedPageObservation`.

#### Function signatures:

```typescript
import type { Page } from 'playwright';
import type { FieldSnapshot, PageDecisionContext } from './types';
import type {
  AXFieldNode,
  DurableFieldRecord,
  MergedFieldMergeResult,
  MergedFieldState,
  MergedPageObservation,
  SelectStateModel,
} from './mergedObserverTypes';
import type { BrowserAutomationAdapter } from '../../adapters/types';

/**
 * Core merge function. Called by PageSnapshotBuilder.buildMergedSnapshot().
 *
 * Steps:
 *   1. Build a join index: (normalizedLabel, inferredFieldType) for AX fields
 *   2. For each DOM field, attempt to match an AX field by fuzzy (label, type) match
 *   3. For matched pairs: compare currentValue, fieldType, required -- flag discrepancies
 *   4. For unmatched DOM fields: emit with provenance ['dom'], state based on value
 *   5. For unmatched AX fields: emit with provenance ['ax'], add to axOnlyFields
 *   6. If any field has ambiguous_observer_mismatch: optionally invoke Stagehand tiebreaker
 *   7. Consult durable context for stale_context_mismatch detection
 *
 * @param domSnapshot    The PageDecisionContext from existing DOM pipeline
 * @param axFields       AXFieldNode[] from extractAXFields()
 * @param durableContext Map of fieldKey -> DurableFieldRecord (from PageContextService)
 *                       Pass empty Map when durable context is not available.
 * @param tiebreakerFn   Optional: invoked when observers disagree. If null, disagreements
 *                       are left as ambiguous_observer_mismatch without resolution.
 * @returns MergedPageObservation
 */
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
): Promise<MergedPageObservation>;

/**
 * Fuzzy-match an AX field to a DOM field.
 *
 * Strategy (in priority order):
 *   1. Exact label match (normalized): AX name === DOM label (case-insensitive, whitespace-normalized)
 *   2. Containment match: AX name contains DOM label or vice versa (>= 80% overlap)
 *   3. Type-constrained fuzzy: Same inferred FieldType + Levenshtein distance <= 3 on label
 *   4. Positional fallback: Same FieldType + same orderIndex (within +/- 1)
 *
 * Returns null if no match found (field is DOM-only or AX-only).
 *
 * @param axField        The AX field to match
 * @param domFields      All DOM FieldSnapshot[] to search
 * @param alreadyMatched Set of DOM field IDs already claimed by prior matches
 * @returns The matching DOM field ID, or null
 */
export function matchAXToDOMField(
  axField: AXFieldNode,
  domFields: FieldSnapshot[],
  alreadyMatched: Set<string>,
): string | null;

/**
 * Given a matched DOM + AX pair, determine the MergedFieldState.
 *
 * Decision matrix:
 *   - Both agree value is empty          -> 'empty' (or 'missing_required' if required)
 *   - Both agree value is non-empty      -> 'valid'
 *   - DOM has value, AX has different    -> 'ambiguous_observer_mismatch'
 *   - DOM has value, AX has empty        -> 'ambiguous_observer_mismatch'
 *   - DOM empty, AX has value            -> 'ambiguous_observer_mismatch'
 *   - Durable context expected != actual -> 'stale_context_mismatch'
 *   - Field type disagreement            -> 'ambiguous_observer_mismatch'
 */
export function classifyMergedState(
  domField: FieldSnapshot,
  axField: AXFieldNode | null,
  durableRecord: DurableFieldRecord | null,
): MergedFieldState;

/**
 * Generate a stable field key from a DOM FieldSnapshot.
 * Must produce the same key as formFiller's getStableFieldKey().
 *
 * Strategy: normalizedLabel + fieldType + sectionContext hash
 * Falls back to selector-based key if label is synthetic.
 */
export function stableFieldKey(field: FieldSnapshot, sectionHint?: string): string;
```

#### Merge algorithm pseudocode:

```
1. axIndex = Map<normalizedKey, AXFieldNode[]>  // keyed by normalize(name) + inferredFieldType
2. matchedDomIds = Set<string>
3. matchedAxIndices = Set<number>
4. mergeResults = Map<string, MergedFieldMergeResult>

FOR EACH domField IN domSnapshot.fields:
    fieldKey = stableFieldKey(domField)
    bestMatch = matchAXToDOMField(domField -> scan axFields, matchedAxIndices)

    IF bestMatch:
        matchedAxIndices.add(bestMatch.index)
        matchedDomIds.add(domField.id)
        provenance = { sources: ['dom', 'ax'], concordant: valuesAgree(domField, bestMatch) }
        state = classifyMergedState(domField, bestMatch, durableContext.get(fieldKey))
        mergeResults.set(fieldKey, { domField, axField: bestMatch, provenance, state, ... })
    ELSE:
        provenance = { sources: ['dom'], concordant: null }
        state = classifyMergedState(domField, null, durableContext.get(fieldKey))
        mergeResults.set(fieldKey, { domField, axField: null, provenance, state, ... })

axOnlyFields = []
FOR EACH (axField, index) IN axFields:
    IF index NOT IN matchedAxIndices:
        axOnlyFields.push(axField)
        // Optionally promote to mergeResults with provenance ['ax'] if it looks interactive

IF any mergeResult has state 'ambiguous_observer_mismatch' AND tiebreakerFn:
    FOR EACH disagreement:
        verdict = await tiebreakerFn(page, adapter, domField, axField)
        UPDATE mergeResult with stagehandVerdict
        RECLASSIFY state based on verdict

RETURN MergedPageObservation
```

#### When Stagehand is invoked as tiebreaker:

Stagehand is ONLY invoked when:
1. `tiebreakerFn` is provided (it is NOT provided in formFiller path, only in DecisionLoopRunner)
2. At least one field has `ambiguous_observer_mismatch`
3. The field is **required** (optional fields with mismatches are left as ambiguous)
4. Maximum 3 Stagehand tiebreaker calls per observation cycle (budget guard)

Stagehand tiebreaker uses `adapter.observe()` with a targeted prompt:
`"What is the current value of the field labeled '{label}'? Report the field type and value."`

---

## Layer 4: Durable Context Wiring

### 4A: DecisionLoopRunner constructor

**File:** `packages/ghosthands/src/engine/decision/DecisionLoopRunner.ts`

Add `pageContext` to the constructor config:

```typescript
// In the config type passed to constructor (around line 249):
constructor(config: {
  // ... all existing fields ...
  pageContext?: PageContextService;  // NEW -- optional for backward compat
})
```

How it is used inside the run loop:

```typescript
// In the run() method, at each iteration:
//
// BEFORE building snapshot:
//   const durableFields = await this.loadDurableFieldRecords();
//
// AFTER building snapshot:
//   const merged = await this.snapshotBuilder.buildMergedSnapshot(
//     page, actionHistory, durableFields, tiebreakerFn
//   );
//
// AFTER action execution:
//   await this.commitActionOutcome(merged, executorResult);
```

New private methods on `DecisionLoopRunner`:

```typescript
/**
 * Load DurableFieldRecord for all fields on the current page from PageContextService.
 * Returns empty Map when pageContext is not wired (backward compat).
 */
private async loadDurableFieldRecords(): Promise<Map<string, DurableFieldRecord>>;

/**
 * After an action executes, commit outcomes to durable context.
 * - For fill_form: update each field's lastActor, lastCommittedValue, mergedState
 * - For click_next/click_apply: finalize the current page in context
 * - For other actions: annotate the page with action metadata
 */
private async commitActionOutcome(
  merged: MergedPageObservation,
  result: ExecutorResult,
): Promise<void>;
```

The `pageContext` parameter is plumbed from the Mastra step factory. The
`buildPageDecisionLoopStep` already has access to `RuntimeContext` which holds
the `PageContextService` instance.

### 4B: ActionExecutor constructor

**File:** `packages/ghosthands/src/engine/decision/actionExecutor.ts`

Add `pageContext` to `ActionExecutorOptions`:

```typescript
type ActionExecutorOptions = {
  // ... all existing fields ...
  pageContext?: PageContextService;  // NEW
};
```

How it is used inside `executeFill`:

```typescript
// In executeFill(), before calling fillFormOnPage():
//   Pass pageContext through to fillFormOnPage options
//
// After fillFormOnPage() returns:
//   pageContext is already updated by fillFormOnPage (see 4C below)
```

The `ActionExecutor.executeFill()` method (around line 370-400) calls `fillFormOnPage()`.
The new `pageContext` parameter is forwarded:

```typescript
// Current call:
const result = await fillFormOnPage(this.page, this.adapter, profileText, resumePath, {
  observers: this.buildFillObservers(),
  anthropicClientConfig: this.options.anthropicClientConfig,
});

// New call:
const result = await fillFormOnPage(this.page, this.adapter, profileText, resumePath, {
  observers: this.buildFillObservers(),
  anthropicClientConfig: this.options.anthropicClientConfig,
  pageContext: this.options.pageContext,  // NEW
});
```

### 4C: formFiller.fillFormOnPage

**File:** `packages/ghosthands/src/workers/taskHandlers/formFiller.ts`

#### Signature change:

```typescript
export interface FillFormOptions {
  // ... all existing fields ...
  pageContext?: PageContextService;  // NEW
}
```

#### Where durable context reads happen:

At the TOP of the iterative fill loop (around line 4618-4623), before deciding which
fields to fill in this round:

```typescript
// EXISTING (line ~4618):
//   while (round < 10) {
//     round++;
//     ... re-extract fields ...
//     ... determine toFill list ...

// NEW: Before building toFill, consult durable context:
//
//   const durableRecords = await loadDurableRecordsForFields(pageContext, fieldKeys);
//   const skipKeys = new Set<string>();
//   for (const [key, record] of durableRecords) {
//     if (record.lastMergedState === 'valid' || record.lastMergedState === 'skipped_optional') {
//       skipKeys.add(key);
//     }
//   }
//   // Filter toFill: exclude fields whose durable state is 'valid' or 'skipped_optional'
//   toFill = toFill.filter(field => !skipKeys.has(getStableFieldKey(field)));
```

This is the "skip already-valid" check. It prevents re-filling fields that a previous
round (or a previous page visit) already verified as correct.

#### Where durable context writes happen:

After each individual field fill attempt succeeds (inside the per-field loop, around
line 4880-4937):

```typescript
// EXISTING: After domWrite() succeeds for a field:
//   domFilledOk.add(field.id);

// NEW: Also commit to durable context:
//   if (pageContext) {
//     await pageContext.recordFieldResult({
//       questionKey: fieldIdToQuestionKey[field.id],
//       state: 'filled',
//       currentValue: resolvedValue,
//       source: 'dom',
//     });
//   }
```

And after the Magnitude fallback loop (around line 5040-5190):

```typescript
// EXISTING: After Magnitude fills a field:
//   filledCount++;

// NEW: Also commit to durable context:
//   if (pageContext) {
//     await pageContext.recordFieldResult({
//       questionKey: fieldIdToQuestionKey[field.id],
//       state: 'filled',
//       currentValue: /* re-read from DOM */,
//       source: 'magnitude',
//     });
//   }
```

#### What new methods are needed in formFiller:

```typescript
/**
 * Load durable field records for a set of field keys from PageContextService.
 * Returns empty Map when pageContext is null/undefined.
 * Uses getSession() to read the current page's QuestionRecords.
 */
async function loadDurableRecordsForFields(
  pageContext: PageContextService | undefined,
  fieldKeys: string[],
): Promise<Map<string, DurableFieldRecord>>;

/**
 * Convert a QuestionRecord (from PageContextService) into a DurableFieldRecord
 * for the merged observer pipeline.
 */
function questionRecordToDurableField(qr: QuestionRecord): DurableFieldRecord;
```

### 4D: PageContextService interface extension

**File:** `packages/ghosthands/src/context/PageContextService.ts`

No new methods needed on the interface. The existing methods are sufficient:

- `getSession()` -- read current page's QuestionRecords (provides durable state)
- `recordFieldResult()` -- write back after fill
- `recordFieldAttempt()` -- record attempt before fill
- `syncQuestions()` -- update field inventory from merged observer

The `DurableFieldRecord` is a **read-side projection** built by the consumer
(`loadDurableRecordsForFields`) from the existing `QuestionRecord` data. It is NOT
stored separately -- it is derived at read time from `QuestionRecord` plus the new
optional fields (`lastActor`, `sectionFingerprint`, `observerProvenance`).

### 4E: PageSnapshotBuilder extension

**File:** `packages/ghosthands/src/engine/decision/pageSnapshotBuilder.ts`

New method on `PageSnapshotBuilder`:

```typescript
/**
 * Build a merged snapshot that combines DOM scanning + AX tree extraction.
 * This is the new primary entry point for the decision loop.
 *
 * Runs DOM scan (existing buildSnapshot) and AX extraction in parallel,
 * then merges via observerMerger.mergeObservations().
 *
 * @param page            Playwright Page
 * @param actionHistory   Action history for LLM context
 * @param durableContext  Field records from PageContextService
 * @param tiebreakerFn   Optional Stagehand tiebreaker (only in decision loop path)
 * @returns MergedPageObservation
 */
async buildMergedSnapshot(
  page: Page,
  actionHistory: ActionHistoryEntry[],
  durableContext: Map<string, DurableFieldRecord>,
  tiebreakerFn?: Parameters<typeof mergeObservations>[3],
): Promise<MergedPageObservation>;
```

Implementation approach:
```
1. const [domSnapshot, axFields] = await Promise.all([
     this.buildSnapshot(page, actionHistory),    // existing
     extractAXFields(page),                       // new
   ]);
2. return mergeObservations(domSnapshot, axFields, durableContext, tiebreakerFn);
```

The existing `buildSnapshot()` method is UNCHANGED. `buildMergedSnapshot()` is additive.
Callers that don't need AX merge continue using `buildSnapshot()`.

---

## Layer 5: Magnitude Gate Contract

### File: `packages/ghosthands/src/engine/decision/magnitudeGate.ts` (NEW)

**Purpose:** Single source of truth for "should we escalate to Magnitude?"

```typescript
import type { DurableFieldRecord, MergedFieldState } from './mergedObserverTypes';

/**
 * States that ALLOW Magnitude escalation.
 * These are the ONLY states where spending $0.005-0.01/action is justified.
 */
const MAGNITUDE_ALLOWED_STATES: Set<MergedFieldState> = new Set([
  'empty',
  'missing_required',
  'invalid_after_fill',
  'ambiguous_observer_mismatch',
  'wrong_value',
]);

/**
 * States that BLOCK Magnitude escalation.
 * The field either doesn't need help or is beyond help.
 */
const MAGNITUDE_BLOCKED_STATES: Set<MergedFieldState> = new Set([
  'valid',
  'skipped_optional',
  'unresolvable',
  'pending_stagehand',  // wait for Stagehand verdict first
]);

/** Maximum Magnitude attempts per field before marking unresolvable */
const MAX_MAGNITUDE_ATTEMPTS_PER_FIELD = 2;

/**
 * Determine whether a field should be escalated to Magnitude (visual agent).
 *
 * Decision logic:
 *   1. If mergedState is in MAGNITUDE_BLOCKED_STATES -> false
 *   2. If field.magnitudeAttemptCount >= MAX_MAGNITUDE_ATTEMPTS -> false
 *      (mark field as 'unresolvable' and move on)
 *   3. If mergedState is in MAGNITUDE_ALLOWED_STATES -> true
 *   4. For 'stale_context_mismatch': true only if field is required
 *   5. Default -> false
 *
 * @param field        Durable field record (null if no durable context available)
 * @param mergedState  Current merged state from observer pipeline
 * @returns Whether Magnitude should be invoked for this field
 */
export function shouldEscalateToMagnitude(
  field: DurableFieldRecord | null,
  mergedState: MergedFieldState,
): boolean;

/**
 * After Magnitude acts on a field, re-observe and commit the result to durable context.
 *
 * Steps:
 *   1. Re-read the field's current value from DOM (page.evaluate)
 *   2. Optionally re-read from AX tree for cross-check
 *   3. Update the DurableFieldRecord:
 *      - lastActor = 'magnitude'
 *      - lastActorTimestamp = now
 *      - magnitudeAttemptCount++
 *      - fillAttemptCount++
 *      - lastCommittedValue = re-read value
 *      - lastMergedState = 'valid' if value matches expected, else 'invalid_after_fill'
 *   4. Commit to PageContextService via recordFieldResult()
 *
 * @param page          Playwright Page (for re-reading value)
 * @param field         The durable field record to update
 * @param fieldSelector CSS selector to re-read the field value
 * @param pageContext   PageContextService instance (for committing result)
 * @returns Updated DurableFieldRecord
 */
export async function commitMagnitudeResult(
  page: import('playwright').Page,
  field: DurableFieldRecord,
  fieldSelector: string,
  pageContext?: import('../../context/PageContextService').PageContextService,
): Promise<DurableFieldRecord>;

/**
 * Batch version: given a set of fields to fill, partition into DOM-eligible
 * and Magnitude-eligible based on their durable state.
 *
 * @param fields    Map of fieldKey -> { mergedState, durableRecord }
 * @returns { domEligible: string[], magnitudeEligible: string[], skip: string[] }
 */
export function partitionByEscalationTier(
  fields: Map<string, { mergedState: MergedFieldState; durableRecord: DurableFieldRecord | null }>,
): {
  domEligible: string[];
  magnitudeEligible: string[];
  skip: string[];
};
```

### Where the gate is enforced:

**In formFiller.ts** (Magnitude fallback section, line ~5036-5042):

```typescript
// EXISTING:
//   const unfilledFields = fieldContexts
//     .filter(ctx => ctx.state !== 'valid' && ctx.state !== 'skipped_optional')
//     .map(...)
//     .filter(...);
//
// NEW: Replace with gate check:
//   const partition = partitionByEscalationTier(fieldStates);
//   const unfilledFields = partition.magnitudeEligible
//     .map(key => postVisible.find(f => getStableFieldKey(f) === key))
//     .filter(Boolean);
//   // partition.skip fields are logged but not attempted
```

**In actionExecutor.ts** (`tryMagnitudeFill` method, line ~779):

```typescript
// EXISTING: tryMagnitudeFill always invokes adapter.act()
//
// NEW: Check gate first:
//   const fieldStates = buildFieldStatesFromContext(action, context, this.options.pageContext);
//   const partition = partitionByEscalationTier(fieldStates);
//   if (partition.magnitudeEligible.length === 0) {
//     return { ok: true, layer: null, ..., summary: 'All target fields already valid or gated.' };
//   }
//   // Only pass magnitudeEligible fields to adapter.act()
```

---

## Layer 6: Select/Dropdown State Model

### File: `packages/ghosthands/src/engine/decision/selectStateManager.ts` (NEW)

This consolidates the 6+ duplicated dropdown discovery/interaction patterns into one module.

```typescript
import type { Page } from 'playwright';
import type { SelectStateModel, SelectOption } from './mergedObserverTypes';
import type { FieldSnapshot } from './types';

/**
 * Discover the full state of a select/dropdown control.
 * Handles native <select>, custom dropdowns, typeaheads, ARIA listboxes,
 * and button groups.
 *
 * Does NOT open/close the dropdown unless forceDiscover is true.
 * When forceDiscover is true, briefly opens the dropdown to read options,
 * then closes it.
 *
 * @param page           Playwright Page
 * @param field          The FieldSnapshot for this control
 * @param forceDiscover  Whether to open the dropdown to read options
 * @returns SelectStateModel
 */
export async function discoverSelectState(
  page: Page,
  field: FieldSnapshot,
  forceDiscover?: boolean,
): Promise<SelectStateModel>;

/**
 * Select a specific option in a dropdown.
 * Returns true if the option was successfully selected.
 *
 * Strategy cascade:
 *   1. Native <select>: page.selectOption()
 *   2. Custom dropdown: click trigger -> click option by selector
 *   3. Typeahead: type text -> wait for listbox -> click matching option
 *   4. ARIA listbox: focus -> arrow keys to option -> Enter
 *   5. Button group: click the matching button
 *
 * @param page    Playwright Page
 * @param select  The SelectStateModel
 * @param value   The option label or value to select
 * @returns { selected: boolean, method: string }
 */
export async function selectOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }>;

/**
 * Detect the dropdown variant from a FieldSnapshot.
 * Used to determine which interaction strategy to use.
 */
export function classifyDropdownVariant(
  field: FieldSnapshot,
): SelectStateModel['variant'];
```

---

## File Change Summary

### New Files (6)

| File | Layer | Purpose |
|------|-------|---------|
| `src/engine/decision/mergedObserverTypes.ts` | 1 | All new type definitions |
| `src/engine/decision/axTreeExtractor.ts` | 2 | AX tree snapshot + flattening |
| `src/engine/decision/observerMerger.ts` | 3 | DOM + AX merge algorithm |
| `src/engine/decision/magnitudeGate.ts` | 5 | Escalation gate logic |
| `src/engine/decision/selectStateManager.ts` | 6 | Unified dropdown handling |
| `src/__tests__/unit/observerMerger.test.ts` | 8 | Tests for merge algorithm |

All new file paths are relative to `packages/ghosthands/`.

### Modified Files (6)

| File | Layer | Changes |
|------|-------|---------|
| `src/context/types.ts` | 1 | Add 3 optional fields to `QuestionRecord` |
| `src/engine/decision/pageSnapshotBuilder.ts` | 3 | Add `buildMergedSnapshot()` method |
| `src/engine/decision/DecisionLoopRunner.ts` | 4 | Add `pageContext` to constructor, wire load/commit |
| `src/engine/decision/actionExecutor.ts` | 4 | Add `pageContext` to options, forward to fillFormOnPage |
| `src/workers/taskHandlers/formFiller.ts` | 4+5 | Add `pageContext` to FillFormOptions, skip-already-valid check, gate Magnitude |
| `src/context/NoopPageContextService.ts` | 4 | No changes needed (interface is unchanged) |

### Dependency Order (build sequence)

```
Layer 1: mergedObserverTypes.ts + context/types.ts extensions
         (no dependencies, pure types)
              |
Layer 2: axTreeExtractor.ts
         (depends on: mergedObserverTypes, playwright)
              |
Layer 3: observerMerger.ts + pageSnapshotBuilder.ts extension
         (depends on: mergedObserverTypes, axTreeExtractor, decision/types)
              |
Layer 4: DecisionLoopRunner + ActionExecutor + formFiller wiring
         (depends on: observerMerger, mergedObserverTypes, context/PageContextService)
              |
Layer 5: magnitudeGate.ts + formFiller/actionExecutor gate enforcement
         (depends on: mergedObserverTypes, context/PageContextService)
              |
Layer 6: selectStateManager.ts
         (depends on: mergedObserverTypes, decision/types)
              |
Layer 7: Logging extensions (structured log fields for merge stats)
              |
Layer 8: Tests
```

### Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| `QuestionRecord` extensions | LOW | All 3 fields are optional; existing code ignores them |
| `buildMergedSnapshot()` on PageSnapshotBuilder | LOW | Additive method; existing `buildSnapshot()` unchanged |
| `pageContext` on DecisionLoopRunner | LOW | Optional param; existing callers pass nothing |
| `pageContext` on formFiller | MEDIUM | Must not break the 10-round fill loop; guarded by `if (pageContext)` |
| Magnitude gate in formFiller | MEDIUM | Changes which fields reach Magnitude; needs integration test with real pages |
| AX tree extraction | LOW | New code, no existing code touched; `page.accessibility.snapshot()` is stable Playwright API |
| Observer merge algorithm | MEDIUM | New logic; needs thorough unit tests with mock DOM+AX data |

### Debate Gate 1 Amendments (2026-03-11)

These amendments address critical risks surfaced by the adversarial debate (all 3 providers agreed):

#### Amendment A1: Field Join Key (fixes R1 — silent mis-pairing)

**Problem:** Fuzzy label matching will alias distinct controls on pages with duplicate labels
(e.g., "City" × 3 for address/emergency/etc.) or repeaters ("Question 1", "Question 2").

**Fix:** Use `selector + ordinalIndex + fieldType` as the PRIMARY join key for DOM↔AX matching.
Label matching becomes a secondary enrichment signal, NOT the join key.

**Changes:**
- Add `ordinalIndex: number` to `FieldSnapshot` in `decision/types.ts` (DOM position order)
- PageScanner assigns `ordinalIndex` during extraction (depth-first DOM order)
- `matchAXToDOMField()` primary match: same `ordinalIndex` + compatible `fieldType`
- `matchAXToDOMField()` secondary enrichment: fuzzy label match to confirm/enrich
- `stableFieldKey()` uses `fieldType:ordinalIndex:selectorHash` NOT `normalizedLabel`

#### Amendment A2: Skip-Valid Must Verify DOM Value (fixes R3 — stale skip)

**Problem:** SPA re-render blanks a field, durable context still says "valid",
skip logic prevents re-fill. Regresses multi-page Workday flows.

**Fix:** The skip-already-valid check MUST also verify DOM current value matches
the durable committed value. If DOM shows empty but durable says valid →
mark `stale_context_mismatch`, do NOT skip.

**Changes in formFiller.ts skip logic (line ~783-791):**
```typescript
// AMENDED: Skip only if BOTH durable state is valid AND DOM value matches committed value
for (const [key, record] of durableRecords) {
  if (record.lastMergedState === 'valid' && record.lastCommittedValue) {
    const domValue = getCurrentDOMValue(page, record.fieldSelector);
    if (domValue === record.lastCommittedValue) {
      skipKeys.add(key);  // Safe to skip — DOM confirms the value is still there
    } else {
      // DOM disagrees with durable context → stale, must re-fill
      record.lastMergedState = 'stale_context_mismatch';
    }
  }
}
```

#### Amendment A3: Sequential DOM→AX, Not Parallel (fixes R2 — atomicity)

**Problem:** Parallel DOM scan + AX snapshot observe different UI states on reactive forms,
manufacturing false disagreements.

**Fix:** Run DOM scan FIRST, then AX snapshot sequentially. The ~100ms cost is acceptable.

**Changes in pageSnapshotBuilder.ts `buildMergedSnapshot()`:**
```typescript
// AMENDED: Sequential, not parallel
const domSnapshot = await this.buildSnapshot(page, actionHistory);  // DOM first
const axFields = await extractAXFields(page);                       // AX second
return mergeObservations(domSnapshot, axFields, durableContext, tiebreakerFn);
```

#### Amendment A4: State Mapping Functions (fixes R4 — lossy round-trip)

**Problem:** MergedFieldState has 10 values, QuestionState has 8. No mapping specified.

**Fix:** Add explicit mapping functions in `mergedObserverTypes.ts`:
```typescript
export function mergedStateToQuestionState(s: MergedFieldState): QuestionState;
export function questionStateToMergedState(s: QuestionState): MergedFieldState;
```

Mapping:
- `ambiguous_observer_mismatch` → QuestionState `'empty'` (force re-evaluation)
- `stale_context_mismatch` → QuestionState `'empty'` (force re-fill)
- `pending_stagehand` → QuestionState `'empty'` (waiting)
- `unresolvable` → QuestionState `'failed'`
- All others: 1:1 mapping

#### Amendment A5: AX Extraction Timeout (fixes R5 — cycle latency)

**Problem:** AX extraction may be slow on complex pages, blowing session timeouts.

**Fix:** Add `MAX_AX_EXTRACTION_MS = 200` timeout. If AX snapshot exceeds this,
proceed with DOM-only observation (graceful degradation).

**Changes in `buildMergedSnapshot()`:**
```typescript
const axFields = await Promise.race([
  extractAXFields(page),
  new Promise<AXFieldNode[]>(resolve => setTimeout(() => resolve([]), MAX_AX_EXTRACTION_MS)),
]);
```

---

### Validation Strategy

1. **Layer 1-2:** TypeScript compilation (types only)
2. **Layer 3:** Unit tests with mock DOM + AX field arrays; verify merge logic produces correct provenance, state classification, and disagreement detection
3. **Layer 4:** Integration test: run `fillFormOnPage` with a `PageContextService` instance on a mock page; verify durable records are populated after fill
4. **Layer 5:** Unit tests: verify `shouldEscalateToMagnitude` returns correct boolean for each `MergedFieldState` + attempt count combination
5. **Layer 6:** Unit tests for `classifyDropdownVariant`; integration test on a Workday-style page
6. **End-to-end:** Run a full `DecisionLoopRunner.run()` on a staging job URL with the merged observer pipeline active; compare field outcomes vs. the existing pipeline
