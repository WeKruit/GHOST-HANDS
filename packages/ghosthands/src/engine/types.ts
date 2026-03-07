/**
 * Core types for the GhostHands engine.
 *
 * PageObservation, BlockerDetection, ObservedElement, and related types
 * used by PageObserver, StagehandObserver, and the adapter layer.
 */

import { z } from 'zod';

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

export const BlockerTypeSchema = z.enum(['captcha', 'login', '2fa', 'bot_check', 'rate_limited', 'verification']);
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

export const ObservedElementSchema = z.object({
  selector: z.string(),
  description: z.string(),
  action: z.enum(['click', 'fill', 'select', 'check', 'hover', 'navigate', 'scroll', 'press', 'unknown']),
});

export type ObservedElement = z.infer<typeof ObservedElementSchema>;
