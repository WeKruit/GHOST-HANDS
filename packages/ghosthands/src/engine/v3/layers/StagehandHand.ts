/**
 * StagehandHand — Layer 2 ($0.0005/action). Stagehand a11y observe + DOM fill.
 *
 * Wraps ported StagehandAdapter + GenericPlatformConfig.
 * Observe: Stagehand observe() returns element descriptions via a11y tree + LLM.
 * Execute: DOM injection first (free), falls back to Stagehand act() on failure.
 * Review: DOM readback + a11y tree verification.
 */

import { LayerHand } from '../LayerHand';
import { DOMActionExecutor } from '../DOMActionExecutor';
import { FieldMatcher } from '../FieldMatcher';
import { VerificationEngine } from '../VerificationEngine';
import { getPlatformHandler } from '../platforms';
import type {
  LayerContext,
  V3ObservationResult,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  AnalysisResult,
  LayerError,
  FormField,
  BoundingBox,
} from '../types';
import type { BrowserAutomationAdapter, ObservedElement } from '../../../adapters/types';

export class StagehandHand extends LayerHand {
  readonly id = 'stagehand' as const;
  readonly displayName = 'Stagehand A11y';
  readonly costPerAction = 0.0005;
  readonly requiresLLM = true;

  constructor(private adapter: BrowserAutomationAdapter) {
    super();
  }

  async observe(ctx: LayerContext): Promise<V3ObservationResult> {
    const start = Date.now();
    const url = await ctx.page.url();

    // Use Stagehand observe() via adapter to get interactive elements
    let elements: ObservedElement[] = [];
    if (this.adapter.observe) {
      elements = (await this.adapter.observe('Find all interactive form fields, buttons, and inputs on this page')) ?? [];
    }

    // Enrich with boundingBox via DOM
    const fields: FormField[] = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const fieldInfo = await this.enrichWithDOM(ctx.page, el);
      if (fieldInfo) {
        fields.push({
          ...fieldInfo,
          id: `sh-${i}`,
          stagehandDescription: el.description,
        });
      }
    }

