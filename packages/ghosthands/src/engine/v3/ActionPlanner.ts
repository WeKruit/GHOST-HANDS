import type { FieldModel, FieldMatch, ActionItem, ActionPlan, ActionType, Tier } from './v2types';
import { getLogger } from '../../monitoring/logger';

const logger = getLogger({ service: 'action-planner' });

/**
 * ActionPlanner — Tier assignment and action ordering for the v2 hybrid engine.
 *
 * Converts a list of matched/unmatched fields into a sorted ActionPlan where
 * each ActionItem carries a tier (0 = DOM-direct, 3 = LLM-assisted) and an
 * action type that dictates how the executor should interact with the element.
 */
export class ActionPlanner {
  /**
   * Build a complete ActionPlan from matched and unmatched fields.
   *
   * 1. Converts each FieldMatch into a tiered ActionItem.
   * 2. Converts each unmatched FieldModel into a tier-3 ActionItem.
   * 3. Sorts all actions top-to-bottom by absoluteY.
   * 4. Returns the plan with tier counts.
   */
  plan(matches: FieldMatch[], unmatched: FieldModel[]): ActionPlan {
    const actions: ActionItem[] = [];

    // Matched fields — tier determined by confidence + field type
    for (const match of matches) {
      const tier = this.assignTier(match);
      const action = this.selectAction(match.field);

      actions.push({
        field: match.field,
        action,
        value: match.value,
        tier,
        match,
        retryCount: 0,
        maxRetries: 2,
      });
    }

    // Unmatched fields — always tier 3, LLM must determine value
    for (const field of unmatched) {
      const action = this.selectUnmatchedAction(field);

      actions.push({
        field,
        action,
        value: '',
        tier: 3,
        retryCount: 0,
        maxRetries: 2,
      });
    }

    // Sort top-to-bottom by absolute Y position on the page
    actions.sort((a, b) => a.field.absoluteY - b.field.absoluteY);

    // Count tiers
    const tier0Count = actions.filter((a) => a.tier === 0).length;
    const tier3Count = actions.filter((a) => a.tier === 3).length;

    // Log plan summary
    logger.info('Action plan created', {
      totalActions: actions.length,
      tier0Count,
      tier3Count,
      unmatchedCount: unmatched.length,
    });

    // Debug log each individual action
    for (const item of actions) {
      const truncatedValue = item.value.length > 30
        ? item.value.slice(0, 30) + '...'
        : item.value;

      logger.debug('Planned action', {
        label: item.field.label,
        tier: item.tier,
        actionType: item.action,
        value: truncatedValue,
      });
    }

    return {
      actions,
      tier0Count,
      tier3Count,
      unmatchedFields: unmatched,
    };
  }

  /**
   * Determine the execution tier for a matched field.
   *
   * Tier 0 — DOM-direct: high/medium confidence on standard HTML controls.
   * Tier 3 — LLM-assisted: low confidence, password fields, or unknown types.
   */
  private assignTier(match: FieldMatch): Tier {
    const { field, confidence } = match;
    const { fieldType } = field;

    // Password fields always go to LLM for security handling
    if (fieldType === 'password') {
      return 3;
    }

    // Unknown field types always go to LLM
    if (fieldType === 'unknown') {
      return 3;
    }

    // Typeahead fields — try DOM type-and-select first
    if (fieldType === 'typeahead') {
      return 0;
    }

    // High confidence (>= 0.8)
    if (confidence >= 0.8) {
      const highConfTier0Types = new Set([
        'text', 'email', 'phone', 'number', 'textarea',
        'select', 'checkbox', 'date', 'file',
        'custom_dropdown', 'radio', 'aria_radio',
      ]);

      if (highConfTier0Types.has(fieldType)) {
        return 0;
      }
    }

    // Medium confidence (>= 0.6)
    if (confidence >= 0.6) {
      const medConfTier0Types = new Set([
        'text', 'email', 'phone', 'number', 'textarea', 'select',
        'custom_dropdown', 'radio', 'aria_radio',
      ]);

      if (medConfTier0Types.has(fieldType)) {
        return 0;
      }
    }

    // Low confidence (< 0.6) — LLM handles it
    return 3;
  }

  /**
   * Determine the action type for a matched field based on its field type.
   */
  private selectAction(field: FieldModel): ActionType {
    switch (field.fieldType) {
      case 'text':
      case 'email':
      case 'phone':
      case 'number':
      case 'textarea':
      case 'contenteditable':
      case 'password':
      case 'date':
        return 'fill';

      case 'select':
      case 'custom_dropdown':
      case 'radio':
      case 'aria_radio':
        return 'select';

      case 'checkbox':
        return 'check';

      case 'file':
      case 'upload_button':
        return 'upload';

      case 'typeahead':
        return 'type_and_select';

      case 'unknown':
      default:
        return 'fill';
    }
  }

  /**
   * Determine the action type for an unmatched field.
   * Same mapping as selectAction — all unmatched fields are tier 3
   * regardless of the action type returned here.
   */
  private selectUnmatchedAction(field: FieldModel): ActionType {
    return this.selectAction(field);
  }
}
