/**
 * GHOST-HANDS v3 Engine Types
 *
 * Core types for the three-layer hybrid execution engine.
 * Layers: DOM ($0) → Stagehand ($0.0005) → Magnitude ($0.005)
 *
 * This file defines the NEW v3 types.
 * Legacy v2 types (from CheaperAttempt) are in v2types.ts — used by ported files.
 */

// Re-export v2 types that ported files need
export type {
  FieldModel,
  PageModel,
  ActionItem,
  ActionPlan,
  FieldMatch as V2FieldMatch,
  MatchMethod as V2MatchMethod,
  VerificationResult,
  BoundingBox as V2BoundingBox,
  ButtonModel,
  FieldType as V2FieldType,
  FillStrategy,
  Tier,
  ActionType as V2ActionType,
  ButtonRole,
  PlatformHandler,
  RawElementData,
} from './v2types';

// ── Layer Identity ──────────────────────────────────────────────────────

export type LayerId = 'dom' | 'stagehand' | 'magnitude';

// ── Form Field (v3 unified) ─────────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'password'
  | 'select'
  | 'searchable_select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'hidden'
  | 'unknown';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormField {
  id: string;
  selector: string;
  xpath?: string;
  automationId?: string;
  fieldType: FieldType;
  label: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  required: boolean;
  currentValue?: string;
  options?: string[];
  boundingBox?: BoundingBox;
  visible: boolean;
  disabled: boolean;
  domDepth?: number;
  parentContainer?: string;
  stagehandDescription?: string;
}

// ── Form Section ────────────────────────────────────────────────────────

export interface FormSection {
  id: string;
  name: string;
  fields: FormField[];
  buttons: ButtonInfo[];
  yRange: { min: number; max: number };
  allFilled: boolean;
}

export interface ButtonInfo {
  selector: string;
  text: string;
  type?: string;
  boundingBox?: BoundingBox;
  disabled?: boolean;
}

// ── Observation Result ──────────────────────────────────────────────────

export interface V3ObservationResult {
  fields: FormField[];
  buttons: ButtonInfo[];
  url: string;
  platform: string;
  pageType: string;
  fingerprint: string;
  blockers: BlockerInfo[];
  timestamp: number;
  screenshot?: Buffer;
  observedBy: LayerId;
  costIncurred: number;
}

export interface BlockerInfo {
  category: 'captcha' | 'login' | '2fa' | 'bot_check' | 'rate_limited' | 'verification';
  confidence: number;
  selector?: string;
  description: string;
}

// ── Field Matching ──────────────────────────────────────────────────────

export type MatchMethod =
  | 'automation_id'
  | 'name_attr'
  | 'label_exact'
  | 'qa_match'
  | 'label_fuzzy'
  | 'placeholder'
  | 'stagehand_desc'
  | 'llm_inference'
  | 'default';

export interface FieldMatch {
  field: FormField;
  userDataKey: string;
  value: string;
  confidence: number;
  matchMethod: MatchMethod;
}

// ── Action Planning ─────────────────────────────────────────────────────

export type ActionType = 'fill' | 'click' | 'select' | 'check' | 'uncheck' | 'upload' | 'clear_and_fill';

export interface PlannedAction {
  field: FormField;
  actionType: ActionType;
  value: string;
  layer: LayerId;
  attemptCount: number;
  layerHistory: Array<{ layer: LayerId; error?: string }>;
  confidence: number;
  matchMethod: MatchMethod;
}

// ── Execution Result ────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  layer: LayerId;
  field: FormField;
  valueApplied: string;
  costIncurred: number;
  durationMs: number;
  error?: string;
  boundingBoxAtExecution?: BoundingBox;
}

// ── Review Result ───────────────────────────────────────────────────────

export interface ReviewResult {
  verified: boolean;
  field: FormField;
  expected: string;
  actual: string;
  reason?: string;
  reviewedBy: LayerId;
}

// ── Analysis Result ─────────────────────────────────────────────────────

export interface AnalysisResult {
  discoveredFields: FormField[];
  suggestedValues: FieldMatch[];
  costIncurred: number;
}

// ── Layer Error ─────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'element_not_found'
  | 'element_not_visible'
  | 'element_not_interactable'
  | 'value_mismatch'
  | 'timeout'
  | 'navigation_failed'
  | 'blocker_detected'
  | 'budget_exceeded'
  | 'browser_disconnected'
  | 'unknown';

export interface LayerError {
  category: ErrorCategory;
  message: string;
  layer: LayerId;
  recoverable: boolean;
  shouldEscalate: boolean;
  originalError?: unknown;
}

// ── Cookbook Types ───────────────────────────────────────────────────────

export interface CookbookDOMAction {
  selector: string;
  valueTemplate: string;
  action: ActionType;
}

export interface CookbookGUIAction {
  variant: 'click' | 'type' | 'scroll';
  x: number;
  y: number;
  content?: string;
}

export interface CookbookAction {
  fieldSnapshot: Omit<FormField, 'currentValue' | 'visible' | 'disabled'>;
  domAction: CookbookDOMAction;
  guiAction?: CookbookGUIAction;
  executedBy: LayerId;
  boundingBoxAtExecution?: BoundingBox;
  healthScore: number;
}

export interface CookbookPageEntry {
  pageFingerprint: string;
  urlPattern: string;
  platform: string;
  actions: CookbookAction[];
  healthScore: number;
  perActionHealth: number[];
  successCount: number;
  failureCount: number;
  updatedAt: string;
}

// ── Escalation Policy ───────────────────────────────────────────────────

export interface EscalationPolicy {
  maxAttemptsPerLayer: number;
  layerOrder: LayerId[];
  fastEscalationErrors: ErrorCategory[];
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  maxAttemptsPerLayer: 2,
  layerOrder: ['dom', 'stagehand', 'magnitude'],
  fastEscalationErrors: ['element_not_found', 'element_not_visible'],
};

// ── Layer Context ───────────────────────────────────────────────────────

export interface LayerContext {
  page: import('playwright').Page;
  userProfile: Record<string, unknown>;
  jobId: string;
  budgetRemaining: number;
  totalCost: number;
  platformHint?: string;
  cookbook?: CookbookPageEntry;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
    debug(msg: string, meta?: Record<string, unknown>): void;
  };
}

// ── Magnitude Direct Action ─────────────────────────────────────────────

export interface MagnitudeExecAction {
  variant: string;
  [key: string]: unknown;
}