    // Also scan for buttons
    const buttons = await ctx.page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], [role="button"]');
      return Array.from(btns).map((b) => {
        const rect = b.getBoundingClientRect();
        return {
          selector: b.id ? `#${b.id}` : `button:has-text("${(b.textContent || '').trim().slice(0, 30)}")`,
          text: (b.textContent || '').trim(),
          disabled: (b as HTMLButtonElement).disabled || false,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    });

    const blockers = await this.detectBlockers(ctx.page);
    const costIncurred = elements.length > 0 ? 0.0005 : 0;

    return {
      fields,
      buttons,
      url,
      platform: ctx.platformHint ?? 'unknown',
      pageType: 'unknown',
      fingerprint: `${url}::stagehand::${fields.length}`,
      blockers,
      timestamp: Date.now(),
      observedBy: 'stagehand',
      costIncurred,
    };
  }

  async process(observation: V3ObservationResult, ctx: LayerContext): Promise<FieldMatch[]> {
    const userData = ctx.userProfile as Record<string, string>;
    const qaAnswers = (ctx.userProfile as any)?.qaAnswers ?? {};
    const matcher = new FieldMatcher(userData, qaAnswers, getPlatformHandler(observation.platform));

    // Build a v2 PageModel for the FieldMatcher
    const pageModel = {
      url: observation.url,
      platform: observation.platform,
      pageType: observation.pageType,
      fields: observation.fields.map((f) => ({
        id: f.id,
        selector: f.selector,
        automationId: f.automationId,
        name: f.name,
        fieldType: f.fieldType as any,
        fillStrategy: 'tier0' as any,
        isRequired: f.required,
        isVisible: f.visible,
        isDisabled: f.disabled,
        label: f.label || f.stagehandDescription || '',
        placeholder: f.placeholder,
        ariaLabel: f.ariaLabel,
        currentValue: f.currentValue ?? '',
        isEmpty: !f.currentValue || f.currentValue.trim() === '',
        boundingBox: f.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        absoluteY: f.boundingBox?.y ?? 0,
      })),
      buttons: [],
      timestamp: observation.timestamp,
    };

    const { matches } = matcher.match(pageModel as any);

    return matches.map((m) => ({
      field: observation.fields.find((f) => f.id === m.field.id) ?? observation.fields[0],
      userDataKey: m.userDataKey,
      value: m.value,
      confidence: m.confidence,
      matchMethod: m.matchMethod as FieldMatch['matchMethod'],
    }));
  }

  async execute(actions: PlannedAction[], ctx: LayerContext): Promise<ExecutionResult[]> {
    const domExecutor = new DOMActionExecutor(ctx.page, { type: 'mock' } as any);
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const start = Date.now();

      // Try DOM injection first (free)
      const v2Field = this.toV2Field(action.field);
      const domResult = await domExecutor.execute({
        field: v2Field,
        value: action.value,
        tier: 0,
        action: action.actionType as any,
        retryCount: 0,
        maxRetries: 2,
      });

      if (domResult.success) {
        results.push({
          success: true,
          layer: 'stagehand',
          field: action.field,
          valueApplied: action.value,
          costIncurred: 0, // DOM injection is free even when done by StagehandHand
          durationMs: Date.now() - start,
          boundingBoxAtExecution: action.field.boundingBox,
        });
        continue;
      }

      // Fallback: Use Stagehand act() (costs LLM call)
      try {
        const prompt = action.actionType === 'fill' || action.actionType === 'clear_and_fill'
          ? `Fill the "${action.field.label}" field with "${action.value}"`
          : action.actionType === 'click'
          ? `Click the "${action.field.label}" element`
          : action.actionType === 'select'
          ? `Select "${action.value}" in the "${action.field.label}" dropdown`
          : `Interact with "${action.field.label}"`;

        const actResult = await this.adapter.act(prompt);

        results.push({
          success: actResult.success,
          layer: 'stagehand',
          field: action.field,
          valueApplied: action.value,
          costIncurred: 0.0005,
          durationMs: Date.now() - start,
          error: actResult.success ? undefined : actResult.message,
          boundingBoxAtExecution: action.field.boundingBox,
        });
      } catch (err) {
        results.push({
          success: false,
          layer: 'stagehand',
          field: action.field,
          valueApplied: action.value,
          costIncurred: 0.0005,
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
          reviewedBy: 'stagehand',
        });
        continue;
      }

      const v2Field = this.toV2Field(action.field);
      const verification = await verifier.verify(v2Field, action.value);
      reviews.push({
        verified: verification.passed,
        field: action.field,
        expected: action.value,
        actual: verification.actual,
        reason: verification.reason,
        reviewedBy: 'stagehand',
      });
    }

    return reviews;
  }

  async analyze(
    observation: V3ObservationResult,
    _history: V3ObservationResult[],
    ctx: LayerContext,
  ): Promise<AnalysisResult> {
    // Use Stagehand extract() for deeper analysis if adapter supports it
    let discoveredFields: FormField[] = [];
    let costIncurred = 0;

    try {
      const extracted = await this.adapter.extract(
        'List all form fields on this page that are not yet filled, including their labels and types',
        require('zod').z.array(
          require('zod').z.object({
            label: require('zod').z.string(),
            type: require('zod').z.string(),
            selector: require('zod').z.string().optional(),
          }),
        ),
      ) as Array<{ label: string; type: string; selector?: string }>;

      costIncurred = 0.001;
      const knownSelectors = new Set(observation.fields.map((f) => f.selector));
      discoveredFields = extracted
        .filter((e) => e.selector && !knownSelectors.has(e.selector))
        .map((e: any, i: number) => ({
          id: `analyze-${i}`,
          selector: e.selector || '',
          fieldType: 'unknown' as const,
          label: e.label,
          required: false,
          visible: true,
          disabled: false,
        }));
    } catch {
      // Extract failed — return empty analysis
    }

    return { discoveredFields, suggestedValues: [], costIncurred };
  }

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    const category = this.classifyError(error);
    return {
      category,
      message: error instanceof Error ? error.message : String(error),
      layer: 'stagehand',
      recoverable: category !== 'browser_disconnected',
      shouldEscalate: true, // Stagehand failures should try Magnitude next
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async enrichWithDOM(
    page: import('playwright').Page,
    el: ObservedElement,
  ): Promise<Omit<FormField, 'id' | 'stagehandDescription'> | null> {
    try {
      const info = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const input = element as HTMLInputElement;

        return {
          selector,
          fieldType: input.type || element.tagName.toLowerCase(),
          label:
            input.labels?.[0]?.textContent?.trim() ||
            element.getAttribute('aria-label') ||
            element.getAttribute('placeholder') ||
            '',
          name: element.getAttribute('name') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          ariaLabel: element.getAttribute('aria-label') || undefined,
          automationId:
            element.getAttribute('data-automation-id') ||
            element.getAttribute('data-testid') ||
            undefined,
          required: input.required || element.getAttribute('aria-required') === 'true',
          currentValue: input.value || '',
          visible: rect.width > 0 && rect.height > 0,
          disabled: input.disabled || false,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }, el.selector);

      if (!info) return null;

      return {
        selector: info.selector,
        fieldType: this.mapFieldType(info.fieldType),
        label: info.label,
        name: info.name,
        placeholder: info.placeholder,
        ariaLabel: info.ariaLabel,
        automationId: info.automationId,
        required: info.required,
        currentValue: info.currentValue,
        visible: info.visible,
        disabled: info.disabled,
        boundingBox: info.boundingBox,
      };
    } catch {
      return null;
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

  private toV2Field(field: FormField): any {
    return {
      id: field.id,
      selector: field.selector,
      automationId: field.automationId,
      name: field.name,
      fieldType: field.fieldType,
      fillStrategy: 'tier0',
      isRequired: field.required,
      isVisible: field.visible,
      isDisabled: field.disabled,
      label: field.label,
      placeholder: field.placeholder,
      ariaLabel: field.ariaLabel,
      currentValue: field.currentValue ?? '',
      isEmpty: true,
      boundingBox: field.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
      absoluteY: field.boundingBox?.y ?? 0,
    };
  }
}
