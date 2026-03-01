/**
 * MagnitudeHand — Layer 3 ($0.005/action). Full GUI agent with vision LLM.
 *
 * Wraps existing MagnitudeAdapter from staging.
 * Uses adapter.exec() for cheap direct actions when possible.
 * Falls back to adapter.act() for complex interactions requiring LLM planning.
 * This is the top layer — throwError sets recoverable based on error type.
 */

import { LayerHand } from '../LayerHand';
import { VerificationEngine } from '../VerificationEngine';
import { toV2FieldModel, toV2PageModel } from '../v2compat';
import type {
  LayerContext,
  V3ObservationResult,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  LayerError,
  FormField,
} from '../types';
import type { BrowserAutomationAdapter } from '../../../adapters/types';

export class MagnitudeHand extends LayerHand {
  readonly id = 'magnitude' as const;
  readonly displayName = 'Magnitude GUI Agent';
  readonly costPerAction = 0.005;
  readonly requiresLLM = true;

  private totalTokenCost = 0;

  constructor(private adapter: BrowserAutomationAdapter) {
    super();
    // Track token costs from adapter events
    this.adapter.on('tokensUsed', (usage: { inputCost?: number; outputCost?: number }) => {
      this.totalTokenCost += (usage.inputCost ?? 0) + (usage.outputCost ?? 0);
    });
  }

  async observe(ctx: LayerContext): Promise<V3ObservationResult> {
    const url = ctx.page.url();

    // Magnitude observe uses screenshot + StagehandObserver
    let fields: FormField[] = [];
    let costIncurred = 0;

    // Try adapter.observe() if available
    if (this.adapter.observe) {
      const elements = await this.adapter.observe('Identify all interactive form fields, dropdowns, checkboxes, radio buttons, file uploads, and buttons on this page') ?? [];
      costIncurred = 0.001;

      fields = await Promise.all(
        elements.map(async (el, i) => {
          const info = await ctx.page.evaluate((selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const input = element as HTMLInputElement;
            return {
              type: input.type || element.tagName.toLowerCase(),
              label: input.labels?.[0]?.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '',
              name: element.getAttribute('name') || undefined,
              required: input.required || element.getAttribute('aria-required') === 'true',
              currentValue: input.value || '',
              visible: rect.width > 0 && rect.height > 0,
              disabled: input.disabled || false,
              boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              automationId: element.getAttribute('data-automation-id') || element.getAttribute('data-testid') || undefined,
            };
          }, el.selector).catch(() => null);

          const field: FormField = {
            id: `mag-${i}`,
            selector: el.selector,
            fieldType: this.mapFieldType(info?.type ?? 'unknown'),
            label: info?.label || el.description,
            name: info?.name,
            automationId: info?.automationId,
            required: info?.required ?? false,
            currentValue: info?.currentValue,
            visible: info?.visible ?? true,
            disabled: info?.disabled ?? false,
            boundingBox: info?.boundingBox,
            stagehandDescription: el.description,
          };
          return field;
        }),
      );
    }

    // P2-1: CSS.escape for button IDs
    const buttons = await ctx.page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], [role="button"]');
      return Array.from(btns).map((b) => {
        const rect = b.getBoundingClientRect();
        return {
          selector: b.id ? `#${CSS.escape(b.id)}` : '',
          text: (b.textContent || '').trim(),
          disabled: (b as HTMLButtonElement).disabled || false,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    });

    const blockers = await this.detectBlockers(ctx.page);

    return {
      fields,
      buttons,
      url,
      platform: ctx.platformHint ?? 'unknown',
      pageType: 'unknown',
      fingerprint: `${url}::magnitude::${fields.length}`,
      blockers,
      timestamp: Date.now(),
      observedBy: 'magnitude',
      costIncurred,
    };
  }

  async process(observation: V3ObservationResult, ctx: LayerContext): Promise<FieldMatch[]> {
    // Magnitude can use LLM vision to match fields — but first try heuristic
    const { FieldMatcher } = await import('../FieldMatcher');
    const { getPlatformHandler } = await import('../platforms');

    const userData = ctx.userProfile as Record<string, string>;
    const qaAnswers = (ctx.userProfile as Record<string, unknown>)?.qaAnswers as Record<string, string> ?? {};
    const matcher = new FieldMatcher(userData, qaAnswers, getPlatformHandler(observation.platform));

    // Use stagehand descriptions as label fallback
    const pageModel = toV2PageModel(observation);
    for (let i = 0; i < pageModel.fields.length; i++) {
      const v3Field = observation.fields[i];
      if ((!pageModel.fields[i].label || pageModel.fields[i].label.trim() === '') && v3Field?.stagehandDescription) {
        pageModel.fields[i].label = v3Field.stagehandDescription;
      }
    }

    const { matches } = matcher.match(pageModel);

    // Filter out matches where the v3 field can't be found — falling back to fields[0]
    // would silently map the wrong value to the wrong field.
    return matches
      .map((m) => {
        const v3Field = observation.fields.find((f) => f.id === m.field.id);
        if (!v3Field) return null;
        return {
          field: v3Field,
          userDataKey: m.userDataKey,
          value: m.value,
          confidence: m.confidence,
          matchMethod: m.matchMethod as FieldMatch['matchMethod'],
        };
      })
      .filter((m): m is FieldMatch => m !== null);
  }

