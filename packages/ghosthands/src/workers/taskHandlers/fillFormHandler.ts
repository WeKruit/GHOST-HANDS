import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';

/**
 * Zod schema for FillFormHandler input validation.
 * At least one of user_data or form_data must be present.
 */
const FillFormInputSchema = z.object({
  user_data: z.record(z.unknown()).optional(),
  form_data: z.record(z.unknown()).optional(),
}).passthrough().refine(
  (data) => data.user_data !== undefined || data.form_data !== undefined,
  { message: 'Either user_data or form_data is required' },
);

export class FillFormHandler implements TaskHandler {
  readonly type = 'fill_form';
  readonly description = 'Fill out a web form with provided data';

  validate(inputData: Record<string, any>): ValidationResult {
    const result = FillFormInputSchema.safeParse(inputData);
    if (result.success) {
      return { valid: true };
    }
    const errors = result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')} ${issue.message}` : issue.message
    );
    return { valid: false, errors };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter } = ctx;

    // Resume upload is handled automatically by JobExecutor's filechooser listener.
    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.resumeFilePath
        ? `${ctx.dataPrompt}\n\nA resume file is available for upload. When you encounter a file upload field, click it to trigger the file dialog — the file will be attached automatically.`
        : ctx.dataPrompt,
      data: job.input_data.user_data || job.input_data.form_data,
    });

    if (!actResult.success) {
      return { success: false, error: `Form fill failed: ${actResult.message}` };
    }

    // Try to extract confirmation
    const result = await adapter.extract(
      'Extract any confirmation or success message from the page',
      z.object({
        success_message: z.string().optional(),
        submitted: z.boolean(),
      })
    );

    return {
      success: result.submitted ?? actResult.success,
      data: result,
    };
  }
}
