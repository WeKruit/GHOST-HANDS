import type { BrowserAutomationAdapter } from '../../adapters';
import { z } from 'zod';

/**
 * Handle "scrape" job type.
 * Navigates to a URL and extracts structured data from the page.
 * Used for scraping job postings, company info, etc.
 */
export async function handleExtractData(
  adapter: BrowserAutomationAdapter,
  taskDescription: string,
  dataPrompt: string,
  inputData: Record<string, any>,
): Promise<{ result: any; screenshotBuffer: Buffer | null }> {
  // For scrape jobs, we may need to navigate and interact first
  if (taskDescription) {
    const actResult = await adapter.act(taskDescription, {
      prompt: dataPrompt,
    });
    if (!actResult.success) {
      throw new Error(`Extract navigation failed: ${actResult.message}`);
    }
  }

  // Extract the requested data
  const extractionSchema = inputData.extraction_schema
    ? z.record(z.unknown()) // User-provided schema would be validated elsewhere
    : z.object({
        title: z.string().optional(),
        company: z.string().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
        requirements: z.array(z.string()).optional(),
        salary_range: z.string().optional(),
        application_deadline: z.string().optional(),
        extracted_data: z.record(z.unknown()).optional(),
      });

  const result = await adapter.extract(
    taskDescription || 'Extract all relevant information from this page',
    extractionSchema,
  );

  let screenshotBuffer: Buffer | null = null;
  try {
    screenshotBuffer = await adapter.screenshot();
  } catch {
    // Non-fatal
  }

  return { result, screenshotBuffer };
}