  async execute(actions: PlannedAction[], ctx: LayerContext): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const start = Date.now();
      const costBefore = this.totalTokenCost;

      try {
        // Try direct exec() first if adapter supports it (cheaper than act())
        if (this.adapter.exec && action.field.boundingBox) {
          await this.executeViaExec(action);
        } else {
          // Fall back to act() for full LLM-guided execution
          await this.executeViaAct(action);
        }

        results.push({
          success: true,
          layer: 'magnitude',
          field: action.field,
          valueApplied: action.value,
          costIncurred: this.totalTokenCost - costBefore,
          durationMs: Date.now() - start,
          boundingBoxAtExecution: action.field.boundingBox,
        });
      } catch (err) {
        results.push({
          success: false,
          layer: 'magnitude',
          field: action.field,
          valueApplied: action.value,
          costIncurred: this.totalTokenCost - costBefore,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  async review(
    actions: PlannedAction[],
    results: ExecutionResult[],
    ctx: LayerContext,
  ): Promise<ReviewResult[]> {
    // DOM readback first (free)
    const verifier = new VerificationEngine(ctx.page);
    const reviews: ReviewResult[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const result = results[i];

      if (!result?.success) {
        reviews.push({
          verified: false,
          field: action.field,
          expected: action.value,
          actual: '',
          reason: result?.error ?? 'Execution failed',
          reviewedBy: 'magnitude',
        });
        continue;
      }

      const v2Field = toV2FieldModel(action.field);
      const verification = await verifier.verify(v2Field, action.value);
      reviews.push({
        verified: verification.passed,
        field: action.field,
        expected: action.value,
        actual: verification.actual,
        reason: verification.reason,
        reviewedBy: 'magnitude',
      });
    }

    return reviews;
  }

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    const category = this.classifyError(error);
    return {
      category,
      message: error instanceof Error ? error.message : String(error),
      layer: 'magnitude',
      recoverable: category !== 'browser_disconnected' && category !== 'budget_exceeded',
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Execute via adapter.exec() — direct action, bypasses LLM planning.
   * Dramatically cheaper than act().
   */
  private async executeViaExec(action: PlannedAction): Promise<void> {
    if (action.actionType === 'fill' || action.actionType === 'clear_and_fill') {
      // Click the field, then type
      await this.adapter.exec!({ variant: 'click', target: action.field.label });
      await this.adapter.exec!({ variant: 'type', target: action.field.label, content: action.value });
    } else if (action.actionType === 'click' || action.actionType === 'check') {
      await this.adapter.exec!({ variant: 'click', target: action.field.label });
    } else if (action.actionType === 'select') {
      // Click to open, then click option
      await this.adapter.exec!({ variant: 'click', target: action.field.label });
      await this.adapter.exec!({ variant: 'click', target: action.value });
    } else {
      // Fallback to act()
      await this.executeViaAct(action);
    }
  }

  /**
   * Execute via adapter.act() — full LLM-guided action.
   */
  private async executeViaAct(action: PlannedAction): Promise<void> {
    const instruction =
      action.actionType === 'fill' || action.actionType === 'clear_and_fill'
        ? `Fill the "${action.field.label}" field with "${action.value}". Do not interact with any other fields.`
        : action.actionType === 'click' || action.actionType === 'check'
        ? `Click on "${action.field.label}".`
        : action.actionType === 'select'
        ? `Select "${action.value}" in the "${action.field.label}" dropdown.`
        : `Interact with "${action.field.label}" to set value "${action.value}".`;

    const result = await this.adapter.act(instruction);
    if (!result.success) {
      throw new Error(result.message);
    }
  }

  private mapFieldType(type: string): FormField['fieldType'] {
    const map: Record<string, FormField['fieldType']> = {
      text: 'text', email: 'email', tel: 'tel', url: 'url',
      number: 'number', password: 'password', textarea: 'textarea',
      select: 'select', radio: 'radio', checkbox: 'checkbox',
      date: 'date', file: 'file', hidden: 'hidden',
    };
    return map[type.toLowerCase()] ?? 'unknown';
  }
}
