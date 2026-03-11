import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { PageDecisionContext } from './types';

const SYSTEM_PROMPT_CACHE = new Map<string, string>();

export const PLATFORM_GUARDRAILS: Record<string, string> = {
  workday: [
    'Workday often uses multi-step sections with repeated "Next" buttons.',
    'Treat any visible "Submit", "Submit Application", or final review CTA as a stop condition, not a click target.',
    'If password fields are visible, prefer login or create_account over generic form filling.',
    'Use expand_repeaters when work history or education sections expose visible "Add" controls.',
  ].join('\n'),
  greenhouse: [
    'Greenhouse usually has a single-page application flow with resume upload near the top.',
    'The initial "Apply" button can be valid, but never click a final "Submit Application" button.',
    'If the page shows a review/confirmation summary, return stop_for_review or mark_complete.',
  ].join('\n'),
  lever: [
    'Lever often keeps the application on one long page with a final submit button at the bottom.',
    'Prefer fill_form while editable fields remain visible; never convert a visible submit button into a click.',
    'Scrolling is acceptable when the page is long and no higher-priority action is clear.',
  ].join('\n'),
  smartrecruiters: [
    'SmartRecruiters may split flows across apply, login, and review steps.',
    'If authentication prompts appear, prefer login or create_account rather than generic click actions.',
    'Any CAPTCHA, turnstile, or verification wall must map to report_blocked.',
  ].join('\n'),
  other: [
    'Stay conservative on unfamiliar platforms.',
    'Prefer fill_form over navigation when visible editable fields remain.',
    'Never press a button whose text implies final submission.',
    'Use stop_for_review on read-only review pages and mark_complete only on true confirmations.',
  ].join('\n'),
};

export const DECISION_TOOL: Tool = {
  name: 'page_decision',
  type: 'custom',
  strict: true,
  description:
    'Return the single safest next navigation action for the current job application page. Never submit the application.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'fill_form',
          'click_next',
          'click_apply',
          'upload_resume',
          'select_option',
          'dismiss_popup',
          'scroll_down',
          'login',
          'create_account',
          'enter_verification',
          'expand_repeaters',
          'wait_and_retry',
          'stop_for_review',
          'mark_complete',
          'report_blocked',
        ],
      },
      reasoning: {
        type: 'string',
        description: 'Brief justification grounded in the current page state.',
      },
      target: {
        type: 'string',
        description: 'Optional selector, label, or button text to target.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      fieldsToFill: {
        type: 'array',
        items: { type: 'string' },
        description: 'Field labels to fill when action is fill_form.',
      },
    },
    required: ['action', 'reasoning', 'confidence'],
  },
};

export function buildSystemPrompt(profileSummary: string, platformGuardrails: string): string {
  const cacheKey = `${profileSummary}\n<<<GUARDRAILS>>>\n${platformGuardrails}`;
  const cached = SYSTEM_PROMPT_CACHE.get(cacheKey);
  if (cached) return cached;

  const prompt = [
    'You are a job application navigation agent.',
    'Your job is to choose exactly one safe next action for the current page of a job application flow.',
    '',
    'Primary objective:',
    '- Move the application forward without losing data, duplicating actions, or triggering final submission.',
    '',
    'Hard rules:',
    '- Never submit the application.',
    '- Never click any final "Submit", "Submit Application", "Finish", or equivalent CTA.',
    '- Prefer `fill_form` when editable fields remain visible and empty.',
    '- Prefer `click_next` only after the visible fields for the current step appear filled or intentionally skipped.',
    '- Use `click_apply` only for an initial apply/start-application CTA, never for final submission.',
    '- Use `stop_for_review` when the page looks like a review page or the next obvious action would be final submission.',
    '- Use `mark_complete` only when the page is clearly a confirmation/success/submitted page.',
    '- Use `report_blocked` for CAPTCHA, turnstile, bot checks, or human verification challenges.',
    '- Use `login`, `create_account`, or `enter_verification` when the page is clearly in an auth flow.',
    '- If the page is ambiguous or unstable, use `wait_and_retry` instead of forcing a risky action.',
    '',
    'Decision policy:',
    '- Be conservative.',
    '- Output one action only.',
    '- Prefer the smallest reversible action that advances the flow.',
    '- Do not invent selectors or fields that are not grounded in the snapshot.',
    '- If you choose `fill_form`, include the field labels in `fieldsToFill`.',
    '- If you choose a targeted click, provide `target` when there is a clear button or selector.',
    '- Confidence should reflect actual certainty from the snapshot, not optimism.',
    '',
    'Review / completion guidance:',
    '- Review pages are usually read-only summaries with a visible final submit button and few or no editable fields.',
    '- Confirmation pages usually contain thank-you, submitted, received, or success language.',
    '- If a blocker is detected with high confidence, prioritize `report_blocked` over all other actions.',
    '',
    'Platform guardrails:',
    platformGuardrails || PLATFORM_GUARDRAILS.other,
    '',
    'Applicant profile summary:',
    profileSummary || 'No profile summary provided.',
    '',
    'Use the `page_decision` tool for your answer.',
  ].join('\n');

  SYSTEM_PROMPT_CACHE.set(cacheKey, prompt);
  return prompt;
}

