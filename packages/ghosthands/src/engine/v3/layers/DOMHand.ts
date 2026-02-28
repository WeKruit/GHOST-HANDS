/**
 * DOMHand — Layer 1 ($0/action). Pure DOM injection, zero LLM.
 *
 * Wraps ported v2 implementations:
 *   - PageScanner (scroll+extract)
 *   - FieldMatcher (7-strategy cascade)
 *   - DOMActionExecutor (nativeInputValueSetter)
 *   - VerificationEngine (DOM readback)
 */

import { LayerHand } from '../LayerHand';
import { PageScanner } from '../PageScanner';
import { FieldMatcher } from '../FieldMatcher';
import { DOMActionExecutor } from '../DOMActionExecutor';
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
  FormSection,
} from '../types';
import type { FieldModel, PageModel } from '../v2types';

/**
 * Convert a v2 FieldModel (from ported PageScanner) to a v3 FormField.
 */
function fieldModelToFormField(fm: FieldModel): FormField {
  return {
    id: fm.id,
    selector: fm.selector,
    automationId: fm.automationId,
    fieldType: mapV2FieldType(fm.fieldType),
    label: fm.label,
    name: fm.name,
    placeholder: fm.placeholder,
    ariaLabel: fm.ariaLabel,
    required: fm.isRequired,
    currentValue: fm.currentValue,
    options: fm.options,
    boundingBox: fm.boundingBox,
    visible: fm.isVisible,
    disabled: fm.isDisabled,
  };
}

function mapV2FieldType(ft: string): FormField['fieldType'] {
  const map: Record<string, FormField['fieldType']> = {
    text: 'text',
    email: 'email',
    phone: 'tel',
    number: 'number',
    password: 'password',
    textarea: 'textarea',
    select: 'select',
    custom_dropdown: 'searchable_select',
    typeahead: 'searchable_select',
    radio: 'radio',
    aria_radio: 'radio',
    checkbox: 'checkbox',
    date: 'date',
    file: 'file',
    contenteditable: 'text',
    hidden: 'hidden',
  };
  return map[ft] ?? 'unknown';
}

export class DOMHand extends LayerHand {
  readonly id = 'dom' as const;
  readonly displayName = 'DOM Injection';
  readonly costPerAction = 0;
  readonly requiresLLM = false;

  async observe(ctx: LayerContext): Promise<V3ObservationResult> {
    const scanner = new PageScanner(ctx.page, ctx.platformHint ?? 'unknown');
    const pageModel: PageModel = await scanner.scan();

    const fields: FormField[] = pageModel.fields.map(fieldModelToFormField);
    const buttons = pageModel.buttons.map((b) => ({
      selector: b.selector,
      text: b.text,
      boundingBox: b.boundingBox,
      disabled: b.isDisabled,
    }));

    // Generate fingerprint from URL + field structure
    const fingerprint = `${pageModel.url}::${fields.map((f) => f.selector).join(',')}`.slice(0, 256);

    const blockers = await this.detectBlockers(ctx.page);

    return {
      fields,
      buttons,
      url: pageModel.url,
      platform: pageModel.platform,
      pageType: pageModel.pageType,
      fingerprint,
      blockers,
      timestamp: Date.now(),
      observedBy: 'dom',
      costIncurred: 0,
    };
  }

