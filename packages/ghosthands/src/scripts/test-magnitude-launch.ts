#!/usr/bin/env node
/**
 * Test Magnitude's startBrowserAgent to isolate the launch failure.
 */
import { startBrowserAgent } from 'magnitude-core';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load env
const envPath = join(__dirname, '../../.env');
const envContent = readFileSync(envPath, 'utf8');
for (const line of envContent.split('\n')) {
  const trimmed = line.replace(/\r/g, '');
  if (trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx <= 0) continue;
  process.env[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
}

async function main() {
  console.log('Testing Magnitude startBrowserAgent...');
  const start = Date.now();
  try {
    const agent = await startBrowserAgent({
      url: 'https://example.com',
      llm: {
        provider: 'openai-generic' as any,
        options: {
          model: 'deepseek-chat',
          apiKey: process.env.DEEPSEEK_API_KEY || 'test',
          baseUrl: 'https://api.deepseek.com/v1',
          temperature: 0.2,
        },
      },
    });
    console.log(`Agent started in ${Date.now() - start}ms`);
    console.log('Page:', await agent.page.title());

    // Clean up
    await agent.stop();
    console.log('SUCCESS: Magnitude agent works!');
  } catch (e: any) {
    console.error(`FAILED after ${Date.now() - start}ms:`, e.message?.substring(0, 300));
  }
  process.exit(0);
}

main();
