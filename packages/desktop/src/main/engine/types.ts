/**
 * Core types for the GhostHands cookbook engine.
 *
 * LocatorDescriptor, ManualStep, ActionManual, and related
 * types used by LocatorResolver, CookbookExecutor, and LocalManualStore.
 *
 * Copied from packages/ghosthands/src/engine/types.ts for bundling isolation.
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
