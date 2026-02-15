import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult } from './types.js';

export class ScrapeHandler implements TaskHandler {
  readonly type = 'scrape';
  readonly description = 'Scrape structured data from a web page';

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter } = ctx;

    // Navigate is already done by JobExecutor
    // Use extract to get structured data
    const instruction = job.task_description || 'Extract all relevant structured data from this page';

    // Use a generic schema if none provided
    const result = await adapter.extract(
      instruction,
      z.object({
        title: z.string().optional(),
        content: z.record(z.unknown()).optional(),
        extracted_data: z.array(z.record(z.unknown())).optional(),
      })
    );

    return {
      success: true,
      data: result,
    };
  }
}
