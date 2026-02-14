import type { BrowserAutomationAdapter } from '../../adapters';
import { z } from 'zod';

/**
 * Handle "apply" job type.
 * Navigates to a job posting URL and fills out the application form
 * using the provided user data and Q&A overrides.
 */
export async function handleApplyJob(
  adapter: BrowserAutomationAdapter,
  taskDescription: string,
  dataPrompt: string,
  inputData: Record<string, any>,
): Promise<{ result: any; screenshotBuffer: Buffer | null }> {
  // Execute the application
  const actResult = await adapter.act(taskDescription, {
    prompt: dataPrompt,
    data: inputData.user_data,
  });

  if (!actResult.success) {
    throw new Error(`Apply action failed: ${actResult.message}`);
  }

  // Extract confirmation
  const result = await adapter.extract(
    'Extract any confirmation number, success message, application ID, or submission status visible on the page',
    z.object({
      confirmation_id: z.string().optional(),
      success_message: z.string().optional(),
      submitted: z.boolean(),
      application_status: z.string().optional(),
    })
  );

  // Capture final screenshot
  let screenshotBuffer: Buffer | null = null;
  try {
    screenshotBuffer = await adapter.screenshot();
  } catch {
    // Non-fatal
  }

  return { result, screenshotBuffer };
}
