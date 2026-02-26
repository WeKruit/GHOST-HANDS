/**
 * AgentApplyHandler — Uses Stagehand's built-in agent mode to autonomously
 * fill out job applications. The LLM agent has DOM tools (act, fillForm,
 * extract, screenshot, scroll, keys, think, done) and decides what to do
 * at each step.
 *
 * Replaces SmartApplyHandler's rigid detect-and-act loop with a single
 * agent.execute() call that handles login, form filling, resume upload,
 * and navigation autonomously.
 */

import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { StagehandAdapter } from '../../adapters/stagehand.js';
import { ProgressStep } from '../progressTracker.js';
import { getLogger } from '../../monitoring/logger.js';
import { detectPlatformFromUrl } from './platforms/index.js';

// ── Metrics Snapshot ──────────────────────────────────────────────────────

interface AllMetricsSnapshot {
  agentPrompt: number;
  agentCompletion: number;
  actPrompt: number;
  actCompletion: number;
  observePrompt: number;
  observeCompletion: number;
}

function snapshotAllMetrics(stagehand: any): AllMetricsSnapshot {
  const m = stagehand.stagehandMetrics;
  return {
    agentPrompt: m.agentPromptTokens || 0,
    agentCompletion: m.agentCompletionTokens || 0,
    actPrompt: m.actPromptTokens || 0,
    actCompletion: m.actCompletionTokens || 0,
    observePrompt: m.observePromptTokens || 0,
    observeCompletion: m.observeCompletionTokens || 0,
  };
}

// ── Constants ────────────────────────────────────────────────────────────

const MAX_AGENT_STEPS = 1000;

// ── Handler ──────────────────────────────────────────────────────────────

