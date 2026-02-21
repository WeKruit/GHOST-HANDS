import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import { ProgressStep } from '../progressTracker.js';

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
    const { job, adapter, progress } = ctx;

    // Execute the browser automation.
    // Resume upload is handled automatically by JobExecutor's filechooser listener
    // which intercepts any file input dialog and attaches the downloaded resume.
    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.resumeFilePath
        ? `${ctx.dataPrompt}\n\nA resume file is available for upload. When you encounter a file upload field for resume/CV, click it to trigger the file dialog — the file will be attached automatically.`
        : ctx.dataPrompt,
      data: job.input_data.user_data,
    });

    if (!actResult.success) {
      return { success: false, error: `Action failed: ${actResult.message}` };
    }

    // Extract results
    await progress.setStep(ProgressStep.EXTRACTING_RESULTS);
    const result = await adapter.extract(
      'Extract any confirmation number, success message, or application ID visible on the page',
      z.object({
        confirmation_id: z.string().optional(),
        success_message: z.string().optional(),
        submitted: z.boolean(),
      })
    );

    return {
      success: result.submitted ?? true,
      data: result,
    };
  }
}
