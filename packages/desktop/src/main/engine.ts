import type { UserProfile, ProgressEvent, AppSettings } from '../shared/types';
import { randomUUID } from 'crypto';
import { CookbookExecutor } from './engine/CookbookExecutor';
import { LocalManualStore } from './engine/LocalManualStore';
import { TraceRecorder } from './engine/TraceRecorder';
import { detectPlatform } from './engine/platformDetector';
import type { ActionManual, ManualSource } from './engine/types';
import { fillWithSmartScroll } from './engine/smartScroll';

/** Active agent handle for cancellation */
let activeAgent: any = null;

/** Singleton manual store (created lazily to avoid calling app.getPath before ready) */
let manualStore: LocalManualStore | null = null;

export function getManualStore(): LocalManualStore {
  if (!manualStore) {
    manualStore = new LocalManualStore();
  }
  return manualStore;
}

export interface RunApplicationParams {
  targetUrl: string;
  profile: UserProfile;
  resumePath?: string;
  settings: AppSettings;
  onProgress: (event: ProgressEvent) => void;
}

export interface RunResult {
  success: boolean;
  message: string;
}

export async function runApplication(params: RunApplicationParams): Promise<RunResult> {
  const { targetUrl, profile, resumePath, settings, onProgress } = params;

  const emit = (type: ProgressEvent['type'], message?: string, extra?: Partial<ProgressEvent>) => {
    onProgress({ type, message, timestamp: Date.now(), ...extra });
  };

  try {
    emit('status', 'Starting automation engine...');

    // Dynamic import so magnitude-core is only loaded when user clicks Apply
    const { startBrowserAgent } = await import('magnitude-core');

    const agent = await startBrowserAgent({
      url: targetUrl,
      llm: {
        provider: settings.llmProvider,
        options: {
          model: settings.llmModel,
          apiKey: settings.llmApiKey,
        },
      },
      browser: {
        launchOptions: { headless: false },
      },
    });

    activeAgent = agent;
    emit('status', 'Browser launched, navigating to application page...');

    // Wire events
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
    const store = getManualStore();
    const manual = store.lookup(targetUrl, 'apply', platform);

    if (manual) {
      emit('status', `Cookbook found for ${platform} — replaying ${manual.steps.length} steps...`);
      cookbookSucceeded = await tryCookbookExecution(agent.page, manual, profile, emit);
    }

    // ── Magnitude LLM fallback ────────────────────────────────────────
    let traceRecorder: TraceRecorder | null = null;

    if (!cookbookSucceeded) {
      if (manual) {
        emit('status', 'Cookbook replay failed, falling back to LLM automation...');
      }

      // Start trace recording so we can create a cookbook from this run
      const userData = buildUserData(profile);
      traceRecorder = new TraceRecorder({
        page: agent.page,
        events: agent.events,
        userData,
      });
      traceRecorder.start();
      emit('status', 'Recording actions for future cookbook...');

      emit('status', 'Filling out application form...');
      if (platform === 'workday') {
        const { runWorkdayPipeline } = await import('./engine/workday/workdayOrchestrator.js');
        await runWorkdayPipeline(agent, profile, emit, resumePath);
      } else {
        await fillWithSmartScroll(agent, profile, emit, resumePath);
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
    if (traceRecorder && traceRecorder.isRecording()) {
      traceRecorder.stopRecording();
      const trace = traceRecorder.getTrace();
      if (trace.length > 0) {
        try {
          const now = new Date().toISOString();
          const newManual: ActionManual = {
            id: randomUUID(),
            url_pattern: LocalManualStore.urlToPattern(targetUrl),
            task_pattern: 'apply',
            platform,
            steps: trace,
            health_score: 1.0,
            source: 'recorded' as ManualSource,
            created_at: now,
            updated_at: now,
          };
          store.save(newManual);
          emit('status', `Cookbook saved (${trace.length} steps) — next run will be faster`);
        } catch {
          // Best-effort: don't fail the job if save fails
        }
      }
    }

    // Keep browser open for manual review — do NOT call agent.stop().
    // The user reviews and submits manually, then closes the browser.
    // activeAgent stays set so cancelApplication() can still stop it.
    emit('complete', 'Application filled — browser open for manual review');
    return { success: true, message: 'Application filled — browser open for manual review' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('error', `Failed: ${message}`);

    if (activeAgent) {
      try { await activeAgent.stop(); } catch { /* best-effort */ }
    }
    activeAgent = null;

    return { success: false, message };
  }
}

export async function cancelApplication(): Promise<void> {
  if (activeAgent) {
    try { await activeAgent.stop(); } catch { /* best-effort */ }
    activeAgent = null;
  }
}

/**
 * Attempt to execute a cookbook against the current page.
 * Returns true if all steps succeeded, false otherwise.
 */
async function tryCookbookExecution(
  page: any,
  manual: ActionManual,
  profile: UserProfile,
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

/**
 * Build a flat key-value map from user profile for template variable resolution.
 */
function buildUserData(profile: UserProfile): Record<string, string> {
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

  // Flatten first education entry
  if (profile.education.length > 0) {
    const edu = profile.education[0];
    data.school = edu.school;
    data.degree = edu.degree;
    data.field = edu.field;
    data.startYear = String(edu.startYear);
    data.endYear = edu.endYear ? String(edu.endYear) : '';
  }

  // Flatten first experience entry
  if (profile.experience.length > 0) {
    const exp = profile.experience[0];
    data.company = exp.company;
    data.jobTitle = exp.title;
    data.startDate = exp.startDate;
    data.endDate = exp.endDate || '';
    data.jobDescription = exp.description;
  }

  // Include Q&A answers as template variables
  if (profile.qaAnswers) {
    for (const [key, value] of Object.entries(profile.qaAnswers)) {
      data[key] = value;
    }
  }

  return data;
}