export class AgentApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'LLM agent fills out job application autonomously via Stagehand agent mode';

  validate(inputData: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const userData = inputData.user_data;

    if (!userData) {
      errors.push('user_data is required');
    } else {
      if (!userData.first_name) errors.push('user_data.first_name is required');
      if (!userData.last_name) errors.push('user_data.last_name is required');
      if (!userData.email) errors.push('user_data.email is required');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress, costTracker } = ctx;
    const logger = getLogger();
    const userProfile = job.input_data.user_data as Record<string, any>;
    const qaOverrides = job.input_data.qa_overrides as Record<string, string> || {};

    // 1. Get Stagehand instance from adapter
    const stagehandAdapter = adapter as StagehandAdapter;
    if (typeof stagehandAdapter.getStagehand !== 'function') {
      throw new Error('AgentApplyHandler requires StagehandAdapter (set GH_BROWSER_ENGINE=stagehand)');
    }
    const stagehand = stagehandAdapter.getStagehand();

    // Get model cost config for USD calculation
    const resolvedModel = stagehandAdapter.getResolvedModel();
    const costPerMInput = resolvedModel?.cost.input ?? 0;
    const costPerMOutput = resolvedModel?.cost.output ?? 0;

    // 2. Detect platform for hints
    const platformConfig = detectPlatformFromUrl(job.target_url);
    logger.info('[AgentApply] Starting', {
      platform: platformConfig.displayName,
      url: job.target_url,
      applicant: `${userProfile.first_name} ${userProfile.last_name}`,
    });

    // 3. Build system prompt (includes credentials directly — agent needs them for login)
    const systemPrompt = buildSystemPrompt(userProfile, qaOverrides, ctx.resumeFilePath, platformConfig.platformId);

    // 4. Set up resume file chooser handler
    if (ctx.resumeFilePath) {
      const resumePath = ctx.resumeFilePath;
      adapter.page.on('filechooser', async (chooser: any) => {
        logger.info('[AgentApply] File chooser opened — attaching resume', { path: resumePath });
        await chooser.setFiles(resumePath);
      });
    }

    await progress.setStep(ProgressStep.NAVIGATING);

    // 5. Click Apply button directly — Stagehand's agent hangs with disableAPI+experimental
    const page = stagehand.context.activePage();
    if (page) {
      await clickApplyButton(page, logger);
    }

    // 6. Create and run agent
    const agent = stagehand.agent({
      mode: 'dom',
      systemPrompt,
    });

    let stepCount = 0;

    // Snapshot metrics before agent run to compute delta for act/observe sub-calls
    const metricsBefore = snapshotAllMetrics(stagehand);

    try {
      const result = await agent.execute({
        instruction: buildInstruction(job.target_url, userProfile, ctx.resumeFilePath),
        maxSteps: MAX_AGENT_STEPS,
        callbacks: {
          onStepFinish: async (stepResult: any) => {
            stepCount++;

            // Get reasoning — AI SDK puts it in `text`, but Stagehand may use `content`
            let text = stepResult.text || '';
            if (!text && stepResult.content) {
              if (typeof stepResult.content === 'string') {
                text = stepResult.content;
              } else if (Array.isArray(stepResult.content)) {
                text = stepResult.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join(' ');
              }
            }
            if (text) {
              logger.info('[Agent] THINKING', { step: stepCount, text: String(text).slice(0, 500) });
              progress.recordThought(String(text).slice(0, 300));
            }

            // Dump tool calls
            const toolCalls = stepResult.toolCalls || [];
            for (const tc of toolCalls) {
              let argsStr = '(no args)';
              try { argsStr = JSON.stringify(tc.args ?? tc.input ?? tc, null, 0).slice(0, 800); } catch { argsStr = String(tc); }
              logger.info('[Agent] CALL', { step: stepCount, tool: tc.toolName || tc.name || tc.type || 'unknown', args: argsStr });
            }

            // Dump tool results
            const toolResults = stepResult.toolResults || [];
            for (const tr of toolResults) {
              let resultStr = '(no result)';
              try { resultStr = JSON.stringify(tr.result ?? tr.output ?? tr, null, 0).slice(0, 800); } catch { resultStr = String(tr); }
              logger.info('[Agent] RESULT', { step: stepCount, tool: tr.toolName || tr.name || 'unknown', result: resultStr });
            }

            // Log running metrics from stagehand (definitive source of truth)
            const currentMetrics = snapshotAllMetrics(stagehand);
            const deltaFromStart = {
              agentIn: currentMetrics.agentPrompt - metricsBefore.agentPrompt,
              agentOut: currentMetrics.agentCompletion - metricsBefore.agentCompletion,
              actIn: currentMetrics.actPrompt - metricsBefore.actPrompt,
              actOut: currentMetrics.actCompletion - metricsBefore.actCompletion,
              observeIn: currentMetrics.observePrompt - metricsBefore.observePrompt,
              observeOut: currentMetrics.observeCompletion - metricsBefore.observeCompletion,
            };
            const totalIn = deltaFromStart.agentIn + deltaFromStart.actIn + deltaFromStart.observeIn;
            const totalOut = deltaFromStart.agentOut + deltaFromStart.actOut + deltaFromStart.observeOut;
            const runningCost = totalIn * (costPerMInput / 1_000_000) + totalOut * (costPerMOutput / 1_000_000);
            logger.info('[Agent] Running cost', {
              step: stepCount,
              agentIO: `${deltaFromStart.agentIn}/${deltaFromStart.agentOut}`,
              actIO: `${deltaFromStart.actIn}/${deltaFromStart.actOut}`,
              observeIO: `${deltaFromStart.observeIn}/${deltaFromStart.observeOut}`,
              totalIn,
              totalOut,
              runningCostUsd: runningCost.toFixed(4),
            });

            // Update progress based on step count
            if (stepCount <= 3) {
              await progress.setStep(ProgressStep.NAVIGATING);
            } else if (stepCount <= 10) {
              await progress.setStep(ProgressStep.ANALYZING_PAGE);
            } else {
              await progress.setStep(ProgressStep.FILLING_FORM);
            }
          },
        },
      });

      // Use stagehand.stagehandMetrics for definitive totals (includes all LLM calls)
      const metricsAfter = snapshotAllMetrics(stagehand);
      const agentInDelta = metricsAfter.agentPrompt - metricsBefore.agentPrompt;
      const agentOutDelta = metricsAfter.agentCompletion - metricsBefore.agentCompletion;
      const actInDelta = metricsAfter.actPrompt - metricsBefore.actPrompt;
      const actOutDelta = metricsAfter.actCompletion - metricsBefore.actCompletion;
      const observeInDelta = metricsAfter.observePrompt - metricsBefore.observePrompt;
      const observeOutDelta = metricsAfter.observeCompletion - metricsBefore.observeCompletion;
      const totalIn = agentInDelta + actInDelta + observeInDelta;
      const totalOut = agentOutDelta + actOutDelta + observeOutDelta;
      const inputCost = totalIn * (costPerMInput / 1_000_000);
      const outputCost = totalOut * (costPerMOutput / 1_000_000);
      const totalCostUsd = inputCost + outputCost;

      // Record to costTracker for budget enforcement and DB persistence
      costTracker.recordTokenUsage({
        inputTokens: totalIn,
        outputTokens: totalOut,
        inputCost,
        outputCost,
      });

      // Also check for Stagehand's result.usage (snake_case from v3AgentHandler)
      const resultUsage = result.usage;

      logger.info('[AgentApply] Agent finished', {
        success: result.success,
        completed: result.completed,
        message: result.message,
        steps: stepCount,
        actions: result.actions?.length || 0,
        agentIO: `${agentInDelta} in / ${agentOutDelta} out`,
        actIO: `${actInDelta} in / ${actOutDelta} out`,
        observeIO: `${observeInDelta} in / ${observeOutDelta} out`,
        totalIn,
        totalOut,
        costUsd: totalCostUsd.toFixed(4),
        model: resolvedModel?.alias || 'unknown',
        ...(resultUsage ? { stagehandReportedUsage: resultUsage } : {}),
      });

      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);

      return {
        success: result.success,
        keepBrowserOpen: true,
        awaitingUserReview: result.success,
        data: {
          platform: platformConfig.platformId,
          message: result.message,
          steps: stepCount,
          actions: result.actions?.length || 0,
          completed: result.completed,
          cost: {
            agentIn: agentInDelta,
            agentOut: agentOutDelta,
            actIn: actInDelta,
            actOut: actOutDelta,
            observeIn: observeInDelta,
            observeOut: observeOutDelta,
            totalIn,
            totalOut,
            costUsd: totalCostUsd,
            model: resolvedModel?.alias || 'unknown',
          },
        },
      };
    } catch (error) {
      // Still capture cost even on failure
      const metricsAfter = snapshotAllMetrics(stagehand);
      const totalIn = (metricsAfter.agentPrompt - metricsBefore.agentPrompt) +
        (metricsAfter.actPrompt - metricsBefore.actPrompt) +
        (metricsAfter.observePrompt - metricsBefore.observePrompt);
      const totalOut = (metricsAfter.agentCompletion - metricsBefore.agentCompletion) +
        (metricsAfter.actCompletion - metricsBefore.actCompletion) +
        (metricsAfter.observeCompletion - metricsBefore.observeCompletion);
      const totalCostUsd = totalIn * (costPerMInput / 1_000_000) + totalOut * (costPerMOutput / 1_000_000);

      if (totalIn > 0 || totalOut > 0) {
        costTracker.recordTokenUsage({
          inputTokens: totalIn,
          outputTokens: totalOut,
          inputCost: totalIn * (costPerMInput / 1_000_000),
          outputCost: totalOut * (costPerMOutput / 1_000_000),
        });
      }

      logger.error('[AgentApply] Agent execution failed', {
        error: (error as Error).message,
        steps: stepCount,
        totalIn,
        totalOut,
        costUsd: totalCostUsd.toFixed(4),
      });

      return {
        success: false,
        keepBrowserOpen: true,
        error: (error as Error).message,
        data: {
          platform: platformConfig.platformId,
          steps: stepCount,
          cost: { totalIn, totalOut, costUsd: totalCostUsd },
        },
      };
    }
  }
}

