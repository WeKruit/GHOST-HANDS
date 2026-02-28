/**
 * SectionOrchestrator — Main v3 execution loop.
 *
 * For each page:
 *   1. Observe → detect sections → for each section:
 *      a. Process (match fields → user data, cheapest layer first)
 *      b. Plan actions (assign layers by confidence)
 *      c. Execute with escalation (try assigned layer, review, escalate on failure)
 *      d. Verify field filled after each action (DOM readback, free)
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
    let lastFingerprint = '';

    for (let page = 0; page < MAX_PAGES; page++) {
      const currentUrl = ctx.page.url();

      // P0-1: SPA-aware stuck detection — track URL + page fingerprint
      // Generate fingerprint from field count + sorted field IDs to detect SPA changes
      const fingerprint = await this.getPageFingerprint(ctx);

      if (currentUrl === lastUrl && fingerprint === lastFingerprint) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK_COUNT) {
          result.errors.push(`Stuck on page for ${MAX_STUCK_COUNT} attempts: ${currentUrl}`);
          break;
        }
      } else {
        stuckCount = 0;
        lastUrl = currentUrl;
        lastFingerprint = fingerprint;
      }

      ctx.logger?.info('Processing page', { page: page + 1, url: currentUrl });

      try {
        const pageResult = await this.processPage(ctx, result.actionsVerified);
        result.pagesProcessed++;
        result.actionsExecuted += pageResult.actionsExecuted;
        result.actionsVerified += pageResult.actionsVerified;
        result.actionsFailed += pageResult.actionsFailed;
        result.totalCost += pageResult.cost;
        this.totalCost += pageResult.cost;
        ctx.budgetRemaining -= pageResult.cost;

        // P0-2: If blocked, do NOT count as success — break immediately
        if (pageResult.blocked) {
          result.errors.push(`Blocked: ${pageResult.blockerCategories.join(', ')}`);
          break;
        }

        // Budget exhausted — stop, do not navigate or continue
        if (pageResult.budgetExhausted) {
          result.errors.push('Budget exhausted');
          break;
        }

        if (pageResult.isLastPage) {
          // Terminal page detected — actually click the submit button before reporting success.
          // Without this, we'd detect the page as terminal but never press submit.
          const submitResult = await this.clickSubmitButton(ctx);
          result.totalCost += submitResult.cost;
          this.totalCost += submitResult.cost;
          ctx.budgetRemaining -= submitResult.cost;

          if (submitResult.submitted) {
            result.success = result.actionsVerified > 0;
          } else {
            result.errors.push('Terminal page detected but submit button click failed');
          }
          break;
        }

        // Navigate to next page using Magnitude (Layer 3)
        const navResult = await this.navigateNext(ctx);
        // Charge navigation cost even on failure
        result.totalCost += navResult.cost;
        this.totalCost += navResult.cost;
        ctx.budgetRemaining -= navResult.cost;

        if (!navResult.navigated) {
          // Navigation failed — NOT success. Could be disabled button,
          // unrecognized label, or Magnitude failure. Do NOT assume completion.
          result.errors.push('Navigation failed: could not find or click next/continue button');
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
  private async processPage(ctx: LayerContext, cumulativeVerified: number = 0): Promise<{
    actionsExecuted: number;
    actionsVerified: number;
    actionsFailed: number;
    cost: number;
    isLastPage: boolean;
    blocked: boolean;
    blockerCategories: string[];
    budgetExhausted: boolean;
  }> {
    let actionsExecuted = 0;
    let actionsVerified = 0;
    let actionsFailed = 0;
    let cost = 0;

    // Step 1: Observe (cheapest layer first — DOM)
    const domLayer = this.layers.get('dom')!;
    const observation = await domLayer.observe(ctx);
    cost += observation.costIncurred;

    // P1-3: Budget check AFTER observation (observation itself costs money on some layers)
    if (ctx.budgetRemaining - cost <= 0) {
      return {
        actionsExecuted, actionsVerified, actionsFailed, cost,
        isLastPage: false, blocked: false, blockerCategories: [],
        budgetExhausted: true,
      };
    }

    // P0-2: Check for blockers — return blocked flag instead of falsely continuing
    if (observation.blockers.length > 0) {
      const blockerCategories = observation.blockers.map((b) => b.category);
      ctx.logger?.warn('Blockers detected', { blockers: blockerCategories });
      return {
        actionsExecuted, actionsVerified, actionsFailed, cost,
        isLastPage: false, blocked: true, blockerCategories,
        budgetExhausted: false,
      };
    }

    // Step 2: Group into sections
    const sections = this.grouper.group(observation.fields, observation.buttons);
    ctx.logger?.info('Sections detected', {
      count: sections.length,
      names: sections.map((s) => s.name),
    });

    // Accumulating set of known field fingerprints — grows as conditional fields are discovered.
    // Uses durable fingerprints (id, data-testid, data-automation-id, name, label+type)
    // instead of synthetic data-gh-scan-idx selectors which PageScanner reassigns on rescan.
    // Start empty — seed lazily as fields are successfully processed.
    // Pre-seeding from observation.fields includes hidden/offscreen fields that
    // stale-field pruning later removes, preventing conditional field discovery
    // from detecting fields that were initially hidden but became interactive.
    const knownFieldFingerprints = new Set<string>();

    // Step 3: Process each section
    for (const section of sections) {
      if (section.allFilled) {
        ctx.logger?.debug('Section already filled', { section: section.name });
        continue;
      }

      // Prune stale fields: DOM mutations from prior fills may have hidden or removed
      // fields that were visible in the initial observation. Re-check visibility before
      // processing to avoid matching/escalating against stale selectors.
      const liveFields = await Promise.all(
        section.fields.map(async (f) => ({
          field: f,
          visible: await ctx.page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (!el) return false;
            if (el.disabled) return false;
            const tag = el.tagName.toLowerCase();
            const type = (el as HTMLInputElement).type?.toLowerCase() ?? '';
            if (el.readOnly && tag === 'input' && !['date', 'button'].includes(type) && el.getAttribute('role') !== 'combobox') {
              return false;
            }
            if (el.getAttribute('aria-disabled') === 'true') return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          }, f.selector).catch(() => false),
        })),
      );

      const currentSection: FormSection = {
        ...section,
        fields: liveFields.filter((x) => x.visible).map((x) => x.field),
      };

      if (currentSection.fields.length === 0) {
        ctx.logger?.debug('Section has no visible fields after pruning', { section: section.name });
        continue;
      }

      // Match fields to user data (cheapest layer first)
      const matches = await this.processSection(currentSection, observation, ctx);
      if (matches.length === 0) continue;

      // Plan actions (assign layers by confidence)
      const actions = this.planActions(matches);

      // Track per-section verified count for conditional field trigger
      let sectionVerified = 0;
      const sectionResults: Array<{ action: PlannedAction; success: boolean }> = [];

      // Execute each action with escalation
      for (const action of actions) {
        // Per-action budget guard — stop spending once budget is exhausted
        if (ctx.budgetRemaining - cost <= 0) {
          ctx.logger?.warn('Budget exhausted mid-section, stopping', {
            budgetRemaining: ctx.budgetRemaining,
            costSoFar: cost,
          });
          return {
            actionsExecuted, actionsVerified, actionsFailed, cost,
            isLastPage: false, blocked: false, blockerCategories: [],
            budgetExhausted: true,
          };
        }

        const execResult = await this.executeWithEscalation(action, ctx);
        actionsExecuted++;
        cost += execResult.costIncurred;
        sectionResults.push({ action, success: execResult.success });

        if (execResult.success) {
          actionsVerified++;
          sectionVerified++;
        } else {
          actionsFailed++;
        }

        // P1-2: Targeted field verification instead of full rescan
        if (execResult.success) {
          await this.verifyFieldFilled(action.field, ctx);
        }

        // Record for cookbook
        this.recordAction(action, execResult);
      }

      // Only seed fingerprints for actions that were verified successful.
      // Failed actions should remain discoverable for conditional re-processing.
      for (const { action, success } of sectionResults) {
        if (success) {
          knownFieldFingerprints.add(this.fieldFingerprint(action.field));
        }
      }

      // Conditional field discovery: re-observe after filling THIS section to catch
      // newly revealed fields (e.g., selecting "Yes" reveals a follow-up input).
      // Only trigger when this section had verified fills (not page-total).
      if (sectionVerified > 0) {
        const newFieldsResult = await this.discoverConditionalFields(
          section, knownFieldFingerprints, ctx, cost,
        );
        if (newFieldsResult) {
          actionsExecuted += newFieldsResult.executed;
          actionsVerified += newFieldsResult.verified;
          actionsFailed += newFieldsResult.failed;
          cost += newFieldsResult.cost;
        }
      }
    }

    // Check if this is the last page (submit-only, no next/continue).
    // A terminal page requires EITHER:
    //   - This page had verified fills (normal form page with submit), OR
    //   - Prior pages had verified fills (review-only submit page with no editable fields)
    // This handles the common "review and submit" final page that has no form fields.
    //
    // Re-observe AFTER fills if we modified the page — a submit button that starts
    // disabled (e.g. "complete required fields first") and becomes enabled after fills
    // would be missed by the pre-fill observation snapshot.
    const totalVerified = cumulativeVerified + actionsVerified;
    let terminalObservation: V3ObservationResult;
    if (actionsVerified > 0) {
      const freshObs = await domLayer.observe(ctx);
      cost += freshObs.costIncurred;
      terminalObservation = freshObs;
    } else {
      terminalObservation = observation;
    }
    const isLastPage = totalVerified > 0 && this.detectLastPage(terminalObservation);

    return {
      actionsExecuted, actionsVerified, actionsFailed, cost,
      isLastPage, blocked: false, blockerCategories: [],
      budgetExhausted: false,
    };
  }

  /**
   * P1-1: Match section fields to user data, merging DOM + Stagehand matches by field ID.
   * DOM matches first (free), then Stagehand fills gaps for fields DOM missed.
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
    const domMatches = await domLayer.process(sectionObs, ctx);

    // If DOM matched all fields, done
    if (domMatches.length >= section.fields.length) {
      return domMatches;
    }

    // Find fields DOM missed and try Stagehand for those
    const stagehandLayer = this.layers.get('stagehand');
    if (stagehandLayer) {
      const matchedIds = new Set(domMatches.map((m) => m.field.id));
      const unmatchedFields = section.fields.filter((f) => !matchedIds.has(f.id));

      if (unmatchedFields.length > 0) {
        const stagehandObs: V3ObservationResult = {
          ...sectionObs,
          fields: unmatchedFields,
        };
        const stagehandMatches = await stagehandLayer.process(stagehandObs, ctx);
        return [...domMatches, ...stagehandMatches];
      }
    }

    return domMatches;
  }

  /**
   * Assign layers by match confidence:
   *   >=0.8 -> DOM (free)
   *   >=0.6 -> Stagehand (cheap)
   *   <0.6  -> Magnitude (expensive)
   *
   * P0-4: Threads userDataKey from FieldMatch into PlannedAction.
   */
  private planActions(matches: FieldMatch[]): PlannedAction[] {
    return matches.map((m) => {
      let layer: LayerId;
      if (m.confidence >= 0.8) {
        layer = 'dom';
      } else if (m.confidence >= 0.6) {
        layer = this.layers.has('stagehand') ? 'stagehand' : 'dom';
      } else {
        // Fall through the layer chain: magnitude → stagehand → dom.
        // Without this, a DOM-only config assigns 'stagehand' which doesn't exist,
        // and escalation starts at index 1, skipping DOM entirely.
        layer = this.layers.has('magnitude')
          ? 'magnitude'
          : this.layers.has('stagehand')
            ? 'stagehand'
            : 'dom';
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
        userDataKey: m.userDataKey,
      };
    });
  }

  /**
   * Execute an action with escalation on failure.
   * Tries assigned layer -> next layer -> next layer.
   * Max 2 attempts per layer.
   *
   * P1-3: Accumulates cost from each layer attempt, even on failure.
   */
  private async executeWithEscalation(
    action: PlannedAction,
    ctx: LayerContext,
  ): Promise<ExecutionResult> {
    const layerOrder = this.policy.layerOrder;
    let startIdx = layerOrder.indexOf(action.layer);
    if (startIdx === -1) startIdx = 0;

    let accumulatedCost = 0;

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
          accumulatedCost += result.costIncurred;

          if (result.success) {
            // Review
            const [review] = await layer.review([action], [result], ctx);

            if (review.verified) {
              return { ...result, costIncurred: accumulatedCost };
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

          // Track cost estimate for failed attempt
          accumulatedCost += layer.costPerAction;

          if (this.policy.fastEscalationErrors.includes(layerError.category)) {
            break;
          }
        }
      }
    }

    // All layers exhausted — return accumulated cost, not hardcoded 0
    return {
      success: false,
      layer: action.layer,
      field: action.field,
      valueApplied: action.value,
      costIncurred: accumulatedCost,
      durationMs: 0,
      error: `All layers failed for field "${action.field.label}"`,
    };
  }

  /**
   * Returns a durable fingerprint for a field that survives PageScanner rescans.
   * Synthetic `data-gh-scan-idx` selectors are NOT durable — they're reassigned
   * on every scan based on DOM order, so a newly inserted field shifts all later indices.
   * Falls back to label + fieldType as a last resort for anonymous fields.
   */
  private fieldFingerprint(field: FormField): string {
    // Durable selectors: id-based, data-testid, data-automation-id
    if (field.selector.startsWith('#')) return field.selector;
    if (field.selector.startsWith('[data-testid=')) return field.selector;
    if (field.selector.startsWith('[data-automation-id=')) return field.selector;
    if (field.automationId) return `[data-automation-id="${field.automationId}"]`;
    if (field.name) return `name:${field.name}`;
    // Synthetic scan-idx selectors are NOT stable — use label+type+structural metadata.
    // parentContainer + domDepth + domOrdinal disambiguate repeated labels in dynamic rows
    // (e.g., multiple "Company" text fields in work experience sections).
    // domOrdinal is the sibling index among same-tag children — prevents collapsing
    // anonymous siblings that share the same parent container and DOM depth.
    const container = field.parentContainer ?? 'root';
    const depth = field.domDepth ?? -1;
    const ordinal = field.domOrdinal ?? -1;
    return `label:${field.label}::${field.fieldType}::parent:${container}::depth:${depth}::ord:${ordinal}`;
  }

  /**
   * Discover conditional fields that appeared after filling a section.
   * Diffs by durable fingerprint (stable across rescans) not by ID or synthetic selector.
   * The knownFingerprints set accumulates across sections to prevent re-processing.
   */
  /**
   * Discover conditional fields that appeared after filling a section.
   * Multi-pass: a newly revealed field may itself trigger another conditional field
   * (e.g., "Do you have a disability?" → "Yes" → "Describe your disability").
   * Runs up to 3 discovery passes to catch chained conditionals.
   */
  private async discoverConditionalFields(
    section: FormSection,
    knownFingerprints: Set<string>,
    ctx: LayerContext,
    pageCostSoFar: number = 0,
  ): Promise<{ executed: number; verified: number; failed: number; cost: number } | null> {
    const total = { executed: 0, verified: 0, failed: 0, cost: 0 };
    const MAX_CONDITIONAL_DEPTH = 3;

    try {
      for (let depth = 0; depth < MAX_CONDITIONAL_DEPTH; depth++) {
        const passResult = await this.discoverConditionalFieldsPass(
          section, knownFingerprints, ctx, pageCostSoFar + total.cost,
        );
        if (!passResult) break;

        total.executed += passResult.executed;
        total.verified += passResult.verified;
        total.failed += passResult.failed;
        total.cost += passResult.cost;

        // Only continue if we actually filled something (which could reveal more fields)
        if (passResult.verified === 0) break;
      }

      return total.executed > 0 ? total : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/target closed|browser.*closed|execution context.*destroyed|page closed/i.test(msg)) {
        throw err;
      }
      return total.executed > 0 ? total : null;
    }
  }

  /**
   * Single pass of conditional field discovery.
   */
  private async discoverConditionalFieldsPass(
    section: FormSection,
    knownFingerprints: Set<string>,
    ctx: LayerContext,
    pageCostSoFar: number,
  ): Promise<{ executed: number; verified: number; failed: number; cost: number } | null> {
    const domLayer = this.layers.get('dom')!;
    const newObs = await domLayer.observe(ctx);

    // Diff by durable fingerprint — NOT synthetic data-gh-scan-idx selectors
    // which PageScanner reassigns on every rescan based on DOM order.
    const newFields = newObs.fields.filter(
      (f) => !knownFingerprints.has(this.fieldFingerprint(f)) && f.visible && !f.disabled,
    );

    if (newFields.length === 0) return null;

    // Add discovered fingerprints to the accumulating set so they're not
    // re-discovered by later sections or passes.
    for (const f of newFields) {
      knownFingerprints.add(this.fieldFingerprint(f));
    }

    ctx.logger?.info('Conditional fields discovered', {
      count: newFields.length,
      labels: newFields.map((f) => f.label),
    });

    // Build a mini section for the new fields and process them
    const miniSection: FormSection = {
      id: `${section.id}-conditional`,
      name: `${section.name} (conditional)`,
      fields: newFields,
      buttons: [],
      yRange: section.yRange,
      allFilled: false,
    };

    const matches = await this.processSection(miniSection, newObs, ctx);
    if (matches.length === 0) return null;

    const actions = this.planActions(matches);
    let executed = 0, verified = 0, failed = 0, cost = 0;

    for (const action of actions) {
      // Budget guard accounts for BOTH page cost already spent and local cost
      if (ctx.budgetRemaining - pageCostSoFar - cost <= 0) break;

      const execResult = await this.executeWithEscalation(action, ctx);
      executed++;
      cost += execResult.costIncurred;

      if (execResult.success) {
        verified++;
        await this.verifyFieldFilled(action.field, ctx);
      } else {
        failed++;
      }

      this.recordAction(action, execResult);
    }

    return { executed, verified, failed, cost };
  }

  /**
   * P1-2: Targeted value readback for the field we just filled (free, fast).
   * Replaces the expensive full-page quickObserve().
   */
  private async verifyFieldFilled(field: FormField, ctx: LayerContext): Promise<boolean> {
    try {
      return await ctx.page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as Element | null;
        if (!el) return false;
        // Check for value property (inputs, selects, textareas)
        if ('value' in el) return ((el as HTMLInputElement).value || '').trim().length > 0;
        // Check combobox role
        if (el.getAttribute('role') === 'combobox') return (el.textContent || '').trim() !== 'Select One';
        return (el.textContent || '').trim().length > 0;
      }, field.selector);
    } catch {
      return false;
    }
  }

  /**
   * P0-1: Generate a lightweight page fingerprint from field structure.
   * Detects SPA changes where URL stays the same but page content changes.
   */
  private async getPageFingerprint(ctx: LayerContext): Promise<string> {
    try {
      return await ctx.page.evaluate(() => {
        const fields = document.querySelectorAll(
          'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="radiogroup"]',
        );
        const ids: string[] = [];
        const fieldArr = Array.from(fields);
        // Per-type ordinal counter for anonymous fields — ensures unique tokens
        // even when multiple fields share the same tag+type+depth.
        const anonCounts = new Map<string, number>();
        for (let i = 0; i < fieldArr.length; i++) {
          const f = fieldArr[i];
          const rect = f.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const named = f.id || f.getAttribute('name') || f.getAttribute('data-automation-id');
            if (named) {
              ids.push(named);
            } else {
              // Anonymous field: tag + input type + DOM depth + ordinal.
              // This prevents many anonymous INPUTs from collapsing into one
              // "INPUT" token, which would make turnover comparison meaningless.
              const tag = f.tagName;
              const type = (f as HTMLInputElement).type?.toLowerCase() || '';
              let depth = 0;
              let p = f.parentElement;
              while (p) { depth++; p = p.parentElement; }
              const key = `${tag}:${type}:d${depth}`;
              const ord = anonCounts.get(key) || 0;
              anonCounts.set(key, ord + 1);
              ids.push(`${key}:${ord}`);
            }
          }
        }
        return `${ids.length}::${ids.sort().join(',')}`;
      });
    } catch {
      return '';
    }
  }

  /**
   * Navigate to the next page using the GUI agent (Layer 3).
   * P1-7/P1-11: DOM fallback uses JavaScript text matching instead of invalid :has-text() CSS.
   */
  private async navigateNext(ctx: LayerContext): Promise<{ navigated: boolean; cost: number }> {
    const beforeUrl = ctx.page.url();
    const beforeFingerprint = await this.getPageFingerprint(ctx);
    let navCost = 0;
    let clicked = false;

    // Try Magnitude first (best at clicking Next/Continue/Submit)
    const magLayer = this.layers.get('magnitude');
    if (magLayer) {
      try {
        const navAction: PlannedAction = {
          field: {
            id: 'nav-next',
            selector: 'button',
            fieldType: 'unknown',
            label: 'Next/Continue button',
            required: false,
            visible: true,
            disabled: false,
          },
          actionType: 'click',
          value: 'Next',
          layer: 'magnitude',
          attemptCount: 0,
          layerHistory: [],
          confidence: 0.9,
          matchMethod: 'default',
        };
        const [result] = await magLayer.execute([navAction], ctx);
        navCost += result.costIncurred;
        if (result.success) {
          clicked = true;
        }
      } catch (err) {
        // Fatal browser errors should abort, not silently fall through
        if (err instanceof Error && /target closed|browser.*closed|execution context.*destroyed|page closed/i.test(err.message)) {
          throw err;
        }
        // Fall through to DOM approach
      }
    }

    // Fallback: Try clicking via DOM with JavaScript text matching.
    // Order matters: data-automation-id → text match (Next/Continue) → submit-type buttons.
    // Submit-type buttons MUST be last resort — they can match "Save Draft", "Add Employer",
    // or subform submits that are NOT the primary navigation button.
    if (!clicked) {
      clicked = await ctx.page.evaluate(() => {
        // 1. Try data-automation-id first (most reliable)
        const autoBtn = document.querySelector(
          'button[data-automation-id="bottom-navigation-next-button"]',
        ) as HTMLButtonElement | null;
        if (autoBtn && !autoBtn.disabled) {
          autoBtn.click();
          return true;
        }

        // 2. Text-match buttons for Next/Continue/Save & Continue
        const patterns = [/^next$/i, /^continue$/i, /^save.*continue$/i, /^save\s*&\s*continue$/i];
        const allButtons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < allButtons.length; i++) {
          const text = (allButtons[i].textContent || '').trim();
          if (patterns.some((p) => p.test(text)) && !allButtons[i].disabled) {
            allButtons[i].click();
            return true;
          }
        }

        // 3. Submit-type buttons as LAST resort — but ONLY if their label matches
        // navigation patterns. Clicking by type alone can hit "Save Draft", "Add",
        // or nested subform submits that are NOT the primary navigation.
        const submitInputs = Array.from(document.querySelectorAll(
          'button[type="submit"], input[type="submit"]',
        )) as Array<HTMLButtonElement | HTMLInputElement>;
        for (const el of submitInputs) {
          if (el.disabled) continue;
          const text = (el.textContent || (el as HTMLInputElement).value || '').trim();
          if (patterns.some((p) => p.test(text))) {
            el.click();
            return true;
          }
        }

        return false;
      });
    }

    if (!clicked) {
      return { navigated: false, cost: navCost };
    }

    // Poll for navigation — slow Workday/Greenhouse transitions may take several seconds.
    // A single immediate check misses legitimate in-progress transitions.
    // Check BOTH url change AND nav button disappearance (not just any fingerprint change,
    // which would false-positive on accordion expansions or revealed fields).
    let lastChangedFingerprint: string | null = null;
    let lastStableCount: number | null = null;

    for (let i = 0; i < 10; i++) {
      await ctx.page.waitForTimeout(500);

      const afterUrl = ctx.page.url();
      if (afterUrl !== beforeUrl) {
        return { navigated: true, cost: navCost };
      }

      // Lightweight check: is the nav button still present?
      // Uses a direct page.evaluate instead of full observe() (which runs PageScanner
      // scroll+extract ~15 rounds). This keeps each poll iteration fast (~50ms, not ~3s).
      try {
        const stillHasNav = await ctx.page.evaluate(() => {
          const patterns = [/^next$/i, /^continue$/i, /^save.*continue$/i];
          const buttons = document.querySelectorAll('button, input[type="submit"]');
          for (const btn of buttons) {
            if ((btn as HTMLButtonElement).disabled) continue;
            const text = (btn.textContent || (btn as HTMLInputElement).value || '').trim();
            if (patterns.some((p) => p.test(text))) return true;
          }
          return false;
        });
        if (!stillHasNav) {
          return { navigated: true, cost: navCost };
        }

        // Structural fingerprint comparison: detects SPA page turns where field
        // count stays similar but field identity changes. Requires stable change
        // across two consecutive polls to avoid accordion false-positives.
        const afterFingerprint = await this.getPageFingerprint(ctx).catch(() => '');
        if (beforeFingerprint && afterFingerprint && afterFingerprint !== beforeFingerprint) {
          // Exact stability: same changed fingerprint on 2 consecutive polls
          if (lastChangedFingerprint === afterFingerprint && this.isSignificantFieldTurnover(beforeFingerprint, afterFingerprint)) {
            return { navigated: true, cost: navCost };
          }
          lastChangedFingerprint = afterFingerprint;

          // Count-stability shortcut: field count changed by >2, stable for 2 polls,
          // AND significant field identity turnover (not just revealed fields).
          // Field addition (accordion, validation) keeps the same IDs + adds new ones.
          // Page turn replaces most field IDs with different ones.
          const beforeCount = this.extractCountFromFingerprint(beforeFingerprint);
          const afterCount = this.extractCountFromFingerprint(afterFingerprint);
          if (Math.abs(afterCount - beforeCount) > 2 && this.isSignificantFieldTurnover(beforeFingerprint, afterFingerprint)) {
            if (lastStableCount === afterCount) {
              return { navigated: true, cost: navCost };
            }
            lastStableCount = afterCount;
          } else {
            lastStableCount = null;
          }
        } else {
          lastChangedFingerprint = null;
          lastStableCount = null;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/target closed|browser.*closed|page closed/i.test(msg)) {
          throw err;
        }
        if (/execution context was destroyed/i.test(msg)) {
          return { navigated: true, cost: navCost };
        }
        // Unknown error — NOT navigation success. Log and continue polling.
        ctx.logger?.warn('Navigation poll error (not treated as success)', { error: msg });
      }
    }

    return { navigated: false, cost: navCost };
  }

  /**
   * Record an executed action for cookbook.
   * P0-4: Uses userDataKey for template resolution instead of field label.
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
        valueTemplate: `{{${action.userDataKey ?? action.field.label}}}`,
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

  /**
   * Click the submit button on the terminal page and verify the page actually advanced.
   * A dispatched click alone is NOT proof of success — client-side validation can block it.
   * Returns { submitted: true } only if the page URL changed or the submit button disappeared.
   */
  private async clickSubmitButton(ctx: LayerContext): Promise<{ submitted: boolean; cost: number }> {
    const beforeUrl = ctx.page.url();
    let cost = 0;

    // Shared submit patterns — kept in sync with detectLastPage()
    const submitPatternSources = [
      '^submit$',
      '^submit\\s+application$',
      '^confirm$',
      '^review\\s*(and|&)?\\s*submit$',
    ];

    // Try DOM click first (free)
    // Reads both textContent (buttons) and .value (input[type="submit"])
    // and preserves case-insensitive matching via the 'i' flag.
    const clicked = await ctx.page.evaluate((patternSources: string[]) => {
      const regexps = patternSources.map((p) => new RegExp(p, 'i'));
      const buttons = document.querySelectorAll('button, input[type="submit"]');
      for (const btn of buttons) {
        if ((btn as HTMLButtonElement).disabled) continue;
        const text = (
          btn.textContent ||
          (btn as HTMLInputElement).value ||
          ''
        ).trim();
        if (regexps.some((p) => p.test(text))) {
          (btn as HTMLButtonElement).click();
          return true;
        }
      }
      return false;
    }, submitPatternSources);

    if (clicked) {
      ctx.logger?.info('Submit button clicked via DOM');
    } else {
      // Fallback: Magnitude
      const magLayer = this.layers.get('magnitude');
      if (magLayer) {
        try {
          const submitAction: PlannedAction = {
            field: {
              id: 'submit-btn',
              selector: 'button',
              fieldType: 'unknown',
              label: 'Submit button',
              required: false,
              visible: true,
              disabled: false,
            },
            actionType: 'click',
            value: 'Submit',
            layer: 'magnitude',
            attemptCount: 0,
            layerHistory: [],
            confidence: 0.9,
            matchMethod: 'default',
          };
          const [result] = await magLayer.execute([submitAction], ctx);
          cost += result.costIncurred;
          if (result.success) {
            ctx.logger?.info('Submit button clicked via Magnitude');
          } else {
            return { submitted: false, cost };
          }
        } catch (err) {
          // Fatal browser errors should propagate, not be treated as failed submit
          if (err instanceof Error && /target closed|browser.*closed|execution context.*destroyed|page closed/i.test(err.message)) {
            throw err;
          }
          return { submitted: false, cost };
        }
      } else {
        return { submitted: false, cost };
      }
    }

    // Poll for submit effect — slow Workday/Greenhouse transitions may take several seconds.
    // A single immediate check misses legitimate in-progress submissions.
    // Checks URL change AND submit button disappearance (including disabled state).
    for (let i = 0; i < 10; i++) {
      await ctx.page.waitForTimeout(500);

      const afterUrl = ctx.page.url();
      if (afterUrl !== beforeUrl) {
        return { submitted: true, cost };
      }

      // Check if the submit button is still present (including disabled).
      // A disabled submit button still on the page means the form wasn't submitted
      // (just temporarily disabled during validation). Only count as success when
      // the button is completely gone from the DOM.
      try {
        const submitStillPresent = await ctx.page.evaluate((patternSources: string[]) => {
          const regexps = patternSources.map((p) => new RegExp(p, 'i'));
          const buttons = document.querySelectorAll('button, input[type="submit"]');
          for (const btn of buttons) {
            const text = (
              btn.textContent ||
              (btn as HTMLInputElement).value ||
              ''
            ).trim();
            if (regexps.some((p) => p.test(text))) {
              return true;
            }
          }
          return false;
        }, submitPatternSources);

        if (!submitStillPresent) {
          return { submitted: true, cost };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/target closed|browser.*closed|page closed/i.test(msg)) {
          throw err;
        }
        if (/execution context was destroyed/i.test(msg)) {
          return { submitted: true, cost };
        }
        // Unknown error — NOT submit success. Log and continue polling.
        ctx.logger?.warn('Submit poll error (not treated as success)', { error: msg });
      }
    }

    // After 5 seconds of polling, submit button still present — failed
    return { submitted: false, cost };
  }

  /**
   * Extract the field count from a page fingerprint (format: "N::id1,id2,...").
   * Returns -1 if the fingerprint doesn't match the expected format.
   */
  private extractCountFromFingerprint(fp: string): number {
    const idx = fp.indexOf('::');
    if (idx === -1) return -1;
    const n = parseInt(fp.substring(0, idx), 10);
    return isNaN(n) ? -1 : n;
  }

  /**
   * Check if two fingerprints represent a page turn (field identity turnover)
   * vs. field addition (accordion, validation reveals).
   *
   * Page turn: most before-IDs are replaced with new IDs (>50% turnover).
   * Field addition: before-IDs are a subset of after-IDs (same fields + new ones).
   */
  private isSignificantFieldTurnover(beforeFp: string, afterFp: string): boolean {
    const extractMultiset = (fp: string): Map<string, number> => {
      const idx = fp.indexOf('::');
      if (idx === -1) return new Map();
      const idStr = fp.substring(idx + 2);
      if (!idStr) return new Map();
      const counts = new Map<string, number>();
      for (const id of idStr.split(',')) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      return counts;
    };

    const beforeCounts = extractMultiset(beforeFp);
    const afterCounts = extractMultiset(afterFp);
    if (beforeCounts.size === 0) return false;

    // Multiset subtraction: for each token, missing = max(0, beforeCount - afterCount).
    let totalBefore = 0;
    let missing = 0;
    for (const [id, count] of beforeCounts) {
      totalBefore += count;
      const afterCount = afterCounts.get(id) || 0;
      if (afterCount < count) {
        missing += count - afterCount;
      }
    }
    // >50% of before-fields are gone → page turn, not field addition
    return missing > totalBefore * 0.5;
  }

  private detectLastPage(observation: V3ObservationResult): boolean {
    // Only consider enabled buttons — disabled buttons are not actionable
    const enabledButtons = observation.buttons.filter((b) => !b.disabled);

    const hasNextButton = enabledButtons.some(
      (b) => /^(next|continue|save.*continue)$/i.test(b.text.trim()),
    );
    if (hasNextButton) return false;

    // Terminal submit signals — exclude "Apply" / "Apply Now" which are entry-page buttons
    const submitPatterns = [
      /^submit$/i,
      /^submit\s+application$/i,
      /^confirm$/i,
      /^review\s*(and|&)?\s*submit$/i,
    ];
    const hasSubmitButton = enabledButtons.some(
      (b) => submitPatterns.some((p) => p.test(b.text.trim())),
    );
    return hasSubmitButton;
  }
}
