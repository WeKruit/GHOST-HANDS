/**
 * SectionOrchestrator — Main v3 execution loop.
 *
 * For each page:
 *   1. Observe → detect sections → for each section:
 *      a. Process (match fields → user data, cheapest layer first)
 *      b. Plan actions (assign layers by confidence)
 *      c. Execute with escalation (try assigned layer, review, escalate on failure)
 *      d. Re-observe after EVERY action (DOM readback, free)
 *      e. Record for cookbook
 *   2. Navigate to next page
 *   3. Repeat (max 15 pages)
 */

import { LayerHand } from './LayerHand';
import { SectionGrouper } from './SectionGrouper';
import type {
  LayerId,
  LayerContext,
  V3ObservationResult,
  FormField,
  FormSection,
  FieldMatch,
  PlannedAction,
  ExecutionResult,
  ReviewResult,
  CookbookAction,
  EscalationPolicy,
  DEFAULT_ESCALATION_POLICY,
} from './types';

const MAX_PAGES = 15;
const MAX_STUCK_COUNT = 3;

export interface OrchestratorResult {
  success: boolean;
  pagesProcessed: number;
  totalCost: number;
  actionsExecuted: number;
  actionsVerified: number;
  actionsFailed: number;
  cookbookActions: CookbookAction[];
  errors: string[];
}

export class SectionOrchestrator {
  private layers: Map<LayerId, LayerHand> = new Map();
  private grouper = new SectionGrouper();
  private policy: EscalationPolicy;
  private cookbookActions: CookbookAction[] = [];
  private totalCost = 0;

  constructor(
    layers: LayerHand[],
    policy?: EscalationPolicy,
  ) {
    for (const layer of layers) {
      this.layers.set(layer.id, layer);
    }
    this.policy = policy ?? {
      maxAttemptsPerLayer: 2,
      layerOrder: ['dom', 'stagehand', 'magnitude'],
      fastEscalationErrors: ['element_not_found', 'element_not_visible'],
    };
  }

