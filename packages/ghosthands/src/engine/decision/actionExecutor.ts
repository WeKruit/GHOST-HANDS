import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { Page } from 'playwright';
import type {
  DecisionAction,
  ExecutorResult,
  FieldSnapshot,
  PageDecisionContext,
} from './types';
import { ExecutorResultSchema } from './types';

type ExecutionAttempt = {
  ok: boolean;
  layer: ExecutorResult['layer'];
  fieldsAttempted: number;
  fieldsFilled: number;
  pageNavigated: boolean;
  costUsd: number;
  summary: string;
  error?: string;
  terminal?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string | undefined | null): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function looksLikeSelector(value: string): boolean {
  return /^[#.[]/.test(value) || value.includes('data-') || value.includes('button') || value.includes('input');
}

export class ActionExecutor {
  constructor(
    private readonly page: Page,
    private readonly adapter: BrowserAutomationAdapter,
  ) {}

  async execute(action: DecisionAction, context: PageDecisionContext): Promise<ExecutorResult> {
    const startedAt = Date.now();
    let result: ExecutionAttempt;

    switch (action.action) {
      case 'fill_form':
        result = await this.executeFill(action, context);
        break;
      case 'click_next':
      case 'click_apply':
      case 'dismiss_popup':
        result = await this.executeClick(action, context);
        break;
      case 'select_option':
        result = await this.tryMagnitudeFill(action, context);
        break;
      case 'scroll_down': {
        const beforeUrl = this.safePageUrl();
        await this.page.evaluate(() => {
          window.scrollBy(0, Math.max(Math.floor(window.innerHeight * 0.8), 400));
        });
        await this.page.waitForTimeout(250);
        result = {
          ok: true,
          layer: null,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: beforeUrl !== this.safePageUrl(),
          summary: 'Scrolled down to reveal more page content.',
        };
        break;
      }
      case 'wait_and_retry':
        await sleep(2000);
        result = {
          ok: true,
          layer: null,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: 'Paused briefly before the next observation cycle.',
        };
        break;
      case 'upload_resume':
        result = {
          ok: true,
          layer: null,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: 'Resume upload deferred to external file chooser handling.',
        };
        break;
      case 'login':
        result = await this.executeAdapterAuthAction(
          'Sign in using already-registered credentials available in your runtime context. Do not submit the final application.',
        );
        break;
      case 'create_account':
        result = await this.executeAdapterAuthAction(
          'Create an account using available applicant data and runtime credentials context. Do not submit the final application.',
        );
        break;
      case 'enter_verification':
        result = await this.executeAdapterAuthAction(
          'Enter the required verification code or complete the verification step using trusted runtime context. If no trusted code is available, stop without risky guesses.',
        );
        break;
      case 'expand_repeaters':
        result = await this.expandRepeaters(action, context);
        break;
      case 'stop_for_review':
      case 'mark_complete':
      case 'report_blocked':
        result = {
          ok: true,
          layer: null,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: `No browser action executed for terminal decision "${action.action}".`,
        };
        break;
      default:
        result = {
          ok: false,
          layer: null,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: `Unsupported action "${action.action}".`,
          error: `Unsupported action "${action.action}"`,
          terminal: true,
        };
        break;
    }

    const status: ExecutorResult['status'] =
      action.action === 'stop_for_review' ||
      action.action === 'mark_complete' ||
      action.action === 'report_blocked'
        ? 'needs_review'
        : result.ok
          ? 'action_succeeded'
          : result.terminal
            ? 'action_failed_terminal'
            : 'action_failed_retryable';

    return ExecutorResultSchema.parse({
      status,
      layer: result.layer,
      fieldsAttempted: result.fieldsAttempted,
      fieldsFilled: result.fieldsFilled,
      durationMs: Date.now() - startedAt,
      costUsd: result.costUsd,
      pageNavigated: result.pageNavigated,
      error: result.error,
      summary: result.summary,
    });
  }

  private async executeFill(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const domAttempt = await this.tryDOMFill(action, context);
    if (domAttempt.ok) return domAttempt;

    const stagehandAttempt = await this.tryStagehandFill(action, context);
    if (stagehandAttempt.ok) return stagehandAttempt;

    return this.tryMagnitudeFill(action, context, domAttempt.error || stagehandAttempt.error);
  }

  private async executeClick(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const domAttempt = await this.tryDOMClick(action, context);
    if (domAttempt.ok) return domAttempt;

    const stagehandAttempt = await this.tryStagehandClick(action, context);
    if (stagehandAttempt.ok) return stagehandAttempt;

    return this.tryMagnitudeClick(action, context, domAttempt.error || stagehandAttempt.error);
  }

  private async tryDOMFill(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const targets = this.resolveTargetFields(action, context);
    if (targets.length === 0) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'DOM fill could not resolve any target fields.',
        error: 'no_target_fields',
      };
    }

    const emptyTargets = targets.filter((field) => field.isEmpty && !field.isDisabled && field.isVisible);
    if (emptyTargets.length === 0) {
      return {
        ok: true,
        layer: 'dom',
        fieldsAttempted: targets.length,
        fieldsFilled: targets.length,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Target fields already appear filled; no DOM fill needed.',
      };
    }

    return {
      ok: false,
      layer: 'dom',
      fieldsAttempted: emptyTargets.length,
      fieldsFilled: 0,
      costUsd: 0,
      pageNavigated: false,
      summary: 'DOM fill skipped because decision actions do not yet include concrete field values.',
      error: 'missing_field_values',
    };
  }

  private async tryStagehandFill(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    if (!this.adapter.observe) {
      return {
        ok: false,
        layer: 'stagehand',
        fieldsAttempted: this.resolveTargetFields(action, context).length,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Stagehand fill unavailable because adapter.observe() is not implemented.',
        error: 'observe_unavailable',
      };
    }

    try {
      await this.adapter.observe('Identify the visible fields relevant to the current application step.');
      const beforeUrl = this.safePageUrl();
      const fieldLabels = this.resolveTargetFields(action, context).map((field) => field.label);
      const result = await this.adapter.act(
        [
          'Fill the visible application form fields for this step.',
          fieldLabels.length > 0 ? `Prioritize these field labels: ${fieldLabels.join(', ')}.` : 'Prioritize the visible empty fields on the page.',
          'Use the applicant profile and runtime context already available to the adapter.',
          'Do not click Next, Submit, or any final submission button.',
        ].join(' '),
      );

      return {
        ok: result.success,
        layer: 'stagehand',
        fieldsAttempted: fieldLabels.length || context.fields.filter((field) => field.isVisible && field.isEmpty).length,
        fieldsFilled: result.success ? (fieldLabels.length || context.fields.filter((field) => field.isVisible && field.isEmpty).length) : 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: result.message || 'Stagehand fill attempt completed.',
        error: result.success ? undefined : result.message,
      };
    } catch (error) {
      return {
        ok: false,
        layer: 'stagehand',
        fieldsAttempted: this.resolveTargetFields(action, context).length,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Stagehand fill attempt failed.',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryMagnitudeFill(
    action: DecisionAction,
    context: PageDecisionContext,
    priorError?: string,
  ): Promise<ExecutionAttempt> {
    try {
      const beforeUrl = this.safePageUrl();
      const fieldLabels = this.resolveTargetFields(action, context).map((field) => field.label);
      const result = await this.adapter.act(
        [
          'Fill the current job application form fields.',
          fieldLabels.length > 0 ? `Focus on these fields: ${fieldLabels.join(', ')}.` : 'Focus on the visible empty fields.',
          'Use the applicant profile already available in your runtime context.',
          'Do not click any final submit button.',
          priorError ? `Previous lower-tier error: ${priorError}.` : '',
        ].filter(Boolean).join(' '),
      );

      return {
        ok: result.success,
        layer: 'magnitude',
        fieldsAttempted: fieldLabels.length || context.fields.filter((field) => field.isVisible && field.isEmpty).length,
        fieldsFilled: result.success ? (fieldLabels.length || context.fields.filter((field) => field.isVisible && field.isEmpty).length) : 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: result.message || 'Magnitude fill attempt completed.',
        error: result.success ? undefined : result.message,
      };
    } catch (error) {
      return {
        ok: false,
        layer: 'magnitude',
        fieldsAttempted: this.resolveTargetFields(action, context).length,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Magnitude fill attempt failed.',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryDOMClick(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const selector = this.resolveTargetButtonSelector(action, context);
    if (!selector) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'DOM click could not resolve a button target.',
        error: 'no_click_target',
      };
    }

    try {
      const beforeUrl = this.safePageUrl();
      await this.page.locator(selector).first().click({ timeout: 3000 });
      await this.page.waitForTimeout(750);
      return {
        ok: true,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: `Clicked ${selector} via DOM.`,
      };
    } catch (error) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: `DOM click failed for ${selector}.`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryStagehandClick(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    if (!this.adapter.observe) {
      return {
        ok: false,
        layer: 'stagehand',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Stagehand click unavailable because adapter.observe() is not implemented.',
        error: 'observe_unavailable',
      };
    }

    try {
      await this.adapter.observe('Identify the primary next interactive button on this page.');
      const beforeUrl = this.safePageUrl();
      const result = await this.adapter.act(this.buildClickInstruction(action, context));
      return {
        ok: result.success,
        layer: 'stagehand',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: result.message || 'Stagehand click attempt completed.',
        error: result.success ? undefined : result.message,
      };
    } catch (error) {
      return {
        ok: false,
        layer: 'stagehand',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Stagehand click attempt failed.',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async tryMagnitudeClick(
    action: DecisionAction,
    context: PageDecisionContext,
    priorError?: string,
  ): Promise<ExecutionAttempt> {
    try {
      const beforeUrl = this.safePageUrl();
      const result = await this.adapter.act(
        [this.buildClickInstruction(action, context), priorError ? `Previous lower-tier error: ${priorError}.` : '']
          .filter(Boolean)
          .join(' '),
      );
      return {
        ok: result.success,
        layer: 'magnitude',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: result.message || 'Magnitude click attempt completed.',
        error: result.success ? undefined : result.message,
      };
    } catch (error) {
      return {
        ok: false,
        layer: 'magnitude',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Magnitude click attempt failed.',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeAdapterAuthAction(instruction: string): Promise<ExecutionAttempt> {
    try {
      const beforeUrl = this.safePageUrl();
      const result = await this.adapter.act(instruction);
      return {
        ok: result.success,
        layer: this.adapter.observe ? 'stagehand' : 'magnitude',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: result.message || 'Adapter auth action completed.',
        error: result.success ? undefined : result.message,
        terminal: !result.success,
      };
    } catch (error) {
      return {
        ok: false,
        layer: this.adapter.observe ? 'stagehand' : 'magnitude',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Adapter auth action failed.',
        error: error instanceof Error ? error.message : String(error),
        terminal: true,
      };
    }
  }

  private async expandRepeaters(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const targetLabel = normalizeText(action.target);
    const repeaters = targetLabel
      ? context.repeaters.filter((repeater) => normalizeText(repeater.label).includes(targetLabel))
      : context.repeaters;

    if (repeaters.length === 0) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'No repeater add buttons were available to expand.',
        error: 'no_repeaters',
      };
    }

    let clicked = 0;
    const beforeUrl = this.safePageUrl();
    for (const repeater of repeaters) {
      try {
        await this.page.locator(repeater.addButtonSelector).first().click({ timeout: 3000 });
        clicked++;
        await this.page.waitForTimeout(250);
      } catch {
        // Keep going so one bad repeater does not hide the rest.
      }
    }

    return {
      ok: clicked > 0,
      layer: 'dom',
      fieldsAttempted: repeaters.length,
      fieldsFilled: clicked,
      costUsd: 0,
      pageNavigated: beforeUrl !== this.safePageUrl(),
      summary: clicked > 0
        ? `Expanded ${clicked} repeater section(s).`
        : 'Failed to click any repeater add buttons.',
      error: clicked > 0 ? undefined : 'repeater_click_failed',
    };
  }

  private resolveTargetFields(
    action: DecisionAction,
    context: PageDecisionContext,
  ): FieldSnapshot[] {
    const visibleEditableFields = context.fields.filter(
      (field) => field.isVisible && !field.isDisabled,
    );

    if (!action.fieldsToFill || action.fieldsToFill.length === 0) {
      return visibleEditableFields.filter((field) => field.isEmpty);
    }

    const requested = action.fieldsToFill.map(normalizeText);
    return visibleEditableFields.filter((field) => {
      const label = normalizeText(field.label);
      return requested.some((target) => label === target || label.includes(target) || target.includes(label));
    });
  }

  private resolveTargetButtonSelector(
    action: DecisionAction,
    context: PageDecisionContext,
  ): string | null {
    if (action.target && looksLikeSelector(action.target)) {
      return action.target;
    }

    const buttons = context.buttons.filter((button) => !button.isDisabled);
    const target = normalizeText(action.target);
    if (target) {
      const directMatch = buttons.find((button) =>
        normalizeText(button.selector) === target ||
        normalizeText(button.automationId) === target ||
        normalizeText(button.text) === target ||
        normalizeText(button.text).includes(target),
      );
      if (directMatch) return directMatch.selector;
    }

    switch (action.action) {
      case 'click_next':
        return buttons.find((button) =>
          button.role === 'navigation' ||
          /next|continue|save and continue|review/i.test(button.text),
        )?.selector ?? null;
      case 'click_apply':
        return buttons.find((button) =>
          /apply( now)?|start application|easy apply/i.test(button.text) &&
          !/submit/i.test(button.text),
        )?.selector ?? null;
      case 'dismiss_popup':
        return buttons.find((button) =>
          /close|dismiss|not now|maybe later|skip|accept/i.test(button.text),
        )?.selector ?? null;
      default:
        return null;
    }
  }

  private buildClickInstruction(action: DecisionAction, context: PageDecisionContext): string {
    const target = this.resolveTargetButtonSelector(action, context) || action.target || 'the best matching visible button';
    switch (action.action) {
      case 'click_next':
        return `Click the next-step navigation button (${target}) for the current application step. Do not click any final submit button.`;
      case 'click_apply':
        return `Click the initial apply/start-application button (${target}) if it begins the application flow. Do not click any final submit button.`;
      case 'dismiss_popup':
        return `Dismiss the visible popup or consent overlay using ${target}. Avoid navigation or final submission buttons.`;
      default:
        return `Click ${target} safely without submitting the application.`;
    }
  }

  private safePageUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }
}
