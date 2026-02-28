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

    // Extract page state to determine actual submission outcome
    const PageStateSchema = z.object({
      page_type: z.enum(['confirmation', 'review', 'in_progress', 'unknown']),
      evidence: z.string().optional(),
    });

    let pageState: z.infer<typeof PageStateSchema> | null = null;
    try {
      pageState = await adapter.extract(
        'Look at the current page. Classify it as one of: "confirmation" (application was submitted — you see a thank you message, confirmation number, or success notice), "review" (application summary shown with a final Submit/Confirm button the user must click), "in_progress" (form fields still visible, application is not complete), "unknown" (cannot determine). Also provide brief evidence for your classification.',
        PageStateSchema,
      );
    } catch {
      // Extraction failed — treat as unknown
    }

    const page_type = pageState?.page_type ?? 'unknown';

    if (page_type === 'confirmation') {
      return {
        success: true,
        data: {
          submitted: true,
          success_message: 'Application submitted successfully',
          message: 'Application submitted successfully',
          page_type,
          evidence: pageState?.evidence,
        },
      };
    }

    if (page_type === 'review') {
      return {
        success: false,
        awaitingUserReview: true,
        keepBrowserOpen: true,
        data: {
          submitted: false,
          message: 'Application reached review page — awaiting user submission',
          page_type,
          evidence: pageState?.evidence,
        },
      };
    }

    // in_progress or unknown — the application was NOT submitted
    return {
      success: false,
      error: page_type === 'in_progress'
        ? 'Application form still in progress after agent execution'
        : 'Could not confirm application was submitted',
      data: { submitted: false, page_type, evidence: pageState?.evidence },
    };
  }
}