  /**
   * Run the full multi-page execution loop.
   */
  async run(ctx: LayerContext): Promise<OrchestratorResult> {
    const result: OrchestratorResult = {
      success: false,
      pagesProcessed: 0,
      totalCost: 0,
      actionsExecuted: 0,
      actionsVerified: 0,
      actionsFailed: 0,
      cookbookActions: [],
      errors: [],
    };

    let stuckCount = 0;
    let lastUrl = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      const currentUrl = ctx.page.url();

      // Stuck detection
      if (currentUrl === lastUrl) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK_COUNT) {
          result.errors.push(`Stuck on page for ${MAX_STUCK_COUNT} attempts: ${currentUrl}`);
          break;
        }
      } else {
        stuckCount = 0;
        lastUrl = currentUrl;
      }

      ctx.logger?.info('Processing page', { page: page + 1, url: currentUrl });

      // Budget check
      if (ctx.budgetRemaining <= 0) {
        result.errors.push('Budget exceeded');
        break;
      }

      try {
        const pageResult = await this.processPage(ctx);
        result.pagesProcessed++;
        result.actionsExecuted += pageResult.actionsExecuted;
        result.actionsVerified += pageResult.actionsVerified;
        result.actionsFailed += pageResult.actionsFailed;
        result.totalCost += pageResult.cost;
        this.totalCost += pageResult.cost;

        if (pageResult.isLastPage) {
          result.success = true;
          break;
        }

        // Navigate to next page using Magnitude (Layer 3)
        const navigated = await this.navigateNext(ctx);
        if (!navigated) {
          // If no next button found, assume we're done
          result.success = true;
          break;
        }

        // Wait for new page to load
        await this.layers.get('dom')!.waitForPageSettled(ctx.page);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
        break;
      }
    }

    result.cookbookActions = this.cookbookActions;
    return result;
  }

  /**
   * Process a single page: observe → group sections → fill each section.
   */
  private async processPage(ctx: LayerContext): Promise<{
    actionsExecuted: number;
    actionsVerified: number;
    actionsFailed: number;
    cost: number;
    isLastPage: boolean;
  }> {
    let actionsExecuted = 0;
    let actionsVerified = 0;
    let actionsFailed = 0;
    let cost = 0;

    // Step 1: Observe (cheapest layer first — DOM)
    const domLayer = this.layers.get('dom')!;
    let observation = await domLayer.observe(ctx);
    cost += observation.costIncurred;

    // Check for blockers
    if (observation.blockers.length > 0) {
      ctx.logger?.warn('Blockers detected', {
        blockers: observation.blockers.map((b) => b.category),
      });
      // Blockers are handled by the caller (JobExecutor) via HITL
      return { actionsExecuted, actionsVerified, actionsFailed, cost, isLastPage: false };
    }

    // Step 2: Group into sections
    const sections = this.grouper.group(observation.fields, observation.buttons);
    ctx.logger?.info('Sections detected', {
      count: sections.length,
      names: sections.map((s) => s.name),
    });

    // Step 3: Process each section
    for (const section of sections) {
      if (section.allFilled) {
        ctx.logger?.debug('Section already filled', { section: section.name });
        continue;
      }

      // Match fields to user data (cheapest layer first)
      const matches = await this.processSection(section, observation, ctx);
      if (matches.length === 0) continue;

      // Plan actions (assign layers by confidence)
      const actions = this.planActions(matches);

      // Execute each action with escalation
      for (const action of actions) {
        const execResult = await this.executeWithEscalation(action, ctx);
        actionsExecuted++;
        cost += execResult.costIncurred;

        if (execResult.success) {
          actionsVerified++;
        } else {
          actionsFailed++;
        }

        // RE-OBSERVE after EVERY action (DOM readback, free)
        const quickObs = await this.quickObserve(ctx);
        cost += quickObs.costIncurred;

        // Record for cookbook
        this.recordAction(action, execResult);
      }
    }

    // Check if this is the last page (no next/continue/submit button that advances)
    const isLastPage = this.detectLastPage(observation);

    return { actionsExecuted, actionsVerified, actionsFailed, cost, isLastPage };
  }

  /**
   * Match section fields to user data using the cheapest layer first.
   */
  private async processSection(
    section: FormSection,
    observation: V3ObservationResult,
    ctx: LayerContext,
  ): Promise<FieldMatch[]> {
    // Create a section-scoped observation
    const sectionObs: V3ObservationResult = {
      ...observation,
      fields: section.fields,
      buttons: section.buttons,
    };

    // Try DOM layer first (free)
    const domLayer = this.layers.get('dom')!;
    const matches = await domLayer.process(sectionObs, ctx);

    // If we got matches for most fields, use them
    const unmatchedCount = section.fields.length - matches.length;
    if (unmatchedCount === 0 || matches.length > 0) {
      return matches;
    }

    // If DOM couldn't match, try Stagehand (cheap LLM)
    const stagehandLayer = this.layers.get('stagehand');
    if (stagehandLayer) {
      const stagehandMatches = await stagehandLayer.process(sectionObs, ctx);
      if (stagehandMatches.length > matches.length) {
        return stagehandMatches;
      }
    }

    return matches;
  }

  /**
   * Assign layers by match confidence:
   *   ≥0.8 → DOM (free)
   *   ≥0.6 → Stagehand (cheap)
   *   <0.6 → Magnitude (expensive)
   */
  private planActions(matches: FieldMatch[]): PlannedAction[] {
    return matches.map((m) => {
      let layer: LayerId;
      if (m.confidence >= 0.8) {
        layer = 'dom';
      } else if (m.confidence >= 0.6) {
        layer = this.layers.has('stagehand') ? 'stagehand' : 'dom';
      } else {
        layer = this.layers.has('magnitude') ? 'magnitude' : 'stagehand';
      }

      return {
        field: m.field,
        actionType: this.inferActionType(m.field),
        value: m.value,
        layer,
        attemptCount: 0,
        layerHistory: [],
        confidence: m.confidence,
        matchMethod: m.matchMethod,
      };
    });
  }

  /**
   * Execute an action with escalation on failure.
   * Tries assigned layer → next layer → next layer.
   * Max 2 attempts per layer.
   */
  private async executeWithEscalation(
    action: PlannedAction,
    ctx: LayerContext,
  ): Promise<ExecutionResult> {
    const layerOrder = this.policy.layerOrder;
    let startIdx = layerOrder.indexOf(action.layer);
    if (startIdx === -1) startIdx = 0;

    for (let li = startIdx; li < layerOrder.length; li++) {
      const layerId = layerOrder[li];
      const layer = this.layers.get(layerId);
      if (!layer) continue;

      for (let attempt = 0; attempt < this.policy.maxAttemptsPerLayer; attempt++) {
        action.attemptCount++;
        action.layer = layerId;

        try {
          // Execute
          const [result] = await layer.execute([action], ctx);

          if (result.success) {
            // Review
            const [review] = await layer.review([action], [result], ctx);

            if (review.verified) {
              return result;
            }

            // Review failed — retry or escalate
            ctx.logger?.warn('Review failed', {
              field: action.field.label,
              layer: layerId,
              expected: review.expected,
              actual: review.actual,
            });
          } else {
            // Execution failed
            const layerError = layer.throwError(
              new Error(result.error ?? 'Execution failed'),
              ctx,
            );

            action.layerHistory.push({ layer: layerId, error: result.error });

            // Fast escalation for certain errors
            if (this.policy.fastEscalationErrors.includes(layerError.category)) {
              ctx.logger?.debug('Fast escalation', {
                field: action.field.label,
                from: layerId,
                reason: layerError.category,
              });
              break; // Skip to next layer
            }
          }
        } catch (err) {
          const layerError = layer.throwError(err, ctx);
          action.layerHistory.push({
            layer: layerId,
            error: err instanceof Error ? err.message : String(err),
          });

          if (this.policy.fastEscalationErrors.includes(layerError.category)) {
            break;
          }
        }
      }
    }

    // All layers exhausted
    return {
      success: false,
      layer: action.layer,
      field: action.field,
      valueApplied: action.value,
      costIncurred: 0,
      durationMs: 0,
      error: `All layers failed for field "${action.field.label}"`,
    };
  }

  /**
   * Quick DOM readback observation after each action (free).
   */
  private async quickObserve(ctx: LayerContext): Promise<V3ObservationResult> {
    const domLayer = this.layers.get('dom')!;
    return domLayer.observe(ctx);
  }

  /**
   * Navigate to the next page using the GUI agent (Layer 3).
   */
  private async navigateNext(ctx: LayerContext): Promise<boolean> {
    // Try Magnitude first (best at clicking Next/Continue/Submit)
    const magLayer = this.layers.get('magnitude');
    if (magLayer) {
      try {
        const result = await (magLayer as any).adapter.act(
          'Click the "Next", "Continue", or "Save & Continue" button to proceed to the next page. Do NOT click "Submit" unless this is the final review page.',
        );
        if (result.success) {
          await ctx.page.waitForTimeout(1000);
          return true;
        }
      } catch {
        // Fall through to DOM approach
      }
    }

    // Fallback: Try clicking via DOM
    const clicked = await ctx.page.evaluate(() => {
      const selectors = [
        'button[data-automation-id="bottom-navigation-next-button"]',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Save & Continue")',
        'button[type="submit"]',
        'input[type="submit"]',
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel) as HTMLButtonElement;
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
        } catch { /* try next */ }
      }
      return false;
    });

    if (clicked) {
      await ctx.page.waitForTimeout(1000);
    }

    return clicked;
  }

  /**
   * Record an executed action for cookbook.
   */
  private recordAction(action: PlannedAction, result: ExecutionResult): void {
    this.cookbookActions.push({
      fieldSnapshot: {
        id: action.field.id,
        selector: action.field.selector,
        xpath: action.field.xpath,
        automationId: action.field.automationId,
        fieldType: action.field.fieldType,
        label: action.field.label,
        name: action.field.name,
        placeholder: action.field.placeholder,
        ariaLabel: action.field.ariaLabel,
        required: action.field.required,
        options: action.field.options,
        boundingBox: action.field.boundingBox,
        domDepth: action.field.domDepth,
        parentContainer: action.field.parentContainer,
        stagehandDescription: action.field.stagehandDescription,
      },
      domAction: {
        selector: action.field.selector,
        valueTemplate: `{{${action.matchMethod === 'automation_id' ? action.value : action.field.label}}}`,
        action: action.actionType,
      },
      guiAction: result.boundingBoxAtExecution
        ? {
            variant: action.actionType === 'fill' ? 'type' : 'click',
            x: result.boundingBoxAtExecution.x + result.boundingBoxAtExecution.width / 2,
            y: result.boundingBoxAtExecution.y + result.boundingBoxAtExecution.height / 2,
            content: action.actionType === 'fill' ? action.value : undefined,
          }
        : undefined,
      executedBy: result.layer,
      boundingBoxAtExecution: result.boundingBoxAtExecution,
      healthScore: result.success ? 1.0 : 0.0,
    });
  }

  private inferActionType(field: FormField): PlannedAction['actionType'] {
    switch (field.fieldType) {
      case 'select':
      case 'searchable_select':
        return 'select';
      case 'checkbox':
        return 'check';
      case 'radio':
        return 'click';
      case 'file':
        return 'upload';
      default:
        return 'fill';
    }
  }

  private detectLastPage(observation: V3ObservationResult): boolean {
    // Check for submit/review indicators
    const hasSubmitOnly = observation.buttons.some(
      (b) =>
        /submit|apply|confirm/i.test(b.text) &&
        !observation.buttons.some((b2) => /next|continue|save.*continue/i.test(b2.text)),
    );
    return hasSubmitOnly;
  }
}
