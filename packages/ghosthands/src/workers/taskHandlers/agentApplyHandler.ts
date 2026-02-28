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
import { loadModelConfig } from '../../config/index.js';

// ── Cost rates per model ($/M tokens) ────────────────────────────────────
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'opus':   { input: 5.00,  output: 25.00 },
  'sonnet': { input: 3.00,  output: 15.00 },
  'haiku':  { input: 1.00,  output: 5.00  },
};

/** Resolve cost rates from a model alias or full model name */
function resolveCostRates(modelNameOrAlias: string): { input: number; output: number } {
  const lower = modelNameOrAlias.toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_COSTS)) {
    if (lower.includes(key)) return rates;
  }
  // Fallback: try loadModelConfig
  try {
    const resolved = loadModelConfig(modelNameOrAlias);
    return { input: resolved.cost.input, output: resolved.cost.output };
  } catch {
    return { input: 0, output: 0 };
  }
}

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
    // Agent planner uses the main model; act/observe use the executionModel (Haiku)
    const resolvedModel = stagehandAdapter.getResolvedModel();
    const agentCost = resolveCostRates(resolvedModel?.model || resolvedModel?.alias || 'haiku');
    const execCost = resolveCostRates('haiku'); // executionModel is hardcoded to Haiku

    // 2. Detect platform for hints
    const platformConfig = detectPlatformFromUrl(job.target_url);
    logger.info('[AgentApply] Starting', {
      platform: platformConfig.displayName,
      url: job.target_url,
      applicant: `${userProfile.first_name} ${userProfile.last_name}`,
    });

    // 3. Build system prompt (includes credentials directly — agent needs them for login)
    const systemPrompt = buildSystemPrompt(userProfile, qaOverrides, ctx.resumeFilePath, platformConfig.platformId);

    // 4. Resume upload — two mechanisms:
    //   A) CDP file chooser interception: when agent clicks "Attach", the native
    //      OS file picker is suppressed and we handle it via Page.handleFileChooser.
    //   B) Proactive setInputFiles: on each step, check for <input type="file">
    //      elements and set the file directly (handles remote browsers too).
    let resumeUploaded = false;
    const resumePath = ctx.resumeFilePath;

    // Track which CDP sessions have file chooser interception to avoid duplicate handlers
    const interceptedSessionIds = new Set<string | null>();

    async function tryUploadResume(): Promise<boolean> {
      if (!resumePath || resumeUploaded) return false;
      try {
        const activePage = stagehand.context.activePage();
        if (!activePage) return false;
        const count = await activePage.evaluate(() =>
          document.querySelectorAll('input[type="file"]').length
        );
        if (count > 0) {
          await activePage.locator('input[type="file"]').setInputFiles(resumePath);
          resumeUploaded = true;
          logger.info('[AgentApply] Resume auto-uploaded via setInputFiles', { path: resumePath });
          return true;
        }
      } catch (err) {
        logger.warn('[AgentApply] Resume auto-upload attempt failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }

    // Set up CDP file chooser interception on the current active page.
    // Called initially and on each agent step (to handle page navigations/new tabs).
    async function ensureFileChooserInterception(): Promise<void> {
      if (!resumePath) return;
      try {
        const activePage = stagehand.context.activePage();
        if (!activePage) return;

        const frame = activePage.mainFrame();
        const session = frame?.session;
        if (!session?.on || !session?.send) return;

        const sessionId = session.id ?? 'root';
        if (interceptedSessionIds.has(sessionId)) return;

        await activePage.sendCDP('Page.setInterceptFileChooserDialog', { enabled: true });

        session.on('Page.fileChooserOpened', async () => {
          logger.info('[AgentApply] File chooser dialog intercepted via CDP');
          try {
            // Accept with local file path (works for local browsers)
            await session.send('Page.handleFileChooser', {
              action: 'accept',
              files: [resumePath],
            });
            resumeUploaded = true;
            logger.info('[AgentApply] Resume uploaded via Page.handleFileChooser');
          } catch (acceptErr) {
            // Remote browsers can't access local paths — cancel dialog, use setInputFiles
            logger.warn('[AgentApply] handleFileChooser accept failed, falling back to setInputFiles', {
              error: acceptErr instanceof Error ? acceptErr.message : String(acceptErr),
            });
            try {
              await session.send('Page.handleFileChooser', { action: 'cancel' });
            } catch { /* ignore cancel failure */ }
            await tryUploadResume();
          }
        });

        interceptedSessionIds.add(sessionId);
        logger.info('[AgentApply] File chooser interception active', { sessionId });
      } catch (err) {
        logger.warn('[AgentApply] File chooser interception setup failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ensureFileChooserInterception();

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
      executionModel: 'anthropic/claude-haiku-4-5-20251001',
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

            // Ensure file chooser interception on current page (re-applies after navigations)
            // and proactively upload resume if a file input already exists on the page.
            if (resumePath && !resumeUploaded) {
              await ensureFileChooserInterception();
              await tryUploadResume();
            }

            // Log running cost from act+observe sub-calls (stagehandMetrics).
            // Agent planner tokens are NOT available mid-run — they only get
            // reported after execute() returns via result.totalUsage.
            // So the running cost shown here is a LOWER BOUND (sub-calls only).
            const currentMetrics = snapshotAllMetrics(stagehand);
            const actIn = currentMetrics.actPrompt - metricsBefore.actPrompt;
            const actOut = currentMetrics.actCompletion - metricsBefore.actCompletion;
            const obsIn = currentMetrics.observePrompt - metricsBefore.observePrompt;
            const obsOut = currentMetrics.observeCompletion - metricsBefore.observeCompletion;
            const subCallIn = actIn + obsIn;
            const subCallOut = actOut + obsOut;
            const subCallCost = subCallIn * (execCost.input / 1_000_000) + subCallOut * (execCost.output / 1_000_000);
            logger.info('[Agent] Running cost (sub-calls only, planner not yet available)', {
              step: stepCount,
              actIO: `${actIn}/${actOut}`,
              observeIO: `${obsIn}/${obsOut}`,
              subCallIn,
              subCallOut,
              subCallCostUsd: subCallCost.toFixed(4),
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

      // ── Token accounting ──────────────────────────────────────────────
      // Agent planner tokens (from Vercel AI SDK's generateText totalUsage)
      // come from result.usage — these are ONLY the planner's own LLM calls.
      // Act/observe sub-call tokens are separate API calls tracked independently
      // in stagehandMetrics. They do NOT overlap, so we SUM all three.
      //
      // stagehandMetrics.agentPromptTokens is also updated from result.totalUsage
      // at the end of execute(), so it should match result.usage.input_tokens.

      // 1. Agent planner tokens from result.usage (most reliable source)
      const agentPlannerIn = result.usage?.input_tokens || 0;
      const agentPlannerOut = result.usage?.output_tokens || 0;

      // 2. Act/observe sub-call tokens from stagehandMetrics
      const metricsAfter = snapshotAllMetrics(stagehand);
      const actInDelta = metricsAfter.actPrompt - metricsBefore.actPrompt;
      const actOutDelta = metricsAfter.actCompletion - metricsBefore.actCompletion;
      const observeInDelta = metricsAfter.observePrompt - metricsBefore.observePrompt;
      const observeOutDelta = metricsAfter.observeCompletion - metricsBefore.observeCompletion;

      // 3. Cross-check: stagehandMetrics.agent should match result.usage
      const agentMetricsIn = metricsAfter.agentPrompt - metricsBefore.agentPrompt;
      const agentMetricsOut = metricsAfter.agentCompletion - metricsBefore.agentCompletion;

      // 4. Total = planner + act + observe (no overlap)
      const totalIn = agentPlannerIn + actInDelta + observeInDelta;
      const totalOut = agentPlannerOut + actOutDelta + observeOutDelta;
      const plannerCost = agentPlannerIn * (agentCost.input / 1_000_000) + agentPlannerOut * (agentCost.output / 1_000_000);
      const actObserveCost = (actInDelta + observeInDelta) * (execCost.input / 1_000_000) + (actOutDelta + observeOutDelta) * (execCost.output / 1_000_000);
      const inputCost = agentPlannerIn * (agentCost.input / 1_000_000) + (actInDelta + observeInDelta) * (execCost.input / 1_000_000);
      const outputCost = agentPlannerOut * (agentCost.output / 1_000_000) + (actOutDelta + observeOutDelta) * (execCost.output / 1_000_000);
      const totalCostUsd = plannerCost + actObserveCost;

      // Record to costTracker for budget enforcement and DB persistence
      costTracker.recordTokenUsage({
        inputTokens: totalIn,
        outputTokens: totalOut,
        inputCost,
        outputCost,
      });

      logger.info('[AgentApply] Agent finished', {
        success: result.success,
        completed: result.completed,
        message: result.message,
        steps: stepCount,
        actions: result.actions?.length || 0,
        plannerIO: `${agentPlannerIn} in / ${agentPlannerOut} out`,
        plannerMetricsIO: `${agentMetricsIn} in / ${agentMetricsOut} out`,
        actIO: `${actInDelta} in / ${actOutDelta} out`,
        observeIO: `${observeInDelta} in / ${observeOutDelta} out`,
        totalIn,
        totalOut,
        costUsd: totalCostUsd.toFixed(4),
        model: resolvedModel?.alias || 'unknown',
      });

      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);

      return {
        success: result.success,
        keepBrowserOpen: true,
        awaitingUserReview: true,
        data: {
          platform: platformConfig.platformId,
          message: result.message,
          steps: stepCount,
          actions: result.actions?.length || 0,
          completed: result.completed,
          cost: {
            plannerIn: agentPlannerIn,
            plannerOut: agentPlannerOut,
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
      // Still capture cost even on failure — on error, agent planner tokens
      // may not be available (result.totalUsage not returned), so we use
      // stagehandMetrics which may or may not have been updated.
      const metricsAfter = snapshotAllMetrics(stagehand);
      const agentIn = metricsAfter.agentPrompt - metricsBefore.agentPrompt;
      const agentOut = metricsAfter.agentCompletion - metricsBefore.agentCompletion;
      const actIn = metricsAfter.actPrompt - metricsBefore.actPrompt;
      const actOut = metricsAfter.actCompletion - metricsBefore.actCompletion;
      const obsIn = metricsAfter.observePrompt - metricsBefore.observePrompt;
      const obsOut = metricsAfter.observeCompletion - metricsBefore.observeCompletion;
      const totalIn = agentIn + actIn + obsIn;
      const totalOut = agentOut + actOut + obsOut;
      const totalCostUsd = agentIn * (agentCost.input / 1_000_000) + agentOut * (agentCost.output / 1_000_000)
        + (actIn + obsIn) * (execCost.input / 1_000_000) + (actOut + obsOut) * (execCost.output / 1_000_000);

      if (totalIn > 0 || totalOut > 0) {
        costTracker.recordTokenUsage({
          inputTokens: totalIn,
          outputTokens: totalOut,
          inputCost: agentIn * (agentCost.input / 1_000_000) + (actIn + obsIn) * (execCost.input / 1_000_000),
          outputCost: agentOut * (agentCost.output / 1_000_000) + (actOut + obsOut) * (execCost.output / 1_000_000),
        });
      }

      logger.error('[AgentApply] Agent execution failed', {
        error: (error as Error).message,
        steps: stepCount,
        plannerIO: `${agentIn}/${agentOut}`,
        actIO: `${actIn}/${actOut}`,
        observeIO: `${obsIn}/${obsOut}`,
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
          cost: { plannerIn: agentIn, plannerOut: agentOut, actIn, actOut, observeIn: obsIn, observeOut: obsOut, totalIn, totalOut, costUsd: totalCostUsd },
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
  const basePassword = profile.password || process.env.TEST_GMAIL_PASSWORD || 'GhApp2026!x';
  const workdayPassword = basePassword + 'aA1!'; // Strengthened for Workday account creation complexity requirements
  const lines: string[] = [];

  // ── Role & Tool Usage (MOST IMPORTANT — goes first) ──
  lines.push(`You are filling out a job application for ${profile.first_name} ${profile.last_name}. Fill every field on every page, then call done. Do NOT submit.`);
  lines.push('');
  lines.push('HOW TO USE YOUR TOOLS:');
  lines.push('');
  lines.push('act: Your primary tool. Be EXTREMELY specific — always include the QUESTION LABEL or SECTION NAME to disambiguate.');
  lines.push('  GOOD: act("click the Sign In button next to Already have an account")');
  lines.push('  GOOD: act("type happy.wu@gmail.com into the Email Address text field")');
  lines.push(`  GOOD: act("type ${basePassword} into the Password text field")`);
  lines.push('  GOOD: act("click the \\"Yes\\" option in the dropdown for \\"Are you a citizen of the United States?\\"")');
  lines.push('  GOOD: act("click the dropdown button for \\"Did you previously work for RTX?\\"")');
  lines.push('  BAD:  act("click the \\"No\\" option in the listbox")  ← WHICH listbox? There are multiple on the page!');
  lines.push('  BAD:  act("click Sign In")  ← too vague, will fail if multiple matches');
  lines.push('  BAD:  act("type email into the email field")  ← types the WORD "email" instead of the actual address');
  lines.push('  BAD:  act("enter password")  ← types the WORD "password"');
  lines.push('');
  lines.push('CRITICAL: When there are multiple dropdowns/listboxes/buttons on the page, ALWAYS include the question label or nearby heading in your act instruction to identify WHICH one you mean.');
  lines.push('');
  lines.push('When using act to type, ALWAYS include the LITERAL value to type in quotes:');
  lines.push(`  act("type \\"${profile.email}\\" into the Email Address field")`);
  lines.push(`  act("type \\"${profile.first_name}\\" into the First Name field")`);
  lines.push('');
  lines.push('fillForm: Use for filling multiple text fields at once. Each field needs {action, value}.');
  lines.push('observe: Use to identify interactive elements and understand page structure via the accessibility tree. This is your GO-TO tool for understanding the page. Use observe BEFORE act when you are unsure what elements exist.');
  lines.push('extract: Use to read text content from the page.');
  lines.push('screenshot: LAST RESORT ONLY. Screenshots cost 100x more tokens than observe/extract. NEVER use screenshot unless observe AND extract both failed to give you the information you need. The ONLY valid uses for screenshot are: visual-only elements with no accessibility labels, CAPTCHAs, or image-based layouts where the accessibility tree is empty.');
  lines.push('');
  lines.push('TOOL PRIORITY (always follow this order):');
  lines.push('  1. observe / ariaTree — to understand page structure and find elements');
  lines.push('  2. extract — to read text content');
  lines.push('  3. act / fillForm — to interact with elements');
  lines.push('  4. screenshot — ABSOLUTE LAST RESORT, only after observe+extract failed');
  lines.push('');
  lines.push('NEVER take a screenshot to "confirm" an action succeeded. Use observe instead.');
  lines.push('NEVER take a screenshot to "see what the page looks like". Use observe instead.');
  lines.push('');
  lines.push('IF AN ACT CALL FAILS:');
  lines.push('1. Use observe to get the accessibility tree and find the correct element');
  lines.push('2. If observe returns nothing useful, try extract');
  lines.push('3. ONLY if both observe and extract failed, take a screenshot as a last resort');
  lines.push('4. Retry with a MORE SPECIFIC description referencing nearby text, heading, or section name');
  lines.push('');

  // ── Credentials (high priority — near the top) ──
  lines.push('LOGIN CREDENTIALS (use these EXACT strings when typing):');
  lines.push(`  Email: ${profile.email}`);
  lines.push(`  Google Account Password: ${basePassword}`);
  lines.push(`  Workday Account Password: ${workdayPassword}`);
  lines.push('');
  lines.push('PASSWORD RULES:');
  lines.push('- For Google sign-in / "Sign in with Google": use the Google Account Password');
  lines.push('- For Workday login or account creation: use the Workday Account Password');
  lines.push('- If unsure which platform you are logging into, use the Google Account Password for Google pages and the Workday Account Password for everything else.');
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
    lines.push('RESUME: A resume file is being uploaded automatically by the system. Do NOT click any upload/attach/select-file buttons — the file input is filled directly. If you see a resume upload section, just wait a moment and then continue to the next page. If the page requires a resume to proceed and it hasn\'t appeared yet, call the wait tool for 3 seconds and try again.');
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
  lines.push('- ALWAYS prefer "Sign in with Google" or "Continue with Google" when available. Only use email/password if Google sign-in is not an option.');
  lines.push('- Fill ALL fields with ACTUAL DATA values, never field labels.');
  lines.push('- For dropdowns: (1) click the dropdown button to OPEN it, (2) then in a SEPARATE act call, click the option you want. Never try to select an option and open the dropdown in the same act call.');
  lines.push('- For "How did you hear?" → "LinkedIn" or "Online Job Board".');
  lines.push('- Click Next/Continue to advance through pages.');
  lines.push('- NEVER click Submit / Submit Application. When all fields are filled and only a Submit button remains, call done.');
  lines.push('- If you reach a Review/Summary page, call done immediately. But not all applications have one — if all fields are filled and there is nothing left but Submit, call done.');
  lines.push('- If you hit a CAPTCHA or 2FA, call done and explain the blocker.');

  // Platform-specific
  if (platformId === 'workday') {
    lines.push('');
    lines.push('WORKDAY TIPS:');
    lines.push('- Multi-step form with progress bar at top.');
    lines.push('- SEARCHABLE DROPDOWNS: NEVER scroll through dropdown options. ALWAYS type your desired value into the search field to filter, then click the matching option from the filtered list. Dropdowns use virtual rendering — only ~20 options are visible at a time, so scrolling will miss most options.');
    lines.push('- SEARCHABLE DROPDOWN CONFIRMATION: After typing in a searchable dropdown, you MUST click the matching option that appears in the filtered list. Just typing is NOT enough — the value is not selected until you click the option. If no options appear after typing, press Enter to trigger a search, then click the result.');
    lines.push('- SELECT-ONE DROPDOWNS (Yes/No, Select One): These are NOT searchable. Click the dropdown button to OPEN it, then in a SEPARATE act call click the option. Always reference the QUESTION LABEL: act("click the \\"Yes\\" option in the dropdown for \\"Are you a citizen?\\""), NOT act("click the \\"Yes\\" option in the listbox").');
    lines.push('- If "Create Account" page appears, check for "Already have an account? Sign In" link at the bottom.');
    lines.push('- Custom ARIA widgets: if fillForm fails on a field, use act instead.');
    lines.push('- MULTISELECT PILLS: The × button on selected pills is hidden from the accessibility tree. To remove a selected value, click/focus the pill (the option element), then press Delete or Backspace. Do NOT try to click the × icon directly — it will always fail.');
    lines.push('- RADIO BUTTONS: Workday hides the actual <input> and uses custom styled elements. If clicking a radio button reports success but nothing changes, click the LABEL text next to it instead. For example: act("click the label text \\"No\\" next to the radio button") rather than act("click the No radio button").');
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
    parts.push('Resume uploads are handled automatically — do NOT click upload/attach buttons for resume. Just continue filling other fields.');
  }

  parts.push('Navigate through all pages by clicking Next/Continue.');
  parts.push('NEVER click Submit. When all fields are filled and only a Submit button remains, call done.');

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
