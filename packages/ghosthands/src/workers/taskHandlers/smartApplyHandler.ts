import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import type { BrowserAutomationAdapter } from '../../adapters/types.js';
import type { PageContextService } from '../../context/PageContextService.js';
import type { PlatformConfig, PageState, PageType, ScannedField, ScanResult } from './platforms/types.js';
import type { CostTracker } from '../costControl.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import {
  generatePlatformCredential,
  inferCredentialPlatformFromUrl,
  resolvePlatformAccountEmail,
  resolvePlatformAccountPassword,
  type AccountCreationEvent,
  type GeneratedPlatformCredential,
} from './platforms/accountCredentials.js';
import { findBestAnswer } from './platforms/genericConfig.js';
import { ProgressStep } from '../progressTracker.js';
import { fillFormOnPage, buildProfileText } from './formFiller.js';
import type { WorkdayUserProfile } from './workday/workdayTypes.js';
import type { RecentInboxMessage } from '../emailVerification/types.js';
import { VERIFICATION_INPUT_SELECTOR_QUERY } from '../verificationSelectors.js';

// --- Constants ---

const PAGE_TRANSITION_WAIT_MS = 3_000;
const MAX_FORM_PAGES = 15;
const MIN_LLM_GAP_MS = 5_000; // Minimum gap between LLM calls to stay under rate limits

// MagnitudeHand (Phase 2.75) — last-resort general GUI agent fallback
const MAGNITUDE_HAND_BUDGET_CAP = 0.50;       // Max $ to spend in MagnitudeHand per page
const MAGNITUDE_HAND_MAX_FIELDS = 15;          // Max fields to attempt per pass
const MAGNITUDE_HAND_ACT_TIMEOUT_MS = 30_000;  // Timeout per individual act() call
const MAGNITUDE_HAND_MIN_REMAINING_BUDGET = 0.02; // Skip if less than this remains
const VERIFICATION_EMAIL_CONTEXT_LIMIT = 5;
const VERIFICATION_EMAIL_CONTEXT_BODY_MAX_CHARS = 4_000;
const VERIFICATION_AGENT_MAX_ATTEMPTS = 2;
const VERIFICATION_AGENT_RETRY_DELAY_MS = 1_500;

function asMutableRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function rememberCredentialOnProfile(
  profile: Record<string, any>,
  credential: GeneratedPlatformCredential,
): void {
  const platformKey = credential.platform;
  const platformCredentials =
    asMutableRecord(profile.platform_credentials) ??
    asMutableRecord(profile.platformCredentials) ??
    {};
  const existingPlatformEntry = asMutableRecord(platformCredentials[platformKey]) ?? {};
  const scopedByDomain = asMutableRecord(existingPlatformEntry.byDomain) ?? {};

  if (credential.domain) {
    scopedByDomain[credential.domain] = {
      domain: credential.domain,
      email: credential.loginIdentifier,
      loginIdentifier: credential.loginIdentifier,
      password: credential.secret,
      secret: credential.secret,
    };
  }

  platformCredentials[platformKey] = {
    ...existingPlatformEntry,
    email: credential.loginIdentifier,
    loginIdentifier: credential.loginIdentifier,
    password: credential.secret,
    secret: credential.secret,
    domain: credential.domain ?? null,
    ...(Object.keys(scopedByDomain).length > 0 ? { byDomain: scopedByDomain } : {}),
  };

  profile.platform_credentials = platformCredentials;
  profile.platformCredentials = platformCredentials;
  profile[`${platformKey}_email`] = credential.loginIdentifier;
  profile[`${platformKey}Email`] = credential.loginIdentifier;
  profile[`${platformKey}_password`] = credential.secret;
  profile[`${platformKey}Password`] = credential.secret;
}

// --- Handler ---

