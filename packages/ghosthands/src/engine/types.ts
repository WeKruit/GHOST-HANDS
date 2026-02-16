/**
 * Core types for the GhostHands cookbook engine.
 *
 * LocatorDescriptor, ManualStep, ActionManual, PageObservation, and related
 * types used by LocatorResolver, CookbookExecutor, TraceRecorder, and ManualStore.
 */

import { z } from 'zod';

// ── LocatorDescriptor ────────────────────────────────────────────────────
// Multi-strategy element locator. LocatorResolver tries strategies in
// priority order: testId > role > ariaLabel > name > id > text > css > xpath

export const LocatorDescriptorSchema = z.object({
  testId: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  ariaLabel: z.string().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  xpath: z.string().optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'LocatorDescriptor must have at least one strategy defined' },
);

export type LocatorDescriptor = z.infer<typeof LocatorDescriptorSchema>;

// ── ManualStep ───────────────────────────────────────────────────────────

export const ManualStepSchema = z.object({
  order: z.number().int().nonnegative(),
  locator: LocatorDescriptorSchema,
  action: z.enum(['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'press', 'navigate', 'wait', 'scroll']),
  value: z.string().optional(),
  description: z.string().optional(),
  waitAfter: z.number().nonnegative().optional(),
  verification: z.string().optional(),
  healthScore: z.number().min(0).max(1).default(1.0),
});

export type ManualStep = z.infer<typeof ManualStepSchema>;

// ── ActionManual ─────────────────────────────────────────────────────────

export const ManualSourceSchema = z.enum(['recorded', 'actionbook', 'template']);
export type ManualSource = z.infer<typeof ManualSourceSchema>;

export const ActionManualSchema = z.object({
  id: z.string().uuid(),
  url_pattern: z.string(),
  task_pattern: z.string(),
  platform: z.string(),
  steps: z.array(ManualStepSchema).min(1),
  health_score: z.number().min(0).max(1).default(1.0),
  source: ManualSourceSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ActionManual = z.infer<typeof ActionManualSchema>;

// ── Observation types ────────────────────────────────────────────────────

export const FieldObservationSchema = z.object({
  selector: z.string(),
  label: z.string().optional(),
  type: z.string(),
  name: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
});

export type FieldObservation = z.infer<typeof FieldObservationSchema>;

export const FormObservationSchema = z.object({
  selector: z.string(),
  action: z.string().optional(),
  method: z.string().optional(),
  fields: z.array(FieldObservationSchema),
});

export type FormObservation = z.infer<typeof FormObservationSchema>;

export const ButtonObservationSchema = z.object({
  selector: z.string(),
  text: z.string(),
  type: z.string().optional(),
  disabled: z.boolean().optional(),
});

export type ButtonObservation = z.infer<typeof ButtonObservationSchema>;

export const NavObservationSchema = z.object({
  selector: z.string(),
  text: z.string(),
  href: z.string().optional(),
});

export type NavObservation = z.infer<typeof NavObservationSchema>;

export const PageObservationSchema = z.object({
  url: z.string(),
  platform: z.string(),
  pageType: z.string(),
  fingerprint: z.string(),
  forms: z.array(FormObservationSchema),
  buttons: z.array(ButtonObservationSchema),
  navigation: z.array(NavObservationSchema),
  urlPattern: z.string(),
  structureHash: z.string(),
});

export type PageObservation = z.infer<typeof PageObservationSchema>;

// ── BlockerDetection ─────────────────────────────────────────────────────
// Mirrors Sprint 1 BlockerDetector types with added selectors array

export const BlockerTypeSchema = z.enum(['captcha', 'login', '2fa', 'bot_check']);
export type BlockerType = z.infer<typeof BlockerTypeSchema>;

export const BlockerDetectionSchema = z.object({
  type: BlockerTypeSchema,
  confidence: z.number().min(0).max(1),
  screenshot: z.string().optional(),
  description: z.string(),
  selectors: z.array(z.string()).optional(),
});

export type BlockerDetection = z.infer<typeof BlockerDetectionSchema>;

// ── ObservedElement ──────────────────────────────────────────────────────
// Mapped from Stagehand Action observation results

export const ObservedElementSchema = z.object({
  selector: z.string(),
  description: z.string(),
  action: z.enum(['click', 'fill', 'select', 'check', 'hover', 'navigate', 'scroll', 'press', 'unknown']),
});

export type ObservedElement = z.infer<typeof ObservedElementSchema>;
