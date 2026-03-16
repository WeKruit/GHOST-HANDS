import type { QuestionState } from '../../context/types';
import type { FieldType } from '../v3/v2types';
import type { FieldSnapshot, PageDecisionContext } from './types';

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
  | 'valid'
  | 'empty'
  | 'missing_required'
  | 'invalid_after_fill'
  | 'ambiguous_observer_mismatch'
  | 'stale_context_mismatch'
  | 'wrong_value'
  | 'skipped_optional'
  | 'pending_stagehand'
  | 'unresolvable';

// ── AX Field Node ────────────────────────────────────────────

/**
 * A single interactive field extracted from the Playwright accessibility tree.
 * This is the AX-side analog of FieldSnapshot (DOM-side).
 *
 * DOM↔AX joins use DOM FieldSnapshot.ordinalIndex as the primary key and the AX
 * depth-first extraction order as the corresponding ordinal signal.
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
  inferredFieldType: FieldType;

  /**
   * Depth in the AX tree (0 = root). Used for section grouping.
   */
  depth: number;

  /**
   * The nearest ancestor with role 'group' or 'region', used for section inference.
   */
  sectionName: string | null;

  /**
   * Position in the flattened AX tree (depth-first order).
   * Used for ordinal-based join with DOM FieldSnapshot.ordinalIndex.
   */
  ordinalIndex: number;
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
  snapshot: PageDecisionContext;

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
  domField: FieldSnapshot | null;

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

const MERGED_TO_QUESTION_STATE: Record<MergedFieldState, QuestionState> = {
  valid: 'verified',
  empty: 'empty',
  missing_required: 'empty',
  invalid_after_fill: 'attempted',
  ambiguous_observer_mismatch: 'empty',
  stale_context_mismatch: 'empty',
  wrong_value: 'filled',
  skipped_optional: 'skipped',
  pending_stagehand: 'empty',
  unresolvable: 'failed',
};

const QUESTION_TO_MERGED_STATE: Record<QuestionState, MergedFieldState> = {
  empty: 'empty',
  planned: 'empty',
  attempted: 'invalid_after_fill',
  filled: 'valid',
  verified: 'valid',
  failed: 'unresolvable',
  skipped: 'skipped_optional',
  uncertain: 'ambiguous_observer_mismatch',
};

export function mergedStateToQuestionState(s: MergedFieldState): QuestionState {
  return MERGED_TO_QUESTION_STATE[s];
}

export function questionStateToMergedState(s: QuestionState): MergedFieldState {
  return QUESTION_TO_MERGED_STATE[s];
}
