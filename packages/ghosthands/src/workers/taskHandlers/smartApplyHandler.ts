import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import { LayeredOrchestrator } from './LayeredOrchestrator.js';

/**
 * Zod schema for SmartApplyHandler input validation.
 * user_data is required and must contain first_name, last_name, and a valid email.
 */
const SmartApplyInputSchema = z.object({
  user_data: z.object({
    first_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
    last_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
    email: z.string({ required_error: 'is required' }).email('must be a valid email'),
  }).passthrough(),
}).passthrough();

/**
 * SmartApplyHandler — Thin wrapper that delegates to LayeredOrchestrator.
 *
 * Resolves platform config, user profile, resume path, and QA mappings,
 * then hands off to the orchestrator for the actual multi-page fill loop.
 */
export class SmartApplyHandler implements TaskHandler {
  readonly type = 'smart_apply';
  readonly description = 'Fill out a job application on any ATS platform (multi-step), stopping before submission';

  validate(inputData: Record<string, any>): ValidationResult {
    const result = SmartApplyInputSchema.safeParse(inputData);
    if (result.success) {
      return { valid: true };
    }
    const errors = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')} ${issue.message}` : issue.message
    );
    return { valid: false, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress, costTracker } = ctx;
    const userProfile = job.input_data.user_data as Record<string, any>;
    const qaOverrides = job.input_data.qa_overrides || {};

    // Resolve platform config from URL
    const config = detectPlatformFromUrl(job.target_url);
    console.log(`[SmartApply] Platform: ${config.displayName} (${config.platformId})`);
    console.log(`[SmartApply] Starting application for ${job.target_url}`);

    // Build data prompt and QA map via platform config
    const dataPrompt = config.buildDataPrompt(userProfile, qaOverrides);
    const qaMap = config.buildQAMap(userProfile, qaOverrides);

    // Resolve resume file path (check user_data.resume_path, then ctx.resumeFilePath from JobExecutor)
    let resumePath: string | null = null;
    if (userProfile.resume_path) {
      const resolved = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);
      if (fs.existsSync(resolved)) {
        resumePath = resolved;
        console.log('[SmartApply] Resume file found');
      } else {
        console.warn(`[SmartApply] Resume not found at ${resolved} — skipping upload.`);
      }
    }
    if (!resumePath && ctx.resumeFilePath) {
      resumePath = ctx.resumeFilePath;
      console.log('[SmartApply] Using JobExecutor resume file');
    }

    // Create orchestrator and run
    const orchestrator = new LayeredOrchestrator({
      adapter,
      llmAdapter: ctx.llmAdapter,
      config,
      costTracker,
      progress,
    });

    const result = await orchestrator.run({
      userProfile,
      qaMap,
      dataPrompt,
      resumePath,
    });

    // Convert OrchestratorResult → TaskResult
    return {
      success: result.success,
      keepBrowserOpen: result.keepBrowserOpen,
      awaitingUserReview: result.awaitingUserReview,
      error: result.error,
      data: {
        platform: result.platform,
        pages_processed: result.pagesProcessed,
        final_page: result.finalPage,
        dom_filled: result.domFilled,
        llm_filled: result.llmFilled,
        magnitude_filled: result.magnitudeFilled,
        total_fields: result.totalFields,
        message: result.awaitingUserReview
          ? 'Application filled. Waiting for user to review and submit.'
          : result.error || `Processed ${result.pagesProcessed} pages.`,
      },
    };
  }
}