// ── System Prompt Builder ────────────────────────────────────────────────

function buildSystemPrompt(
  profile: Record<string, any>,
  qaOverrides: Record<string, string>,
  resumePath: string | null | undefined,
  platformId: string,
): string {
  const loginPassword = (profile.password || process.env.TEST_GMAIL_PASSWORD || 'GhApp2026!x') + 'aA1!';
  const lines: string[] = [];

  // ── Role & Tool Usage (MOST IMPORTANT — goes first) ──
  lines.push(`You are filling out a job application for ${profile.first_name} ${profile.last_name}. Fill every field, then STOP at the review page.`);
  lines.push('');
  lines.push('HOW TO USE YOUR TOOLS:');
  lines.push('');
  lines.push('act: Your primary tool. Be EXTREMELY specific about which element to interact with.');
  lines.push('  GOOD: act("click the Sign In button next to Already have an account")');
  lines.push('  GOOD: act("type happy.wu@gmail.com into the Email Address text field")');
  lines.push(`  GOOD: act("type ${loginPassword} into the Password text field")`);
  lines.push('  BAD:  act("click Sign In")  ← too vague, will fail if multiple matches');
  lines.push('  BAD:  act("type email into the email field")  ← types the WORD "email" instead of the actual address');
  lines.push('  BAD:  act("enter password")  ← types the WORD "password"');
  lines.push('');
  lines.push('When using act to type, ALWAYS include the LITERAL value to type in quotes:');
  lines.push(`  act("type \\"${profile.email}\\" into the Email Address field")`);
  lines.push(`  act("type \\"${profile.first_name}\\" into the First Name field")`);
  lines.push('');
  lines.push('fillForm: Use for filling multiple text fields at once. Each field needs {action, value}.');
  lines.push('extract: Use to read the page and understand what fields/buttons are present.');
  lines.push('screenshot: Take a screenshot to see the visual layout when confused.');
  lines.push('');
  lines.push('IF AN ACT CALL FAILS:');
  lines.push('1. Take a screenshot to see what is on screen');
  lines.push('2. Use extract or ariaTree to understand the page structure');
  lines.push('3. Retry with a MORE SPECIFIC description referencing nearby text, heading, or section name');
  lines.push('');

  // ── Credentials (high priority — near the top) ──
  lines.push('LOGIN CREDENTIALS (use these EXACT strings when typing):');
  lines.push(`  Email: ${profile.email}`);
  lines.push(`  Password: ${loginPassword}`);
  lines.push('');

  // ── Applicant Data ──
  lines.push('APPLICANT DATA:');
  const fields: [string, any][] = [
    ['First Name', profile.first_name],
    ['Last Name', profile.last_name],
    ['Email', profile.email],
    ['Phone', profile.phone],
  ];
  const addr = profile.address || {};
  fields.push(
    ['Street Address', addr.street || profile.street],
    ['Address Line 2', addr.line2 || profile.address_line_2],
    ['City', addr.city || profile.city],
    ['State', addr.state || profile.state],
    ['ZIP Code', addr.zip || profile.zip],
    ['Country', addr.country || profile.country],
    ['LinkedIn', profile.linkedin_url],
    ['Website/Portfolio', profile.portfolio_url || profile.website_url],
    ['Current Company', profile.current_company],
    ['Current Title', profile.current_title],
    ['Work Authorization', profile.work_authorization],
    ['Salary Expectation', profile.salary_expectation],
    ['Years of Experience', profile.years_of_experience],
  );
  for (const [label, val] of fields) {
    if (val != null && val !== '') lines.push(`  ${label}: ${val}`);
  }

  // Education
  const eduArr = profile.education || profile.work_history_education || [];
  if (Array.isArray(eduArr) && eduArr.length > 0) {
    lines.push('  Education:');
    for (const edu of eduArr) {
      const parts = [edu.degree || edu.level, edu.field_of_study || edu.field || edu.major, edu.school || edu.institution].filter(Boolean);
      const year = edu.graduation_year || edu.end_date || '';
      lines.push(`    - ${parts.join(', ')}${year ? ` (${year})` : ''}`);
    }
  }

  // Work experience
  const expArr = profile.experience || profile.work_history || [];
  if (Array.isArray(expArr) && expArr.length > 0) {
    lines.push('  Work Experience:');
    for (const exp of expArr) {
      const end = exp.currently_work_here ? 'Present' : (exp.end_date || '');
      lines.push(`    - ${exp.title || ''} at ${exp.company || ''}, ${exp.start_date || ''}–${end}`);
      if (exp.description) lines.push(`      ${String(exp.description).slice(0, 200)}`);
    }
  }
  lines.push('');

  // Resume
  if (resumePath) {
    lines.push('RESUME: Click any file upload field for resume/CV — the file will be attached automatically.');
    lines.push('');
  }

  // QA overrides
  if (Object.keys(qaOverrides).length > 0) {
    lines.push('ANSWER OVERRIDES (use these exact answers when the question matches):');
    for (const [q, a] of Object.entries(qaOverrides)) {
      lines.push(`  Q: "${q}" → A: "${a}"`);
    }
    lines.push('');
  }

  // ── Rules (concise) ──
  lines.push('RULES:');
  lines.push('- Log in or create account using the exact credentials above.');
  lines.push('- Fill ALL fields with ACTUAL DATA values, never field labels.');
  lines.push('- For dropdowns, click to open, then select the closest match.');
  lines.push('- For "How did you hear?" → "LinkedIn" or "Online Job Board".');
  lines.push('- Click Next/Continue to advance through pages.');
  lines.push('- NEVER click Submit/Submit Application.');
  lines.push('- STOP at the Review/Summary page and call done.');
  lines.push('- If you hit a CAPTCHA or 2FA, call done and explain the blocker.');

  // Platform-specific
  if (platformId === 'workday') {
    lines.push('');
    lines.push('WORKDAY TIPS:');
    lines.push('- Multi-step form with progress bar at top.');
    lines.push('- Dropdowns are searchable — click field, type to filter, then select.');
    lines.push('- If "Create Account" page appears, check for "Already have an account? Sign In" link at the bottom.');
    lines.push('- Custom ARIA widgets: if fillForm fails on a field, use act instead.');
    lines.push('- MULTISELECT PILLS: The × button on selected pills is hidden from the accessibility tree. To remove a selected value, click/focus the pill (the option element), then press Delete or Backspace. Do NOT try to click the × icon directly — it will always fail.');
  }

  return lines.join('\n');
}

