import { z } from 'zod';
import type {
  ButtonModel,
  ButtonRole,
  FieldModel,
  FieldType,
} from '../v3/v2types';

const FIELD_TYPE_VALUES = [
  'text',
  'email',
  'phone',
  'number',
  'date',
  'textarea',
  'select',
  'custom_dropdown',
  'radio',
  'aria_radio',
  'checkbox',
  'file',
  'typeahead',
  'contenteditable',
  'upload_button',
  'password',
  'button_group',
  'unknown',
] as const satisfies readonly FieldType[];

const BUTTON_ROLE_VALUES = [
  'navigation',
  'submit',
  'add',
  'action',
  'unknown',
] as const satisfies readonly ButtonRole[];

export const FieldSnapshotSchema = z.object({
  id: z.string().min(1),
  selector: z.string().min(1),
  label: z.string().min(1),
  fieldType: z.enum(FIELD_TYPE_VALUES),
  ordinalIndex: z.number().int().nonnegative(),
  isRequired: z.boolean(),
  isVisible: z.boolean(),
  isDisabled: z.boolean(),
  isEmpty: z.boolean(),
  currentValue: z.string(),
  options: z.array(z.string()).optional(),
  groupKey: z.string().optional(),
}).strict();

export type FieldSnapshot = z.infer<typeof FieldSnapshotSchema>;

type _FieldSnapshotCompatible = FieldSnapshot extends Pick<
  FieldModel,
  | 'id'
  | 'selector'
  | 'label'
  | 'fieldType'
  | 'isRequired'
  | 'isVisible'
  | 'isDisabled'
  | 'isEmpty'
  | 'currentValue'
  | 'options'
  | 'groupKey'
> ? true : never;

export const ButtonSnapshotSchema = z.object({
  selector: z.string().min(1),
  text: z.string(),
  role: z.enum(BUTTON_ROLE_VALUES),
  isDisabled: z.boolean(),
  automationId: z.string().optional(),
}).strict();

export type ButtonSnapshot = z.infer<typeof ButtonSnapshotSchema>;

type _ButtonSnapshotCompatible = ButtonSnapshot extends Pick<
  ButtonModel,
  'selector' | 'text' | 'role' | 'isDisabled' | 'automationId'
> ? true : never;

export const ActionHistoryEntrySchema = z.object({
  iteration: z.number().int().nonnegative(),
  action: z.string().min(1),
  target: z.string(),
  result: z.enum(['success', 'partial', 'failed', 'skipped']),
  layer: z.enum(['dom', 'stagehand', 'magnitude']).nullable(),
  costUsd: z.number().min(0),
  durationMs: z.number().min(0),
  fieldsAttempted: z.number().int().nonnegative().optional(),
  fieldsFilled: z.number().int().nonnegative().optional(),
  pageFingerprint: z.string().min(1),
  timestamp: z.number().nonnegative(),
}).strict();

export type ActionHistoryEntry = z.infer<typeof ActionHistoryEntrySchema>;

export const StepContextSchema = z.object({
  label: z.string(),
  current: z.number().int().positive(),
  total: z.number().int().positive(),
}).strict();

export type StepContext = z.infer<typeof StepContextSchema>;

export const RepeaterSnapshotSchema = z.object({
  label: z.string(),
  addButtonSelector: z.string().min(1),
  currentCount: z.number().int().nonnegative(),
  targetCount: z.number().int().nonnegative().optional(),
}).strict();

export type RepeaterSnapshot = z.infer<typeof RepeaterSnapshotSchema>;

export const FingerprintSchema = z.object({
  heading: z.string(),
  fieldCount: z.number().int().nonnegative(),
  filledCount: z.number().int().nonnegative(),
  activeStep: z.string(),
  hash: z.string().min(1),
}).strict();

export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const BlockerSnapshotSchema = z.object({
  detected: z.boolean(),
  type: z.string().nullable(),
  confidence: z.number().min(0).max(1),
}).strict();

export type BlockerSnapshot = z.infer<typeof BlockerSnapshotSchema>;

export const PageDecisionContextSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  platform: z.string().min(1),
  pageType: z.string().min(1),
  headings: z.array(z.string()),
  fields: z.array(FieldSnapshotSchema),
  buttons: z.array(ButtonSnapshotSchema),
  stepContext: StepContextSchema.nullable(),
  repeaters: z.array(RepeaterSnapshotSchema),
  fingerprint: FingerprintSchema,
  blocker: BlockerSnapshotSchema,
  actionHistory: z.array(ActionHistoryEntrySchema),
  guardrailHints: z.array(z.string()),
  observationConfidence: z.number().min(0).max(1),
  observedAt: z.number().nonnegative(),
}).strict();

export type PageDecisionContext = z.infer<typeof PageDecisionContextSchema>;

export const DecisionActionSchema = z.object({
  action: z.enum([
    'fill_form',
    'click_next',
    'click_apply',
    'upload_resume',
    'select_option',
    'dismiss_popup',
    'scroll_down',
    'login',
    'create_account',
    'enter_verification',
    'expand_repeaters',
    'wait_and_retry',
    'stop_for_review',
    'mark_complete',
    'report_blocked',
  ]),
  reasoning: z.string().min(1),
  target: z.string().optional(),
  confidence: z.number().min(0).max(1),
  fieldsToFill: z.array(z.string().min(1)).optional(),
  fieldValues: z.record(z.string(), z.string()).optional(),
}).strict();

export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const ExecutorResultSchema = z.object({
  status: z.enum([
    'action_succeeded',
    'action_failed_retryable',
    'action_failed_terminal',
    'needs_review',
  ]),
  layer: z.enum(['dom', 'stagehand', 'magnitude']).nullable(),
  fieldsAttempted: z.number().int().nonnegative(),
  fieldsFilled: z.number().int().nonnegative(),
  durationMs: z.number().min(0),
  costUsd: z.number().min(0),
  pageNavigated: z.boolean(),
  error: z.string().optional(),
  summary: z.string().min(1),
}).strict();

export type ExecutorResult = z.infer<typeof ExecutorResultSchema>;

export const DecisionLoopStateSchema = z.object({
  iteration: z.number().int().nonnegative(),
  pagesProcessed: z.number().int().nonnegative(),
  currentPageFingerprint: z.string().nullable(),
  previousPageFingerprint: z.string().nullable(),
  samePageCount: z.number().int().nonnegative(),
  actionHistory: z.array(ActionHistoryEntrySchema),
  loopCostUsd: z.number().min(0),
  terminalState: z.enum([
    'running',
    'confirmation',
    'review_page',
    'submitted',
    'blocked',
    'stuck',
    'budget_exceeded',
    'error',
    'max_iterations',
  ]),
  terminationReason: z.string().nullable(),
}).strict();

export type DecisionLoopState = z.infer<typeof DecisionLoopStateSchema>;
