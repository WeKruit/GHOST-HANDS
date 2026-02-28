/**
 * CookbookExecutorV3 — Dual-mode cookbook replay engine.
 *
 * Unlike v1 CookbookExecutor (Playwright locator replay), v3 uses two strategies:
 *   1. DOM-first replay: nativeInputValueSetter for fills, selector clicks (free)
 *   2. GUI fallback: coordinate-based click/type via Magnitude exec() (cheap)
 *
 * Per-action health scoring determines which strategy to use for each step.
 * If a step's health drops below threshold, it's skipped and the page is
 * re-observed to handle any conditional fields that may have appeared.
 */

import { DOMActionExecutor } from './DOMActionExecutor';
import { VerificationEngine } from './VerificationEngine';
import type { Page } from 'playwright';
import type {
  CookbookAction,
  CookbookPageEntry,
  BoundingBox,
  ActionType,
} from './types';
import type { FieldModel } from './v2types';
import type { BrowserAutomationAdapter } from '../../adapters/types';

export interface CookbookV3Result {
  success: boolean;
  actionsAttempted: number;
  actionsSucceeded: number;
  actionsFailed: number;
  costIncurred: number;
  failedAt?: number;
  error?: string;
}

export interface CookbookV3Options {
  /** Adapter for GUI fallback (optional — DOM-only if not provided) */
  adapter?: BrowserAutomationAdapter;
  /** Minimum per-action health to attempt (0-1) */
  minActionHealth?: number;
  /** Maximum consecutive failures before aborting */
  maxConsecutiveFailures?: number;
  /** Callback for logging events */
  logEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;
}

