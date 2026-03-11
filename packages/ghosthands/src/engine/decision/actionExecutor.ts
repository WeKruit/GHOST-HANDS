import { createHash } from 'node:crypto';
import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { PageContextService } from '../../context/PageContextService.js';
import type { ContextEvent, QuestionRecord } from '../../context/types.js';
import type { Page } from 'playwright';
import type { AnthropicClientConfig } from '../../workers/taskHandlers/types';
import {
  generatePlatformCredential,
  inferCredentialDomainFromUrl,
  inferCredentialPlatformFromUrl,
  resolvePlatformAccountEmail,
  resolvePlatformAccountPassword,
  type GeneratedPlatformCredential,
} from '../../workers/taskHandlers/platforms/accountCredentials.js';
import {
  applyPlatformCredentialToProfile,
  getPlatformAuthContext,
  setPlatformAuthContext,
  upsertGeneratedPlatformCredentialRuntime,
  type PlatformAuthContext,
} from '../../workers/platformAuthRuntime.js';
import {
  buildProfileText,
  fillFormOnPage,
} from '../../workers/taskHandlers/formFiller.js';
import type { WorkdayUserProfile } from '../../workers/taskHandlers/workday/workdayTypes.js';
import { writeInferenceOutput } from '../../monitoring/logger.js';
import type {
  DecisionAction,
  FieldSnapshot,
  ExecutorResult,
  PageDecisionContext,
} from './types';
import { ExecutorResultSchema } from './types';
import type { DurableFieldRecord, MergedFieldState } from './mergedObserverTypes';
import { questionStateToMergedState } from './mergedObserverTypes';
import { partitionByEscalationTier } from './magnitudeGate';
import { stableFieldKey } from './observerMerger';

// Cost tracking is handled by the CostTracker via adapter tokensUsed events.
// Adapter calls (act/observe) emit tokensUsed with real inputCost/outputCost
// from the LLM provider, which the JobExecutor listener routes to CostTracker.
// No local cost estimation is needed here.

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

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function normalizeQuestionType(value: string | undefined | null): string {
  switch ((value || '').trim().toLowerCase()) {
    case 'tel':
      return 'phone';
    case 'radio-group':
    case 'aria_radio':
    case 'button-group':
      return 'radio';
    case 'checkbox-group':
    case 'toggle':
      return 'checkbox';
    default:
      return (value || '').trim().toLowerCase();
  }
}

function questionMatchesField(question: QuestionRecord, field: FieldSnapshot): boolean {
  if (question.selectors.includes(field.selector)) return true;

  const questionLabel = normalizeText(question.promptText || question.normalizedPrompt);
  const fieldLabel = normalizeText(field.label);
  if (!questionLabel || !fieldLabel) return false;

  if (normalizeQuestionType(question.questionType) !== normalizeQuestionType(field.fieldType)) {
    return false;
  }

  return (
    questionLabel === fieldLabel ||
    questionLabel.includes(fieldLabel) ||
    fieldLabel.includes(questionLabel)
  );
}

function recordActorFromEvent(
  actor: ContextEvent['actor'] | undefined,
): DurableFieldRecord['lastActor'] {
  if (actor === 'dom' || actor === 'magnitude' || actor === 'human') return actor;
  return null;
}

function buildDurableStateHistory(history: ContextEvent[]): DurableFieldRecord['stateHistory'] {
  const transitions: DurableFieldRecord['stateHistory'] = [];
  let previousState: MergedFieldState | null = null;

  for (const event of history) {
    const nextQuestionState = typeof event.after?.state === 'string'
      ? event.after.state
      : null;
    if (!nextQuestionState) continue;

    const nextState = questionStateToMergedState(nextQuestionState as any);
    if (previousState && previousState !== nextState) {
      transitions.push({
        from: previousState,
        to: nextState,
        actor: event.actor,
        timestamp: event.timestamp,
      });
    }
    previousState = nextState;
  }

  return transitions.slice(-5);
}

function questionRecordToDurableField(
  question: QuestionRecord,
  history: ContextEvent[],
): DurableFieldRecord {
  const questionHistory = history.filter((event) => event.targetQuestionKey === question.questionKey);
  const lastEvent = questionHistory[questionHistory.length - 1];

  return {
    fieldKey: question.questionKey,
    lastMergedState: questionStateToMergedState(question.state),
    lastProvenance: question.observerProvenance
      ? {
          sources: [...question.observerProvenance.sources],
          concordant: question.observerProvenance.concordant,
        }
      : {
          sources: ['dom'],
          concordant: null,
        },
    lastActor: question.lastActor ?? recordActorFromEvent(lastEvent?.actor),
    lastActorTimestamp: lastEvent?.timestamp ?? question.lastUpdatedAt ?? null,
    fillAttemptCount: question.attemptCount,
    magnitudeAttemptCount: questionHistory.filter(
      (event) => event.actor === 'magnitude' && event.type === 'fill_attempted',
    ).length,
    lastCommittedValue: question.currentValue ?? question.lastAnswer ?? null,
    expectedValue: question.lastAnswer ?? null,
    sectionFingerprint: question.sectionFingerprint ?? null,
    stateHistory: buildDurableStateHistory(questionHistory),
  };
}

function secretFingerprint(secret: string | null | undefined): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    return 'none';
  }
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

type WorkdayAuthObservation = {
  state:
    | 'still_create_account'
    | 'native_login'
    | 'verification_required'
    | 'authenticated_or_application_resumed'
    | 'explicit_auth_error'
    | 'unknown_pending';
  currentUrl: string;
  title: string;
  heading: string;
  visiblePasswordCount: number;
  hasConfirmPassword: boolean;
  hasSignInIndicators: boolean;
  hasCreateAccountIndicators: boolean;
  hasVerificationIndicators: boolean;
  hasCreateAccountSubmit: boolean;
  hasSignInSubmit: boolean;
  visibleErrors: string[];
  validationText: string;
};

type SubmitAttempt = {
  found: boolean;
  clicked: boolean;
  method: 'magnitude_click' | 'playwright_click' | 'keyboard_enter' | 'none';
  error?: string;
};

type WorkdayFillResult = {
  filled: boolean;
  passwordCount: number;
  checked: number;
  submitFound: boolean;
};

type ActionExecutorOptions = {
  platform: string;
  profile: Record<string, any>;
  jobId?: string;
  userId?: string;
  callbackUrl?: string | null;
  runtimeBaseUrl?: string | null;
  anthropicClientConfig?: AnthropicClientConfig;
  resumePath?: string | null;
  pageContext?: PageContextService;
};

export class ActionExecutor {
  private activeHand: 'dom' | 'stagehand' | 'magnitude' | null = null;