export class SmartApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'Fill out a job application on any ATS platform (multi-step), stopping before submission';
  private lastLlmCallTime = 0;
  /** True after we've attempted native login — prevents re-trying login on Create Account pages */
  loginAttempted = false;
  /** True after clicking Apply — prevents SPA re-detection as job_listing */
  private applyClicked = false;
  /** Tracks last fill result so the main loop can detect consecutive zero-field pages */
  private _lastFillTotalFields = -1;
  private _lastFillDomFilled = -1;
  private _lastFillMagnitudeFilled = -1;
  private accountCreationEvents: AccountCreationEvent[] = [];
  private generatedPlatformCredentials: GeneratedPlatformCredential[] = [];

  private resetRunState(): void {
    this.lastLlmCallTime = 0;
    this.loginAttempted = false;
    this.applyClicked = false;
    this.accountCreationEvents = [];
    this.generatedPlatformCredentials = [];
  }

  private rememberGeneratedPlatformCredential(
    profile: Record<string, any>,
    credential: GeneratedPlatformCredential,
    event: AccountCreationEvent,
  ): void {
    const existingCredentialIndex = this.generatedPlatformCredentials.findIndex(
      (entry) =>
        entry.platform === credential.platform &&
        (entry.domain ?? null) === (credential.domain ?? null) &&
        entry.loginIdentifier === credential.loginIdentifier,
    );
    if (existingCredentialIndex >= 0) {
      this.generatedPlatformCredentials[existingCredentialIndex] = credential;
    } else {
      this.generatedPlatformCredentials.push(credential);
    }

    const existingEventIndex = this.accountCreationEvents.findIndex(
      (entry) =>
        entry.platform === event.platform &&
        (entry.domain ?? null) === (event.domain ?? null) &&
        entry.action === event.action &&
        entry.loginIdentifier === event.loginIdentifier,
    );
    if (existingEventIndex >= 0) {
      this.accountCreationEvents[existingEventIndex] = event;
    } else {
      this.accountCreationEvents.push(event);
    }

    rememberCredentialOnProfile(profile, credential);
  }

  private withAccountCreationMetadata(result: TaskResult): TaskResult {
    if (
      this.accountCreationEvents.length === 0 &&
      this.generatedPlatformCredentials.length === 0
    ) {
      return result;
    }

    return {
      ...result,
      data: {
        ...(result.data || {}),
        ...(this.accountCreationEvents.length > 0
          ? { account_creation_events: this.accountCreationEvents }
          : {}),
      },
      runtimeMetadata: {
        ...(result.runtimeMetadata || {}),
        ...(this.accountCreationEvents.length > 0
          ? { accountCreationEvents: this.accountCreationEvents }
          : {}),
        ...(this.generatedPlatformCredentials.length > 0
          ? { generatedPlatformCredentials: this.generatedPlatformCredentials }
          : {}),
      },
    };
  }

  private attachPageDebugListeners(adapter: BrowserAutomationAdapter): void {
    const page = adapter.page as typeof adapter.page & { __ghSmartApplyDebugAttached?: boolean };
    if (!page.__ghSmartApplyDebugAttached) {
      page.__ghSmartApplyDebugAttached = true;
      page.on('close', () => {
        console.warn(`[SmartApply] Playwright page closed (last url: ${page.url() || 'unknown'})`);
      });
      page.on('crash', () => {
        console.warn(`[SmartApply] Playwright page crashed (last url: ${page.url() || 'unknown'})`);
      });
      page.on('popup', (popup) => {
        console.warn(`[SmartApply] Popup opened during apply flow (url: ${popup.url() || 'about:blank'})`);
      });
    }

    const context = page.context() as ReturnType<typeof page.context> & { __ghSmartApplyDebugAttached?: boolean };
    if (!context.__ghSmartApplyDebugAttached) {
      context.__ghSmartApplyDebugAttached = true;
      context.on('close', () => {
        console.warn('[SmartApply] Browser context closed during apply flow');
      });
      context.on('page', (newPage) => {
        console.warn(`[SmartApply] New page observed in context (url: ${newPage.url() || 'about:blank'})`);
      });
    }
  }

  private async logAdapterPageState(adapter: BrowserAutomationAdapter, label: string): Promise<void> {
    try {
      const page = adapter.page;
      const contextPages = page.context().pages().map((candidate, index) => ({
        index,
        url: candidate.url() || 'about:blank',
        isClosed: candidate.isClosed(),
      }));
      let currentUrl = '(closed)';
      let title = '(unavailable)';
      if (!page.isClosed()) {
        currentUrl = await adapter.getCurrentUrl().catch(() => page.url() || '(unavailable)');
        title = await page.title().catch(() => '(unavailable)');
      }
      console.warn(
        `[SmartApply] ${label}: ${JSON.stringify({
          currentUrl,
          title,
          pageClosed: page.isClosed(),
          adapterConnected: adapter.isConnected(),
          contextPageCount: contextPages.length,
          contextPages,
        })}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[SmartApply] ${label}: failed to snapshot page state: ${message}`);
    }
  }

  private async closeUnexpectedSiblingPages(
    adapter: BrowserAutomationAdapter,
    expectedUrl: string,
  ): Promise<void> {
    let expectedHost = "";
    try {
      expectedHost = new URL(expectedUrl).hostname.toLowerCase();
    } catch {
      return;
    }

    const currentPage = adapter.page;
    const siblingPages = currentPage.context().pages().filter((page) => page !== currentPage && !page.isClosed());
    for (const sibling of siblingPages) {
      const siblingUrl = sibling.url();
      let siblingHost = "";
      try {
        siblingHost = siblingUrl ? new URL(siblingUrl).hostname.toLowerCase() : "";
      } catch {
        siblingHost = "";
      }

      if (!siblingHost || siblingHost === expectedHost) {
        continue;
      }

      console.warn(
        `[SmartApply] Closing unexpected sibling page during apply flow ` +
        `(expected host: ${expectedHost}, found: ${siblingHost || siblingUrl || 'about:blank'})`,
      );
      await sibling.close().catch(() => {});
    }

    await currentPage.bringToFront().catch(() => {});
  }

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
    const { job, adapter, progress, resumeFilePath: downloadedResumePath } = ctx;
    const userProfile = job.input_data.user_data as Record<string, any>;
    const pageContext = ctx.pageContext;

    // TaskHandlerRegistry stores singleton handler instances, so reset
    // per-run state at the start of each execute() call.
    this.resetRunState();

    // Normalize address: API route stores flat (city, state, country, zip)
    // but platform configs expect nested address object
    if (!userProfile.address && (userProfile.city || userProfile.state || userProfile.country || userProfile.zip)) {
      userProfile.address = {
        street: userProfile.street || '',
        city: userProfile.city || '',
        state: userProfile.state || '',
        zip: userProfile.zip || '',
        country: userProfile.country || 'United States of America',
      };
    } else if (!userProfile.address) {
      userProfile.address = { street: '', city: '', state: '', zip: '', country: 'United States of America' };
    }

    const qaOverrides = job.input_data.qa_overrides || {};

    // Polyfill __name in browser context — esbuild/bun may inject __name
    // references into serialized page.evaluate() callbacks. Define it as a
    // no-op both now (for the current page) and via addInitScript (survives
    // SPA navigations).
    const namePolyfill = 'if(typeof globalThis.__name==="undefined"){globalThis.__name=function(f){return f}}';
    await adapter.page.addInitScript(namePolyfill);
    await adapter.page.evaluate(namePolyfill);
    this.attachPageDebugListeners(adapter);

    // Resolve platform config from URL
    // When running under Mastra, force generic config — skip platform-specific
    // logic (e.g. Workday skills/dropdown handlers) so the generic flow is exercised.
    const config = job.execution_mode === 'mastra'
      ? detectPlatformFromUrl('')   // empty URL → GenericPlatformConfig
      : detectPlatformFromUrl(job.target_url);
    console.log(`[SmartApply] Platform: ${config.displayName} (${config.platformId})${job.execution_mode === 'mastra' ? ' (forced generic for Mastra)' : ''}`);
    console.log(`[SmartApply] Starting application for ${job.target_url}`);
    console.log(`[SmartApply] Applicant: ${userProfile.first_name} ${userProfile.last_name}`);

    // Build data prompt, QA map, and profile text for formFiller
    const dataPrompt = config.buildDataPrompt(userProfile, qaOverrides);
    const qaMap = config.buildQAMap(userProfile, qaOverrides);
    const profileText = buildProfileText(userProfile as WorkdayUserProfile);

    // Resolve resume file path.
    // Prefer ctx.resumeFilePath (downloaded by JobExecutor from resume_ref),
    // then fall back to userProfile.resume_path if it points to a local file.
    let resumePath: string | null = null;
    if (downloadedResumePath) {
      const resolvedDownloaded = path.resolve(downloadedResumePath);
      if (fs.existsSync(resolvedDownloaded)) {
        resumePath = resolvedDownloaded;
        console.log(`[SmartApply] Resume found (downloaded): ${resumePath}`);
      } else {
        console.warn(`[SmartApply] Downloaded resume missing at ${resolvedDownloaded} — falling back to profile path.`);
      }
    }
    if (!resumePath && userProfile.resume_path) {
      const resolved = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);
      if (fs.existsSync(resolved)) {
        resumePath = resolved;
        console.log(`[SmartApply] Resume found (profile path): ${resumePath}`);
      } else {
        console.warn(`[SmartApply] Resume not found at ${resolved} — skipping upload.`);
      }
    }
    if (resumePath) {
      // Keep platform-specific handlers (e.g. Workday custom experience handler)
      // aligned with the concrete local file path.
      userProfile.resume_path = resumePath;
    }

    // Auto-attach resume to any file dialog the LLM or DOM triggers
    if (resumePath) {
      const rp = resumePath;
      adapter.page.on('filechooser', async (chooser) => {
        try {
          console.log(`[SmartApply] File chooser opened — attaching resume: ${rp}`);
          await chooser.setFiles(rp);
        } catch (err) {
          console.warn(`[SmartApply] File chooser resume attach failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    let pagesProcessed = 0;
    let lastPageSignature = '';
    let samePageCount = 0;
    let consecutiveZeroFieldPages = 0;
    const ESCALATE_AFTER = 3;  // escalate to MagnitudeHand after this many stuck iterations
    const MAX_SAME_PAGE = 6;   // bail after this many total stuck iterations (3 DOM + 3 Magnitude)
    const MAX_ZERO_FIELD_PAGES = 3; // bail if N consecutive pages have 0 fields (site incompatible)

    try {
      // Main detect-and-act loop
      while (pagesProcessed < MAX_FORM_PAGES) {
        pagesProcessed++;

        await this.waitForPageLoad(adapter);
        if (config.platformId === 'workday') {
          await this.closeUnexpectedSiblingPages(adapter, job.target_url);
        }

        // Dismiss cookie consent banners (common on many job sites)
        await this.dismissCookieBanner(adapter);

        // Detect current page type
        await progress.setStatusMessage?.('Analyzing page...');
        await progress.setStep(ProgressStep.ANALYZING_PAGE);
        const pageState = await this.detectPage(adapter, config);
        const currentPageUrl = await adapter.getCurrentUrl();
        console.log(
          `[SmartApply] Page ${pagesProcessed}: ${pageState.page_type} (title: ${pageState.page_title || 'N/A'}, url: ${currentPageUrl})`,
        );

        // Stuck detection: compare URL + visible content fingerprint.
        // On SPAs (like Amazon.jobs), the URL stays constant across sections,
        // so we also check headings, field count, and active sidebar item.
        const contentFingerprint = await this.getPageFingerprint(adapter);
        const pageSignature = `${currentPageUrl}|${contentFingerprint}`;
        let stuckEscalate = false;
        if (pageSignature === lastPageSignature) {
          samePageCount++;
          if (samePageCount >= MAX_SAME_PAGE) {
            console.warn(`[SmartApply] Stuck on same page for ${samePageCount} iterations (${ESCALATE_AFTER} DOM + ${samePageCount - ESCALATE_AFTER} Magnitude) — stopping.`);
            await pageContext?.finalizeActivePage({ status: 'blocked' });
            await pageContext?.markAwaitingReview();
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            return this.withAccountCreationMetadata({
              success: true,
              keepBrowserOpen: true,
              awaitingUserReview: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'stuck',
                message: `Application appears stuck on the same page. Browser open for manual takeover.`,
              },
            });
          }
          if (samePageCount >= ESCALATE_AFTER) {
            console.log(`[SmartApply] Stuck ${samePageCount}/${MAX_SAME_PAGE} — escalating to MagnitudeHand for this page.`);
            stuckEscalate = true;
          }
        } else {
          samePageCount = 0;
          lastPageSignature = pageSignature;
        }

        // SPA guard: after clicking Apply on SPAs (Greenhouse), the URL doesn't
        // change and the form page may still have Apply-like buttons — override to questions
        if (pageState.page_type === 'job_listing' && this.applyClicked) {
          console.log(`[SmartApply] SPA guard: already clicked Apply — treating as questions page`);
          pageState.page_type = 'questions' as any;
          pageState.page_title = 'Form Page (SPA)';
        }

        await pageContext?.enterOrResumePage({
          pageType: pageState.page_type,
          pageTitle: pageState.page_title,
          url: currentPageUrl,
          fingerprint: contentFingerprint,
          pageStepKey: this.buildPageStepKey(pageState),
          pageSequence: pagesProcessed,
          domSummary: this.buildPageDomSummary(pageState),
        });

        // Handle based on page type
        switch (pageState.page_type) {
          case 'job_listing':
            await this.handleJobListing(adapter);
            this.applyClicked = true;
            break;

          case 'login':
          case 'google_signin':
            if (config.handleLogin) {
              await config.handleLogin(adapter, userProfile);
            } else {
              await this.handleGenericLogin(adapter, userProfile, dataPrompt, ctx);
            }
            // Track that login was attempted so detectObviousPage doesn't
            // re-classify a Create Account page as login.
            this.loginAttempted = true;
            break;

          case 'verification_code':
            await this.handleVerificationCode(adapter, userProfile, ctx);
            break;

          case 'phone_2fa':
            await this.handlePhone2FA(adapter);
            break;

          case 'account_creation':
            // Workday account creation should proceed directly. Many Workday flows
            // present a combined auth screen, but for our desktop apply flow we want
            // a new account created unless we explicitly entered the login branch.
            if (config.platformId === 'workday') {
              await this.handleAccountCreation(adapter, dataPrompt, userProfile);
              break;
            }

            // If we haven't tried login yet, try it first — many sites show the
            // Create Account page by default with an "Already have an account? Sign In" link.
            if (!this.loginAttempted) {
              console.log('[SmartApply] Account creation page detected but login not yet attempted — trying login first.');
              if (config.handleLogin) {
                await config.handleLogin(adapter, userProfile);
              } else {
                await this.handleGenericLogin(adapter, userProfile, dataPrompt, ctx);
              }
              this.loginAttempted = true;
              // Don't call handleAccountCreation here — let the main loop re-detect the page.
              // If login succeeded, we'll land on the application form.
              // If login failed, the login handler navigates to Create Account,
              // and the next iteration will classify it as account_creation with loginAttempted=true.
              break;
            }
            await this.handleAccountCreation(adapter, dataPrompt, userProfile);
            break;

          case 'review':
            // We've reached the review page — STOP HERE
            await pageContext?.markAwaitingReview();
            await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
            console.log('\n' + '='.repeat(70));
            console.log('[SmartApply] APPLICATION FILLED SUCCESSFULLY');
            console.log('[SmartApply] Stopped at REVIEW page — NOT submitting.');
            console.log('[SmartApply] The browser is open for you to review and submit manually.');
            console.log('[SmartApply] DO NOT close this terminal until you are done.');
            console.log('='.repeat(70) + '\n');

            return this.withAccountCreationMetadata({
              success: true,
              keepBrowserOpen: true,
              awaitingUserReview: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'review',
                message: 'Application filled. Waiting for user to review and submit.',
              },
            });

          case 'confirmation':
            console.warn('[SmartApply] Unexpected: landed on confirmation page');
            await pageContext?.finalizeActivePage({ status: 'completed' });
            return this.withAccountCreationMetadata({
              success: true,
              data: {
                platform: config.platformId,
                pages_processed: pagesProcessed,
                final_page: 'confirmation',
                message: 'Application appears to have been submitted (unexpected).',
              },
            });

          case 'error':
            return this.withAccountCreationMetadata({
              success: false,
              error: `Application error page: ${pageState.error_message || 'Unknown error'}`,
              data: { platform: config.platformId, pages_processed: pagesProcessed },
            });

          default: {
            // ALL form pages — personal_info, experience, resume_upload, questions, etc.
            if (
              (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload') &&
              config.needsCustomExperienceHandler && config.handleExperiencePage
            ) {
              await progress.setStep(ProgressStep.UPLOADING_RESUME);
              await config.handleExperiencePage(adapter, userProfile, dataPrompt);

              // Robust navigation after custom handler — mirrors fillPage()'s post-click logic
              const urlBeforeExp = await adapter.getCurrentUrl();
              const fpBeforeExp = await this.getPageFingerprint(adapter);

              // Scroll to bottom to ensure Next button is visible
              await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
              await adapter.page.waitForTimeout(500);

              let expClickResult = await config.clickNextButton(adapter);
              console.log(`[SmartApply] [experience] After custom handler, clickNext: ${expClickResult}`);

              if (expClickResult === 'clicked') {
                await adapter.page.waitForTimeout(2000);

                // Check for validation errors
                const hasErrors = await config.detectValidationErrors(adapter);
                if (hasErrors) {
                  console.log(`[SmartApply] [experience] Validation errors after clicking Next — re-detecting page for recovery.`);
                  // Don't break — let the main loop re-detect the page.
                  // handleExperiencePage is idempotent (resume/skills already done, LLM sees filled fields).
                } else {
                  // Verify page actually changed
                  const urlAfterExp = await adapter.getCurrentUrl();
                  const fpAfterExp = await this.getPageFingerprint(adapter);
                  if (urlAfterExp !== urlBeforeExp || fpAfterExp !== fpBeforeExp) {
                    await this.waitForPageLoad(adapter);
                    break;
                  }
                  // SPA delayed render — wait and check again
                  await adapter.page.waitForTimeout(2000);
                  const urlAfterWait = await adapter.getCurrentUrl();
                  const fpAfterWait = await this.getPageFingerprint(adapter);
                  if (urlAfterWait !== urlBeforeExp || fpAfterWait !== fpBeforeExp) {
                    await this.waitForPageLoad(adapter);
                    break;
                  }
                  console.log(`[SmartApply] [experience] Clicked Next but page unchanged — re-detecting.`);
                }
              }

              if (expClickResult === 'review_detected') {
                console.log(`[SmartApply] [experience] Review page detected.`);
                break; // Main loop will re-detect as 'review' page type
              }

              if (expClickResult === 'not_found') {
                // Scroll to content bottom and retry
                const scrollMax = await this.getContentScrollMax(adapter);
                await adapter.page.evaluate((target: number) =>
                  window.scrollTo({ top: target, behavior: 'smooth' }),
                scrollMax);
                await adapter.page.waitForTimeout(800);

                const retryClick = await config.clickNextButton(adapter);
                if (retryClick === 'clicked') {
                  await adapter.page.waitForTimeout(2000);
                  await this.waitForPageLoad(adapter);
                  break;
                }
                if (retryClick === 'review_detected') {
                  console.log(`[SmartApply] [experience] Review page detected at bottom.`);
                  break;
                }
                console.log(`[SmartApply] [experience] Next button not found even at bottom — re-detecting.`);
              }
              // Fall-through: re-detect page for recovery
              break;
            }

            const step = (pageState.page_type === 'experience' || pageState.page_type === 'resume_upload')
              ? ProgressStep.UPLOADING_RESUME
              : ProgressStep.FILLING_FORM;
            await progress.setStep(step as any);

            const result = await this.fillPage(
              adapter,
              config,
              resumePath,
              profileText,
              0,
              stuckEscalate,
              ctx.costTracker,
              progress,
              pageContext,
              ctx.llmClientConfig,
            );

            if (result === 'review') {
              // fillPage detected this is actually the review page
              console.log(`[SmartApply] Review page reached via fillPage — stopping.`);
              await pageContext?.markAwaitingReview();
              await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
              console.log('\n' + '='.repeat(70));
              console.log('[SmartApply] Stopped at REVIEW page — NOT submitting.');
              console.log('[SmartApply] The browser is open for you to review and submit manually.');
              console.log('[SmartApply] DO NOT close this terminal until you are done.');
              console.log('='.repeat(70) + '\n');

              return this.withAccountCreationMetadata({
                success: true,
                keepBrowserOpen: true,
                awaitingUserReview: true,
                data: {
                  platform: config.platformId,
                  pages_processed: pagesProcessed,
                  final_page: 'review',
                  message: 'Application filled. Waiting for user to review and submit.',
                },
              });
            }
            // Track consecutive zero-field pages: if the site consistently has
            // 0 detectable form fields, it's incompatible with our field extraction.
            // Bail early instead of looping through Magnitude timeouts.
            if (this._lastFillTotalFields === 0 && this._lastFillDomFilled === 0 && this._lastFillMagnitudeFilled === 0) {
              consecutiveZeroFieldPages++;
              console.warn(
                `[SmartApply] Zero-field page ${consecutiveZeroFieldPages}/${MAX_ZERO_FIELD_PAGES} ` +
                `(url: ${currentPageUrl}, pageType: ${pageState.page_type})`,
              );
              await this.logAdapterPageState(adapter, 'Zero-field diagnostics');
              if (consecutiveZeroFieldPages >= MAX_ZERO_FIELD_PAGES) {
                console.warn(`[SmartApply] ${consecutiveZeroFieldPages} consecutive pages with 0 detectable fields — site uses non-standard form components. Stopping.`);
                await pageContext?.finalizeActivePage({ status: 'blocked' });
                await pageContext?.markAwaitingReview();
                await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
                return this.withAccountCreationMetadata({
                  success: true,
                  keepBrowserOpen: true,
                  awaitingUserReview: true,
                  data: {
                    platform: config.platformId,
                    pages_processed: pagesProcessed,
                    final_page: 'incompatible',
                    message: 'Site uses non-standard form components that cannot be automated. Browser open for manual takeover.',
                  },
                });
              }
            } else {
              consecutiveZeroFieldPages = 0;
            }
            // 'navigated' and 'complete' both continue the main loop
            break;
          }
        }
      }

      // Safety: hit max pages without reaching review
      console.warn(`[SmartApply] Reached max page limit (${MAX_FORM_PAGES}) without finding review page`);
      await pageContext?.finalizeActivePage({ status: 'blocked' });
      await pageContext?.markAwaitingReview();
      await progress.setStep(ProgressStep.AWAITING_USER_REVIEW);
      console.log('\n' + '='.repeat(70));
      console.log('[SmartApply] Reached page limit. Browser is open for manual takeover.');
      console.log('[SmartApply] DO NOT close this terminal until you are done.');
      console.log('='.repeat(70) + '\n');

      return this.withAccountCreationMetadata({
        success: true,
        keepBrowserOpen: true,
        awaitingUserReview: true,
        data: {
          platform: config.platformId,
          pages_processed: pagesProcessed,
          final_page: 'max_pages_reached',
          message: `Processed ${pagesProcessed} pages. Browser open for manual review.`,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[SmartApply] Error on page ${pagesProcessed}: ${msg}`);
      if (/Target page, context or browser has been closed/i.test(msg)) {
        await this.logAdapterPageState(adapter, `Closed-page diagnostics after failure on page ${pagesProcessed}`);
      }
      await pageContext?.markFailed();

      // If we fail mid-application, keep browser open so user can recover
      if (pagesProcessed > 2) {
        console.log('[SmartApply] Keeping browser open for manual recovery.');
        return this.withAccountCreationMetadata({
          success: false,
          keepBrowserOpen: true,
          error: msg,
          data: { platform: config.platformId, pages_processed: pagesProcessed },
        });
      }

      return this.withAccountCreationMetadata({
        success: false,
        error: msg,
        data: { platform: config.platformId, pages_processed: pagesProcessed },
      });
    }
  }

  // =========================================================================
  // Page Detection — 4-tier delegation
  // =========================================================================

  private async detectPage(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
  ): Promise<PageState> {
    const currentUrl = await adapter.getCurrentUrl();

    // Tier 1: URL-based (fast, no LLM cost) — only catches dead-obvious patterns
    const urlResult = config.detectPageByUrl(currentUrl);
    if (urlResult) return urlResult;

    // Tier 2: Minimal DOM checks — ONLY for things the LLM can't see (or to save cost on obvious pages)
    const obviousResult = await this.detectObviousPage(adapter, currentUrl);
    if (obviousResult) return obviousResult;

    // Tier 2.5: Platform-specific DOM detection — catches form pages, login, review, etc.
    // without needing an LLM call. genericConfig.detectPageByDOM checks input counts,
    // review signals, apply buttons, etc.
    const domResult = await config.detectPageByDOM(adapter);
    if (domResult) {
      console.log(`[SmartApply] DOM detection classified page as: ${domResult.page_type}`);
      return domResult;
    }

    // Tier 3: LLM classification — the LLM sees the screenshot and decides
    try {
      const healthy = await this.isPageHealthy(adapter);
      if (!healthy) {
        console.warn('[SmartApply] Page appears broken (raw JS/code visible) — using DOM fallback.');
        const fallbackType = await config.classifyByDOMFallback(adapter);
        return { page_type: fallbackType, page_title: 'broken_page' };
      }

      // Build URL hints so the LLM has context about where we are
      const urlHints: string[] = [];
      if (currentUrl.includes('signin') || currentUrl.includes('login') || currentUrl.includes('accounts.google.com')) {
        urlHints.push('The URL indicates this is a login/sign-in page.');
      }
      if (currentUrl.includes('review') || currentUrl.includes('summary')) {
        urlHints.push('The URL indicates this may be a review/summary page.');
      }
      if (currentUrl.includes('job') || currentUrl.includes('position') || currentUrl.includes('career')) {
        urlHints.push('The URL is job-related.');
      }
      if (currentUrl.includes('apply')) {
        urlHints.push('The URL contains "apply" — this could be the application form or a job listing with an Apply button.');
      }

      const classificationPrompt = config.buildClassificationPrompt(urlHints);
      await this.throttleLlm(adapter);
      const llmResult = await adapter.extract(classificationPrompt, config.pageStateSchema);
      console.log(`[SmartApply] LLM classified page as: ${llmResult.page_type}`);

      // SAFETY: If LLM says "account_creation" but the page has many form fields
      // beyond email/password (name, phone, address, etc.), it's a regular form page.
      // Amazon.jobs Contact Information on account.amazon.jobs triggers this false positive.
      if (llmResult.page_type === 'account_creation') {
        const formFieldCount = await adapter.page.evaluate(() => {
          return document.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
            'input[type="email"]:not([readonly]):not([disabled]), ' +
            'input[type="tel"]:not([readonly]):not([disabled]), ' +
            'textarea:not([readonly]):not([disabled]), ' +
            'select:not([disabled]), ' +
            '[role="combobox"]:not([aria-disabled="true"])'
          ).length;
        });

        // Real account creation forms have at most ~4 fields (email, password, confirm, name).
        // If there are 5+ form fields, this is a regular application form page.
        if (formFieldCount >= 5) {
          console.log(`[SmartApply] LLM said "account_creation" but page has ${formFieldCount} form fields — overriding to "questions"`);
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      // SAFETY: If LLM says "review", double-check — many single-page forms
      // show a Submit button on every page, which fools the classification.
      if (llmResult.page_type === 'review') {
        const hasEditableFields = await adapter.page.evaluate(() => {
          return document.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
            'input[type="email"]:not([readonly]):not([disabled]), ' +
            'input[type="tel"]:not([readonly]):not([disabled]), ' +
            'textarea:not([readonly]):not([disabled]), ' +
            'select:not([disabled]), ' +
            '[role="combobox"]:not([aria-disabled="true"]), ' +
            '[role="radiogroup"], ' +
            '[role="radio"]:not([aria-checked="true"])'
          ).length > 0;
        });

        if (hasEditableFields) {
          console.log('[SmartApply] LLM said "review" but page has editable fields — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }

        const isReallyReview = await this.verifyReviewPage(adapter);
        if (!isReallyReview) {
          console.log('[SmartApply] Review verification failed — overriding to "questions"');
          return { ...llmResult, page_type: 'questions' as PageType };
        }
      }

      return llmResult;
    } catch (error) {
      console.warn(`[SmartApply] LLM page detection failed: ${error}`);

      // Tier 4: DOM fallback
      const fallbackType = await config.classifyByDOMFallback(adapter);
      if (fallbackType !== 'unknown') {
        console.log(`[SmartApply] DOM fallback classified page as: ${fallbackType}`);
      }
      return { page_type: fallbackType, page_title: fallbackType === 'unknown' ? 'N/A' : fallbackType };
    }
  }

  /**
   * Detect only dead-obvious pages that don't need LLM classification.
   * Keeps costs down for pages like Google Sign-In, confirmation, etc.
   */
  private async detectObviousPage(
    adapter: BrowserAutomationAdapter,
    currentUrl: string,
  ): Promise<PageState | null> {
    // Google Sign-In — URL is unmistakable
    if (currentUrl.includes('accounts.google.com')) {
      return { page_type: 'google_signin', page_title: 'Google Sign-In', has_sign_in_with_google: true };
    }

    // Quick DOM check for login (password field) and confirmation (thank you text)
    const obvious = await adapter.page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!el) return false;
        const node = el as HTMLElement;
        if (node.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const passwordFields = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="password"]:not([disabled])')
      ).filter((input) => isVisible(input));
      const hasPasswordField = passwordFields.length > 0;
      // 2+ password fields (password + confirm) = account creation, not login
      const hasConfirmPassword = passwordFields.length > 1;
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const isCreateAccountHeading = headingText.includes('create account')
        || headingText.includes('register')
        || headingText.includes('sign up');
      const hasConfirmation = bodyText.includes('thank you for applying')
        || bodyText.includes('application received')
        || bodyText.includes('successfully submitted')
        || bodyText.includes('application has been submitted');
      // Count form fields — pages with many inputs are application forms, not login
      const formFieldCount = Array.from(document.querySelectorAll(
        'input[type="text"]:not([readonly]):not([disabled]), ' +
        'input[type="email"]:not([readonly]):not([disabled]), ' +
        'input[type="tel"]:not([readonly]):not([disabled]), ' +
        'textarea:not([readonly]):not([disabled]), ' +
        'select:not([disabled]), ' +
        '[role="combobox"]:not([aria-disabled="true"])'
      )).filter((el) => isVisible(el)).length;
      return { hasPasswordField, hasConfirmPassword, isCreateAccountHeading, hasConfirmation, formFieldCount };
    });

    if (obvious.hasConfirmation) {
      return { page_type: 'confirmation', page_title: 'Confirmation' };
    }

    // Account creation (confirm password or "Create Account" heading) — let
    // platform-specific detectPageByDOM handle the nuance instead of
    // misclassifying as login here.
    // Also: after login has been attempted and failed, the page may still have
    // password fields (Create Account form). Don't re-classify as login — let
    // detectPageByDOM decide if it's account_creation.
    // Also: if the page has 5+ form fields, it's an application form that happens
    // to have a password field somewhere (e.g. security question) — not a login page.
    if (obvious.hasPasswordField && !obvious.hasConfirmPassword && !obvious.isCreateAccountHeading
        && !this.loginAttempted && obvious.formFieldCount < 5) {
      return { page_type: 'login', page_title: 'Sign-In' };
    }

    // Everything else → let the LLM decide
    return null;
  }

  // =========================================================================
  // Universal Page Handlers
  // =========================================================================

  private async handleJobListing(adapter: BrowserAutomationAdapter): Promise<void> {
    console.log('[SmartApply] On job listing page, clicking Apply...');

    // Remove target="_blank" from Apply links so navigation stays in the same tab
    await adapter.page.evaluate(() => {
      document.querySelectorAll('a[target="_blank"]').forEach(a => {
        a.removeAttribute('target');
      });
    });

    const urlBefore = await adapter.getCurrentUrl();
    await this.throttleLlm(adapter);
    const result = await adapter.act(
      'Click the "Apply" or "Apply Now" button to start the job application. ' +
      'After clicking, one of these will happen: ' +
      '(1) The page scrolls to show a form — this means Apply worked, STOP immediately. ' +
      '(2) A new page loads with a form — this means Apply worked, STOP immediately. ' +
      '(3) A modal/dialog appears with options like "Apply Manually", "Autofill with Resume", etc. — ' +
      'click "Apply Manually" (or the plain apply option without autofill), then STOP. ' +
      'Do NOT fill in any form fields, do NOT click Next, and do NOT click any sign-in/auth buttons.',
    );

    // The LLM agent may report "failure" if the page navigated to a login/auth
    // page after clicking Apply — but the click itself succeeded. Check if the
    // URL actually changed to determine real success.
    if (!result.success) {
      const urlAfter = await adapter.getCurrentUrl();
      const onAuthPage = await this.isLikelyAuthPage(adapter);
      if (urlAfter !== urlBefore || onAuthPage) {
        console.log('[SmartApply] Apply button clicked — page navigated. Continuing...');
      } else {
        // The modal might still be open — try clicking "Apply Manually" directly
        try {
          await this.throttleLlm(adapter);
          const modalResult = await adapter.act(
            'If a dialog or modal is visible, click "Apply Manually" or the option to proceed ' +
            'with the application without autofill. If no modal is visible and a form is already ' +
            'showing on the page, report done — the Apply action already succeeded.',
          );
          if (modalResult.success) {
            console.log('[SmartApply] Clicked through Apply modal. Continuing...');
          } else {
            throw new Error(`Failed to click Apply button: ${result.message}`);
          }
        } catch (modalErr) {
          throw new Error(`Failed to click Apply button: ${result.message}`);
        }
      }
    }

    await this.waitForPageLoad(adapter);
  }

  /**
   * Best-effort auth-page detection used after Apply actions.
   * Some ATS flows keep the same URL while replacing content with login UI.
   */
  private async isLikelyAuthPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasPasswordField = document.querySelectorAll('input[type="password"]:not([disabled])').length > 0;
      const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
      const hasGoogleSignIn = clickables.some((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        return (
          (text.includes('google') && (text.includes('sign in') || text.includes('continue') || text.includes('log in')))
          || (aria.includes('google') && (aria.includes('sign in') || aria.includes('continue') || aria.includes('log in')))
        );
      });
      const hasNativeSignIn = clickables.some((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'sign in' || text === 'log in' || text === 'login';
      });
      const hasAuthText = bodyText.includes('sign in') || bodyText.includes('log in') || bodyText.includes('create account');

      return hasPasswordField || hasGoogleSignIn || (hasAuthText && hasNativeSignIn);
    });
  }

  /**
   * Priority 1: Prefer Google SSO when available.
   */
  private async clickPreferredGoogleSignIn(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const selectors = [
      'button:has-text("Sign in with Google")',
      'button:has-text("Continue with Google")',
      'a:has-text("Sign in with Google")',
      'a:has-text("Continue with Google")',
      '[data-automation-id*="google" i]',
      '[aria-label*="google" i]',
    ];

    for (const sel of selectors) {
      try {
        const el = adapter.page.locator(sel).first();
        const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          await el.click();
          return true;
        }
      } catch {
        // try next selector
      }
    }

    return adapter.page.evaluate(() => {
      const els = document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"]');
      for (const el of els) {
        const text = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const isGoogle = text.includes('google') || aria.includes('google');
        const isSignIn = text.includes('sign in') || text.includes('continue') || text.includes('log in')
          || aria.includes('sign in') || aria.includes('continue') || aria.includes('log in');
        if (isGoogle && isSignIn) {
          el.click();
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Priority 2: Open the platform's sign-in path (not account creation).
   */
  private async clickPlatformSpecificSignIn(
    adapter: BrowserAutomationAdapter,
    url: string,
  ): Promise<boolean> {
    const platformId = detectPlatformFromUrl(url).platformId;
    const selectors: string[] = [];

    if (platformId === 'workday') {
      selectors.push(
        '[data-automation-id="signInLink"]',
        '[data-automation-id="utilityButtonSignIn"]',
        '[data-automation-id="click_filter"][aria-label*="Sign In" i]',
        '[role="tab"]:has-text("Sign In")',
        'button:has-text("Sign In")',
        'a:has-text("Sign In")',
      );
    }

    selectors.push(
      '[role="tab"]:has-text("Sign In")',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
      'button:has-text("Log In")',
      'a:has-text("Log In")',
    );

    for (const sel of selectors) {
      try {
        const el = adapter.page.locator(sel).first();
        const visible = await el.isVisible({ timeout: 700 }).catch(() => false);
        if (visible) {
          await el.click();
          return true;
        }
      } catch {
        // try next selector
      }
    }

    return adapter.page.evaluate(() => {
      const body = document.body.innerText || '';
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"], [role="tab"]'));

      if (body.includes('Already have an account')) {
        for (const el of candidates) {
          const t = (el.textContent || '').trim().toLowerCase();
          if (!/^sign\s*in$|^log\s*in$/.test(t)) continue;
          let parent: HTMLElement | null = el;
          for (let i = 0; i < 5 && parent; i++) {
            parent = parent.parentElement;
            if (parent && parent.textContent?.includes('Already have an account')) {
              el.click();
              return true;
            }
          }
        }
      }

      for (const el of candidates) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === 'sign in' || t === 'log in' || t === 'login') {
          el.click();
          return true;
        }
      }

      return false;
    });
  }

  /**
   * Priority 3: If sign-in fails, move to platform-specific account creation.
   */
  private async clickPlatformSpecificCreateAccount(
    adapter: BrowserAutomationAdapter,
    url: string,
  ): Promise<boolean> {
    const platformId = detectPlatformFromUrl(url).platformId;
    const selectors: string[] = [];

    if (platformId === 'workday') {
      selectors.push(
        '[data-automation-id="createAccountLink"]',
        '[role="tab"]:has-text("Create Account")',
      );
    }

    selectors.push(
      '[role="tab"]:has-text("Create Account")',
      'a:has-text("Create Account")',
      'button:has-text("Create Account")',
      'a:has-text("Sign Up")',
      'button:has-text("Sign Up")',
      'a:has-text("Register")',
      'button:has-text("Register")',
    );

    for (const sel of selectors) {
      try {
        const el = adapter.page.locator(sel).first();
        const visible = await el.isVisible({ timeout: 700 }).catch(() => false);
        if (visible) {
          await el.click();
          return true;
        }
      } catch {
        // try next selector
      }
    }

    return adapter.page.evaluate(() => {
      const TEXTS = ['create account', 'sign up', 'register', "don't have an account", 'new user', 'get started'];
      const els = document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"], [role="tab"], span');
      for (const el of els) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (TEXTS.some((t) => text.includes(t))) {
          el.click();
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Pause for manual auth recovery (HITL) when automatic login/account creation
   * has exhausted deterministic fallbacks.
   */
  private async emitAuthEvent(
    ctx: TaskContext | undefined,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!ctx?.logEvent) return;
    try {
      await ctx.logEvent(eventType, metadata);
    } catch {
      // Best effort event logging; never fail auth flow on logger errors.
    }
  }

  /**
   * Pause for manual auth recovery (HITL) when automatic login/account creation
   * has exhausted deterministic fallbacks.
   */
  private async pauseForManualAuth(
    ctx: TaskContext | undefined,
    type: string,
    description: string,
    timeoutSeconds = 600,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!ctx?.waitForManualAction) return false;
    const hitlResult = await ctx.waitForManualAction({
      type,
      description,
      timeoutSeconds,
      metadata,
    });
    return hitlResult.resumed;
  }

  private async handleGenericLogin(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
    dataPrompt = '',
    ctx?: TaskContext,
  ): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();
    // Use TEST_GMAIL credentials for login/account creation pages;
    // profile.email is for the application form itself (filled by formFiller).
    const email = process.env.TEST_GMAIL_EMAIL || profile.email || '';

    // Google SSO detection
    if (currentUrl.includes('accounts.google.com')) {
      console.log(`[SmartApply] On Google sign-in page for ${email}...`);
      const password = process.env.TEST_GMAIL_PASSWORD || '';

      const googlePageType = await adapter.page.evaluate(`
        (() => {
          const targetEmail = ${JSON.stringify(email)}.toLowerCase();
          let hasVisiblePassword = false;
          let hasVisibleEmail = false;
          document.querySelectorAll('input[type="password"]').forEach(el => {
            if (hasVisiblePassword) return;
            if (el.getAttribute('aria-hidden') === 'true') return;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) hasVisiblePassword = true;
          });
          document.querySelectorAll('input[type="email"]').forEach(el => {
            if (hasVisibleEmail) return;
            if (el.getAttribute('aria-hidden') === 'true') return;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) hasVisibleEmail = true;
          });

          if (hasVisiblePassword) return { type: 'password_entry' };
          if (hasVisibleEmail) return { type: 'email_entry' };

          const bodyText = document.body.innerText.toLowerCase();

          // Check for confirmation page (account pre-selected, "Continue" button visible)
          const buttons = document.querySelectorAll('button, div[role="button"]');
          const hasContinue = Array.from(buttons).some(b => {
            const t = (b.textContent || '').trim().toLowerCase();
            return t === 'continue' || t === 'confirm' || t === 'allow';
          });
          if (hasContinue && (bodyText.includes(targetEmail) || bodyText.includes('confirm') || bodyText.includes('signing in'))) {
            return { type: 'confirmation' };
          }

          const accountLinks = document.querySelectorAll('[data-email], [data-identifier]');
          for (const el of accountLinks) {
            const addr = (el.getAttribute('data-email') || el.getAttribute('data-identifier') || '').toLowerCase();
            if (addr === targetEmail) return { type: 'account_chooser' };
          }
          if (bodyText.includes('choose an account') || bodyText.includes('select an account')) {
            return { type: 'account_chooser' };
          }

          return { type: 'unknown' };
        })()
      `) as { type: string };

      if (googlePageType.type === 'confirmation') {
        console.log('[SmartApply] Google confirmation page — clicking Continue...');
        const clicked = await adapter.page.evaluate(() => {
          const buttons = document.querySelectorAll('button, div[role="button"]');
          for (const btn of buttons) {
            const t = (btn.textContent || '').trim().toLowerCase();
            if (t === 'continue' || t === 'confirm' || t === 'allow') {
              (btn as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
        if (!clicked) {
          await adapter.act('Click the "Continue" or "Confirm" button to proceed with the Google sign-in.');
        }
        await adapter.page.waitForTimeout(2000);
        return;
      }

      if (googlePageType.type === 'account_chooser') {
        const clicked = await adapter.page.evaluate((targetEmail: string) => {
          const byAttr = document.querySelector(`[data-email="${targetEmail}" i], [data-identifier="${targetEmail}" i]`);
          if (byAttr) { (byAttr as HTMLElement).click(); return true; }
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            if (el.textContent?.toLowerCase().includes(targetEmail.toLowerCase()) && el.children.length < 5) {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, email);
        if (!clicked) await adapter.act(`Click on the account "${email}" to sign in with it.`);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      if (googlePageType.type === 'email_entry') {
        const emailInput = adapter.page.locator('input[type="email"]:visible').first();
        await emailInput.fill(email);
        await adapter.page.waitForTimeout(300);
        await this.clickNextOnGooglePage(adapter);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      if (googlePageType.type === 'password_entry') {
        const passwordInput = adapter.page.locator('input[type="password"]:visible').first();
        await passwordInput.fill(password);
        await adapter.page.waitForTimeout(300);
        await this.clickNextOnGooglePage(adapter);
        await adapter.page.waitForTimeout(2000);
        return;
      }

      // Unknown Google page — LLM fallback (password handled via DOM only)
      await adapter.act(
        `This is a Google sign-in page. Move through the sign-in flow for "${email}":
- If you see a "Continue", "Confirm", or "Allow" button, click it to proceed.
- If you see the account "${email}" listed, click on it to select it.
- If you see an "Email or phone" field, type "${email}" and click "Next".
- If you see a "Password" field, do NOT type anything — just report the task as done.
- If you see a CAPTCHA or image challenge, report the task as done.
Click only ONE button, then report the task as done.`,
      );
      await adapter.page.waitForTimeout(2000);
      return;
    }

    // Non-Google login path: Google SSO → platform sign-in → account creation
    console.log('[SmartApply] On login page, looking for sign-in options...');
    const password = process.env.TEST_GMAIL_PASSWORD || profile.password || '';
    const readFormState = () => adapter.page.evaluate(() => {
      const passwordFields = document.querySelectorAll('input[type="password"]:not([disabled])');
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
      const headingText = headings.map(h => (h.textContent || '').toLowerCase()).join(' ');
      const isCreateAccountForm = passwordFields.length > 1
        || headingText.includes('create account')
        || headingText.includes('register')
        || headingText.includes('sign up');
      const hasEmail = !!document.querySelector(
        'input[type="email"]:not([disabled]), input[autocomplete="email"]:not([disabled]), ' +
        'input[name*="email" i]:not([disabled]), input[name*="user" i]:not([disabled])'
      );
      const hasPassword = passwordFields.length > 0;
      return { hasEmail, hasPassword, isCreateAccountForm };
    });

    // Step 1: Prefer Google SSO when available.
    let googleClickDidNotNavigate = false;
    const clickedGoogle = await this.clickPreferredGoogleSignIn(adapter);
    if (clickedGoogle) {
      console.log('[SmartApply] Clicked Google SSO option.');
      await this.waitForPageLoad(adapter);

      const postGoogleUrl = await adapter.getCurrentUrl().catch(() => currentUrl);
      const movedToExternalGoogle = postGoogleUrl.includes('accounts.google.com') || postGoogleUrl !== currentUrl;
      if (movedToExternalGoogle) {
        return;
      }

      const postGoogleFormState = await readFormState();
      if (postGoogleFormState.hasEmail || postGoogleFormState.hasPassword) {
        console.log('[SmartApply] Google SSO click stayed on local page with visible credential fields — treating as local sign-in form.');
        googleClickDidNotNavigate = true;
      } else {
        return;
      }
    }

    // Step 2: No Google SSO — try opening the platform-specific sign-in path.
    if (!googleClickDidNotNavigate) {
      const signInViewClicked = await this.clickPlatformSpecificSignIn(
        adapter,
        await adapter.getCurrentUrl(),
      );
      if (signInViewClicked) {
        console.log('[SmartApply] Opened platform-specific sign-in view.');
        await adapter.page.waitForTimeout(1200);
      }
    }

    console.log('[SmartApply] Checking sign-in/create-account state...');
    let formState = await readFormState();

    // If we're still on Create Account, one more explicit attempt to switch to Sign In.
    if (formState.isCreateAccountForm) {
      const switchedToSignIn = await this.clickPlatformSpecificSignIn(
        adapter,
        await adapter.getCurrentUrl(),
      );
      if (switchedToSignIn) {
        console.log('[SmartApply] Create Account view detected — switched to Sign In.');
        await adapter.page.waitForTimeout(1200);
        formState = await readFormState();
      }
    }

    // Create Account form → delegate entirely to handleAccountCreation
    // (no DOM clicking of "Sign In" links — that can open modals and cause loops)
    if (formState.isCreateAccountForm) {
      console.log('[SmartApply] On Create Account form — creating account...');
      try {
        await this.handleAccountCreation(adapter, dataPrompt, profile);
        (profile as any)._accountCreationCompleted = true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const resumed = await this.pauseForManualAuth(
          ctx,
          'account_creation_failed',
          `Automatic account creation failed (${errMsg}). Please complete account creation and sign in manually, then click Resume.`,
        );
        if (resumed) return;
        throw err;
      }
      return;
    }

    // Check if the page says "verify your email" (after account creation) — HITL
    const needsEmailVerification = await adapter.page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('verify your account') || text.includes('verify your email')
        || text.includes('email has been sent') || text.includes('verification email')
        || text.includes('confirm your email') || text.includes('check your email')
        || text.includes('please verify');
    });

    if (needsEmailVerification) {
      const alreadyRetriedAfterAutoVerification = Boolean((profile as any)._postVerificationLoginRetryAttempted);
      let autoVerifyReason: string | null = null;

      if (ctx?.emailVerification && !alreadyRetriedAfterAutoVerification) {
        console.log('[SmartApply] Email verification required — attempting automatic inbox verification...');
        const currentPage = await adapter.getCurrentUrl().catch(() => '');
        const autoResult = await ctx.emailVerification.tryAutoVerify({
          adapter,
          loginEmail: email,
          pageUrl: currentPage,
          onEvent: async (eventType, metadata) => {
            await this.emitAuthEvent(ctx, eventType, metadata);
          },
        });

        if (autoResult.success) {
          console.log(`[SmartApply] Email verification automation succeeded via ${autoResult.method}. Retrying sign-in once...`);
          (profile as any)._postVerificationLoginRetryAttempted = true;

          // Move back to sign-in path and perform one explicit retry.
          const switchedToSignIn = await this.clickPlatformSpecificSignIn(
            adapter,
            await adapter.getCurrentUrl(),
          );
          if (switchedToSignIn) {
            await adapter.page.waitForTimeout(1200);
          }

          await this.waitForPageLoad(adapter);
          await this.handleGenericLogin(adapter, profile, dataPrompt, ctx);
          return;
        }

        autoVerifyReason = autoResult.reason || null;
        console.log(`[SmartApply] Email verification automation failed: ${autoResult.reason || 'unknown reason'}`);
      } else if (!ctx?.emailVerification) {
        autoVerifyReason = 'missing_connection';
      }

      const solvedByAgent = await this.trySolveVerificationWithInboxContextRetries(
        adapter,
        ctx,
        email,
        profile,
        VERIFICATION_AGENT_MAX_ATTEMPTS,
      );
      if (solvedByAgent) {
        console.log('[SmartApply] Email verification solved by MagnitudeHand with inbox context. Retrying sign-in once...');
        (profile as any)._postVerificationLoginRetryAttempted = true;

        const switchedToSignIn = await this.clickPlatformSpecificSignIn(
          adapter,
          await adapter.getCurrentUrl(),
        );
        if (switchedToSignIn) {
          await adapter.page.waitForTimeout(1200);
        }

        await this.waitForPageLoad(adapter);
        await this.handleGenericLogin(adapter, profile, dataPrompt, ctx);
        return;
      }

      if (ctx?.waitForManualAction) {
        console.log('[SmartApply] Email verification required — pausing for human action...');
        const pauseType = autoVerifyReason === 'missing_connection'
          ? 'connect_gmail_required'
          : 'email_verification';
        const pauseDescription = autoVerifyReason === 'missing_connection'
          ? `No Gmail connection found for this user. Target login email: ${email || '(unknown)'}. Connect Gmail, complete verification/sign-in, then click Resume.`
          : 'Please verify your email and sign in manually, then click Resume.';
        await this.emitAuthEvent(ctx, 'email_verification_fallback_human', {
          reason: alreadyRetriedAfterAutoVerification ? 'post_auto_retry_still_blocked' : 'auto_verification_unavailable_or_failed',
          auto_verification_reason: autoVerifyReason,
          login_email_attempted: email || null,
        });
        const hitlResult = await ctx.waitForManualAction({
          type: pauseType,
          description: pauseDescription,
          timeoutSeconds: 600,
          metadata: {
            source: 'smart_apply',
            auto_verification_attempted: Boolean(ctx.emailVerification),
            post_auto_retry_attempted: alreadyRetriedAfterAutoVerification,
            auto_verification_reason: autoVerifyReason,
            login_email_attempted: email || null,
            verification_agent_attempts: Number((profile as any)._verificationAgentAttempts || 0),
          },
        });
        if (!hitlResult.resumed) {
          throw new Error('Email verification timed out — user did not respond within 10 minutes.');
        }
        console.log('[SmartApply] Resumed after email verification — continuing page loop.');
        return; // return from handleGenericLogin → page loop re-detects the page
      }
      throw new Error('Email verification required. Please check your email, click the verification link, then sign in manually.');
    }

    // Sign-in form: DOM-fill email + password, then MagnitudeHand clicks the button
    if (formState.hasEmail || formState.hasPassword) {
      console.log('[SmartApply] On sign-in form — filling credentials...');

      // DOM-fill email (keeps credentials out of LLM prompts)
      if (formState.hasEmail) {
        await adapter.page.evaluate((e: string) => {
          const sels = [
            'input[type="email"]', 'input[autocomplete="email"]',
            'input[name*="email" i]', 'input[name*="user" i]',
            'input[id*="email" i]', 'input[id*="user" i]',
          ];
          for (const sel of sels) {
            const input = document.querySelector<HTMLInputElement>(sel + ':not([disabled])');
            if (input && input.getBoundingClientRect().width > 0) {
              input.focus();
              input.value = e;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }, email);
      }

      // DOM-fill password
      if (formState.hasPassword && password) {
        await adapter.page.evaluate((p: string) => {
          const input = document.querySelector<HTMLInputElement>('input[type="password"]:not([disabled])');
          if (input && input.getBoundingClientRect().width > 0) {
            input.focus();
            input.value = p;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, password);
      }

      await adapter.page.waitForTimeout(300);

      // MagnitudeHand handles the rest — button clicks, checkboxes, etc.
      // Wrap in try-catch because MagnitudeHand may report ✕ fail if it sees an error on the page
      try {
        await adapter.act(
          'The email and password fields are already filled. ' +
          'Check any required checkboxes (like "Remember me"), then click the "Sign In", "Log In", or "Continue" button. ' +
          'Click ONLY ONE button, then report done.',
        );
      } catch (signInErr) {
        console.log(`[SmartApply] MagnitudeHand sign-in failed: ${signInErr instanceof Error ? signInErr.message : String(signInErr)}`);
        // Fall through to login error check below
      }

      await adapter.page.waitForTimeout(2000);
      await this.waitForPageLoad(adapter);

      const verificationVisibleAfterSubmit = await this.isVerificationChallengeVisible(adapter);
      if (verificationVisibleAfterSubmit) {
        console.log('[SmartApply] Sign-in advanced to verification challenge — switching to verification handling.');
        await this.handleVerificationCode(adapter, profile, ctx);
        return;
      }

      // Check for login errors
      const loginError = await adapter.page.evaluate(() => {
        const patterns = ['incorrect', 'invalid', 'wrong', 'not found', "doesn't exist", 'does not exist',
          'failed', 'try again', 'not recognized', 'no account', 'unable to sign', 'locked'];
        const alertEls = document.querySelectorAll(
          '[role="alert"], .error, .alert-error, .alert-danger, ' +
          '[class*="error-msg"], [class*="error-message"], [class*="errorMessage"]'
        );
        for (const el of alertEls) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (el.textContent || '').trim().toLowerCase();
          if (text && patterns.some(p => text.includes(p))) return text.substring(0, 200);
        }
        return null;
      });

      if (loginError) {
        const alreadyTriedAccountPath = Boolean(
          (profile as any)._createAccountAttempted || (profile as any)._accountCreationCompleted
        );

        // First failure: route to create-account path.
        // Subsequent failure after create-account path: pause for manual action.
        if (alreadyTriedAccountPath) {
          console.log(`[SmartApply] Login failed after account-creation attempt: "${loginError}" — pausing for human action...`);
          const resumed = await this.pauseForManualAuth(
            ctx,
            'account_locked',
            `Login still failing after account-creation flow (${loginError}). Please sign in manually (or recover account) and click Resume.`,
          );
          if (resumed) {
            console.log('[SmartApply] Resumed after manual sign-in — continuing page loop.');
            return;
          }
          throw new Error(`Login failed after account-creation attempt: ${loginError}`);
        }

        console.log(`[SmartApply] Login failed: "${loginError}" — moving to account creation path...`);
        try {
          (profile as any)._createAccountAttempted = true;
          const clickedCreate = await this.clickPlatformSpecificCreateAccount(
            adapter,
            await adapter.getCurrentUrl(),
          );
          if (!clickedCreate) {
            await adapter.act(
              'The login failed. Look for a "Create Account", "Sign Up", "Register", or "Don\'t have an account?" link and click it. Click ONLY ONE link.',
            );
          }
          await this.waitForPageLoad(adapter);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const resumed = await this.pauseForManualAuth(
            ctx,
            'account_creation_failed',
            `Could not transition to account creation after login failure (${errMsg}). Please create/sign in manually, then click Resume.`,
          );
          if (resumed) return;
          throw err;
        }
      }
      return;
    }

    // Step 3: No form fields visible — let MagnitudeHand find the sign-in option
    await adapter.act(
      'This is a login page. Follow this order strictly: ' +
      '(1) If "Sign in with Google" or "Continue with Google" exists, click that first. ' +
      '(2) Otherwise click a platform Sign In / Log In option (NOT Create Account). ' +
      '(3) Only if there is truly no sign-in option, click a Create Account / Sign Up link. ' +
      'Click ONLY ONE button, then report done.',
    );
    await this.waitForPageLoad(adapter);
  }

  private async handleVerificationCode(
    adapter: BrowserAutomationAdapter,
    profile: Record<string, any>,
    ctx?: TaskContext,
  ): Promise<void> {
    const loginEmail = process.env.TEST_GMAIL_EMAIL || profile.email || '';
    let autoVerifyReason: string | null = null;

    if (ctx?.emailVerification) {
      console.log('[SmartApply] Verification code page detected — attempting automatic inbox verification...');
      const autoResult = await ctx.emailVerification.tryAutoVerify({
        adapter,
        loginEmail,
        pageUrl: await adapter.getCurrentUrl().catch(() => ''),
        onEvent: async (eventType, metadata) => {
          await this.emitAuthEvent(ctx, eventType, metadata);
        },
      });
      if (autoResult.success) {
        await this.waitForPageLoad(adapter);
        await adapter.page.waitForTimeout(1000);
        const stillBlockedAfterAuto = await this.isVerificationChallengeVisible(adapter);
        if (!stillBlockedAfterAuto) {
          return;
        }
        autoVerifyReason = 'verification_still_visible_after_auto';
        console.log('[SmartApply] Auto verification submitted, but verification challenge is still visible. Falling back to inbox-context agent/manual path.');
      } else {
        autoVerifyReason = autoResult.reason || null;
        console.log(`[SmartApply] Auto verification attempt failed: ${autoResult.reason || 'unknown reason'}`);
      }
    } else {
      autoVerifyReason = 'missing_connection';
    }

    const solvedByAgent = await this.trySolveVerificationWithInboxContextRetries(
      adapter,
      ctx,
      loginEmail,
      profile,
      VERIFICATION_AGENT_MAX_ATTEMPTS,
    );
    if (solvedByAgent) {
      return;
    }

    const resumed = await this.pauseForManualAuth(
      ctx,
      autoVerifyReason === 'missing_connection' ? 'connect_gmail_required' : 'verification_code_required',
      autoVerifyReason === 'missing_connection'
        ? `No Gmail connection found for this user. Target login email: ${loginEmail || '(unknown)'}. Connect Gmail, enter the verification code manually, then click Resume.`
        : 'Verification code required. Enter the received code manually, then click Resume.',
      600,
      {
        source: 'smart_apply',
        auto_verification_attempted: Boolean(ctx?.emailVerification),
        auto_verification_reason: autoVerifyReason,
        login_email_attempted: loginEmail || null,
        verification_agent_attempts: Number((profile as any)._verificationAgentAttempts || 0),
      },
    );
    if (!resumed) {
      throw new Error('Verification code required and no manual resolution was provided.');
    }
  }

  private async trySolveVerificationWithInboxContextRetries(
    adapter: BrowserAutomationAdapter,
    ctx: TaskContext | undefined,
    loginEmail: string,
    profile: Record<string, any>,
    maxAttempts = VERIFICATION_AGENT_MAX_ATTEMPTS,
  ): Promise<boolean> {
    const attemptsUsed = Math.max(0, Number((profile as any)._verificationAgentAttempts || 0));
    if (attemptsUsed >= maxAttempts) {
      return false;
    }

    if (!ctx?.emailVerification?.getRecentInboxMessages) {
      await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
        reason: 'email_service_unavailable',
      });
      (profile as any)._verificationAgentAttempts = maxAttempts;
      return false;
    }

    for (let attempt = attemptsUsed + 1; attempt <= maxAttempts; attempt++) {
      (profile as any)._verificationAgentAttempts = attempt;
      await this.emitAuthEvent(ctx, 'email_verification_agent_attempted', {
        attempt,
        max_attempts: maxAttempts,
      });

      const solved = await this.trySolveVerificationWithInboxContext(adapter, ctx, loginEmail);
      if (solved) {
        (profile as any)._verificationAgentAttempts = 0;
        return true;
      }

      if (attempt < maxAttempts) {
        await adapter.page.waitForTimeout(VERIFICATION_AGENT_RETRY_DELAY_MS);
      }
    }

    return false;
  }

  private async trySolveVerificationWithInboxContext(
    adapter: BrowserAutomationAdapter,
    ctx: TaskContext | undefined,
    loginEmail: string,
  ): Promise<boolean> {
    if (!ctx?.emailVerification?.getRecentInboxMessages) {
      return false;
    }

    let recentEmails: RecentInboxMessage[] = [];
    try {
      recentEmails = await ctx.emailVerification.getRecentInboxMessages({
        limit: VERIFICATION_EMAIL_CONTEXT_LIMIT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[SmartApply] Failed to fetch recent inbox context: ${message}`);
      await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
        reason: 'email_context_fetch_failed',
        error: message,
      });
      return false;
    }

    if (recentEmails.length === 0) {
      await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
        reason: 'no_recent_emails',
      });
      return false;
    }

    const deterministicLink = this.findVerificationLinkInEmails(recentEmails);
    if (deterministicLink) {
      console.log('[SmartApply] Verification page: opening verification link from recent inbox context...');
      try {
        await this.openVerificationLinkFromInbox(adapter, deterministicLink);
        await this.waitForPageLoad(adapter);
        await adapter.page.waitForTimeout(1000);

        const stillBlockedAfterLink = await this.isVerificationChallengeVisible(adapter);
        if (!stillBlockedAfterLink) {
          await this.emitAuthEvent(ctx, 'email_verification_agent_context_succeeded', {
            method: 'link',
            email_count: recentEmails.length,
          });
          return true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SmartApply] Opening verification link from inbox context failed: ${message}`);
        await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
          reason: 'link_open_failed',
          error: message,
        });
      }
    }

    const prompt = this.buildVerificationContextPrompt(loginEmail, recentEmails);
    await this.emitAuthEvent(ctx, 'email_verification_agent_context_loaded', {
      email_count: recentEmails.length,
      newest_received_at: recentEmails[0]?.receivedAt || null,
    });

    console.log(`[SmartApply] Verification page: invoking MagnitudeHand with ${recentEmails.length} recent email(s) as context...`);
    try {
      await this.throttleLlm(adapter);
      const result = await adapter.act(prompt, { timeoutMs: 60_000 });
      if (!result.success) {
        console.warn(`[SmartApply] Inbox-context verification attempt failed: ${result.message}`);
        await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
          reason: 'agent_action_failed',
          message: result.message,
        });
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[SmartApply] Inbox-context verification attempt errored: ${message}`);
      await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
        reason: 'agent_action_error',
        error: message,
      });
      return false;
    }

    await this.waitForPageLoad(adapter);
    await adapter.page.waitForTimeout(1000);

    const stillBlocked = await this.isVerificationChallengeVisible(adapter);
    if (stillBlocked) {
      await this.emitAuthEvent(ctx, 'email_verification_agent_context_failed', {
        reason: 'verification_still_visible',
      });
      return false;
    }

    await this.emitAuthEvent(ctx, 'email_verification_agent_context_succeeded', {
      email_count: recentEmails.length,
    });
    return true;
  }

  private buildVerificationContextPrompt(
    loginEmail: string,
    recentEmails: RecentInboxMessage[],
  ): string {
    const ordered = this.sortRecentEmailsByReceivedAt(recentEmails).slice(0, VERIFICATION_EMAIL_CONTEXT_LIMIT);
    const context = ordered.map((email, index) => {
      const bodyText = (email.bodyText || email.snippet || '').trim();
      const clipped = bodyText.length > VERIFICATION_EMAIL_CONTEXT_BODY_MAX_CHARS
        ? `${bodyText.slice(0, VERIFICATION_EMAIL_CONTEXT_BODY_MAX_CHARS)}\n[truncated]`
        : bodyText || '(no body text)';

      return [
        `EMAIL ${index + 1} (newest=${index === 0 ? 'yes' : 'no'})`,
        `received_at: ${email.receivedAt || 'unknown'}`,
        `from: ${email.from || 'unknown'}`,
        `subject: ${email.subject || '(no subject)'}`,
        `message_id: ${email.messageId || 'unknown'}`,
        'body:',
        clipped,
      ].join('\n');
    }).join('\n\n');

    return [
      'You are on an account/email verification step.',
      'Goal: complete verification and continue the flow.',
      'Use ONLY the inbox context below (newest email first).',
      'If a recent email contains a verification code, enter the most likely code.',
      'If a recent email contains a verification link, click/open that link.',
      'If multiple candidates exist, prefer the most recent matching verification email.',
      'After completing the best verification action, click Verify/Continue/Next once.',
      'Do not edit account credentials. Do not perform unrelated navigation.',
      `Target site login email: ${loginEmail || '(unknown)'}`,
      '',
      'RECENT INBOX CONTEXT (ordered by received time, newest first):',
      context,
      '',
      'Stop when verification is completed or no reliable action can be taken.',
    ].join('\n');
  }

  private sortRecentEmailsByReceivedAt(emails: RecentInboxMessage[]): RecentInboxMessage[] {
    return [...emails]
      .map((email, index) => ({ email, index }))
      .sort((a, b) => {
        const aTime = Date.parse(a.email.receivedAt || '');
        const bTime = Date.parse(b.email.receivedAt || '');
        const aValid = Number.isFinite(aTime);
        const bValid = Number.isFinite(bTime);
        if (aValid && bValid) return bTime - aTime;
        if (aValid) return -1;
        if (bValid) return 1;
        return a.index - b.index;
      })
      .map((entry) => entry.email);
  }

  private findVerificationLinkInEmails(emails: RecentInboxMessage[]): string | null {
    const ordered = this.sortRecentEmailsByReceivedAt(emails);
    const preferredPattern = /verify|verification|confirm|activate|magic|token|signin|sign-in|account/i;

    let fallback: string | null = null;
    for (const email of ordered) {
      const text = `${email.bodyText || ''}\n${email.snippet || ''}`;
      const matches = text.match(/https?:\/\/[^\s<>")]+/gi) || [];
      if (matches.length === 0) continue;

      const preferred = matches.find((url) => preferredPattern.test(url));
      if (preferred) return preferred;
      if (!fallback) fallback = matches[0] || null;
    }

    return fallback;
  }

  private async openVerificationLinkFromInbox(
    adapter: BrowserAutomationAdapter,
    link: string,
  ): Promise<void> {
    const originalPage = adapter.page;
    const verificationPage = await originalPage.context().newPage();
    try {
      await verificationPage.goto(link, { waitUntil: 'domcontentloaded' });
      await verificationPage.waitForTimeout(3000);
      await verificationPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    } finally {
      try {
        await verificationPage.close();
      } catch {
        // Ignore close errors.
      }
      await originalPage.bringToFront().catch(() => {});
    }

    await originalPage.waitForTimeout(500);
  }

  private async isVerificationChallengeVisible(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate((verificationSelectorQuery: string) => {
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!el) return false;
        const node = el as HTMLElement;
        if (node.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const text = document.body.innerText.toLowerCase();
      const keywordMatch =
        text.includes('enter verification code') ||
        text.includes('enter the code') ||
        text.includes('enter code') ||
        text.includes('security code') ||
        text.includes('one-time') ||
        text.includes('otp') ||
        text.includes('verify your email') ||
        text.includes('check your email');

      const hasVisiblePasswordInput = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[type="password"]:not([disabled])',
      )).some((input) => isVisible(input));

      const hasLikelyCodeInput = Array.from(document.querySelectorAll<HTMLInputElement>(
        verificationSelectorQuery,
      )).some((input) => isVisible(input) && !input.disabled);

      // Prefer concrete UI signals. Generic instructional text alone is not enough.
      if (hasLikelyCodeInput) return true;
      if (hasVisiblePasswordInput) return false;

      return keywordMatch;
    }, VERIFICATION_INPUT_SELECTOR_QUERY);
  }

  private async handlePhone2FA(adapter: BrowserAutomationAdapter): Promise<void> {
    const currentUrl = await adapter.getCurrentUrl();

    let challengeDesc: string;
    if (currentUrl.includes('recaptcha')) {
      challengeDesc = 'Captcha challenge requires human intervention';
    } else if (currentUrl.includes('ipp') || currentUrl.includes('/challenge/')) {
      challengeDesc = '2FA phone verification requires human intervention';
    } else {
      challengeDesc = '2FA security challenge requires human intervention';
    }

    console.log(`[SmartApply] ${challengeDesc} at ${currentUrl}`);
    throw new Error(challengeDesc);
  }

  private async handleAccountCreation(
    adapter: BrowserAutomationAdapter,
    dataPrompt: string,
    profile: Record<string, any>,
  ): Promise<void> {
    console.log('[SmartApply] Account creation page detected, filling in details...');

    const currentUrl = adapter.page.url();
    const platform = inferCredentialPlatformFromUrl(currentUrl);
    const email = resolvePlatformAccountEmail(profile, platform);
    const initialValidationText = await this.readAccountCreationValidationText(adapter);
    let passwordResolution = resolvePlatformAccountPassword(profile, platform);
    let password = passwordResolution.password;

    if (
      platform === 'workday' &&
      email &&
      passwordResolution.source !== 'platform_override'
    ) {
      const generated = generatePlatformCredential(profile, platform, email, {
        validationText: initialValidationText,
        sourceUrl: currentUrl,
      });
      this.rememberGeneratedPlatformCredential(profile, generated.credential, generated.event);
      passwordResolution = {
        password: generated.credential.secret,
        source: generated.credential.source,
      };
      password = generated.credential.secret;
      console.log(
        `[SmartApply] Generated ${platform} account password for ${email} ` +
        `(${generated.credential.requirements.join(', ')})`,
      );
    }

    console.log(
      `[SmartApply] Account credentials resolved for ${platform ?? 'generic'}: ` +
      `email=${email ? 'present' : 'missing'}, passwordSource=${passwordResolution.source}`,
    );

    // ── DOM-first: fill everything without LLM (cost: $0) ──

    await this.fillAccountCreationCredentials(adapter, email, password);
    const submitted = await this.submitAccountCreationDom(adapter);

    if (submitted) {
      console.log('[SmartApply] DOM submitted account creation form.');
      await adapter.page.waitForTimeout(3000);
      await this.waitForPageLoad(adapter);

      let stillOnCreateAccount = await this.isStillOnAccountCreationPage(adapter);

      if (stillOnCreateAccount && passwordResolution.source !== 'platform_override') {
        const validationText = await this.readAccountCreationValidationText(adapter);
        if (validationText) {
          const strengthened =
            platform === 'workday' && email
              ? (() => {
                  const generated = generatePlatformCredential(profile, platform, email, {
                    validationText,
                    sourceUrl: currentUrl,
                  });
                  this.rememberGeneratedPlatformCredential(profile, generated.credential, generated.event);
                  return {
                    password: generated.credential.secret,
                    source: generated.credential.source,
                  };
                })()
              : resolvePlatformAccountPassword(profile, platform, {
                  validationText,
                });
          if (strengthened.password !== password) {
            passwordResolution = strengthened;
            password = strengthened.password;
            console.log(
              `[SmartApply] Retrying account creation with strengthened password ` +
              `(source=${strengthened.source}) after validation hint: ${validationText.slice(0, 180)}`,
            );
            await this.fillAccountCreationCredentials(adapter, email, password);
            const retried = await this.submitAccountCreationDom(adapter);
            if (retried) {
              await adapter.page.waitForTimeout(3000);
              await this.waitForPageLoad(adapter);
              stillOnCreateAccount = await this.isStillOnAccountCreationPage(adapter);
            }
          }
        }
      }

      if (!stillOnCreateAccount) {
        console.log('[SmartApply] Account creation succeeded (DOM-only).');
        return;
      }
      console.log('[SmartApply] Still on account creation page after DOM submit — falling back to MagnitudeHand...');
    } else {
      console.log('[SmartApply] DOM could not find submit button — falling back to MagnitudeHand...');
    }

    // ── Fallback: MagnitudeHand for anything DOM couldn't handle ──
    // This handles custom checkboxes, complex UI, or non-standard buttons.
    const result = await adapter.act(
      `Complete this account creation form and submit it.

The email and password fields are already filled — do NOT clear or retype them.

STEPS:
1. Check ALL unchecked checkboxes — privacy policy, terms of service, consent, etc.
2. Click the "Create Account", "Register", or "Submit" button.

IMPORTANT: Do NOT select, clear, or retype any already-filled fields.`,
    );

    if (!result.success) {
      const hasPasswordField = await adapter.page.evaluate(() =>
        document.querySelectorAll('input[type="password"]').length > 0
      );
      if (!hasPasswordField) {
        console.log('[SmartApply] act() reported failure but page has moved past account creation — continuing.');
        return;
      }
      throw new Error(`Failed to create account: ${result.message}`);
    }

    await this.waitForPageLoad(adapter);
  }

  private async fillAccountCreationCredentials(
    adapter: BrowserAutomationAdapter,
    email: string,
    password: string,
  ): Promise<void> {
    await adapter.page.evaluate((e: string) => {
      const sels = [
        'input[type="email"]', 'input[autocomplete="email"]',
        'input[data-automation-id*="email" i]',
        'input[name*="email" i]', 'input[id*="email" i]',
      ];
      for (const sel of sels) {
        const input = document.querySelector<HTMLInputElement>(sel + ':not([disabled])');
        if (input && input.getBoundingClientRect().width > 0 && !input.value?.trim()) {
          input.focus();
          input.value = e;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, email);

    await adapter.page.evaluate((pw: string) => {
      const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]:not([disabled])');
      for (const input of inputs) {
        if (input.getBoundingClientRect().width > 0) {
          input.focus();
          input.value = pw;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, password);

    await adapter.page.waitForTimeout(300);
  }

  private async submitAccountCreationDom(adapter: BrowserAutomationAdapter): Promise<boolean> {
    await adapter.page.evaluate(() => {
      const containers = document.querySelectorAll(
        '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], ' +
        '[class*="Dialog"], [data-automation-id*="dialog"], [data-automation-id*="panel"], ' +
        'form, [class*="scroll"], [class*="Scroll"]',
      );
      for (const container of containers) {
        const el = container as HTMLElement;
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    });

    await adapter.page.waitForTimeout(500);

    const checkedCount = await adapter.page.evaluate(() => {
      let count = 0;
      const htmlCheckboxes = document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:not(:checked):not([disabled])',
      );
      for (const cb of htmlCheckboxes) {
        cb.click();
        count++;
      }

      const ariaCheckboxes = document.querySelectorAll<HTMLElement>(
        '[role="checkbox"][aria-checked="false"]:not([aria-disabled="true"])',
      );
      for (const cb of ariaCheckboxes) {
        cb.click();
        count++;
      }

      return count;
    });
    console.log(`[SmartApply] DOM checked ${checkedCount} checkbox(es)`);

    await adapter.page.waitForTimeout(300);

    return adapter.page.evaluate(() => {
      const TEXTS = ['create account', 'register', 'sign up', 'continue', 'next', 'submit'];
      const btns = document.querySelectorAll<HTMLElement>(
        'button, input[type="submit"], [role="button"]',
      );
      for (const btn of btns) {
        const text = (btn.textContent || (btn as HTMLInputElement).value || '').trim().toLowerCase();
        if (TEXTS.some((t) => text === t || (text.length < 30 && text.includes(t)))) {
          btn.click();
          return true;
        }
      }

      const form = document.querySelector('form');
      if (form) {
        form.requestSubmit();
        return true;
      }
      return false;
    });
  }

  private async isStillOnAccountCreationPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() =>
      document.querySelectorAll('input[type="password"]:not([disabled])').length > 1,
    );
  }

  private async readAccountCreationValidationText(adapter: BrowserAutomationAdapter): Promise<string> {
    return adapter.page.evaluate(() => {
      const selectors = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '[data-automation-id*="error" i]',
        '[class*="error"]',
        '[class*="Error"]',
        '[class*="validation"]',
      ];
      const messages = new Set<string>();
      for (const selector of selectors) {
        const elements = document.querySelectorAll<HTMLElement>(selector);
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) messages.add(text);
        }
      }
      return [...messages].join(' | ').slice(0, 500);
    });
  }

  // =========================================================================
  // Fill + Scroll Loop
  // =========================================================================

  /**
   * Fill the current page using the proven formFiller approach:
   *   1. formFiller: extract fields, LLM answers, DOM fill, MagnitudeHand fallback
   *   2. ADVANCE:   Click Next or detect review page.
   */
  private async fillPage(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    resumePath?: string | null,
    profileText?: string,
    _depth = 0,
    forceEscalate = false,
    costTracker?: CostTracker,
    progress?: TaskContext['progress'],
    pageContext?: PageContextService,
    llmClientConfig?: TaskContext['llmClientConfig'],
  ): Promise<'navigated' | 'review' | 'complete'> {
    const MAX_DEPTH = 3;

    if (_depth >= MAX_DEPTH) {
      console.warn(`[SmartApply] Hit max fill depth (${MAX_DEPTH}) — giving up on validation errors.`);
      return 'complete';
    }

    // Safety: check if this is actually the review page (misclassified)
    if (await this.checkIfReviewPage(adapter)) {
      console.log(`[SmartApply] SAFETY: This is the review page — skipping all fill logic.`);
      return 'review';
    }

    // ── FILL PHASE: Use formFiller (DOM fill + MagnitudeHand fallback) ──
    // Escalate to MagnitudeHand when:
    //   - _depth > 0: validation errors bounced us back (DOM values wrong)
    //   - forceEscalate: stuck on same page too many times (DOM can't advance)
    if (profileText) {
      const escalate = _depth > 0 || forceEscalate;
      if (escalate) console.log(`[SmartApply] Escalating to MagnitudeHand (${forceEscalate ? 'stuck escalation' : `retry ${_depth}/${MAX_DEPTH}`})`);
      const fillResult = await fillFormOnPage(adapter.page, adapter, profileText, resumePath, {
        forceMagnitude: escalate,
        anthropicClientConfig: llmClientConfig?.anthropic,
        onVisualFillStart: progress
          ? () => progress.setStatusMessage?.('Attempting visual form fill...')
          : undefined,
        observers: pageContext
          ? {
              onQuestionsNormalized: async (questions, opts) => pageContext.syncQuestions(questions, opts),
              onAnswerPlanned: async (decisions) => pageContext.recordAnswerPlan(decisions),
              onFieldAttempt: async (questionKey, actor, notes) =>
                pageContext.recordFieldAttempt(questionKey, actor, notes),
              onFieldResult: async (outcome) => pageContext.recordFieldResult(outcome),
              onVerification: async (outcome) => pageContext.recordFieldResult(outcome),
            }
          : undefined,
      });
      console.log(`[SmartApply] formFiller: ${fillResult.domFilled} DOM + ${fillResult.magnitudeFilled} Magnitude filled (${fillResult.llmCalls} LLM calls)`);
      // Expose fill counts for the main loop's zero-field detection
      this._lastFillTotalFields = fillResult.totalFields;
      this._lastFillDomFilled = fillResult.domFilled;
      this._lastFillMagnitudeFilled = fillResult.magnitudeFilled;

      // Record formFiller LLM token usage in cost tracker.
      // formFiller uses claude-haiku-4-5 directly — compute cost from known pricing.
      // Haiku: $1.00/M input, $5.00/M output (see models.config.json "claude-haiku")
      if (costTracker && (fillResult.inputTokens > 0 || fillResult.outputTokens > 0)) {
        costTracker.recordTokenUsage({
          inputTokens: fillResult.inputTokens,
          outputTokens: fillResult.outputTokens,
          inputCost: fillResult.inputTokens * (1.00 / 1_000_000),
          outputCost: fillResult.outputTokens * (5.00 / 1_000_000),
        });
      }
    }

    const audit = await pageContext?.auditBeforeAdvance();
    if (audit?.blockNavigation) {
      console.log(`[SmartApply] Page audit blocked advance: ${audit.summary}`);
      if (_depth + 1 < MAX_DEPTH) {
        return this.fillPage(
          adapter,
          config,
          null,
          profileText,
          _depth + 1,
          true,
          costTracker,
          progress,
          pageContext,
          llmClientConfig,
        );
      }

      await pageContext?.finalizeActivePage({ status: 'blocked' });
      console.warn('[SmartApply] Required questions remain unresolved after retry budget; leaving page for manual recovery.');
      return 'complete';
    }

    // ── ADVANCE PHASE: Click Next or detect review page ──

    // Wait for any in-flight Magnitude act() to fully settle before navigating.
    // Without this, a timed-out act() keeps running in the background and can
    // take rogue actions (e.g. clicking "Back") on the next page.
    if (adapter.waitForActSettle) {
      const settled = await adapter.waitForActSettle(10_000);
      if (!settled) {
        console.warn('[SmartApply] In-flight act() did not settle within 10s — proceeding anyway.');
      }
    }

    // Clean up any data-ff-id attributes (formFiller tags elements)
    // and also clean up legacy scan attributes
    await adapter.page.evaluate(() => {
      document.querySelectorAll('[data-gh-scan-idx]').forEach(el => el.removeAttribute('data-gh-scan-idx'));
    });

    // Scroll to bottom to find Next button
    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(500);

    const urlBeforeClick = await adapter.getCurrentUrl();
    const fingerprintBeforeClick = await this.getPageFingerprint(adapter);
    const scrollBeforeClick = await adapter.page.evaluate(() => window.scrollY);

    const clickResult = await config.clickNextButton(adapter);
    if (clickResult === 'clicked') {
      console.log(`[SmartApply] Clicked Next via DOM.`);
      await adapter.page.waitForTimeout(2000);

      // Check for validation errors
      const hasErrors = await config.detectValidationErrors(adapter);
      if (hasErrors) {
        console.log(`[SmartApply] Validation errors after clicking Next — re-filling.`);
        // Pass null for resumePath on retries — resume was already uploaded on first attempt.
        // Workday replaces the file input after processing, creating a fresh one for "add another file",
        // so re-passing resumePath would cause a duplicate upload.
        return this.fillPage(
          adapter,
          config,
          null,
          profileText,
          _depth + 1,
          false,
          costTracker,
          progress,
          pageContext,
          llmClientConfig,
        );
      }

      // Verify page changed
      const urlAfterClick = await adapter.getCurrentUrl();
      const fingerprintAfterClick = await this.getPageFingerprint(adapter);
      if (urlAfterClick !== urlBeforeClick || fingerprintAfterClick !== fingerprintBeforeClick) {
        await pageContext?.finalizeActivePage();
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }

      // SPA delayed rendering — wait and check again
      await adapter.page.waitForTimeout(2000);
      const urlAfterWait = await adapter.getCurrentUrl();
      const fingerprintAfterWait = await this.getPageFingerprint(adapter);
      if (urlAfterWait !== urlBeforeClick || fingerprintAfterWait !== fingerprintBeforeClick) {
        await pageContext?.finalizeActivePage();
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }

      // Check if site auto-scrolled (validation errors without error markers)
      const scrollAfterClick = await adapter.page.evaluate(() => window.scrollY);
      if (Math.abs(scrollAfterClick - scrollBeforeClick) > 50) {
        console.log(`[SmartApply] Clicked Next — page auto-scrolled to unfilled fields. Re-filling.`);
        return this.fillPage(
          adapter,
          config,
          null,
          profileText,
          _depth + 1,
          false,
          costTracker,
          progress,
          pageContext,
          llmClientConfig,
        );
      }

      console.log(`[SmartApply] Clicked Next but page unchanged.`);
    }

    if (clickResult === 'review_detected') {
      console.log(`[SmartApply] Review page detected — not clicking Submit.`);
      await pageContext?.markAwaitingReview();
      return 'review';
    }

    if (clickResult === 'not_found') {
      // Scroll to content bottom and try once more
      const scrollMax = await this.getContentScrollMax(adapter);
      await adapter.page.evaluate((target: number) =>
        window.scrollTo({ top: target, behavior: 'smooth' }),
      scrollMax);
      await adapter.page.waitForTimeout(800);

      const finalClick = await config.clickNextButton(adapter);
      if (finalClick === 'clicked') {
        console.log(`[SmartApply] Clicked Next at content bottom.`);
        await adapter.page.waitForTimeout(2000);
        await pageContext?.finalizeActivePage();
        await this.waitForPageLoad(adapter);
        return 'navigated';
      }
      if (finalClick === 'review_detected') {
        console.log(`[SmartApply] Review page detected at content bottom.`);
        await pageContext?.markAwaitingReview();
        return 'review';
      }
    }

    // Fallback review detection
    const hasSubmitFallback = await adapter.page.evaluate(() => {
      const roots: ParentNode[] = [document];
      const seenShadowRoots = new Set<ShadowRoot>();
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
        for (const element of elements) {
          const shadowRoot = element.shadowRoot;
          if (shadowRoot && !seenShadowRoots.has(shadowRoot)) {
            seenShadowRoots.add(shadowRoot);
            roots.push(shadowRoot);
          }
        }
      }

      for (const root of roots) {
        const clickables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [role="button"], [role="link"], input[type="submit"], input[type="button"], a[href], a.btn, a[class*="btn"], a[class*="button"]',
          ),
        );
        for (const clickable of clickables) {
          const rect = clickable.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const text = (
            clickable.textContent ||
            clickable.getAttribute('value') ||
            clickable.getAttribute('aria-label') ||
            clickable.getAttribute('title') ||
            ''
          )
            .trim()
            .toLowerCase();
          if (text.includes('submit') || text === 'send application' || text.includes('review')) {
            return true;
          }
        }
      }

      return false;
    });
    if (hasSubmitFallback) {
      const domReview = await this.checkIfReviewPage(adapter);
      const verifiedReview = domReview ? true : await this.verifyReviewPage(adapter);
      if (verifiedReview) {
        console.log(`[SmartApply] Submit button present and review verified — stopping before submit.`);
        await pageContext?.markAwaitingReview();
        return 'review';
      }
      // Single-page forms (e.g. Greenhouse) have Submit on the same page as the
      // form fields — LLM verification will say "not a review page" because fields
      // are still interactive. If we already filled everything, stop and let the
      // user review rather than looping infinitely.
      console.log('[SmartApply] Submit button present on form page — stopping for user review.');
      await pageContext?.markAwaitingReview();
      return 'review';
    }

    console.log(`[SmartApply] Page complete.`);
    return 'complete';
  }

  /**
   * Detect file upload inputs on the page and upload the resume via DOM.
   * Handles both visible <input type="file"> and button-triggered file dialogs.
   * Returns true if a resume was uploaded.
   */
  private async uploadResumeIfPresent(
    adapter: BrowserAutomationAdapter,
    resumePath: string,
  ): Promise<boolean> {
    // Check for file input anywhere on the page (not just viewport — they're often hidden)
    const hasFileInput = await adapter.page.evaluate(() => {
      return document.querySelectorAll('input[type="file"]').length > 0;
    });

    if (!hasFileInput) return false;

    try {
      const fileInput = adapter.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(resumePath);
      console.log(`[SmartApply] Resume uploaded via DOM file input: ${resumePath}`);
      await adapter.page.waitForTimeout(2000); // Wait for upload processing
      return true;
    } catch (err) {
      console.warn(`[SmartApply] DOM resume upload failed: ${err}. LLM will try clicking upload button.`);
      return false;
    }
  }

  /**
   * Quick live-scan of unfilled fields visible in the current viewport.
   * Unlike the full scanPageFields (which scrolls through the entire page),
   * this only checks what's on screen right now — used before each LLM call
   * so the prompt reflects the actual DOM state after conditional fields appear.
   */
  private async scanVisibleUnfilledFields(
    adapter: BrowserAutomationAdapter,
    _config: PlatformConfig,
    qaMap: Record<string, string>,
  ): Promise<ScannedField[]> {
    // Use the platform's collectVisibleFields via a single-viewport scan
    // by calling scanPageFields with the page already at the right scroll position.
    // But that scrolls around — instead, use hasEmptyVisibleFields as a quick gate,
    // then call the adapter's evaluate to get visible empty field data.
    const visibleEmpty = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const results: Array<{ label: string; kind: string; selector: string; isRequired: boolean; options: string[] }> = [];

      // Quick scan of visible empty form fields
      const allInputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([disabled]):not([readonly]), ' +
        'textarea:not([disabled]):not([readonly]), select:not([disabled])'
      );
      for (const el of allInputs) {
        if (el.value && el.value.trim() !== '') continue;
        if (el.tagName === 'SELECT' && (el as HTMLSelectElement).selectedIndex > 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 5 || rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (el.closest('nav, header, [role="navigation"]')) continue;

        let label = '';
        const htmlEl = el as HTMLInputElement;
        if ('labels' in htmlEl && htmlEl.labels?.length) label = (htmlEl.labels[0].textContent || '').trim();
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) label = el.getAttribute('placeholder') || '';
        if (!label && htmlEl.id) {
          const lbl = document.querySelector('label[for="' + CSS.escape(htmlEl.id) + '"]');
          if (lbl) label = (lbl.textContent || '').trim();
        }
        if (!label) {
          const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(el)) label = (lbl.textContent || '').trim();
          }
        }
        if (!label) label = htmlEl.name || htmlEl.id || '';
        label = label.substring(0, 120);

        const kind = el.tagName === 'SELECT' ? 'select' : 'text';
        const selector = el.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + el.getAttribute('data-gh-scan-idx') + '"]'
          : (el.id ? '#' + CSS.escape(el.id) : '');
        const options = el.tagName === 'SELECT'
          ? Array.from((el as HTMLSelectElement).options).filter(o => o.value && !o.disabled).map(o => o.text.trim()).filter(Boolean)
          : [];

        results.push({ label, kind, selector, isRequired: htmlEl.required || el.getAttribute('aria-required') === 'true', options });
      }

      // Also check custom dropdowns and ARIA radios in viewport
      const customEls = document.querySelectorAll(
        '[role="combobox"], [role="listbox"], [aria-haspopup], [role="radiogroup"], [role="radio"]'
      );
      for (const el of customEls) {
        if (el.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5 || rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;

        // Check if already filled
        const inputChild = el.querySelector('input') as HTMLInputElement | null;
        const hasValue = inputChild?.value?.trim();
        if (hasValue) continue;
        if (el.getAttribute('aria-checked') === 'true') continue;
        const role = el.getAttribute('role') || '';
        if (role === 'radiogroup') {
          const checked = el.querySelector('[role="radio"][aria-checked="true"]');
          if (checked) continue;
        }

        let label = '';
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const lbl = document.getElementById(labelledBy);
          if (lbl) label = (lbl.textContent || '').trim();
        }
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label) {
          const parent = el.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(el)) label = (lbl.textContent || '').trim();
          }
        }
        label = label.substring(0, 120);
        if (!label) continue;

        const isRadio = role === 'radiogroup' || role === 'radio';
        const kind = isRadio ? 'aria_radio' : 'custom_dropdown';
        const selector = el.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + el.getAttribute('data-gh-scan-idx') + '"]'
          : (el.id ? '#' + CSS.escape(el.id) : '');

        // Extract radio/dropdown options
        const options: string[] = [];
        if (isRadio) {
          const radios = (role === 'radiogroup' ? el : el.parentElement)?.querySelectorAll('[role="radio"]');
          if (radios) {
            for (const r of radios) {
              const t = r.getAttribute('aria-label') || (r.textContent || '').trim();
              if (t) options.push(t);
            }
          }
        }

        results.push({ label, kind, selector, isRequired: el.getAttribute('aria-required') === 'true', options });
      }

      // Also check Material Design / proprietary styled selects (arrow icon detection)
      const seenLabels = new Set(results.map(r => r.label.toLowerCase()));
      const arrowEls: Element[] = [];
      document.querySelectorAll('i, span').forEach(ael => {
        const t = (ael.textContent || '').trim();
        if (t === 'arrow_drop_down' || t === 'expand_more' || t === 'keyboard_arrow_down') {
          arrowEls.push(ael);
        }
      });
      for (const arrowEl of arrowEls) {
        let container: Element | null = arrowEl.parentElement;
        for (let up = 0; up < 5 && container; up++) {
          const cRect = container.getBoundingClientRect();
          if (cRect.width >= 80 && cRect.width <= 700 && cRect.height >= 20 && cRect.height <= 120) break;
          container = container.parentElement;
        }
        if (!container || container === document.body) continue;
        const cRect = container.getBoundingClientRect();
        if (cRect.width < 5 || cRect.height < 5 || cRect.bottom < 0 || cRect.top > vh) continue;
        const cSt = window.getComputedStyle(container);
        if (cSt.display === 'none' || cSt.visibility === 'hidden') continue;
        if (container.closest('nav, header, [role="navigation"], [role="menubar"], [role="menu"]')) continue;

        // Check if filled
        const mdInput = container.querySelector('input') as HTMLInputElement | null;
        if (mdInput?.value?.trim()) continue;

        // Extract label
        let mdLabel = container.getAttribute('aria-label') || '';
        if (!mdLabel) {
          const lblBy = container.getAttribute('aria-labelledby');
          if (lblBy) {
            const lblEl = document.getElementById(lblBy);
            if (lblEl) mdLabel = (lblEl.textContent || '').trim();
          }
        }
        if (!mdLabel) {
          const parent = container.closest('[class*="field"], [class*="form-group"], [class*="question"], fieldset');
          if (parent) {
            const lbl = parent.querySelector('label, legend, [class*="label"]');
            if (lbl && !lbl.contains(container)) mdLabel = (lbl.textContent || '').trim();
          }
        }
        if (!mdLabel) {
          // Try preceding sibling
          const prev = container.previousElementSibling;
          if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
            const t = (prev.textContent || '').trim();
            if (t.length < 80) mdLabel = t;
          }
        }
        mdLabel = mdLabel.substring(0, 120);
        if (!mdLabel) continue;
        if (seenLabels.has(mdLabel.toLowerCase())) continue;
        seenLabels.add(mdLabel.toLowerCase());

        const mdSelector = container.getAttribute('data-gh-scan-idx')
          ? '[data-gh-scan-idx="' + container.getAttribute('data-gh-scan-idx') + '"]'
          : (container.id ? '#' + CSS.escape(container.id) : '');

        results.push({
          label: mdLabel,
          kind: 'custom_dropdown',
          selector: mdSelector,
          isRequired: container.getAttribute('aria-required') === 'true' || (container.closest('[class*="required"]') !== null),
          options: [],
        });
      }

      return results;
    });

    // Deduplicate by label and match answers
    const seen = new Set<string>();
    const fields: ScannedField[] = [];
    for (const raw of visibleEmpty) {
      const key = raw.label + '|' + raw.kind;
      if (seen.has(key)) continue;
      seen.add(key);

      const answer = findBestAnswer(raw.label, qaMap);
      fields.push({
        id: 'visible-' + fields.length,
        kind: raw.kind as ScannedField['kind'],
        fillStrategy: raw.kind === 'text' || raw.kind === 'select' ? 'native_setter' : 'click_option',
        selector: raw.selector,
        label: raw.label,
        currentValue: '',
        options: raw.options.length > 0 ? raw.options : undefined,
        absoluteY: 0, // not used for LLM viewport scan
        isRequired: raw.isRequired,
        matchedAnswer: answer || undefined,
        filled: false,
      });
    }

    return fields;
  }

  /**
   * Build a text summary of fields for enriching the LLM prompt.
   * Includes field type, options, required status, and expected answer if known.
   * e.g. `- "Country/Region" (Dropdown) → Expected: "United States" [REQUIRED]`
   */
  private buildScanContextForLLM(fields: ScannedField[]): string {
    return fields.map(f => {
      const kindLabel: Record<string, string> = {
        text: 'Text input',
        select: 'Dropdown',
        custom_dropdown: 'Dropdown',
        radio: 'Radio buttons',
        aria_radio: 'Radio buttons',
        checkbox: 'Checkbox',
        date: 'Date input',
        file: 'File upload',
        contenteditable: 'Rich text editor',
        upload_button: 'Upload button',
        unknown: 'Unknown field',
      };
      const kind = kindLabel[f.kind] || f.kind;
      const required = f.isRequired ? ' [REQUIRED]' : '';
      const options = f.options && f.options.length > 0
        ? ` Options: [${f.options.slice(0, 10).join(', ')}${f.options.length > 10 ? ', ...' : ''}]`
        : '';
      const expectedValue = f.matchedAnswer
        ? ` → Fill with: "${f.matchedAnswer}"`
        : f.isRequired
          ? ' → No exact data available — use your best judgment to pick a reasonable answer that benefits the applicant'
          : '';
      return `- "${f.label}" (${kind})${options}${expectedValue}${required}`;
    }).join('\n');
  }

  /**
   * Group unfilled fields into viewport-sized chunks by absoluteY,
   * so each LLM call targets fields that are visible together.
   */
  private groupFieldsByViewport(fields: ScannedField[], viewportHeight: number): ScannedField[][] {
    if (fields.length === 0) return [];
    const groups: ScannedField[][] = [];
    let currentGroup: ScannedField[] = [fields[0]];
    let groupTop = fields[0].absoluteY;

    for (let i = 1; i < fields.length; i++) {
      const field = fields[i];
      // If this field is within the same viewport window as the group start, add it
      if (field.absoluteY - groupTop < viewportHeight * 0.8) {
        currentGroup.push(field);
      } else {
        groups.push(currentGroup);
        currentGroup = [field];
        groupTop = field.absoluteY;
      }
    }
    groups.push(currentGroup);
    return groups;
  }

  /**
   * Check if there's a visible upload button, link, or dropzone on screen.
   * Used to decide whether to invoke the LLM to click it when DOM upload fails.
   */
  private async hasVisibleUploadArea(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const uploadWords = [
        'upload', 'attach', 'choose file', 'select file', 'browse',
        'add file', 'add resume', 'add cv', 'add document', 'add cover letter',
        'drag', 'drop file', 'drop your', 'drop here',
      ];
      const els = document.querySelectorAll(
        'button, [role="button"], a[href], label[for], ' +
        '[class*="upload"], [class*="dropzone"], [class*="drop-zone"], ' +
        '[class*="file-upload"], [class*="attach"], [class*="resume-upload"]'
      );
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const text = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (text.length > 150) continue;
        // Skip nav buttons
        if (text === 'submit' || text === 'next' || text === 'continue' || text === 'save') continue;
        for (const word of uploadWords) {
          if (text.includes(word)) return true;
        }
      }
      return false;
    });
  }

  /**
   * Quick fingerprint of visible field values to detect whether the LLM changed anything.
   */
  private async getVisibleFieldValues(adapter: BrowserAutomationAdapter): Promise<string> {
    return adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const vals: string[] = [];
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select'
      ).forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh || rect.width === 0 || rect.height === 0) return;
        vals.push(el.value || '');
      });
      return vals.join('|');
    });
  }

  /**
   * Dismiss any open dropdowns, popups, or overlays the LLM may have left behind.
   * An open dropdown blocks clicks on other elements and prevents the selected
   * value from being committed (blur/change events don't fire until it closes).
   */
  private async dismissOpenOverlays(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      // Press Escape to close any open dropdown/popup/menu
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(200);

      // Trigger blur on the active element to commit any pending values.
      // Avoid clicking at fixed coordinates (could hit a nav link).
      await adapter.page.evaluate(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          (document.activeElement as HTMLElement).blur?.();
        }
      });
      await adapter.page.waitForTimeout(300);
    } catch {
      // Non-fatal — overlay may not exist
    }
  }

  /**
   * Snapshot which checkboxes are currently checked (by index) so we can detect if
   * the LLM accidentally unchecks any.
   */
  private async getCheckedCheckboxes(adapter: BrowserAutomationAdapter): Promise<number[]> {
    return adapter.page.evaluate(() => {
      const indices: number[] = [];
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      for (let i = 0; i < cbs.length; i++) {
        if ((cbs[i] as HTMLInputElement).checked) indices.push(i);
      }
      return indices;
    });
  }

  /**
   * Re-check any checkboxes that were checked before the LLM acted but got unchecked.
   * The LLM should NEVER uncheck a checkbox.
   */
  private async restoreUncheckedCheckboxes(
    adapter: BrowserAutomationAdapter,
    previouslyChecked: number[],
  ): Promise<void> {
    if (previouslyChecked.length === 0) return;
    const restored = await adapter.page.evaluate((indices) => {
      let count = 0;
      const cbs = document.querySelectorAll('input[type="checkbox"]');
      for (let i = 0; i < indices.length; i++) {
        const cb = cbs[indices[i]] as HTMLInputElement | undefined;
        if (cb && !cb.checked) {
          cb.click();
          count++;
        }
      }
      return count;
    }, previouslyChecked);
    if (restored > 0) {
      console.log(`[SmartApply] Restored ${restored} checkbox(es) the LLM accidentally unchecked.`);
    }
  }

  /**
   * Smart scroll: find the next actionable element below the viewport and scroll
   * just enough to bring it into view. Falls back to 50% viewport jump if no
   * specific target is found.
   * Returns true if the scroll position actually changed.
   */
  private async scrollDown(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await this.getContentScrollMax(adapter);

    if (scrollBefore >= scrollMax - 10) return false; // Already at content bottom

    // Find the Y position of the next actionable element below the viewport
    const targetY = await adapter.page.evaluate(() => {
      const vh = window.innerHeight;
      const scrollY = window.scrollY;

      // All the element types we care about (form fields, upload areas, buttons, custom controls)
      const selectors = [
        'input:not([type="hidden"]):not([disabled])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[contenteditable="true"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[role="radiogroup"]',
        '[role="radio"]',
        '[aria-haspopup="listbox"]',
        '[aria-haspopup="true"]',
        'input[type="file"]',
        'button',
        '[role="button"]',
        'label[for]',
        '[class*="upload"]',
        '[class*="dropzone"]',
        '[class*="drop-zone"]',
        '[class*="file-upload"]',
        '[class*="attach"]',
      ];

      let closestBelow = Infinity;

      for (let s = 0; s < selectors.length; s++) {
        const els = document.querySelectorAll(selectors[s]);
        for (let e = 0; e < els.length; e++) {
          const rect = els[e].getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(els[e]);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          // Element is below the viewport (or partially cut off at the bottom)
          if (rect.top > vh - 20) {
            const absTop = rect.top + scrollY;
            if (absTop < closestBelow) closestBelow = absTop;
          }
        }
      }

      if (closestBelow === Infinity) {
        // No specific target found — fall back to 50% viewport jump
        return scrollY + Math.round(vh * 0.5);
      }

      // Scroll so the target element is ~20% from the top of the viewport
      return Math.max(scrollY + 1, closestBelow - Math.round(vh * 0.2));
    });

    await adapter.page.evaluate((target: number) =>
      window.scrollTo({ top: target, behavior: 'smooth' }),
    targetY);
    await adapter.page.waitForTimeout(1200);

    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    return scrollAfter > scrollBefore;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async waitForPageLoad(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      await adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Dismiss cookie consent banners that may overlay page content.
   * Uses DOM-first approach — clicks common accept/reject/close buttons.
   */
  private async dismissCookieBanner(adapter: BrowserAutomationAdapter): Promise<void> {
    try {
      const dismissed = await adapter.page.evaluate(() => {
        // Common cookie banner selectors across many sites
        const selectors = [
          // By ID
          '#onetrust-accept-btn-handler',           // OneTrust (very common)
          '#cookie-accept', '#accept-cookies',
          '#CookieAcceptAll', '#cookieAcceptAll',
          '#truste-consent-button',                  // TrustArc
          '#sp-cc-accept',                           // Amazon's own cookie banner
          // By class
          '.cookie-accept-btn', '.accept-cookies-btn',
          '.cookie-consent-accept',
          // By data attributes
          '[data-testid="cookie-accept"]',
          '[data-action="accept-cookies"]',
          // Generic buttons with common text
        ];

        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              el.click();
              return true;
            }
          }
        }

        // Text-based fallback: look for buttons with "Accept" or "Accept all" text
        const buttons = document.querySelectorAll('button, a[role="button"], [role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (
            text === 'accept' || text === 'accept all' || text === 'accept cookies' ||
            text === 'accept all cookies' || text === 'i accept' || text === 'got it' ||
            text === 'ok' || text === 'agree' || text === 'consent'
          ) {
            const style = window.getComputedStyle(btn);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                (btn as HTMLElement).click();
                return true;
              }
            }
          }
        }
        return false;
      });

      if (dismissed) {
        console.log('[SmartApply] Dismissed cookie consent banner');
        await adapter.page.waitForTimeout(500);
      }
    } catch {
      // Non-fatal — cookie banner may not exist
    }
  }

  private async clickNextOnGooglePage(adapter: BrowserAutomationAdapter): Promise<void> {
    const nextClicked = await adapter.page.evaluate(() => {
      const buttons = document.querySelectorAll('button, div[role="button"]');
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase().includes('next')) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!nextClicked) {
      await adapter.act('Click the "Next" button.');
    }
  }

  /**
   * Quick DOM-only check if the current page looks like a review page.
   * Used as a lightweight safety net inside fillPage — NOT the
   * primary review detection (that's verifyReviewPage with LLM confirmation).
   * Only returns true if heading says "review" AND Submit present AND no editable fields.
   */
  private async checkIfReviewPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      const roots: ParentNode[] = [document];
      const seenShadowRoots = new Set<ShadowRoot>();
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
        for (const element of elements) {
          const shadowRoot = element.shadowRoot;
          if (shadowRoot && !seenShadowRoots.has(shadowRoot)) {
            seenShadowRoots.add(shadowRoot);
            roots.push(shadowRoot);
          }
        }
      }

      const headings = roots.flatMap((root) => Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"]')));
      const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
      if (!isReviewHeading) return false;
      const buttons = roots.flatMap((root) =>
        Array.from(
          root.querySelectorAll('button, [role="button"], [role="link"], input[type="submit"], input[type="button"], a[href]'),
        ),
      );
      const SUBMIT_TEXTS = ['submit', 'submit application', 'submit my application', 'submit this application', 'send application'];
      const hasSubmit = buttons.some(b => {
        const text = (
          b.textContent ||
          b.getAttribute('value') ||
          b.getAttribute('aria-label') ||
          b.getAttribute('title') ||
          ''
        )
          .trim()
          .toLowerCase();
        return SUBMIT_TEXTS.indexOf(text) !== -1 || text.startsWith('submit');
      });
      if (!hasSubmit) return false;
      // Check entire page for any editable form elements
      const editableCount = roots.reduce((count, root) => {
        return (
          count +
          root.querySelectorAll(
            'input[type="text"]:not([readonly]):not([disabled]), ' +
              'input[type="email"]:not([readonly]):not([disabled]), ' +
              'input[type="tel"]:not([readonly]):not([disabled]), ' +
              'textarea:not([readonly]):not([disabled]), ' +
              'select:not([disabled]), ' +
              'input[type="radio"]:not([disabled]), ' +
              'input[type="checkbox"]:not([disabled])',
          ).length
        );
      }, 0);
      // If there are interactive form elements, probably not a true review page
      return editableCount === 0;
    });
  }

  /**
   * Use a second LLM call to verify the page is truly the final review/summary.
   * DOM checks miss radio buttons, toggles, custom widgets, and other non-standard
   * form elements, so we ask the LLM to visually inspect the page for signs that
   * there is still more application to complete.
   */
  private async verifyReviewPage(adapter: BrowserAutomationAdapter): Promise<boolean> {
    const ReviewVerificationSchema = z.object({
      is_final_review: z.boolean(),
      reason: z.string(),
    });

    try {
      console.log('[SmartApply] Verifying review page classification with LLM...');
      await this.throttleLlm(adapter);
      const result = await adapter.extract(
        `Look at this page carefully. I need to determine if this is the FINAL review/summary page of a job application, or if there are still more steps to complete.

A TRUE final review page:
- Shows a read-only summary of ALL your previously entered application data
- Has a "Submit" or "Submit Application" button as the final action
- Has NO more sections, steps, or pages left to fill out
- The application progress indicator (if any) shows you are at the last step

This is NOT the final review page if ANY of these are true:
- There are still more steps/sections visible in a sidebar, progress bar, or navigation that haven't been completed yet
- The page is asking you to make a choice (e.g. enable notifications, select preferences, agree to terms)
- There are form fields, radio buttons, toggles, checkboxes, or dropdowns that need interaction
- A progress indicator shows you are NOT at the final step
- The page has content to interact with beyond just reviewing submitted data

Set is_final_review to true ONLY if this is genuinely the last page before submission with nothing left to do except click Submit.`,
        ReviewVerificationSchema,
      );

      console.log(`[SmartApply] Review verification: is_final_review=${result.is_final_review}, reason="${result.reason}"`);
      return result.is_final_review;
    } catch (error) {
      console.warn(`[SmartApply] Review verification LLM call failed: ${error}`);
      // If the verification fails, err on the side of NOT treating it as review
      // so we don't prematurely stop the application
      return false;
    }
  }

  /**
   * Call adapter.act() with throttling, broken-page guard, and 429 retry.
   * - Enforces minimum gap between LLM calls to stay under rate limits
   * - Checks page health before sending screenshots (broken pages waste tokens)
   * - Retries once on 429 with a 30s backoff (the rate limit window is per-minute)
   */
  private async safeAct(
    adapter: BrowserAutomationAdapter,
    prompt: string,
    label: string,
  ): Promise<void> {
    // Check page health — don't waste tokens on broken pages showing raw JS
    const healthy = await this.isPageHealthy(adapter);
    if (!healthy) {
      console.warn(`[SmartApply] [${label}] Page appears broken (raw JS/code visible) — skipping LLM call to save tokens.`);
      return;
    }

    // Enforce minimum gap between LLM calls
    await this.throttleLlm(adapter);

    try {
      const result = await adapter.act(prompt);
      // Defense-in-depth: check result even though adapters now throw on failure.
      if (!result.success) {
        throw new Error(`[${label}] act() returned failure: ${result.message}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests')) {
        console.warn(`[SmartApply] [${label}] Rate limited (429) — waiting 30s before retry...`);
        await adapter.page.waitForTimeout(30_000);
        this.lastLlmCallTime = Date.now();
        const retryResult = await adapter.act(prompt);
        if (!retryResult.success) {
          throw new Error(`[${label}] act() returned failure after retry: ${retryResult.message}`);
        }
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // MagnitudeHand — Last-resort general GUI agent fallback
  // ---------------------------------------------------------------------------

  /**
   * Phase 2.75: MagnitudeHand — Last-resort fallback for fields that DOM fill
   * and LLM fill both failed to handle. Uses the adapter as a general GUI agent
   * with per-field micro-scoped act() calls to minimize quadratic cost.
   *
   * Typical targets: nested/cascading dropdowns, custom ARIA widgets,
   * autocomplete fields, contenteditable divs.
   *
   * Returns the number of fields successfully filled.
   */
  private async magnitudeHandFallback(
    adapter: BrowserAutomationAdapter,
    config: PlatformConfig,
    scan: ScanResult,
    qaMap: Record<string, string>,
    dataPrompt: string,
    pageLabel: string,
    costTracker?: CostTracker,
  ): Promise<number> {
    // 1. Identify unfilled fields
    const unfilled = scan.fields.filter(f =>
      !f.filled &&
      (!f.currentValue || f.currentValue.trim() === '') &&
      f.kind !== 'file' && f.kind !== 'upload_button'
    );

    if (unfilled.length === 0) {
      console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: No unfilled fields — skipping.`);
      return 0;
    }

    // 2. Budget gate — skip if insufficient budget remaining
    if (costTracker) {
      const remaining = costTracker.getRemainingBudget();
      if (remaining < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
        console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Budget too low ($${remaining.toFixed(4)} remaining) — skipping.`);
        return 0;
      }
    }

    console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: ${unfilled.length} unfilled field(s) — starting fallback.`);

    // 3. Snapshot cost baseline for soft cap enforcement
    const costBaseline = costTracker
      ? costTracker.getTaskBudget() - costTracker.getRemainingBudget()
      : 0;
    let fieldsFilled = 0;
    const fieldsToAttempt = unfilled.slice(0, MAGNITUDE_HAND_MAX_FIELDS);

    for (const field of fieldsToAttempt) {
      // 3a. Check soft cap — stop if MagnitudeHand has spent too much
      if (costTracker) {
        const currentCost = costTracker.getTaskBudget() - costTracker.getRemainingBudget();
        const magnitudeHandSpent = currentCost - costBaseline;
        if (magnitudeHandSpent >= MAGNITUDE_HAND_BUDGET_CAP) {
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Soft cap reached ($${magnitudeHandSpent.toFixed(4)} / $${MAGNITUDE_HAND_BUDGET_CAP}) — stopping.`);
          break;
        }
        if (costTracker.getRemainingBudget() < MAGNITUDE_HAND_MIN_REMAINING_BUDGET) {
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Global budget exhausted — stopping.`);
          break;
        }
      }

      // 3b. Scroll field into view
      if (field.selector) {
        try {
          await adapter.page.evaluate(
            (sel: string) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }),
            field.selector,
          );
          await adapter.page.waitForTimeout(300);
        } catch {
          // Selector may be stale — continue anyway, Magnitude uses screenshots
        }
      }

      // 3c. Build micro-scoped prompt for this single field
      const answer = field.matchedAnswer || findBestAnswer(field.label, qaMap);
      const prompt = this.buildMagnitudeHandPrompt(field, answer || undefined, dataPrompt);

      // 3d. Execute via adapter.act() with timeout
      const answerPreview = answer ? `"${answer.substring(0, 30)}${answer.length > 30 ? '...' : ''}"` : 'best judgment';
      console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filling "${field.label}" (${field.kind}) → ${answerPreview}`);

      try {
        await this.throttleLlm(adapter);
        const result = await adapter.act(prompt, {
          timeoutMs: MAGNITUDE_HAND_ACT_TIMEOUT_MS,
        });

        if (result.success) {
          field.filled = true;
          fieldsFilled++;
          console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filled "${field.label}" OK (${result.durationMs}ms)`);
        } else {
          console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Failed "${field.label}": ${result.message}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // BudgetExceededError must propagate up
        if (msg.includes('Budget exceeded') || msg.includes('Action limit exceeded')) {
          console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Budget/action limit hit — stopping.`);
          throw err;
        }
        console.warn(`[SmartApply] [${pageLabel}] MagnitudeHand: Error on "${field.label}": ${msg}`);
      }

      // 3e. Dismiss any overlays the agent may have opened
      await this.dismissOpenOverlays(adapter);
    }

    console.log(`[SmartApply] [${pageLabel}] MagnitudeHand: Filled ${fieldsFilled}/${fieldsToAttempt.length} field(s).`);
    return fieldsFilled;
  }

  /**
   * Build a minimal, focused prompt for a single MagnitudeHand field fill.
   * Keeps the prompt short to minimize input tokens (cost optimization).
   */
  private buildMagnitudeHandPrompt(
    field: ScannedField,
    answer: string | undefined,
    dataPrompt: string,
  ): string {
    const kindHints: Record<string, string> = {
      custom_dropdown: 'This is a custom dropdown. Click it to open, find the correct option, and select it. If it has a search/autocomplete input, type the value first, wait for options to appear, then click the match.',
      select: 'This is a dropdown menu. Click to open it, then select the correct option.',
      contenteditable: 'This is a rich text editor. Click into it and type the value.',
      aria_radio: 'This is a radio button group. Click the correct option.',
      radio: 'This is a radio button group. Click the correct option.',
      checkbox: 'This is a checkbox. Click it if it should be checked.',
      date: 'This is a date field. Enter the date in the format shown.',
      text: 'This is a text input field. Click into it and type the value.',
      unknown: 'Interact with this form control appropriately.',
    };

    const fieldHint = kindHints[field.kind] || kindHints['unknown'];
    const optionsList = field.options && field.options.length > 0
      ? `\nAvailable options: [${field.options.slice(0, 20).join(', ')}${field.options.length > 20 ? ', ...' : ''}]`
      : '';

    const valueInstruction = answer
      ? `Fill it with: "${answer}"`
      : `Use your best judgment based on the applicant data below to pick the most reasonable value.`;

    return `You are filling out a job application form. Focus ONLY on the single field described below. Do NOT interact with any other fields, buttons, or navigation elements.

FIELD: "${field.label}"${field.isRequired ? ' [REQUIRED]' : ''}
TYPE: ${field.kind}${optionsList}
INSTRUCTION: ${valueInstruction}

${fieldHint}

RULES:
- Fill ONLY this one field, then stop immediately.
- Do NOT scroll the page or click Next/Submit.
- Do NOT interact with any other fields.
- If a dropdown has no matching option, select the closest reasonable match.
- ONE attempt only — do not retry if it doesn't work.

APPLICANT DATA:
${dataPrompt}`;
  }

  /**
   * Generate a fingerprint of the visible page content for SPA stuck detection.
   * On SPAs where the URL never changes, this detects actual page transitions
   * by comparing headings, form field count, and active sidebar items.
   */
  private async getPageFingerprint(adapter: BrowserAutomationAdapter): Promise<string> {
    return adapter.page.evaluate(() => {
      // First visible heading
      const h = document.querySelector('h1, h2, h3');
      const heading = (h?.textContent || '').trim().substring(0, 60);

      // Count visible form fields AND how many are filled vs empty.
      // Including filled count ensures the fingerprint changes after formFiller
      // fills fields — preventing false "stuck" detection on SPAs where the
      // URL and heading stay constant across fill cycles.
      const fields = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      let visibleFieldCount = 0;
      let filledFieldCount = 0;
      for (const f of fields) {
        const rect = f.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visibleFieldCount++;
          const el = f as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          if (el.value && el.value.trim()) filledFieldCount++;
        }
      }

      // Active sidebar/step indicator (common in multi-step forms)
      const activeSelectors = [
        '[aria-current="step"]', '[aria-current="true"]',
        '.active-step', '.current-step',
        'li.active', 'a.active',
        '[class*="activeSection"]', '[class*="currentSection"]',
      ];
      let activeText = '';
      for (const sel of activeSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          activeText = (el.textContent || '').trim().substring(0, 40);
          break;
        }
      }

      return `${heading}|fields:${visibleFieldCount}|filled:${filledFieldCount}|active:${activeText}`;
    });
  }

  private buildPageStepKey(pageState: PageState): string {
    const normalizedTitle = (pageState.page_title || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return `${pageState.page_type}::${normalizedTitle || 'untitled'}`;
  }

  private buildPageDomSummary(pageState: PageState): string {
    const flags = [
      pageState.has_apply_button ? 'apply' : '',
      pageState.has_next_button ? 'next' : '',
      pageState.has_submit_button ? 'submit' : '',
      pageState.has_sign_in_with_google ? 'google' : '',
    ].filter(Boolean);
    return `${pageState.page_type}:${flags.join(',')}`;
  }

  /**
   * Calculate the maximum safe scroll position based on actual visible content,
   * NOT raw document.scrollHeight. On SPAs (React/Next.js) like Amazon.jobs,
   * scrollHeight includes <script> tags and framework boilerplate past the
   * rendered content. Scrolling into that territory shows raw JavaScript.
   * This finds the bottom edge of the last meaningful UI element and uses
   * that as the content boundary — matching what manual scrolling would reach.
   */
  private async getContentScrollMax(adapter: BrowserAutomationAdapter): Promise<number> {
    return adapter.page.evaluate(() => {
      const elements = document.querySelectorAll(
        'button, [role="button"], input, select, textarea, a[href], label, h1, h2, h3, h4, p, li, td, th, img, [role="listbox"], [role="combobox"]'
      );
      let maxBottom = 0;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const bottom = rect.bottom + window.scrollY;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      // Use content boundary + buffer, capped at actual scroll height
      const contentLimit = maxBottom > 0
        ? Math.min(maxBottom + 150, document.documentElement.scrollHeight)
        : document.documentElement.scrollHeight;
      return Math.max(0, contentLimit - window.innerHeight);
    });
  }

  /**
   * Check if the visible page content is healthy (actual UI) vs broken (raw JS/source code).
   * On SPAs, rendering glitches can expose raw JavaScript, minified bundles, or JSON in the
   * viewport. Sending a screenshot of dense code to the LLM is extremely expensive (a single
   * screenshot of minified JS can burn 5-10k+ vision tokens). This checks the visible text
   * for code-like patterns and returns false if the page looks broken.
   */
  private async isPageHealthy(adapter: BrowserAutomationAdapter): Promise<boolean> {
    return adapter.page.evaluate(() => {
      // Sample visible text in the viewport
      const viewportHeight = window.innerHeight;
      const elements = document.elementsFromPoint(window.innerWidth / 2, viewportHeight / 2);

      // Get all text visible in the viewport by checking elements in the viewport region
      let visibleText = '';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      let textNodes = 0;
      while ((node = walker.nextNode() as Text | null)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        // Only check text in the current viewport
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width === 0 || rect.height === 0) continue;
        visibleText += node.textContent + ' ';
        textNodes++;
        if (visibleText.length > 5000) break; // Sample enough text
      }

      if (visibleText.length < 200) return true; // Not enough text to judge — assume healthy

      // Count code-like patterns
      const codePatterns = [
        /\bfunction\s*\(/g, /\bconst\s+\w+/g, /\bvar\s+\w+/g, /\blet\s+\w+/g,
        /\bimport\s+/g, /\bexport\s+/g, /\brequire\s*\(/g, /\bmodule\.exports/g,
        /=>\s*\{/g, /\}\s*\)/g, /\bclass\s+\w+/g, /\bnew\s+\w+/g,
        /\btry\s*\{/g, /\bcatch\s*\(/g, /\bthrow\s+/g,
        /\bif\s*\(/g, /\belse\s*\{/g, /\breturn\s+/g,
        /\bwindow\./g, /\bdocument\./g, /\bconsole\./g,
        /[{};]\s*[{};]/g, // dense punctuation typical of minified JS
      ];

      let codeHits = 0;
      for (const pattern of codePatterns) {
        const matches = visibleText.match(pattern);
        if (matches) codeHits += matches.length;
      }

      // Count UI-like elements in viewport (buttons, inputs, labels, headings)
      const uiElements = document.querySelectorAll(
        'button, [role="button"], input:not([type="hidden"]), select, textarea, label, h1, h2, h3, h4, img'
      );
      let visibleUiCount = 0;
      for (const el of uiElements) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewportHeight) continue;
        if (rect.width > 0 && rect.height > 0) visibleUiCount++;
      }

      // Heuristic: if code patterns significantly outnumber UI elements, page is broken
      // A healthy form page typically has >5 UI elements and <5 code patterns
      // A broken page showing JS typically has 20+ code patterns and <3 UI elements
      if (codeHits >= 15 && visibleUiCount < 3) return false;
      if (codeHits >= 10 && codeHits > visibleUiCount * 3) return false;

      return true;
    });
  }

  /**
   * Enforce a minimum gap between LLM calls to stay under rate limits.
   * The Magnitude SDK makes multiple internal LLM calls per act()/extract(),
   * so we need breathing room between our calls.
   */
  private async throttleLlm(adapter: BrowserAutomationAdapter): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastLlmCallTime;
    if (this.lastLlmCallTime > 0 && elapsed < MIN_LLM_GAP_MS) {
      const wait = MIN_LLM_GAP_MS - elapsed;
      console.log(`[SmartApply] Rate limit throttle: waiting ${wait}ms before next LLM call...`);
      await adapter.page.waitForTimeout(wait);
    }
    this.lastLlmCallTime = Date.now();
  }

  // Note: dismissErrorBanners was removed. Hiding [role="alert"] elements via
  // style.display='none' breaks React's DOM reconciliation on SPAs. Error banners
  // are left visible — the LLM prompt already instructs it to fix errors, not get
  // distracted by them.
}
