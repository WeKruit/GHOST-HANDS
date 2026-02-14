import { createAdapter, type BrowserAutomationAdapter } from '../../adapters';

/**
 * Health check handler.
 * Verifies that the worker can launch a browser and navigate to a page.
 * Used by monitoring to ensure the worker is operational.
 */
export async function handleHealthCheck(
  targetUrl: string,
): Promise<{ healthy: boolean; details: Record<string, any> }> {
  const startTime = Date.now();
  let adapter: BrowserAutomationAdapter | null = null;

  try {
    adapter = createAdapter('magnitude');
    await adapter.start({
      url: targetUrl || 'https://httpbin.org/get',
      llm: {
        provider: 'google-ai',
        options: { model: 'gemini-2.5-pro-preview-05-06' },
      },
    });

    // Verify page loaded
    const title = await adapter.page.title();
    const url = adapter.page.url();

    await adapter.stop();
    adapter = null;

    return {
      healthy: true,
      details: {
        browser_launch_ms: Date.now() - startTime,
        page_title: title,
        page_url: url,
        checked_at: new Date().toISOString(),
      },
    };
  } catch (error: unknown) {
    return {
      healthy: false,
      details: {
        error: error instanceof Error ? error.message : String(error),
        browser_launch_ms: Date.now() - startTime,
        checked_at: new Date().toISOString(),
      },
    };
  } finally {
    if (adapter) {
      try {
        await adapter.stop();
      } catch {
        // Best effort
      }
    }
  }
}