  constructor(
    private readonly page: Page,
    private readonly adapter: BrowserAutomationAdapter,
    private readonly options: ActionExecutorOptions,
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
        // Resume upload is handled externally via Playwright filechooser event
        // (set up in JobExecutor). We click the file input to trigger the chooser.
        try {
          const fileInput = await this.page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.click({ timeout: 3000 });
            await sleep(1500); // Allow filechooser event to fire
            result = {
              ok: true,
              layer: 'dom',
              fieldsAttempted: 1,
              fieldsFilled: 1,
              costUsd: 0,
              pageNavigated: false,
              summary: 'Clicked file input to trigger resume upload via filechooser handler.',
            };
          } else {
            result = {
              ok: false,
              layer: 'dom',
              fieldsAttempted: 1,
              fieldsFilled: 0,
              costUsd: 0,
              pageNavigated: false,
              summary: 'No file input found on page; resume upload may require Stagehand/Magnitude.',
              error: 'no_file_input',
            };
          }
        } catch (error) {
          result = {
            ok: false,
            layer: 'dom',
            fieldsAttempted: 1,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: 'File input click failed.',
            error: error instanceof Error ? error.message : String(error),
          };
        }
        break;
      case 'login':
        result = this.resolvedPlatform() === 'workday'
          ? await this.executeWorkdayAuthAction('login')
          : await this.executeAdapterAuthAction(
              'Sign in using already-registered credentials available in your runtime context. Do not submit the final application.',
              'login',
            );
        break;
      case 'create_account':
        result = this.resolvedPlatform() === 'workday'
          ? await this.executeWorkdayAuthAction('create_account')
          : await this.executeAdapterAuthAction(
              'Create an account using available applicant data and runtime credentials context. Do not submit the final application.',
              'create_account',
            );
        break;
      case 'enter_verification':
        result = this.resolvedPlatform() === 'workday'
          ? {
              ok: false,
              layer: 'dom',
              fieldsAttempted: 0,
              fieldsFilled: 0,
              costUsd: 0,
              pageNavigated: false,
              summary: 'Workday verification requires a fresh observation and likely manual review; no hand executed.',
              error: 'verification_requires_review',
              terminal: true,
            }
          : await this.executeAdapterAuthAction(
              'Enter the required verification code or complete the verification step using trusted runtime context. If no trusted code is available, stop without risky guesses.',
              'verification',
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

  private async withHandLock(
    hand: 'dom' | 'stagehand' | 'magnitude',
    fn: () => Promise<ExecutionAttempt>,
  ): Promise<ExecutionAttempt> {
    if (this.activeHand && this.activeHand !== hand) {
      return {
        ok: false,
        layer: hand,
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: `Skipped ${hand} execution because ${this.activeHand} still owns the page.`,
        error: `hand_locked_by_${this.activeHand}`,
      };
    }

    this.activeHand = hand;
    try {
      if (hand !== 'dom') {
        const settled = await this.waitForAdapterSettle(12_000);
        if (!settled) {
          return {
            ok: false,
            layer: hand,
            fieldsAttempted: 0,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: `Skipped ${hand} execution because a previous act() call is still in flight.`,
            error: 'adapter_busy_previous_act_running',
            terminal: true,
          };
        }
      }
      return await fn();
    } finally {
      this.activeHand = null;
    }
  }

  private async withHandLease<T>(
    hand: 'dom' | 'stagehand' | 'magnitude',
    lockedValue: T,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.activeHand && this.activeHand !== hand) {
      return lockedValue;
    }

    this.activeHand = hand;
    try {
      if (hand !== 'dom') {
        const settled = await this.waitForAdapterSettle(12_000);
        if (!settled) {
          return lockedValue;
        }
      }
      return await fn();
    } finally {
      this.activeHand = null;
    }
  }

  private async waitForAdapterSettle(timeoutMs: number): Promise<boolean> {
    if (!this.adapter.waitForActSettle) return true;
    try {
      return await this.adapter.waitForActSettle(timeoutMs);
    } catch {
      return false;
    }
  }

  private async executeFill(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    const profileText = buildProfileText(this.options.profile as WorkdayUserProfile);
    const result = await fillFormOnPage(
      this.page,
      this.adapter,
      profileText,
      this.options.resumePath,
      {
        anthropicClientConfig: this.options.anthropicClientConfig,
        pageContext: this.options.pageContext,
      },
    );

    const pageNavigated = context.url !== this.safePageUrl();
    const totalFilled = result.domFilled + result.magnitudeFilled;
    return {
      ok: totalFilled > 0 || result.totalFields > 0,
      layer: result.magnitudeFilled > 0 ? 'magnitude' : 'dom',
      fieldsAttempted: result.totalAttempted || result.totalFields,
      fieldsFilled: totalFilled,
      costUsd: 0,
      pageNavigated,
      summary:
        totalFilled > 0
          ? `Filled ${totalFilled}/${result.totalAttempted || result.totalFields} fields via shared form filler (${result.domFilled} DOM, ${result.magnitudeFilled} Magnitude).`
          : result.totalFields > 0
            ? 'Shared form filler inspected the current page but did not fill any additional fields.'
            : 'Shared form filler found no fillable fields on the current page.',
      error: totalFilled > 0 ? undefined : (result.totalFields > 0 ? 'no_fields_filled' : 'no_fillable_fields'),
    };
  }

  private async executeClick(
    action: DecisionAction,
    context: PageDecisionContext,
  ): Promise<ExecutionAttempt> {
    if (action.action === 'click_apply') {
      const domApplyAttempt = await this.tryDOMApplyFlow();
      if (domApplyAttempt.ok) return domApplyAttempt;
    }

    const domAttempt = await this.tryDOMClick(action, context);
    if (domAttempt.ok) return domAttempt;

    const magnitudeAttempt = await this.tryMagnitudeClick(action, context, domAttempt.error);
    if (magnitudeAttempt.ok) return magnitudeAttempt;

    const stagehandAttempt = await this.tryStagehandClick(action, context);
    if (stagehandAttempt.ok) return stagehandAttempt;

    return {
      ok: false,
      layer: magnitudeAttempt.layer ?? domAttempt.layer ?? stagehandAttempt.layer,
      fieldsAttempted: 0,
      fieldsFilled: 0,
      costUsd: 0,
      pageNavigated: false,
      summary: magnitudeAttempt.summary || domAttempt.summary || stagehandAttempt.summary || 'All button-click strategies failed.',
      error: magnitudeAttempt.error || domAttempt.error || stagehandAttempt.error || 'button_click_failed',
    };
  }