  async process(observation: V3ObservationResult, ctx: LayerContext): Promise<FieldMatch[]> {
    const userData = ctx.userProfile as Record<string, string>;
    const qaAnswers = (ctx.userProfile as any)?.qaAnswers ?? {};
    const matcher = new FieldMatcher(userData, qaAnswers, getPlatformHandler(observation.platform));

    // Convert v3 FormFields back to v2 FieldModel for the ported FieldMatcher
    const pageModel: PageModel = {
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
        label: f.label,
        placeholder: f.placeholder,
        ariaLabel: f.ariaLabel,
        currentValue: f.currentValue ?? '',
        isEmpty: !f.currentValue || f.currentValue.trim() === '',
        boundingBox: f.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        absoluteY: f.boundingBox?.y ?? 0,
      })),
      buttons: observation.buttons.map((b) => ({
        selector: b.selector,
        text: b.text,
        automationId: undefined,
        role: 'unknown' as any,
        boundingBox: b.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        isDisabled: b.disabled ?? false,
      })),
      timestamp: observation.timestamp,
      scrollHeight: 0,
      viewportHeight: 0,
    };

    const { matches } = matcher.match(pageModel);

    // Convert v2 FieldMatch to v3 FieldMatch
    return matches.map((m) => ({
      field: observation.fields.find((f) => f.id === m.field.id) ?? observation.fields[0],
      userDataKey: m.userDataKey,
      value: m.value,
      confidence: m.confidence,
      matchMethod: m.matchMethod as FieldMatch['matchMethod'],
    }));
  }

  async execute(actions: PlannedAction[], ctx: LayerContext): Promise<ExecutionResult[]> {
    const executor = new DOMActionExecutor(ctx.page, { type: 'mock' } as any);
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const start = Date.now();

      // Use the v2 DOMActionExecutor's Tier 0 path
      const v2Field: FieldModel = {
        id: action.field.id,
        selector: action.field.selector,
        automationId: action.field.automationId,
        name: action.field.name,
        fieldType: action.field.fieldType as any,
        fillStrategy: 'tier0' as any,
        isRequired: action.field.required,
        isVisible: action.field.visible,
        isDisabled: action.field.disabled,
        label: action.field.label,
        placeholder: action.field.placeholder,
        ariaLabel: action.field.ariaLabel,
        currentValue: action.field.currentValue ?? '',
        isEmpty: true,
        boundingBox: action.field.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        absoluteY: action.field.boundingBox?.y ?? 0,
      };

      const result = await executor.execute({
        field: v2Field,
        value: action.value,
        tier: 0,
        action: action.actionType as any,
        retryCount: 0,
        maxRetries: 2,
      });

      results.push({
        success: result.success,
        layer: 'dom',
        field: action.field,
        valueApplied: action.value,
        costIncurred: 0,
        durationMs: Date.now() - start,
        error: result.error,
        boundingBoxAtExecution: action.field.boundingBox,
      });
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
          reviewedBy: 'dom',
        });
        continue;
      }

      const v2Field: FieldModel = {
        id: action.field.id,
        selector: action.field.selector,
        fieldType: action.field.fieldType as any,
        fillStrategy: 'tier0' as any,
        isRequired: action.field.required,
        isVisible: true,
        isDisabled: false,
        label: action.field.label,
        currentValue: '',
        isEmpty: false,
        boundingBox: action.field.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 },
        absoluteY: 0,
      };

      const verification = await verifier.verify(v2Field, action.value);
      reviews.push({
        verified: verification.passed,
        field: action.field,
        expected: action.value,
        actual: verification.actual,
        reason: verification.reason,
        reviewedBy: 'dom',
      });
    }

    return reviews;
  }

  async analyze(
    observation: V3ObservationResult,
    _history: V3ObservationResult[],
    ctx: LayerContext,
  ): Promise<AnalysisResult> {
    // DOMHand analysis: Extended DOM traversal for hidden/conditional fields
    const discovered = await ctx.page.evaluate(() => {
      const allInputs = document.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="listbox"]',
      );
      const fields: Array<{
        selector: string;
        label: string;
        type: string;
        visible: boolean;
      }> = [];

      for (const el of allInputs) {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        if (!visible) continue;

        const label =
          (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          '';

        fields.push({
          selector: el.id ? `#${el.id}` : `[name="${el.getAttribute('name')}"]`,
          label,
          type: el.getAttribute('type') || el.tagName.toLowerCase(),
          visible,
        });
      }

      return fields;
    });

    // Find fields not in the original observation
    const knownSelectors = new Set(observation.fields.map((f) => f.selector));
    const newFields: FormField[] = discovered
      .filter((d) => !knownSelectors.has(d.selector))
      .map((d, i) => ({
        id: `discovered-${i}`,
        selector: d.selector,
        fieldType: mapV2FieldType(d.type),
        label: d.label,
        required: false,
        visible: d.visible,
        disabled: false,
      }));

    return {
      discoveredFields: newFields,
      suggestedValues: [],
      costIncurred: 0,
    };
  }

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    const category = this.classifyError(error);
    return {
      category,
      message: error instanceof Error ? error.message : String(error),
      layer: 'dom',
      recoverable: category !== 'browser_disconnected',
      shouldEscalate: true, // DOM failures should always try Stagehand next
    };
  }
}