const DEFAULT_MIN_ACTION_HEALTH = 0.3;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export class CookbookExecutorV3 {
  private adapter?: BrowserAutomationAdapter;
  private minActionHealth: number;
  private maxConsecutiveFailures: number;
  private logEvent?: (eventType: string, metadata: Record<string, unknown>) => Promise<void>;

  constructor(options: CookbookV3Options = {}) {
    this.adapter = options.adapter;
    this.minActionHealth = options.minActionHealth ?? DEFAULT_MIN_ACTION_HEALTH;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.logEvent = options.logEvent;
  }

  /**
   * Execute all actions in a cookbook page entry.
   * Resolves templates ({{fieldName}}) against user data before execution.
   */
  async execute(
    page: Page,
    entry: CookbookPageEntry,
    userData: Record<string, string>,
  ): Promise<CookbookV3Result> {
    const result: CookbookV3Result = {
      success: false,
      actionsAttempted: 0,
      actionsSucceeded: 0,
      actionsFailed: 0,
      costIncurred: 0,
    };

    const domExecutor = new DOMActionExecutor(page, { type: 'mock' } as any);
    const verifier = new VerificationEngine(page);
    let consecutiveFailures = 0;

    for (let i = 0; i < entry.actions.length; i++) {
      const action = entry.actions[i];
      const actionHealth = entry.perActionHealth[i] ?? entry.healthScore;

      // Skip low-health actions
      if (actionHealth < this.minActionHealth) {
        await this.logEvent?.('cookbook_action_skipped', {
          index: i,
          label: action.fieldSnapshot.label,
          health: actionHealth,
          reason: 'below_threshold',
        });
        continue;
      }

      // Resolve template value
      const value = this.resolveTemplate(action.domAction.valueTemplate, userData);
      if (value === null) {
        await this.logEvent?.('cookbook_action_skipped', {
          index: i,
          label: action.fieldSnapshot.label,
          reason: 'unresolvable_template',
          template: action.domAction.valueTemplate,
        });
        continue;
      }

      result.actionsAttempted++;

      // Strategy 1: DOM-first replay (free)
      const domSuccess = await this.tryDOMReplay(
        domExecutor,
        action,
        value,
        verifier,
      );

      if (domSuccess) {
        result.actionsSucceeded++;
        consecutiveFailures = 0;
        await this.logEvent?.('cookbook_action_success', {
          index: i,
          label: action.fieldSnapshot.label,
          strategy: 'dom',
        });
        continue;
      }

      // Strategy 2: GUI fallback via Magnitude exec() (cheap)
      if (this.adapter?.exec && action.guiAction) {
        const guiSuccess = await this.tryGUIReplay(action, value);
        if (guiSuccess) {
          result.actionsSucceeded++;
          result.costIncurred += 0.001; // Cheap exec() call
          consecutiveFailures = 0;
          await this.logEvent?.('cookbook_action_success', {
            index: i,
            label: action.fieldSnapshot.label,
            strategy: 'gui',
          });
          continue;
        }
      }

      // Both strategies failed
      result.actionsFailed++;
      consecutiveFailures++;

      await this.logEvent?.('cookbook_action_failed', {
        index: i,
        label: action.fieldSnapshot.label,
      });

      if (consecutiveFailures >= this.maxConsecutiveFailures) {
        result.error = `${this.maxConsecutiveFailures} consecutive failures at action ${i}`;
        result.failedAt = i;
        return result;
      }
    }

    // Success if we completed more than half the actions
    result.success = result.actionsSucceeded > 0 &&
      result.actionsFailed <= result.actionsSucceeded * 0.3;

    return result;
  }

  /**
   * Try DOM-first replay: use nativeInputValueSetter + selector click.
   */
  private async tryDOMReplay(
    executor: DOMActionExecutor,
    action: CookbookAction,
    value: string,
    verifier: VerificationEngine,
  ): Promise<boolean> {
    try {
      const v2Field: FieldModel = {
        id: action.fieldSnapshot.id,
        selector: action.fieldSnapshot.selector,
        automationId: action.fieldSnapshot.automationId,
        name: action.fieldSnapshot.name,
        fieldType: action.fieldSnapshot.fieldType as any,
        fillStrategy: 'native_setter',
        isRequired: action.fieldSnapshot.required ?? false,
        isVisible: true,
        isDisabled: false,
        label: action.fieldSnapshot.label,
        placeholder: action.fieldSnapshot.placeholder,
        ariaLabel: action.fieldSnapshot.ariaLabel,
        currentValue: '',
        isEmpty: true,
        boundingBox: action.fieldSnapshot.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        absoluteY: action.fieldSnapshot.boundingBox?.y ?? 0,
      };

      const execResult = await executor.execute({
        field: v2Field,
        value,
        tier: 0,
        action: action.domAction.action as any,
        retryCount: 0,
        maxRetries: 1,
      });

      if (!execResult.success) return false;

      // Verify the value was applied
      const verification = await verifier.verify(v2Field, value);
      return verification.passed;
    } catch {
      return false;
    }
  }

  /**
   * Try GUI replay: use coordinate-based click/type via adapter.exec().
   */
  private async tryGUIReplay(
    action: CookbookAction,
    value: string,
  ): Promise<boolean> {
    if (!this.adapter?.exec || !action.guiAction) return false;

    try {
      if (action.guiAction.variant === 'type') {
        // Click the target location, then type
        await this.adapter.exec({
          variant: 'click',
          target: action.fieldSnapshot.label,
        });
        await this.adapter.exec({
          variant: 'type',
          target: action.fieldSnapshot.label,
          content: value,
        });
      } else if (action.guiAction.variant === 'click') {
        await this.adapter.exec({
          variant: 'click',
          target: action.fieldSnapshot.label,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a template string like "{{firstName}}" against user data.
   * Returns null if the template references a key not in userData.
   */
  private resolveTemplate(
    template: string,
    userData: Record<string, string>,
  ): string | null {
    const match = template.match(/^\{\{(.+)\}\}$/);
    if (!match) return template; // Literal value, no template

    const key = match[1];

    // Try exact match
    if (userData[key] !== undefined) return userData[key];

    // Try case-insensitive match
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(userData)) {
      if (k.toLowerCase() === lowerKey) return v;
    }

    return null;
  }
}
