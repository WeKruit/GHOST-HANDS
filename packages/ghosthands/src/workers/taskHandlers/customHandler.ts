import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult } from './types.js';

export class CustomHandler implements TaskHandler {
  readonly type = 'custom';
  readonly description = 'Execute custom browser automation instructions';

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter } = ctx;

    const actResult = await adapter.act(job.task_description, {
      prompt: ctx.dataPrompt,
      data: job.input_data,
    });

    if (!actResult.success) {
      return { success: false, error: `Custom action failed: ${actResult.message}` };
    }

    // Generic result extraction
    const result = await adapter.extract(
      'Summarize the current page state and any visible results or confirmation messages',
      z.object({
        page_title: z.string().optional(),
        current_url: z.string().optional(),
        summary: z.string().optional(),
        success_indicators: z.array(z.string()).optional(),
      })
    );

    return {
      success: true,
      data: result,
    };
  }
}
