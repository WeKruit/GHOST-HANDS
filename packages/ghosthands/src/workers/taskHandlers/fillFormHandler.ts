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

    const actData: Record<string, any> = {
      ...(job.input_data.user_data || job.input_data.form_data),
    };
    if (ctx.resumeFilePath) {
      actData._resumeFilePath = ctx.resumeFilePath;
    }
    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.dataPrompt,
      data: actData,
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