// ── Instruction Builder ──────────────────────────────────────────────────

function buildInstruction(
  targetUrl: string,
  profile: Record<string, any>,
  resumePath: string | null | undefined,
): string {
  const parts = [
    `You are on a job application page for ${profile.first_name} ${profile.last_name}.`,
    'The Apply button has already been clicked and Sign In has been selected if available. You should now be on a login page or the application form.',
    'If you see a login form, enter the credentials from your system prompt. If you see a Create Account page, look for a Sign In link and click it first.',
    'Fill out all form fields using the applicant information provided in your system prompt.',
  ];

  if (resumePath) {
    parts.push('Upload the resume when you see a file upload field for resume/CV.');
  }

  parts.push('Navigate through all pages by clicking Next/Continue.');
  parts.push('STOP at the Review/Summary page — do NOT submit the application. Call done when you reach the review page.');

  return parts.join(' ');
}

// ── Pre-Agent: Click Apply & Sign In ────────────────────────────────────

async function clickApplyButton(page: any, logger: ReturnType<typeof getLogger>): Promise<void> {
  const clicked = await page.evaluate(() => {
    // Workday
    const wdBtn = document.querySelector('[data-automation-id="adventureButton"]') as HTMLElement;
    if (wdBtn) { wdBtn.click(); return 'workday-adventureButton'; }

    // Generic: button or link with "Apply" text
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const el of buttons) {
      const text = (el as HTMLElement).textContent?.trim() || '';
      if (/^apply(\s+now)?$/i.test(text)) {
        (el as HTMLElement).click();
        return `generic-button: "${text}"`;
      }
    }
    return null;
  });

  if (clicked) {
    logger.info('[AgentApply] Clicked Apply button directly', { method: clicked });
    await new Promise(r => setTimeout(r, 3000));
    try {
      await page.waitForLoadState('domcontentloaded', 5000);
    } catch { /* best effort */ }

    // After Apply, Workday often shows "Create Account" with "Already have an account? Sign In".
    // The agent can't click Sign In because there are duplicate "Sign In" elements on the page.
    // Click it directly if present.
    await clickSignInIfPresent(page, logger);
  } else {
    logger.info('[AgentApply] Could not find Apply button — agent will try');
  }
}

