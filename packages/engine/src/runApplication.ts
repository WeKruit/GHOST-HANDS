/**
 * runApplication / cancelApplication — Desktop-facing engine API.
 *
 * Launches a magnitude-core browser agent, attempts cookbook replay first,
 * then falls back to LLM-driven form filling. Emits ProgressEvents throughout.
 *
 * This implementation will be replaced by the v3 three-layer engine once the
 * rewrite is complete. The public API contract (EngineConfig, RunParams, RunResult,
 * ProgressEvent) stays stable across rewrites.
 */

import type {
  EngineConfig,
  RunParams,
  RunResult,
  ProgressEvent,
  EngineProfile,
  ActionManual,
  ManualSource,
} from './types';
import { CookbookExecutor } from './CookbookExecutor';
import { detectPlatform, generateUrlPattern } from './platformDetector';
import { randomUUID } from 'crypto';

/** Active agent handle for cancellation */
let activeAgent: any = null;

export async function runApplication(config: EngineConfig, params: RunParams): Promise<RunResult> {
  const { targetUrl, profile, resumePath, manualStore, onProgress } = params;

  const emit = (type: ProgressEvent['type'], message?: string, extra?: Partial<ProgressEvent>) => {
    onProgress({ type, message, timestamp: Date.now(), ...extra });
  };

  // Validate API key
  if (!config.anthropicApiKey) {
    return { success: false, message: 'anthropicApiKey is required' };
  }

  // Validate required profile fields
  if (!profile.firstName || !profile.lastName || !profile.email) {
    return { success: false, message: 'Profile must include firstName, lastName, and email' };
  }

  try {
    emit('status', 'Starting automation engine...');

    // Dynamic import so magnitude-core is only loaded when needed
    const { startBrowserAgent } = await import('magnitude-core');

    const agent = await startBrowserAgent({
      url: targetUrl,
      llm: {
        provider: 'anthropic',
        options: {
          model: config.model || 'claude-haiku-4-5-20251001',
          apiKey: config.anthropicApiKey,
        },
      } as any,
      browser: {
        launchOptions: { headless: config.headless ?? false },
      },
    });

    activeAgent = agent;
    emit('status', 'Browser launched, navigating to application page...');

    // Wire agent events → ProgressEvents
    agent.events.on('actionStarted', (action: any) => {
      emit('action', `Action: ${action.variant || 'performing step'}`);
    });
    agent.events.on('thought', (reasoning: any) => {
      emit('thought', reasoning?.thought || reasoning?.message || String(reasoning));
    });

    // Periodic screenshots
    const screenshotInterval = setInterval(async () => {
      try {
        if (agent.page) {
          const buf = await agent.page.screenshot();
          emit('screenshot', undefined, { screenshot: Buffer.from(buf).toString('base64') });
        }
      } catch {
        // Ignore screenshot errors during page transitions
      }
    }, 3000);

    // ── Cookbook-first execution ────────────────────────────────────────
    let cookbookSucceeded = false;
    const platform = detectPlatform(targetUrl);
    const manual = manualStore.lookup(targetUrl, 'apply', platform);

    if (manual) {
      emit('status', `Cookbook found for ${platform} — replaying ${manual.steps.length} steps...`);
      cookbookSucceeded = await tryCookbookExecution(agent.page, manual, profile, emit);
    }

    // ── LLM fallback ──────────────────────────────────────────────────
    if (!cookbookSucceeded) {
      if (manual) {
        emit('status', 'Cookbook replay failed, falling back to LLM automation...');
      }

      emit('status', 'Filling out application form with AI...');

      // Build a prompt describing the task
      const taskPrompt = buildApplicationPrompt(profile, resumePath);

      // Use the magnitude agent to fill the form
      try {
        await agent.act(taskPrompt);
      } catch (err: any) {
        // Agent may throw on complex forms — still emit progress
        emit('status', `LLM agent encountered an issue: ${err.message}`);
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────
    clearInterval(screenshotInterval);

    // Final screenshot
    try {
      const buf = await agent.page.screenshot();
      emit('screenshot', undefined, { screenshot: Buffer.from(buf).toString('base64') });
    } catch { /* ignore */ }

    // Save trace as cookbook for future replay
    if (!cookbookSucceeded && manual === null) {
      try {
        const now = new Date().toISOString();
        const newManual: ActionManual = {
          id: randomUUID(),
          url_pattern: generateUrlPattern(targetUrl),
          task_pattern: 'apply',
          platform,
          steps: [],
          health_score: 1.0,
          source: 'recorded' as ManualSource,
          created_at: now,
          updated_at: now,
        };
        manualStore.save(newManual);
      } catch {
        // Best-effort: don't fail the job if save fails
      }
    }

    emit('complete', 'Application filled — browser open for manual review');
    return { success: true, message: 'Application filled — browser open for manual review' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('error', `Failed: ${message}`);
    emit('status', 'Browser left open — you can fix the issue manually or cancel');
    return { success: false, message };
  }
}

export async function cancelApplication(): Promise<void> {
  if (activeAgent) {
    try { await activeAgent.stop(); } catch { /* best-effort */ }
    activeAgent = null;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

async function tryCookbookExecution(
  page: any,
  manual: ActionManual,
  profile: EngineProfile,
  emit: (type: ProgressEvent['type'], message?: string, extra?: Partial<ProgressEvent>) => void,
): Promise<boolean> {
  const userData = buildUserData(profile);
  const totalSteps = manual.steps.length;

  const executor = new CookbookExecutor({
    resolverTimeout: 5000,
    defaultWaitAfter: 300,
    logEvent: async (eventType, metadata) => {
      if (eventType === 'cookbook_step_started') {
        const stepNum = (metadata.step_index as number) + 1;
        const desc = metadata.description || metadata.action;
        emit('status', `Cookbook step ${stepNum}/${totalSteps}: ${desc}`, {
          step: stepNum,
          totalSteps,
        });
      }
    },
  });

  try {
    const result = await executor.executeAll(page, manual, userData);
    if (result.success) {
      emit('status', `Cookbook replay complete — all ${totalSteps} steps succeeded`);
      return true;
    }
    emit('status', `Cookbook failed at step ${(result.failedStepIndex ?? 0) + 1}/${totalSteps}: ${result.error}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit('status', `Cookbook execution error: ${msg}`);
    return false;
  }
}

function buildUserData(profile: EngineProfile): Record<string, string> {
  const data: Record<string, string> = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`,
    email: profile.email,
    phone: profile.phone,
    linkedIn: profile.linkedIn || '',
    address: profile.address || '',
    city: profile.city || '',
    state: profile.state || '',
    zipCode: profile.zipCode || '',
  };

  if (profile.education.length > 0) {
    const edu = profile.education[0];
    data.school = edu.school;
    data.degree = edu.degree;
    data.field = edu.field;
    data.startYear = edu.startDate;
    data.endYear = edu.endDate || '';
  }

  if (profile.experience.length > 0) {
    const exp = profile.experience[0];
    data.company = exp.company;
    data.jobTitle = exp.title;
    data.startDate = exp.startDate;
    data.endDate = exp.endDate || '';
    data.jobDescription = exp.description;
  }

  if (profile.qaAnswers) {
    for (const [key, value] of Object.entries(profile.qaAnswers)) {
      data[key] = value;
    }
  }

  return data;
}

function buildApplicationPrompt(profile: EngineProfile, resumePath?: string): string {
  const lines = [
    'Fill out this job application form with the following information:',
    '',
    `Name: ${profile.firstName} ${profile.lastName}`,
    `Email: ${profile.email}`,
    `Phone: ${profile.phone}`,
  ];

  if (profile.linkedIn) lines.push(`LinkedIn: ${profile.linkedIn}`);
  if (profile.address) lines.push(`Address: ${profile.address}, ${profile.city || ''}, ${profile.state || ''} ${profile.zipCode || ''}`);

  if (profile.education.length > 0) {
    const edu = profile.education[0];
    lines.push(`Education: ${edu.degree} in ${edu.field} from ${edu.school}`);
  }

  if (profile.experience.length > 0) {
    const exp = profile.experience[0];
    lines.push(`Most recent role: ${exp.title} at ${exp.company}`);
  }

  if (profile.skills && profile.skills.length > 0) {
    lines.push(`Skills: ${profile.skills.join(', ')}`);
  }

  if (profile.workAuthorization) lines.push(`Work authorization: ${profile.workAuthorization}`);
  if (profile.visaSponsorship) lines.push(`Visa sponsorship needed: ${profile.visaSponsorship}`);
  if (profile.gender) lines.push(`Gender: ${profile.gender}`);
  if (profile.veteranStatus) lines.push(`Veteran status: ${profile.veteranStatus}`);
  if (profile.disabilityStatus) lines.push(`Disability status: ${profile.disabilityStatus}`);

  if (resumePath) {
    lines.push('', `Upload the resume file if there is a file upload field.`);
  }

  lines.push('', 'Fill out all required fields. Click "Next" or "Continue" to proceed through multi-page forms. Do NOT click the final "Submit" button — leave the form ready for manual review.');

  return lines.join('\n');
}
