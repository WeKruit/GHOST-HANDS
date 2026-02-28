import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';

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

/**
 * ApplyHandler — One-shot agent execution via adapter.act().
 *
 * This handler delegates the entire application process to the adapter's
 * agent (Magnitude/Stagehand) in a single act() call. It does NOT use
 * the LayeredOrchestrator — use SmartApplyHandler (type: 'smart_apply')
 * for structured multi-page form filling with cost tiers.
 */
export class ApplyHandler implements TaskHandler {
  readonly type = 'apply';
  readonly description = 'Apply to a job posting via one-shot agent execution';

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
    const { job, adapter } = ctx;

    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.resumeFilePath
        ? `${ctx.dataPrompt}\n\nA resume file is available for upload. When you encounter a file upload field for resume/CV, click it to trigger the file dialog — the file will be attached automatically.`
        : ctx.dataPrompt,
      data: job.input_data.user_data,
    });

    if (!actResult.success) {
      return { success: false, error: `Action failed: ${actResult.message}` };
    }

    // Attempt to extract final page state for confirmation
    try {
      const PageStateSchema = z.object({ page_type: z.string() });
      const pageState = await adapter.extract(
        'Is this a confirmation page showing the application was submitted? Or is the form still in progress? Return page_type as "confirmation", "review", or "in_progress".',
        PageStateSchema,
      );
      if (pageState?.page_type === 'confirmation') {
        return { success: true, data: { message: 'Application submitted successfully', page_type: 'confirmation' } };
      }
    } catch {
      // Extraction is best-effort for one-shot handler
    }

    return { success: true, data: { message: 'Applied via single-shot agent' } };
  }
}
