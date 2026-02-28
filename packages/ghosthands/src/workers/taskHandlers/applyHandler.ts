import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import { detectPlatformFromUrl } from './platforms/index.js';
import { LayeredOrchestrator } from './LayeredOrchestrator.js';
import { BlockerDetector } from '../../detection/BlockerDetector.js';

/**
 * Zod schema for ApplyHandler input validation.
 * user_data is optional, but when present must contain first_name, last_name, and email.
 */
const ApplyInputSchema = z.object({
  user_data: z.object({
    first_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
    last_name: z.string({ required_error: 'is required' }).min(1, 'is required'),
    email: z.string({ required_error: 'is required' }).email('must be a valid email'),
  }).passthrough().optional(),
}).passthrough();

export class ApplyHandler implements TaskHandler {
  readonly type = 'apply';
  readonly description = 'Apply to a job posting by filling out the application form';

  validate(inputData: Record<string, any>): ValidationResult {
    const result = ApplyInputSchema.safeParse(inputData);
    if (result.success) {
      return { valid: true };
    }
    const errors = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')} ${issue.message}` : issue.message
    );
    return { valid: false, errors };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress, costTracker } = ctx;
    const userProfile = job.input_data.user_data as Record<string, any> | undefined;

    // If no user_data, fall back to simple one-shot adapter.act()
    if (!userProfile || !userProfile.first_name) {
      const actResult = await adapter.act(job.task_description, {
        prompt: ctx.resumeFilePath
          ? `${ctx.dataPrompt}\n\nA resume file is available for upload. When you encounter a file upload field for resume/CV, click it to trigger the file dialog — the file will be attached automatically.`
          : ctx.dataPrompt,
        data: job.input_data.user_data,
      });

      if (!actResult.success) {
        return { success: false, error: `Action failed: ${actResult.message}` };
      }

      return { success: true, data: { message: 'Applied via single-shot agent' } };
    }

    // Route through LayeredOrchestrator for structured multi-page apply
    const qaOverrides = job.input_data.qa_overrides || {};
    const config = detectPlatformFromUrl(job.target_url);
    const dataPrompt = config.buildDataPrompt(userProfile, qaOverrides);
    const qaMap = config.buildQAMap(userProfile, qaOverrides);

    let resumePath: string | null = null;
    if (userProfile.resume_path) {
      const resolved = path.isAbsolute(userProfile.resume_path)
        ? userProfile.resume_path
        : path.resolve(process.cwd(), userProfile.resume_path);
      if (fs.existsSync(resolved)) resumePath = resolved;
    }
    // Also check ctx.resumeFilePath (downloaded by JobExecutor)
    if (!resumePath && ctx.resumeFilePath) {
      resumePath = ctx.resumeFilePath;
    }

    const orchestrator = new LayeredOrchestrator({
      adapter,
      config,
      costTracker,
      progress,
      blockerDetector: new BlockerDetector(),
    });

    const result = await orchestrator.run({
      userProfile,
      qaMap,
      dataPrompt,
      resumePath,
    });

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