  private async tryDOMApplyFlow(): Promise<ExecutionAttempt> {
    return this.withHandLock('dom', async () => {
      const beforeUrl = this.safePageUrl();
      let clickedLabels: string[] = [];

      const clickPriority = async (labels: string[]): Promise<string | null> => {
        const match = await this.page.evaluate((candidates) => {
          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };

          const interactive = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, a, [role="button"], input[type="button"], input[type="submit"]',
            ),
          ).filter((el) => isVisible(el) && !el.hasAttribute('disabled'));

          for (const label of candidates) {
            const lowerLabel = label.toLowerCase();
            const target = interactive.find((el) => {
              const text = (
                el.textContent ||
                (el as HTMLInputElement).value ||
                el.getAttribute('aria-label') ||
                ''
              )
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
              return text === lowerLabel || text.includes(lowerLabel);
            });
            if (target) {
              target.setAttribute('data-gh-quick-apply-click', lowerLabel);
              return lowerLabel;
            }
          }

          return null;
        }, labels);

        if (!match) return null;

        const locator = this.page.locator(`[data-gh-quick-apply-click="${match}"]`).first();
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ timeout: 3000 }).catch(async () => {
          const box = await locator.boundingBox();
          if (box && this.adapter.exec) {
            await this.adapter.exec({
              variant: 'mouse:click',
              x: Math.round(box.x + box.width / 2),
              y: Math.round(box.y + box.height / 2),
            });
          } else {
            throw new Error(`failed_to_click_${match.replace(/\s+/g, '_')}`);
          }
        });
        return match;
      };

      const applyManuallyFirst = await clickPriority(['apply manually']);
      if (applyManuallyFirst) {
        clickedLabels.push(applyManuallyFirst);
        await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
        await this.page.waitForTimeout(900);
        return {
          ok: true,
          layer: 'dom',
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: beforeUrl !== this.safePageUrl(),
          summary: `DOM apply flow clicked ${clickedLabels.join(' -> ')}.`,
        };
      }

      const initialApply = await clickPriority([
        'apply',
        'apply now',
        'start application',
        'easy apply',
      ]);
      if (!initialApply) {
        return {
          ok: false,
          layer: 'dom',
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: 'DOM apply flow could not find an initial Apply control.',
          error: 'no_apply_control',
        };
      }

      clickedLabels.push(initialApply);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
      await this.page.waitForTimeout(1200);

      const applyManuallyAfterModal = await clickPriority(['apply manually']);
      if (applyManuallyAfterModal) {
        clickedLabels.push(applyManuallyAfterModal);
        await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
        await this.page.waitForTimeout(900);
      }

      return {
        ok: true,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: beforeUrl !== this.safePageUrl(),
        summary: `DOM apply flow clicked ${clickedLabels.join(' -> ')}.`,
      };
    });
  }

  private async tryMagnitudeExecClickBySelector(
    selector: string,
    label: string,
  ): Promise<ExecutionAttempt> {
    if (!this.adapter.exec) {
      return {
        ok: false,
        layer: 'magnitude',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: `Magnitude direct click unavailable for ${label}.`,
        error: 'exec_unavailable',
      };
    }

    return this.withHandLock('magnitude', async () => {
      try {
        const locator = this.page.locator(selector).first();
        const found = await locator.count().then((count) => count > 0).catch(() => false);
        if (!found) {
          return {
            ok: false,
            layer: 'magnitude',
            fieldsAttempted: 0,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: `Magnitude direct click could not find ${label}.`,
            error: 'no_click_target',
          };
        }

        await locator.scrollIntoViewIfNeeded().catch(() => {});
        const box = await locator.boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) {
          return {
            ok: false,
            layer: 'magnitude',
            fieldsAttempted: 0,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: `Magnitude direct click could not compute coordinates for ${label}.`,
            error: 'no_click_coordinates',
          };
        }

        const beforeUrl = this.safePageUrl();
        await this.adapter.exec?.({
          variant: 'mouse:click',
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        });
        await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
        await this.page.waitForTimeout(900);

        return {
          ok: true,
          layer: 'magnitude',
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: beforeUrl !== this.safePageUrl(),
          summary: `Magnitude direct-clicked ${label}.`,
        };
      } catch (error) {
        return {
          ok: false,
          layer: 'magnitude',
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: `Magnitude direct click failed for ${label}.`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
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

    // When the LLM provides fieldValues, attempt direct DOM fill
    const fieldValues = action.fieldValues;
    if (fieldValues && Object.keys(fieldValues).length > 0) {
      let filled = 0;
      for (const field of emptyTargets) {
        const fieldLabel = normalizeText(field.label);
        const matchingKey = Object.keys(fieldValues).find((key) => {
          const normalizedKey = normalizeText(key);
          return normalizedKey === fieldLabel || fieldLabel.includes(normalizedKey) || normalizedKey.includes(fieldLabel);
        });
        if (!matchingKey) continue;

        try {
          await this.page.locator(field.selector).first().fill(fieldValues[matchingKey], { timeout: 3000 });
          filled++;
        } catch {
          // Individual field failure is not fatal; continue with remaining fields
        }
      }

      if (filled > 0) {
        return {
          ok: true,
          layer: 'dom',
          fieldsAttempted: emptyTargets.length,
          fieldsFilled: filled,
          costUsd: 0,
          pageNavigated: false,
          summary: `DOM-filled ${filled} of ${emptyTargets.length} fields using LLM-provided values.`,
        };
      }
    }

    // No fieldValues provided or none matched — escalate to next tier
    return {
      ok: false,
      layer: 'dom',
      fieldsAttempted: emptyTargets.length,
      fieldsFilled: 0,
      costUsd: 0,
      pageNavigated: false,
      summary: 'DOM fill could not resolve concrete values for target fields; escalating to Stagehand.',
      error: 'no_field_values_matched',
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

    return this.withHandLock('stagehand', async () => {
      try {
        await this.adapter.observe?.('Identify the visible fields relevant to the current application step.');
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
    });
  }

  private async tryMagnitudeFill(
    action: DecisionAction,
    context: PageDecisionContext,
    priorError?: string,
  ): Promise<ExecutionAttempt> {
    return this.withHandLock('magnitude', async () => {
      try {
        const targets = this.resolveTargetFields(action, context);
        const durableFields = await this.loadDurableFieldRecords(targets);
        const escalationStates = new Map<string, {
          mergedState: MergedFieldState;
          durableRecord: DurableFieldRecord | null;
          required?: boolean;
        }>();

        for (const field of targets) {
          const fieldKey = stableFieldKey(field);
          const durableRecord = durableFields.get(fieldKey) ?? null;
          escalationStates.set(fieldKey, {
            mergedState: this.inferMergedState(field, durableRecord),
            durableRecord,
            required: field.isRequired,
          });
        }

        const partition = partitionByEscalationTier(escalationStates);
        const magnitudeEligibleKeys = new Set(partition.magnitudeEligible);
        const eligibleTargets = targets.filter((field) => magnitudeEligibleKeys.has(stableFieldKey(field)));

        if (targets.length > 0 && eligibleTargets.length === 0) {
          return {
            ok: true,
            layer: null,
            fieldsAttempted: targets.length,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: 'All target fields are already valid or gated from Magnitude escalation.',
          };
        }

        const beforeUrl = this.safePageUrl();
        const fieldLabels = (eligibleTargets.length > 0 ? eligibleTargets : targets).map((field) => field.label);
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
    });
  }

  private async loadDurableFieldRecords(
    fields: FieldSnapshot[],
  ): Promise<Map<string, DurableFieldRecord>> {
    if (!this.options.pageContext || fields.length === 0) {
      return new Map();
    }

    const session = await this.options.pageContext.getSession().catch(() => null);
    const lastPage = session && session.pages.length > 0
      ? session.pages[session.pages.length - 1]
      : undefined;
    const activePage = session?.pages.find((page) => page.pageId === session.activePageId)
      ?? lastPage;
    if (!activePage) {
      return new Map();
    }

    const durableRecords = new Map<string, DurableFieldRecord>();
    const usedQuestionKeys = new Set<string>();

    for (const field of fields) {
      const directSelectorMatch = activePage.questions.find((question) =>
        !usedQuestionKeys.has(question.questionKey) && question.selectors.includes(field.selector),
      );
      const fallbackMatch = directSelectorMatch ?? activePage.questions.find((question) =>
        !usedQuestionKeys.has(question.questionKey) && questionMatchesField(question, field),
      );
      if (!fallbackMatch) continue;

      usedQuestionKeys.add(fallbackMatch.questionKey);
      durableRecords.set(
        stableFieldKey(field),
        questionRecordToDurableField(fallbackMatch, activePage.history),
      );
    }

    return durableRecords;
  }

  private inferMergedState(
    field: FieldSnapshot,
    durableRecord: DurableFieldRecord | null,
  ): MergedFieldState {
    if (field.isEmpty) {
      return field.isRequired ? 'missing_required' : 'empty';
    }

    const expectedValue = normalizeText(durableRecord?.expectedValue);
    const currentValue = normalizeText(field.currentValue);
    if (expectedValue && currentValue && expectedValue !== currentValue) {
      return 'wrong_value';
    }

    return durableRecord?.lastMergedState === 'stale_context_mismatch'
      ? 'stale_context_mismatch'
      : 'valid';
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
      await this.page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
      await this.page.waitForTimeout(900);
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

    return this.withHandLock('stagehand', async () => {
      try {
        await this.adapter.observe?.('Identify the primary next interactive button on this page.');
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
    });
  }

  private async tryMagnitudeClick(
    action: DecisionAction,
    context: PageDecisionContext,
    priorError?: string,
  ): Promise<ExecutionAttempt> {
    const selector = this.resolveTargetButtonSelector(action, context);
    if (selector) {
      const directClickAttempt = await this.tryMagnitudeExecClickBySelector(
        selector,
        action.target || selector,
      );
      if (directClickAttempt.ok) return directClickAttempt;
      priorError = priorError || directClickAttempt.error;
    }

    return this.withHandLock('magnitude', async () => {
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
    });
  }

  private async executeAdapterAuthAction(
    instruction: string,
    actionType: 'login' | 'create_account' | 'verification',
  ): Promise<ExecutionAttempt> {
    const layer: ExecutorResult['layer'] = this.adapter.observe ? 'stagehand' : 'magnitude';
    return this.withHandLock(layer, async () => {
      try {
        const beforeUrl = this.safePageUrl();
        const authContext = this.getCurrentAuthContext(beforeUrl);
        const resolvedPlatform = this.resolvedPlatform();
        let generatedCredential: GeneratedPlatformCredential | null = null;
        const email =
          authContext?.generatedCredential?.loginIdentifier ||
          authContext?.existingCredential?.loginIdentifier ||
          (typeof this.options.profile.email === 'string' && this.options.profile.email.trim().length > 0
            ? this.options.profile.email.trim()
            : undefined);
        const passwordCandidates = [
          authContext?.generatedCredential?.secret,
          authContext?.existingCredential?.secret,
          authContext?.sharedApplicationPassword,
          this.options.profile.application_password,
          this.options.profile.applicationPassword,
          this.options.profile.password,
          this.options.profile.account_password,
          this.options.profile.accountPassword,
        ];
        let password = passwordCandidates.find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )?.trim();

        if (actionType === 'create_account' && email && !password) {
          const generated = generatePlatformCredential(this.options.profile, resolvedPlatform, email, {
            sourceUrl: beforeUrl,
          });
          generatedCredential = generated.credential;
          password = generated.credential.secret;
          this.commitPlatformAuthContext({
            ...(authContext ?? this.buildDefaultAuthContext(resolvedPlatform, beforeUrl)),
            platform: resolvedPlatform,
            domain: inferCredentialDomainFromUrl(beforeUrl),
            authMode: 'create_account',
            credentialExists: Boolean(authContext?.credentialExists),
            existingCredential: authContext?.existingCredential ?? null,
            sharedApplicationPassword:
              authContext?.sharedApplicationPassword ??
              (typeof this.options.profile.application_password === 'string'
                ? this.options.profile.application_password
                : null),
            generatedCredential: generated.credential,
            accountCreationConfirmed: false,
            forceSignIn: false,
            lastAuthState: 'create_account_prepared',
          });
        }

        if ((actionType === 'login' || actionType === 'create_account') && (!email || !password)) {
          return {
            ok: false,
            layer,
            fieldsAttempted: 0,
            fieldsFilled: 0,
            costUsd: 0,
            pageNavigated: false,
            summary: 'Adapter auth action stopped because runtime credentials are incomplete.',
            error: 'missing_runtime_auth_credential',
            terminal: true,
          };
        }

        const result = await this.adapter.act(
          [
            instruction,
            'Never invent placeholder credentials such as "user@example.com", "registered_email@example.com", or synthetic passwords.',
            'Only use credentials explicitly present in the runtime context. If a required credential is missing, stop instead of guessing.',
          ].join(' '),
          {
            data: {
              ...(email ? { email } : {}),
              ...(password ? { password } : {}),
            },
          },
        );

        if (result.success && (authContext || generatedCredential)) {
          this.commitPlatformAuthContext({
            ...(authContext ?? this.buildDefaultAuthContext(resolvedPlatform, beforeUrl)),
            platform: resolvedPlatform,
            domain: inferCredentialDomainFromUrl(this.safePageUrl() || beforeUrl),
            authMode:
              actionType === 'verification'
                ? 'verification'
                : actionType === 'login'
                  ? 'sign_in'
                  : 'create_account',
            credentialExists: Boolean(authContext?.credentialExists || generatedCredential),
            existingCredential: authContext?.existingCredential ?? null,
            sharedApplicationPassword:
              authContext?.sharedApplicationPassword ??
              (typeof this.options.profile.application_password === 'string'
                ? this.options.profile.application_password
                : null),
            generatedCredential: generatedCredential ?? authContext?.generatedCredential ?? null,
            accountCreationConfirmed: Boolean(authContext?.accountCreationConfirmed),
            forceSignIn: Boolean(authContext?.forceSignIn),
            lastAuthState: result.success ? `${actionType}_submitted` : actionType,
          });
        }

        return {
          ok: result.success,
          layer,
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
          layer,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: 'Adapter auth action failed.',
          error: error instanceof Error ? error.message : String(error),
          terminal: true,
        };
      }
    });
  }

  private async executeWorkdayAuthAction(
    action: 'login' | 'create_account',
  ): Promise<ExecutionAttempt> {
    const initialObservation = await this.observeWorkdayAuthState();
    const startLine = `[decision-loop][workday-auth] action=${action} url=${initialObservation.currentUrl} state=${initialObservation.state} errors=${JSON.stringify(initialObservation.visibleErrors)}`;
    console.log(startLine);
    writeInferenceOutput(`${startLine}\n`);

    if (action === 'create_account') {
      return this.executeWorkdayCreateAccount(initialObservation);
    }
    return this.executeWorkdayLogin(initialObservation);
  }

  private async executeWorkdayCreateAccount(
    initialObservation: WorkdayAuthObservation,
  ): Promise<ExecutionAttempt> {
    const authContext = this.getCurrentAuthContext(initialObservation.currentUrl);
    const email = resolvePlatformAccountEmail(this.options.profile, 'workday', {
      sourceUrl: initialObservation.currentUrl,
    });
    if (!email) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Workday account creation could not resolve an email address from the profile.',
        error: 'missing_workday_email',
        terminal: true,
      };
    }

    let credential: GeneratedPlatformCredential;
    let credentialSource = 'generated';
    const existingPassword = resolvePlatformAccountPassword(this.options.profile, 'workday', {
      sourceUrl: initialObservation.currentUrl,
      validationText: initialObservation.validationText,
    });
    const existingDomain = inferCredentialDomainFromUrl(initialObservation.currentUrl);
    const scoped =
      asRecord(asRecord(asRecord(this.options.profile.platform_credentials)?.workday)?.byDomain)?.[existingDomain ?? ''] ??
      asRecord(asRecord(asRecord(this.options.profile.platformCredentials)?.workday)?.byDomain)?.[existingDomain ?? ''];

    if (scoped && (scoped.password || scoped.secret)) {
      credentialSource = 'scoped_profile_override';
      credential = {
        platform: 'workday',
        domain: existingDomain,
        loginIdentifier: email,
        secret: String(scoped.password ?? scoped.secret),
        source: 'generated_platform_password',
        requirements: [],
      };
    } else if (existingPassword.password && existingPassword.source === 'platform_override') {
      credentialSource = 'platform_override';
      credential = {
        platform: 'workday',
        domain: existingDomain,
        loginIdentifier: email,
        secret: existingPassword.password,
        source: 'generated_platform_password',
        requirements: [],
      };
    } else {
      const generated = generatePlatformCredential(this.options.profile, 'workday', email, {
        sourceUrl: initialObservation.currentUrl,
        validationText: initialObservation.validationText,
      });
      credential = generated.credential;
      applyPlatformCredentialToProfile(this.options.profile, credential);
    }

    const createCredentialLine =
      `[decision-loop][workday-auth] create_account credential ` +
      `source=${credentialSource} email=${email} secretFingerprint=${secretFingerprint(credential.secret)} secretLength=${credential.secret.length}`;
    console.log(createCredentialLine);
    writeInferenceOutput(`${createCredentialLine}\n`);

    const domResult = await this.fillWorkdayCreateAccountFields(email, credential.secret);

    const submitAttempt = await this.submitWorkdayAuthButton('create-account', 'Create Account');
    const submitLine = `[decision-loop][workday-auth] create_account submit found=${domResult.submitFound} clicked=${submitAttempt.clicked} method=${submitAttempt.method} error=${submitAttempt.error ?? ''}`;
    console.log(submitLine);
    writeInferenceOutput(`${submitLine}\n`);

    await this.page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await this.page.waitForTimeout(1500);
    let observation = await this.observeWorkdayAuthState();
    if (observation.state === 'unknown_pending') {
      await this.page.waitForTimeout(1500);
      observation = await this.observeWorkdayAuthState();
    }
    const postCreateLine = `[decision-loop][workday-auth] create_account post-submit state=${observation.state} url=${observation.currentUrl} errors=${JSON.stringify(observation.visibleErrors)}`;
    console.log(postCreateLine);
    writeInferenceOutput(`${postCreateLine}\n`);

    const createAccountControlsStillVisible =
      observation.state === 'still_create_account' &&
      (observation.hasCreateAccountSubmit || observation.visiblePasswordCount > 0);

    if (createAccountControlsStillVisible && observation.visibleErrors.length === 0 && submitAttempt.found) {
      const retryAttempt = await this.retryAuthSubmitWithEnter();
      const retryLine = `[decision-loop][workday-auth] create_account retry clicked=${retryAttempt.clicked} method=${retryAttempt.method} error=${retryAttempt.error ?? ''}`;
      console.log(retryLine);
      writeInferenceOutput(`${retryLine}\n`);
      if (retryAttempt.clicked) {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
        await this.page.waitForTimeout(1500);
        const retryObservation = await this.observeWorkdayAuthState();
        const retryPostCreateLine = `[decision-loop][workday-auth] create_account post-retry state=${retryObservation.state} url=${retryObservation.currentUrl} errors=${JSON.stringify(retryObservation.visibleErrors)}`;
        console.log(retryPostCreateLine);
        writeInferenceOutput(`${retryPostCreateLine}\n`);
        observation = retryObservation;
      }
    }

    if (
      observation.state === 'native_login' ||
      observation.state === 'verification_required' ||
      observation.state === 'authenticated_or_application_resumed'
    ) {
      applyPlatformCredentialToProfile(this.options.profile, credential);
      const shouldPersistImmediately =
        observation.state === 'verification_required' ||
        observation.state === 'authenticated_or_application_resumed';

      this.commitPlatformAuthContext({
        ...(authContext ?? this.buildDefaultAuthContext('workday', observation.currentUrl)),
        platform: 'workday',
        domain: inferCredentialDomainFromUrl(observation.currentUrl),
        authMode:
          observation.state === 'verification_required'
            ? 'verification'
            : observation.state === 'authenticated_or_application_resumed'
              ? 'authenticated'
              : 'sign_in',
        credentialExists: shouldPersistImmediately,
        existingCredential: {
          platform: credential.platform,
          domain: credential.domain ?? inferCredentialDomainFromUrl(observation.currentUrl),
          loginIdentifier: credential.loginIdentifier,
          secret: credential.secret,
        },
        generatedCredential: credential,
        accountCreationConfirmed: shouldPersistImmediately,
        forceSignIn:
          observation.state === 'native_login' ||
          observation.state === 'authenticated_or_application_resumed',
        lastAuthState: observation.state,
      });

      if (shouldPersistImmediately && this.options.userId) {
        await upsertGeneratedPlatformCredentialRuntime({
          userId: this.options.userId,
          credential,
          sourceUrl: observation.currentUrl,
          runtimeBaseUrl: this.options.runtimeBaseUrl,
          callbackUrl: this.options.callbackUrl,
        }).catch((error) => {
          console.warn(
            `[decision-loop][auth] failed to upsert generated credential: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }

      return {
        ok: true,
        layer: 'dom',
        fieldsAttempted: 3 + (domResult.checked || 0),
        fieldsFilled: 3 + (domResult.checked || 0),
        costUsd: 0,
        pageNavigated: this.safePageUrl() !== initialObservation.currentUrl,
        summary:
          observation.state === 'native_login'
            ? 'Workday account creation advanced to native_login; waiting for successful sign-in before persisting the generated credential.'
            : `Workday account creation advanced to ${observation.state}.`,
      };
    }

    this.commitPlatformAuthContext({
      ...(authContext ?? this.buildDefaultAuthContext('workday', observation.currentUrl)),
      platform: 'workday',
      domain: inferCredentialDomainFromUrl(observation.currentUrl),
      authMode: 'create_account',
      credentialExists: Boolean(authContext?.credentialExists),
      existingCredential: authContext?.existingCredential ?? null,
      generatedCredential: credential,
      accountCreationConfirmed: false,
      forceSignIn: false,
      lastAuthState: observation.state,
    });

    return {
      ok: false,
      layer: 'dom',
      fieldsAttempted: 3 + (domResult.checked || 0),
      fieldsFilled: domResult.filled ? 1 + Math.max(0, domResult.passwordCount) : 0,
      costUsd: 0,
      pageNavigated: this.safePageUrl() !== initialObservation.currentUrl,
      summary: createAccountControlsStillVisible
        ? 'Workday account creation submit had no observable effect; the same auth controls are still visible.'
        : 'Workday account creation stayed on the same auth view after DOM submit.',
      error: observation.visibleErrors[0] || (createAccountControlsStillVisible ? 'same_page_with_controls' : observation.state),
    };
  }

  private async fillWorkdayCreateAccountFields(
    email: string,
    password: string,
  ): Promise<WorkdayFillResult> {
    return this.withHandLease(
      'dom',
      { filled: false, passwordCount: 0, checked: 0, submitFound: false },
      async () => {
      const result = await this.page.evaluate(
        ({ authEmail, authPassword }) => {
          const isVisible = (el: Element | null): el is HTMLElement => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const setValue = (input: HTMLInputElement, value: string) => {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        };

        const visibleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
          .filter((input) => isVisible(input) && !input.disabled && input.type !== 'hidden');
        const emailInput =
          visibleInputs.find((input) =>
            input.type === 'email' ||
            /email/i.test(input.name || '') ||
            /email/i.test(input.id || '') ||
            /email/i.test(input.getAttribute('autocomplete') || ''),
          ) ?? null;
        const passwordInputs = visibleInputs.filter((input) => input.type === 'password');
        const checkboxTargets = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
          .filter((input) => isVisible(input) && !input.disabled && !input.checked);

        if (emailInput) setValue(emailInput, authEmail);
        if (passwordInputs[0]) setValue(passwordInputs[0], authPassword);
        if (passwordInputs[1]) setValue(passwordInputs[1], authPassword);
        for (const checkbox of checkboxTargets) {
          checkbox.click();
        }

          const submitTargets = Array.from(
            document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], [data-automation-id="click_filter"]'),
          ).filter((el) => isVisible(el) && !el.hasAttribute('disabled'));
          const submit = submitTargets.find((el) =>
            /create account/i.test(el.textContent || (el as HTMLInputElement).value || '') ||
            /create account/i.test(el.getAttribute('aria-label') || ''),
          );
          if (submit) {
            submit.setAttribute('data-gh-auth-submit', 'create-account');
          }

          return {
            filled: Boolean(emailInput) || passwordInputs.length > 0,
            passwordCount: passwordInputs.length,
            checked: checkboxTargets.length,
            submitFound: Boolean(submit),
          };
        },
        {
          authEmail: email,
          authPassword: password,
        },
      );
      return result;
    });
  }

  private async executeWorkdayLogin(
    initialObservation: WorkdayAuthObservation,
  ): Promise<ExecutionAttempt> {
    const authContext = this.getCurrentAuthContext(initialObservation.currentUrl);
    const email =
      authContext?.generatedCredential?.loginIdentifier ||
      authContext?.existingCredential?.loginIdentifier ||
      resolvePlatformAccountEmail(this.options.profile, 'workday', {
        sourceUrl: initialObservation.currentUrl,
      });
    const password =
      authContext?.generatedCredential
        ? {
            password: authContext.generatedCredential.secret,
            source: 'generated_platform_password' as const,
            requirements: [],
          }
        : authContext?.existingCredential
          ? {
              password: authContext.existingCredential.secret,
              source: 'platform_override' as const,
              requirements: [],
            }
          : resolvePlatformAccountPassword(this.options.profile, 'workday', {
              sourceUrl: initialObservation.currentUrl,
              validationText: initialObservation.validationText,
            });

    if (!email || !password.password) {
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 0,
        fieldsFilled: 0,
        costUsd: 0,
        pageNavigated: false,
        summary: 'Workday native login could not resolve tenant credentials for the current host.',
        error: 'missing_workday_tenant_credential',
        terminal: true,
      };
    }

    const loginCredentialLine =
      `[decision-loop][workday-auth] login credential ` +
      `source=${password.source} email=${email} secretFingerprint=${secretFingerprint(password.password)} secretLength=${password.password.length}`;
    console.log(loginCredentialLine);
    writeInferenceOutput(`${loginCredentialLine}\n`);

    const domResult = await this.fillWorkdayLoginFields(email, password.password);

    const submitAttempt = await this.submitWorkdayAuthButton('sign-in', 'Sign In');
    const submitLine = `[decision-loop][workday-auth] login submit found=${domResult.submitFound} clicked=${submitAttempt.clicked} method=${submitAttempt.method} error=${submitAttempt.error ?? ''}`;
    console.log(submitLine);
    writeInferenceOutput(`${submitLine}\n`);

    await this.page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await this.page.waitForTimeout(1500);
    let observation = await this.observeWorkdayAuthState();
    if (observation.state === 'unknown_pending') {
      await this.page.waitForTimeout(1500);
      observation = await this.observeWorkdayAuthState();
    }
    const postLoginLine = `[decision-loop][workday-auth] login post-submit state=${observation.state} url=${observation.currentUrl} errors=${JSON.stringify(observation.visibleErrors)}`;
    console.log(postLoginLine);
    writeInferenceOutput(`${postLoginLine}\n`);

    const loginControlsStillVisible =
      observation.state === 'native_login' &&
      (observation.hasSignInSubmit || observation.visiblePasswordCount > 0);

    if (loginControlsStillVisible && observation.visibleErrors.length === 0 && submitAttempt.found) {
      const retryAttempt = await this.retryAuthSubmitWithEnter();
      const retryLine = `[decision-loop][workday-auth] login retry clicked=${retryAttempt.clicked} method=${retryAttempt.method} error=${retryAttempt.error ?? ''}`;
      console.log(retryLine);
      writeInferenceOutput(`${retryLine}\n`);
      if (retryAttempt.clicked) {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
        await this.page.waitForTimeout(1500);
        const retryObservation = await this.observeWorkdayAuthState();
        const retryPostLoginLine = `[decision-loop][workday-auth] login post-retry state=${retryObservation.state} url=${retryObservation.currentUrl} errors=${JSON.stringify(retryObservation.visibleErrors)}`;
        console.log(retryPostLoginLine);
        writeInferenceOutput(`${retryPostLoginLine}\n`);
        observation = retryObservation;
      }
    }

    if (
      observation.state === 'authenticated_or_application_resumed' ||
      observation.state === 'verification_required' ||
      observation.state === 'unknown_pending'
    ) {
      const generatedCredential = authContext?.generatedCredential ?? null;
      if (
        this.options.userId &&
        generatedCredential &&
        !authContext?.accountCreationConfirmed &&
        (observation.state === 'authenticated_or_application_resumed' || observation.state === 'verification_required')
      ) {
        await upsertGeneratedPlatformCredentialRuntime({
          userId: this.options.userId,
          credential: generatedCredential,
          sourceUrl: observation.currentUrl,
          runtimeBaseUrl: this.options.runtimeBaseUrl,
          callbackUrl: this.options.callbackUrl,
        }).catch((error) => {
          console.warn(
            `[decision-loop][auth] failed to upsert generated credential after sign-in: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }

      this.commitPlatformAuthContext({
        ...(authContext ?? this.buildDefaultAuthContext('workday', observation.currentUrl)),
        platform: 'workday',
        domain: inferCredentialDomainFromUrl(observation.currentUrl),
        authMode:
          observation.state === 'verification_required'
            ? 'verification'
            : observation.state === 'authenticated_or_application_resumed'
              ? 'authenticated'
              : 'sign_in',
        credentialExists:
          Boolean(authContext?.credentialExists || authContext?.generatedCredential) &&
          observation.state !== 'unknown_pending',
        existingCredential:
          authContext?.existingCredential ??
          (authContext?.generatedCredential
            ? {
                platform: authContext.generatedCredential.platform,
                domain: authContext.generatedCredential.domain,
                loginIdentifier: authContext.generatedCredential.loginIdentifier,
                secret: authContext.generatedCredential.secret,
              }
            : null),
        generatedCredential: authContext?.generatedCredential ?? null,
        accountCreationConfirmed:
          Boolean(authContext?.accountCreationConfirmed) ||
          Boolean(authContext?.generatedCredential) &&
            (observation.state === 'authenticated_or_application_resumed' || observation.state === 'verification_required'),
        forceSignIn: false,
        lastAuthState: observation.state,
      });
      return {
        ok: true,
        layer: 'dom',
        fieldsAttempted: 2,
        fieldsFilled: domResult.filled ? 2 : 0,
        costUsd: 0,
        pageNavigated: this.safePageUrl() !== initialObservation.currentUrl,
        summary: `Workday native login advanced to ${observation.state}.`,
      };
    }

    if (
      observation.state === 'explicit_auth_error' &&
      Boolean(authContext?.forceSignIn)
    ) {
      this.commitPlatformAuthContext({
        ...(authContext ?? this.buildDefaultAuthContext('workday', observation.currentUrl)),
        platform: 'workday',
        domain: inferCredentialDomainFromUrl(observation.currentUrl),
        authMode: 'sign_in',
        credentialExists: Boolean(authContext?.credentialExists),
        existingCredential: authContext?.existingCredential ?? null,
        generatedCredential: null,
        accountCreationConfirmed: Boolean(authContext?.accountCreationConfirmed),
        forceSignIn: false,
        lastAuthState: observation.state,
      });
      return {
        ok: false,
        layer: 'dom',
        fieldsAttempted: 2,
        fieldsFilled: domResult.filled ? 2 : 0,
        costUsd: 0,
        pageNavigated: this.safePageUrl() !== initialObservation.currentUrl,
        summary: 'Workday native sign-in failed immediately after account-creation attempt; generated credential was not confirmed or persisted.',
        error: observation.visibleErrors[0] || observation.state,
        terminal: true,
      };
    }

    this.commitPlatformAuthContext({
      ...(authContext ?? this.buildDefaultAuthContext('workday', observation.currentUrl)),
      platform: 'workday',
      domain: inferCredentialDomainFromUrl(observation.currentUrl),
      authMode: 'sign_in',
      credentialExists: Boolean(authContext?.credentialExists || authContext?.generatedCredential),
      existingCredential: authContext?.existingCredential ?? null,
      generatedCredential: authContext?.generatedCredential ?? null,
      accountCreationConfirmed: Boolean(authContext?.accountCreationConfirmed),
      forceSignIn: Boolean(authContext?.forceSignIn),
      lastAuthState: observation.state,
    });

    return {
      ok: false,
      layer: 'dom',
      fieldsAttempted: 2,
      fieldsFilled: domResult.filled ? 2 : 0,
      costUsd: 0,
      pageNavigated: this.safePageUrl() !== initialObservation.currentUrl,
      summary: loginControlsStillVisible
        ? 'Workday native login submit had no observable effect; the same sign-in controls are still visible.'
        : 'Workday native login did not reach an authenticated state after DOM submit.',
      error: observation.visibleErrors[0] || (loginControlsStillVisible ? 'same_page_with_controls' : observation.state),
    };
  }

  private async fillWorkdayLoginFields(
    email: string,
    password: string,
  ): Promise<WorkdayFillResult> {
    return this.withHandLease(
      'dom',
      { filled: false, passwordCount: 0, checked: 0, submitFound: false },
      async () => {
      const result = await this.page.evaluate(
        ({ authEmail, authPassword }) => {
          const isVisible = (el: Element | null): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const setValue = (input: HTMLInputElement, value: string) => {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        };

        const visibleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
          .filter((input) => isVisible(input) && !input.disabled && input.type !== 'hidden');
        const emailInput =
          visibleInputs.find((input) =>
            input.type === 'email' ||
            /email|user/i.test(input.name || '') ||
            /email|user/i.test(input.id || '') ||
            /email/i.test(input.getAttribute('autocomplete') || ''),
          ) ?? null;
        const passwordInput = visibleInputs.find((input) => input.type === 'password') ?? null;

        if (emailInput) setValue(emailInput, authEmail);
        if (passwordInput) setValue(passwordInput, authPassword);

          const submitTargets = Array.from(
            document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], [data-automation-id="click_filter"]'),
          ).filter((el) => isVisible(el) && !el.hasAttribute('disabled'));
          const submit = submitTargets.find((el) =>
            /sign in|log in|login/i.test(el.textContent || (el as HTMLInputElement).value || '') ||
            /sign in|log in|login/i.test(el.getAttribute('aria-label') || ''),
          );
          if (submit) submit.setAttribute('data-gh-auth-submit', 'sign-in');

          return {
            filled: Boolean(emailInput || passwordInput),
            passwordCount: passwordInput ? 1 : 0,
            checked: 0,
            submitFound: Boolean(submit),
          };
        },
        {
          authEmail: email,
          authPassword: password,
        },
      );
      return result;
    });
  }

  private async observeWorkdayAuthState(): Promise<WorkdayAuthObservation> {
    const observation = await this.page.evaluate(() => {
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const texts = Array.from(
        document.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"], button, a, label, legend, [role="alert"], [aria-live="assertive"]'),
      )
        .filter((el) => isVisible(el))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const lowerText = texts.join(' \n ').toLowerCase();
      const visibleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
        .filter((input) => isVisible(input) && !input.disabled && input.type !== 'hidden');
      const visiblePasswordInputs = visibleInputs.filter((input) => input.type === 'password');
      const visibleErrors = Array.from(
        document.querySelectorAll<HTMLElement>('[role="alert"], [aria-live="assertive"], [data-automation-id="errorMessage"], [class*="error"]'),
      )
        .filter((el) => isVisible(el))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 10);
      const primaryHeading =
        texts.find((text) => /create account|sign in|start your application|verification|code/i.test(text)) ??
        texts[0] ??
        '';
      const title = document.title || '';
      const currentUrl = window.location.href;
      const hasConfirmPassword = visiblePasswordInputs.some((input) => {
        const labelText =
          input.getAttribute('aria-label') ||
          input.getAttribute('placeholder') ||
          input.name ||
          input.id ||
          '';
        return /confirm|verify|re-enter/i.test(labelText);
      }) || visiblePasswordInputs.length >= 2;
      const hasSignInIndicators = /sign in|log in|already have an account/.test(lowerText);
      const hasCreateAccountIndicators = /create account|start your application|new account/.test(lowerText);
      const hasVerificationIndicators = /verification code|security code|two-factor|2fa|verify your email/.test(lowerText);
      const hasCreateAccountSubmit = texts.some((text) => /create account/.test(text.toLowerCase()));
      const hasSignInSubmit = texts.some((text) => /sign in|log in|login/.test(text.toLowerCase()));
      const hasApplicationResumedIndicators =
        /my information|my experience|application questions|candidate home|back to job posting/.test(lowerText) &&
        visiblePasswordInputs.length === 0;

      return {
        currentUrl,
        title,
        heading: primaryHeading,
        visiblePasswordCount: visiblePasswordInputs.length,
        hasConfirmPassword,
        hasSignInIndicators,
        hasCreateAccountIndicators,
        hasVerificationIndicators,
        hasCreateAccountSubmit,
        hasSignInSubmit,
        hasApplicationResumedIndicators,
        visibleErrors,
        validationText: lowerText,
      };
    });

    const state = this.classifyWorkdayAuthObservation(observation);
    return {
      state,
      currentUrl: observation.currentUrl,
      title: observation.title,
      heading: observation.heading,
      visiblePasswordCount: observation.visiblePasswordCount,
      hasConfirmPassword: observation.hasConfirmPassword,
      hasSignInIndicators: observation.hasSignInIndicators,
      hasCreateAccountIndicators: observation.hasCreateAccountIndicators,
      hasVerificationIndicators: observation.hasVerificationIndicators,
      hasCreateAccountSubmit: observation.hasCreateAccountSubmit,
      hasSignInSubmit: observation.hasSignInSubmit,
      visibleErrors: observation.visibleErrors,
      validationText: observation.validationText,
    };
  }

  private classifyWorkdayAuthObservation(input: {
    currentUrl: string;
    title: string;
    heading: string;
    visiblePasswordCount: number;
    hasConfirmPassword: boolean;
    hasSignInIndicators: boolean;
    hasCreateAccountIndicators: boolean;
    hasVerificationIndicators: boolean;
    hasCreateAccountSubmit: boolean;
    hasSignInSubmit: boolean;
    hasApplicationResumedIndicators: boolean;
    visibleErrors: string[];
    validationText: string;
  }): WorkdayAuthObservation['state'] {
    if (input.hasVerificationIndicators) return 'verification_required';
    if (input.hasApplicationResumedIndicators) return 'authenticated_or_application_resumed';
    if (
      input.visibleErrors.some((error) =>
        /incorrect|invalid|wrong|not found|does not exist|failed|try again|not recognized|unable|locked/i.test(error),
      )
    ) {
      return 'explicit_auth_error';
    }

    const lowerHeading = normalizeText(input.heading);
    const lowerUrl = normalizeText(input.currentUrl);

    // URL-based auth transitions are more reliable than stale heading/button text
    // during Workday redirects, especially immediately after account creation.
    if (lowerUrl.includes('/login')) {
      return 'native_login';
    }

    if (
      input.hasSignInSubmit ||
      (input.visiblePasswordCount > 0 && input.hasSignInIndicators)
    ) {
      return 'native_login';
    }

    if (
      input.hasConfirmPassword ||
      input.hasCreateAccountSubmit ||
      lowerHeading.includes('create account') ||
      lowerHeading.includes('start your application')
    ) {
      return 'still_create_account';
    }

    return 'unknown_pending';
  }

  private async clickMarkedAuthSubmit(marker: 'create-account' | 'sign-in'): Promise<SubmitAttempt> {
    const selector = `[data-gh-auth-submit="${marker}"]`;
    try {
      const locator = this.page.locator(selector).first();
      const found = await locator.count().then((count) => count > 0).catch(() => false);
      if (!found) {
        return { found: false, clicked: false, method: 'none' };
      }
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 4000 });
      return { found: true, clicked: true, method: 'playwright_click' };
    } catch (error) {
      return {
        found: true,
        clicked: false,
        method: 'playwright_click',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async submitWorkdayAuthButton(
    marker: 'create-account' | 'sign-in',
    buttonLabel: string,
  ): Promise<SubmitAttempt> {
    const domAttempt = await this.clickMarkedAuthSubmit(marker);
    if (domAttempt.clicked) return domAttempt;

    const directClickAttempt = await this.tryMagnitudeExecClickBySelector(
      `[data-gh-auth-submit="${marker}"]`,
      buttonLabel,
    );
    if (directClickAttempt.ok) {
      return { found: true, clicked: true, method: 'magnitude_click' };
    }

    const magnitudeAttempt = await this.withHandLock('magnitude', async () => {
      try {
        const beforeUrl = this.safePageUrl();
        const result = await this.adapter.act(
          `Click the visible "${buttonLabel}" button on the current Workday auth form. This is a button-click task only. Do not type, do not change fields, and do not click any other control.`,
        );
        return {
          ok: result.success,
          layer: 'magnitude' as const,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: beforeUrl !== this.safePageUrl(),
          summary: result.message || `Magnitude ${buttonLabel} click completed.`,
          error: result.success ? undefined : result.message,
        };
      } catch (error) {
        return {
          ok: false,
          layer: 'magnitude' as const,
          fieldsAttempted: 0,
          fieldsFilled: 0,
          costUsd: 0,
          pageNavigated: false,
          summary: `Magnitude ${buttonLabel} click failed.`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    if (magnitudeAttempt.ok) {
      return { found: true, clicked: true, method: 'magnitude_click' };
    }

    return {
      found: domAttempt.found || Boolean(directClickAttempt.error) || true,
      clicked: false,
      method: domAttempt.method,
      error: domAttempt.error || directClickAttempt.error || magnitudeAttempt.error,
    };
  }

  private async retryAuthSubmitWithEnter(): Promise<SubmitAttempt> {
    try {
      const passwordInput = this.page.locator('input[type="password"]').last();
      const found = await passwordInput.count().then((count) => count > 0).catch(() => false);
      if (!found) {
        return { found: false, clicked: false, method: 'none' };
      }
      await passwordInput.focus();
      await this.page.keyboard.press('Enter');
      return { found: true, clicked: true, method: 'keyboard_enter' };
    } catch (error) {
      return {
        found: true,
        clicked: false,
        method: 'keyboard_enter',
        error: error instanceof Error ? error.message : String(error),
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
      // Determine how many clicks needed: targetCount - currentCount, minimum 1
      const clicksNeeded = repeater.targetCount && repeater.targetCount > repeater.currentCount
        ? repeater.targetCount - repeater.currentCount
        : 1;

      for (let i = 0; i < clicksNeeded; i++) {
        try {
          await this.page.locator(repeater.addButtonSelector).first().click({ timeout: 3000 });
          clicked++;
          // Wait for DOM to settle between expansion clicks
          await this.page.waitForTimeout(500);
        } catch {
          // Stop clicking this repeater if a click fails
          break;
        }
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
          /apply manually|apply( now)?|start application|easy apply/i.test(button.text) &&
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
        return `Click the initial apply/start-application control (${target}). If an "Apply Manually" option is visible, prefer that over resume autofill. Do not click any final submit button.`;
      case 'dismiss_popup':
        return `Dismiss the visible popup or consent overlay using ${target}. Avoid navigation or final submission buttons.`;
      default:
        return `Click ${target} safely without submitting the application.`;
    }
  }

  private buildDefaultAuthContext(platform: string, sourceUrl: string): PlatformAuthContext {
    return {
      platform,
      domain: inferCredentialDomainFromUrl(sourceUrl),
      authMode: 'none',
      credentialExists: false,
      existingCredential: null,
      sharedApplicationPassword:
        typeof this.options.profile.application_password === 'string' && this.options.profile.application_password.trim()
          ? this.options.profile.application_password.trim()
          : typeof this.options.profile.applicationPassword === 'string' && this.options.profile.applicationPassword.trim()
            ? this.options.profile.applicationPassword.trim()
            : null,
      generatedCredential: null,
      accountCreationConfirmed: false,
      forceSignIn: false,
      lastAuthState: null,
    };
  }

  private getCurrentAuthContext(sourceUrl: string): PlatformAuthContext | null {
    return getPlatformAuthContext(this.options.profile, {
      sourceUrl,
      platform: this.resolvedPlatform(),
    });
  }

  private commitPlatformAuthContext(context: PlatformAuthContext): void {
    const normalized = setPlatformAuthContext(this.options.profile, context);
    const generatedOrExisting = normalized.generatedCredential ?? normalized.existingCredential;
    applyPlatformCredentialToProfile(
      this.options.profile,
      generatedOrExisting ?? null,
      normalized.sharedApplicationPassword,
    );

    if (normalized.platform === 'workday') {
      (this.options.profile as any)._accountCreationCompleted = normalized.accountCreationConfirmed;
      (this.options.profile as any)._forceNativeLoginAfterAccountCreation = normalized.forceSignIn;
      (this.options.profile as any)._workdayForceAccountCreation = normalized.authMode === 'create_account';
    }
  }

  private safePageUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }

  private resolvedPlatform(): string {
    const hinted = (this.options.platform || '').trim().toLowerCase();
    if (hinted && hinted !== 'other' && hinted !== 'generic' && hinted !== 'unknown') {
      return this.options.platform;
    }
    return inferCredentialPlatformFromUrl(this.safePageUrl()) ?? 'other';
  }
}