async function clickSignInIfPresent(page: any, logger: ReturnType<typeof getLogger>): Promise<void> {
  const clicked = await page.evaluate(() => {
    // Workday-specific: data-automation-id for sign-in link
    const wdSignIn = document.querySelector('[data-automation-id="signInLink"]') as HTMLElement;
    if (wdSignIn) { wdSignIn.click(); return 'workday-signInLink'; }

    // Look for "Already have an account?" text on the page
    const bodyText = document.body.innerText || '';
    if (!bodyText.includes('Already have an account')) return null;

    // Find Sign In button/link that lives near "Already have an account?" text
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const el of candidates) {
      const text = (el as HTMLElement).textContent?.trim() || '';
      if (!/^sign\s*in$/i.test(text)) continue;

      // Walk up to find a container that also has "Already have an account"
      let parent: HTMLElement | null = el as HTMLElement;
      for (let i = 0; i < 5 && parent; i++) {
        parent = parent.parentElement;
        if (parent && parent.textContent?.includes('Already have an account')) {
          (el as HTMLElement).click();
          return 'sign-in-near-already-have-account';
        }
      }
    }
    return null;
  });

  if (clicked) {
    logger.info('[AgentApply] Clicked Sign In link directly', { method: clicked });
    await new Promise(r => setTimeout(r, 3000));
    try {
      await page.waitForLoadState('domcontentloaded', 5000);
    } catch { /* best effort */ }
  }
}
