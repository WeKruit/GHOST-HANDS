#!/usr/bin/env bun
/**
 * GhostHands Smoke Test
 *
 * Quick validation that the adapter + LLM pipeline works.
 * Navigates to example.com and clicks a link.
 *
 * Usage:
 *   bun run smoke-test                        # auto-select best available LLM
 *   bun run smoke-test -- --model=qwen-72b    # force Qwen VL
 *   bun run smoke-test -- --model=claude-haiku # force Claude
 */

import { MagnitudeAdapter } from '../adapters/magnitude.js';
import { loadModelConfig, printModelInfo } from '../config/models.js';
import type { LLMConfig, TokenUsage } from '../adapters/types.js';

async function main() {
  const resolved = loadModelConfig();

  console.log('\n--- GhostHands Smoke Test ---');
  printModelInfo(resolved);
  console.log();

  const llmConfig = resolved.llmClient as LLMConfig;
  const adapter = new MagnitudeAdapter();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  const startTime = Date.now();

  adapter.on('tokensUsed', (usage: TokenUsage) => {
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCost += usage.inputCost + usage.outputCost;
    console.log(`  [tokens] +${usage.inputTokens} in / +${usage.outputTokens} out`);
  });

  try {
    console.log('Starting adapter...');
    await adapter.start({ url: 'https://example.com', llm: llmConfig });

    console.log('\nTask: Click the "More information..." link on example.com\n');
    const result = await adapter.act('Click the "More information..." link');

    const currentUrl = await adapter.getCurrentUrl();
    console.log(`\nFinal URL: ${currentUrl}`);
    console.log(`Action result: ${result.success ? 'SUCCESS' : 'FAILED'} (${result.durationMs}ms)`);

    if (currentUrl.includes('iana.org')) {
      console.log('SUCCESS: Navigated to iana.org!');
    } else {
      console.log('UNEXPECTED: URL is ' + currentUrl);
    }

    await adapter.stop();
  } catch (error) {
    console.error('\nERROR:', error);
  } finally {
    if (adapter.isActive()) {
      await adapter.stop();
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n--- Results ---');
  console.log(`  Model: ${resolved.alias} (${resolved.model})`);
  console.log(`  Duration: ${elapsed}s`);
  console.log(`  Input tokens: ${totalInputTokens}`);
  console.log(`  Output tokens: ${totalOutputTokens}`);
  console.log(`  Cost: $${totalCost.toFixed(6)}`);
  console.log('\nSmoke test complete.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
