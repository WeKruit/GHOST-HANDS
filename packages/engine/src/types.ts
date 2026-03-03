/**
 * Types and schemas for @wekruit/ghosthands-engine.
 *
 * This file defines:
 * - Desktop-facing types (EngineConfig, EngineProfile, RunParams, RunResult, ProgressEvent)
 * - ManualStore interface (dependency injection — desktop provides implementation)
 * - Cookbook types and Zod schemas (ActionManual, ManualStep, LocatorDescriptor)
 */

import { z } from 'zod';

// ── Engine configuration ──────────────────────────────────────────────

export interface EngineConfig {
  anthropicApiKey: string;
  model?: string;
  headless?: boolean;
}

// ── User profile ──────────────────────────────────────────────────────

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  gpa?: string;
  startDate: string;
  endDate?: string;
}

export interface ExperienceEntry {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string;
  description: string;
}

export interface EngineProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedIn?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  skills?: string[];
  qaAnswers?: Record<string, string>;
  workAuthorization?: string;
  visaSponsorship?: string;
  gender?: string;
  raceEthnicity?: string;
  veteranStatus?: string;
  disabilityStatus?: string;
}

// ── Progress events ───────────────────────────────────────────────────

export interface ProgressEvent {
  type: 'action' | 'thought' | 'screenshot' | 'status' | 'error' | 'complete';
  message?: string;
  screenshot?: string;
  step?: number;
  totalSteps?: number;
  timestamp: number;
}

// ── ManualStore interface ─────────────────────────────────────────────

export interface ManualStore {
  lookup(url: string, taskType: string, platform?: string): ActionManual | null;
  save(manual: ActionManual): void;
}

// ── Run parameters and result ─────────────────────────────────────────

export interface RunParams {
  targetUrl: string;
  profile: EngineProfile;
  resumePath?: string;
  manualStore: ManualStore;
  onProgress: (event: ProgressEvent) => void;
}

export interface RunResult {
  success: boolean;
  message: string;
}

// ── Cookbook types and Zod schemas ─────────────────────────────────────
// Copied from packages/ghosthands/src/engine/types.ts to keep the
// engine package standalone (no internal monorepo imports).

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

export const ManualSourceSchema = z.enum(['recorded', 'actionbook', 'template']);
export type ManualSource = z.infer<typeof ManualSourceSchema>;

export const ActionManualSchema = z.object({
  id: z.string(),
  url_pattern: z.string(),
  task_pattern: z.string(),
  platform: z.string(),
  steps: z.array(ManualStepSchema),
  health_score: z.number().min(0).max(1).default(1.0),
  source: ManualSourceSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type ActionManual = z.infer<typeof ActionManualSchema>;

// ── Log event callback (for CookbookExecutor) ────────────────────────

export type LogEventCallback = (eventType: string, metadata: Record<string, any>) => Promise<void>;
