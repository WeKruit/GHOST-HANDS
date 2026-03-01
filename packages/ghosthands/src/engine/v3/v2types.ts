/**
 * Core types for the v2 hybrid execution engine.
 *
 * Aligned with alex-generic-stagehands branch conventions:
 * - FieldModel.fieldType uses same values as ScannedField.kind
 * - FillStrategy enum matches ScannedField.fillStrategy
 * - data-gh-scan-idx attribute used for element tagging
 */

// ── FieldModel ──────────────────────────────────────────────────────────
// A single interactive element discovered on the page.

/** What kind of form field was detected. */
export type FieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'custom_dropdown'
  | 'radio'
  | 'aria_radio'
  | 'checkbox'
  | 'file'
  | 'typeahead'
  | 'contenteditable'
  | 'upload_button'
  | 'password'
  | 'unknown';

/** How a field should be filled. */
export type FillStrategy =
  | 'native_setter'
  | 'click_option'
  | 'click'
  | 'set_input_files'
  | 'keyboard_type'
  | 'llm_act';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldModel {
  /** Unique scan-session ID (e.g., "field-0", "field-1") */
  id: string;
  /** CSS selector for Playwright */
  selector: string;
  /** Workday's data-automation-id */
  automationId?: string;
  /** HTML id attribute */
  fieldId?: string;
  /** HTML name attribute */
  name?: string;

  /** What kind of field this is */
  fieldType: FieldType;
  /** How we plan to fill it */
  fillStrategy: FillStrategy;
  /** Whether this field is required */
  isRequired: boolean;
  /** Whether this field is visible */
  isVisible: boolean;
  /** Whether this field is disabled */
  isDisabled: boolean;

  /** Best-effort label text */
  label: string;
  /** Input placeholder text */
  placeholder?: string;
  /** aria-label attribute */
  ariaLabel?: string;

  /** Current value ('' if empty) */
  currentValue: string;
  /** Whether the field is empty */
  isEmpty: boolean;

  /** For selects/dropdowns/radios: available option texts */
  options?: string[];
  /** For radio groups: the group name or ARIA group selector */
  groupKey?: string;

  /** Bounding box relative to viewport at time of scan */
  boundingBox: BoundingBox;
  /** Absolute Y position on the page (rect.top + scrollY) for ordering */
  absoluteY: number;

  /** Platform-specific metadata */
  platformMeta?: Record<string, string>;
}

// ── ButtonModel ─────────────────────────────────────────────────────────

export type ButtonRole = 'navigation' | 'submit' | 'add' | 'action' | 'unknown';

export interface ButtonModel {
  selector: string;
  text: string;
  automationId?: string;
  role: ButtonRole;
  boundingBox: BoundingBox;
  isDisabled: boolean;
}

// ── PageModel ───────────────────────────────────────────────────────────
// Complete snapshot of a page's interactive elements.

export interface PageModel {
  url: string;
  platform: string;
  pageType: string;
  fields: FieldModel[];
  buttons: ButtonModel[];
  pageLabel?: string;
  scrollHeight: number;
  viewportHeight: number;
  timestamp: number;
}

// ── FieldMatch ──────────────────────────────────────────────────────────
// Result of matching a field to user data.

export type MatchMethod =
  | 'name_attr'
  | 'automation_id'
  | 'label_exact'
  | 'label_fuzzy'
  | 'placeholder'
  | 'qa_match'
  | 'default_value';

export interface FieldMatch {
  field: FieldModel;
  userDataKey: string;
  value: string;
  confidence: number;
  matchMethod: MatchMethod;
}

// ── ActionItem ──────────────────────────────────────────────────────────
// One action to execute on a single field.

export type ActionType = 'fill' | 'select' | 'check' | 'upload' | 'click' | 'type_and_select';
export type Tier = 0 | 3;

export interface ActionItem {
  field: FieldModel;
  action: ActionType;
  value: string;
  tier: Tier;
  match?: FieldMatch;
  retryCount: number;
  maxRetries: number;
}

// ── ActionPlan ──────────────────────────────────────────────────────────
// Full plan for filling a page.

export interface ActionPlan {
  actions: ActionItem[];
  tier0Count: number;
  tier3Count: number;
  unmatchedFields: FieldModel[];
}

// ── VerificationResult ──────────────────────────────────────────────────

export interface VerificationResult {
  field: FieldModel;
  expected: string;
  actual: string;
  passed: boolean;
  reason?: string;
}

// ── StepOrchestratorResult ──────────────────────────────────────────────

export interface OrchestratorResult {
  success: boolean;
  pagesCompleted: number;
  totalTier0Actions: number;
  totalTier3Actions: number;
  totalVerificationFailures: number;
  error?: string;
}

// ── Platform handler interface ──────────────────────────────────────────

export interface PlatformHandler {
  /** Platform identifier */
  readonly platformId: string;

  /** Map of automation-id → user data key */
  getAutomationIdMap(): Record<string, string>;

  /** Map of common label text → user data key */
  getLabelMap(): Record<string, string>;

  /** Normalize a question label for matching */
  normalizeLabel(label: string): string;

  /** Get the CSS selector for the "Next" / "Save and Continue" button */
  getNextButtonSelector(): string;

  /** Detect whether a page is the review/submit page */
  isReviewPage(pageModel: PageModel): boolean;

  /** Get platform-specific field type overrides based on element attributes */
  detectFieldType?(element: RawElementData): FieldType | null;

  /** Handle special experience page "Add" button logic */
  handleExperiencePageExpansion?(page: import('playwright').Page): Promise<void>;
}

/** Raw element data from page.evaluate — used by platform handlers for field type detection */
export interface RawElementData {
  tagName: string;
  type?: string;
  textContent?: string;
  automationId?: string;
  ariaRole?: string;
  ariaHasPopup?: string;
  className?: string;
  name?: string;
}
