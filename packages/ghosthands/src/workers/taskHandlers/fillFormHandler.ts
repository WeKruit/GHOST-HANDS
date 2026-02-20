import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';

export class FillFormHandler implements TaskHandler {
  readonly type = 'fill_form';
  readonly description = 'Fill out a web form with provided data';

  validate(inputData: Record<string, any>): ValidationResult {
    if (!inputData.user_data && !inputData.form_data) {
      return { valid: false, errors: ['Either user_data or form_data is required'] };
    }
    return { valid: true };
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
