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
import type { PageModel } from '../v2types';
import type { BrowserAutomationAdapter } from '../../../adapters/types';

/**
 * Convert a v2 FieldModel (from ported PageScanner) to a v3 FormField.
 */
function fieldModelToFormField(fm: import('../v2types').FieldModel): FormField {
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
    groupKey: fm.groupKey,
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

    // Populate domDepth + parentContainer for fields that lack durable selectors.
    // These are needed by SectionOrchestrator.fieldFingerprint() to disambiguate
    // repeated labels in dynamic sections (e.g., multiple "Company" fields).
    await this.populateStructuralMetadata(ctx.page, fields);

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

  /**
   * Populate domDepth and parentContainer for each field via a single page.evaluate.
   * Only needed for fields without durable selectors (no id, no data-testid, no name).
   * This makes fieldFingerprint() produce distinct fingerprints for repeated labels.
   */
  private async populateStructuralMetadata(
    page: import('playwright').Page,
    fields: FormField[],
  ): Promise<void> {
    try {
      const selectors = fields.map((f) => f.selector);
      const metadata = await page.evaluate((sels: string[]) => {
        return sels.map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { depth: -1, container: '', ordinal: -1 };

          // Compute DOM depth
          let depth = 0;
          let node: Element | null = el;
          while (node && node !== document.documentElement) {
            depth++;
            node = node.parentElement;
          }

          // Compute ordinal: index among same-tag siblings in parent.
          // Disambiguates repeated anonymous siblings under the same named section
          // (e.g., two "Company" text inputs in adjacent work-experience rows).
          let ordinal = 0;
          if (el.parentElement) {
            const siblings = Array.from(el.parentElement.children).filter(
              (child) => child.tagName === el.tagName,
            );
            ordinal = siblings.indexOf(el);
          }

          // Find nearest named container (section, fieldset, or element with data-automation-id/id)
          let container = '';
          node = el.parentElement;
          while (node && node !== document.body) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'section' || tag === 'fieldset') {
              container = node.id || node.getAttribute('data-automation-id') || tag;
              break;
            }
            const autoId = node.getAttribute('data-automation-id');
            if (autoId) {
              container = autoId;
              break;
            }
            if (node.id && !node.id.startsWith('gh-')) {
              container = node.id;
              break;
            }
            node = node.parentElement;
          }

          return { depth, container, ordinal };
        });
      }, selectors);

      for (let i = 0; i < fields.length; i++) {
        const m = metadata[i];
        if (m) {
          fields[i].domDepth = m.depth;
          fields[i].domOrdinal = m.ordinal;
          if (m.container) fields[i].parentContainer = m.container;
        }
      }
    } catch {
      // Non-fatal — fingerprinting falls back to label+type
    }
  }

  async process(observation: V3ObservationResult, ctx: LayerContext): Promise<FieldMatch[]> {
    const userData = ctx.userProfile as Record<string, string>;
    const qaAnswers = (ctx.userProfile as Record<string, unknown>)?.qaAnswers as Record<string, string> ?? {};
    const matcher = new FieldMatcher(userData, qaAnswers, getPlatformHandler(observation.platform));

    const pageModel = toV2PageModel(observation);
    const { matches } = matcher.match(pageModel);

    // Convert v2 FieldMatch to v3 FieldMatch.
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
    // DOMActionExecutor requires a BrowserAutomationAdapter but DOMHand never uses Tier 3.
    // Pass a stub adapter since only Tier 0 (DOM injection) is used.
    const stubAdapter = { type: 'stub', act: () => Promise.resolve({ success: false }) } as unknown as BrowserAutomationAdapter;
    const executor = new DOMActionExecutor(ctx.page, stubAdapter);
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const start = Date.now();

      const v2Field = toV2FieldModel(action.field);

      const result = await executor.execute({
        field: v2Field,
        value: action.value,
        tier: 0,
        action: action.actionType as import('../v2types').ActionType,
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

      const v2Field = toV2FieldModel(action.field);
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

  throwError(error: unknown, _ctx: LayerContext): LayerError {
    const category = this.classifyError(error);
    return {
      category,
      message: error instanceof Error ? error.message : String(error),
      layer: 'dom',
      recoverable: category !== 'browser_disconnected',
    };
  }
}