export function buildUserMessage(context: PageDecisionContext): string {
  const fields = context.fields.length > 0
    ? context.fields.map((field) => {
      const state = [
        field.isRequired ? 'required' : 'optional',
        field.isDisabled ? 'disabled' : 'enabled',
        field.isVisible ? 'visible' : 'hidden',
        field.isEmpty ? 'empty' : 'filled',
      ].join(', ');
      const options = field.options?.length ? ` options=[${field.options.slice(0, 10).join(', ')}]` : '';
      return `- ${field.label} | type=${field.fieldType} | state=${state}${options}`;
    }).join('\n')
    : '- none';

  const buttons = context.buttons.length > 0
    ? context.buttons.map((button) =>
      `- "${button.text || '(no text)'}" | role=${button.role} | selector=${button.selector} | disabled=${button.isDisabled}`,
    ).join('\n')
    : '- none';

  const recentHistory = context.actionHistory.slice(-5);
  const historyBlock = recentHistory.length > 0
    ? recentHistory.map((entry) =>
      `- iter=${entry.iteration} action=${entry.action} target=${entry.target || '(none)'} result=${entry.result} layer=${entry.layer ?? 'none'} cost=$${entry.costUsd.toFixed(4)}`,
    ).join('\n')
    : '- none';

  const trackedCost = context.actionHistory.reduce((sum, entry) => sum + entry.costUsd, 0);
  const nextIteration = (recentHistory[recentHistory.length - 1]?.iteration ?? 0) + 1;
  const stepSummary = context.stepContext
    ? `${context.stepContext.label || 'step'} (${context.stepContext.current}/${context.stepContext.total})`
    : 'none';

  return [
    `URL: ${context.url}`,
    `Title: ${context.title}`,
    `Platform: ${context.platform}`,
    `Page Type: ${context.pageType}`,
    `Fingerprint: ${context.fingerprint.hash}`,
    `Fingerprint Summary: heading="${context.fingerprint.heading}" fields=${context.fingerprint.fieldCount} filled=${context.fingerprint.filledCount} activeStep="${context.fingerprint.activeStep}"`,
    `Step Context: ${stepSummary}`,
    `Blocker: detected=${context.blocker.detected} type=${context.blocker.type ?? 'none'} confidence=${context.blocker.confidence.toFixed(2)}`,
    `Observation Confidence: ${context.observationConfidence.toFixed(2)}`,
    `Guardrail Hints: ${context.guardrailHints.length ? context.guardrailHints.join(' | ') : 'none'}`,
    `Iteration Info: next_iteration=${nextIteration}`,
    `Budget Info: tracked_cost_usd=${trackedCost.toFixed(4)} (hard budget enforced externally)`,
    '',
    'Visible headings:',
    ...(context.headings.length > 0 ? context.headings.map((heading) => `- ${heading}`) : ['- none']),
    '',
    'Fields:',
    fields,
    '',
    'Buttons:',
    buttons,
    '',
    'Recent action history:',
    historyBlock,
  ].join('\n');
}
