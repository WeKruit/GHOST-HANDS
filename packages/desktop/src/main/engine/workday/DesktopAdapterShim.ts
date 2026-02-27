/**
 * DesktopAdapterShim — wraps Magnitude's BrowserAgent to match the
 * BrowserAutomationAdapter interface that the staging Workday pipeline expects.
 *
 * Only the methods actually used by the pipeline are implemented:
 *   act(), extract(), getCurrentUrl(), navigate(), page
 */

import type { ZodSchema } from 'zod';

/** Minimal subset of BrowserAutomationAdapter used by the Workday pipeline. */
export interface MinimalAdapter {
  act(instruction: string): Promise<{ success: boolean; message: string; durationMs: number }>;
  extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T>;
  getCurrentUrl(): Promise<string>;
  navigate(url: string): Promise<void>;
  get page(): any; // Playwright Page
}

/**
 * Wraps a Magnitude BrowserAgent so the staging Workday code can use it
 * through the MinimalAdapter interface.
 */
export class DesktopAdapterShim implements MinimalAdapter {
  private agent: any;

  constructor(agent: any) {
    this.agent = agent;
  }

  async act(instruction: string): Promise<{ success: boolean; message: string; durationMs: number }> {
    const start = Date.now();
    try {
      await this.agent.act(instruction);
      return { success: true, message: 'ok', durationMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message, durationMs: Date.now() - start };
    }
  }

  async extract<T>(instruction: string, schema: ZodSchema<T>): Promise<T> {
    return this.agent.extract(instruction, schema);
  }

  async getCurrentUrl(): Promise<string> {
    return this.agent.page.url();
  }

  async navigate(url: string): Promise<void> {
    await this.agent.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  get page(): any {
    return this.agent.page;
  }
}
