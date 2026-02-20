/**
 * CookbookExecutor — Deterministic step replay engine.
 *
 * Replays an ActionManual's steps using LocatorResolver for element finding
 * and direct Playwright actions for execution. Zero LLM calls.
 */

import type { Page, Locator } from 'playwright';
import type { ActionManual, ManualStep } from './types';
import { LocatorResolver, type ResolveResult } from './LocatorResolver';
import { resolveOptionalTemplate } from './templateResolver';
import type { LogEventCallback } from '../events/JobEventTypes';

export interface ExecuteAllResult {
  success: boolean;
  stepsCompleted: number;
  failedStepIndex?: number;
  error?: string;
}

export interface ExecuteStepResult {
  success: boolean;
  strategy?: string;
  error?: string;
}

export interface CookbookExecutorOptions {
  /** Timeout for locator resolution per step in ms. Default: 3000 */
  resolverTimeout?: number;
  /** Default wait after each step in ms if step.waitAfter not set. Default: 0 */
  defaultWaitAfter?: number;
  /** Optional callback to log events to gh_job_events */
  logEvent?: LogEventCallback;
}

export class CookbookExecutor {
  private resolver: LocatorResolver;
  private defaultWaitAfter: number;
  private logEvent: LogEventCallback | null;

  constructor(options?: CookbookExecutorOptions) {
    this.resolver = new LocatorResolver({
      timeout: options?.resolverTimeout ?? 3000,
    });
    this.defaultWaitAfter = options?.defaultWaitAfter ?? 0;
    this.logEvent = options?.logEvent ?? null;
  }

  /**
   * Execute all steps of a manual in order.
   * Stops on first failure and returns the failed step index.
   */
  async executeAll(
    page: Page,
    manual: ActionManual,
    userData: Record<string, string> = {},
  ): Promise<ExecuteAllResult> {
    const sortedSteps = [...manual.steps].sort((a, b) => a.order - b.order);

    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i];

      if (this.logEvent) {
        await this.logEvent('cookbook_step_started', {
          step_index: i,
          total_steps: sortedSteps.length,
          action: step.action,
          description: step.description,
        }).catch(() => {});
      }

      const result = await this.executeStep(page, step, userData);

      if (!result.success) {
        if (this.logEvent) {
          await this.logEvent('cookbook_step_failed', {
            step_index: i,
            total_steps: sortedSteps.length,
            action: step.action,
            error: result.error,
          }).catch(() => {});
        }
        return {
          success: false,
          stepsCompleted: i,
          failedStepIndex: i,
          error: result.error,
        };
      }

      if (this.logEvent) {
        await this.logEvent('cookbook_step_completed', {
          step_index: i,
          total_steps: sortedSteps.length,
          action: step.action,
          strategy: result.strategy,
        }).catch(() => {});
      }
    }

    return { success: true, stepsCompleted: sortedSteps.length };
  }

  /**
   * Execute a single manual step.
   * Resolves the locator, performs the action, applies wait, then verifies.
   */
  async executeStep(
    page: Page,
    step: ManualStep,
    userData: Record<string, string> = {},
  ): Promise<ExecuteStepResult> {
    // Actions that don't need a locator
    if (step.action === 'navigate') {
      return this.executeNavigate(page, step, userData);
    }

    if (step.action === 'wait') {
      return this.executeWait(step);
    }

    // Resolve the element
    let resolved: ResolveResult;
    try {
      resolved = await this.resolver.resolve(page, step.locator);
    } catch (err: any) {
      return { success: false, error: `Locator resolution failed: ${err.message}` };
    }

    if (!resolved.locator) {
      return {
        success: false,
        error: `No element found for step ${step.order}: ${step.description ?? step.action}`,
      };
    }

    // Execute the action
    try {
      await this.performAction(resolved.locator, step, userData);
    } catch (err: any) {
      return {
        success: false,
        strategy: resolved.strategy,
        error: `Action "${step.action}" failed on step ${step.order}: ${err.message}`,
      };
    }

    // Wait after action
    const waitMs = step.waitAfter ?? this.defaultWaitAfter;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    return { success: true, strategy: resolved.strategy };
  }

  /** Perform the Playwright action on the resolved locator. */
  private async performAction(
    locator: Locator,
    step: ManualStep,
    userData: Record<string, string>,
  ): Promise<void> {
    const value = resolveOptionalTemplate(step.value, userData);

    switch (step.action) {
      case 'click':
        await locator.click();
        break;
      case 'fill':
        if (value === undefined) throw new Error('fill action requires a value');
        await locator.fill(value);
        break;
      case 'select':
        if (value === undefined) throw new Error('select action requires a value');
        await locator.selectOption(value);
        break;
      case 'check':
        await locator.check();
        break;
      case 'uncheck':
        await locator.uncheck();
        break;
      case 'hover':
        await locator.hover();
        break;
      case 'press':
        if (value === undefined) throw new Error('press action requires a value (key name)');
        await locator.press(value);
        break;
      case 'scroll':
        await locator.scrollIntoViewIfNeeded();
        break;
      default:
        throw new Error(`Unsupported action: ${step.action}`);
    }
  }

  private async executeNavigate(
    page: Page,
    step: ManualStep,
    userData: Record<string, string>,
  ): Promise<ExecuteStepResult> {
    const url = resolveOptionalTemplate(step.value, userData);
    if (!url) {
      return { success: false, error: 'navigate action requires a value (URL)' };
    }

    try {
      await page.goto(url);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Navigation failed: ${err.message}` };
    }
  }

  private async executeWait(step: ManualStep): Promise<ExecuteStepResult> {
    const ms = step.value ? parseInt(step.value, 10) : (step.waitAfter ?? 1000);
    if (isNaN(ms) || ms < 0) {
      return { success: false, error: 'wait action requires a valid duration in ms' };
    }
    await new Promise((r) => setTimeout(r, ms));
    return { success: true };
  }
}
