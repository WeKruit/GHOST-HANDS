import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';
import { ProgressStep } from '../progressTracker.js';

export class ApplyHandler implements TaskHandler {
  readonly type = 'apply';
  readonly description = 'Apply to a job posting by filling out the application form';

  validate(inputData: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const userData = inputData.user_data;
    if (userData) {
      if (!userData.first_name) errors.push('user_data.first_name is required');
      if (!userData.last_name) errors.push('user_data.last_name is required');
      if (!userData.email) errors.push('user_data.email is required');
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress } = ctx;

    // Execute the browser automation
    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.dataPrompt,
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
