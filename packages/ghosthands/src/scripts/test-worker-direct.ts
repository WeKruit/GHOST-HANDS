#!/usr/bin/env node
/**
 * Direct test of the full job execution pipeline without the worker/poller.
 * Isolates whether the browser launch issue is in the adapter or the worker infrastructure.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { createAdapter, type AdapterType } from '../adapters/index.js';
import { loadModelConfig } from '../config/models.js';

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
  console.log('=== Direct Adapter Test ===');
  console.log('1. Loading model config...');
  const resolved = loadModelConfig();
  console.log(`   Model: ${resolved.alias} (${resolved.model})`);
  console.log(`   Provider: ${resolved.llmClient.provider}`);

  const llmClient = resolved.llmClient;

  console.log('2. Creating adapter...');
  const adapterType = (process.env.GH_BROWSER_ENGINE || 'magnitude') as AdapterType;
  console.log(`   Adapter type: ${adapterType}`);

  const adapter = createAdapter(adapterType);
  console.log('3. Starting adapter (this launches the browser)...');

  const start = Date.now();
  try {
    await adapter.start({
      url: 'https://caci.wd1.myworkdayjobs.com/en-US/External/job/Software-Engineering-Intern---Summer-2026_317064-1',
      llm: llmClient,
    });
    console.log(`   Adapter started in ${Date.now() - start}ms`);
    console.log('4. Browser is open! Taking screenshot...');

    const title = await adapter.page.title();
    console.log(`   Page title: ${title}`);

    console.log('5. SUCCESS - browser is working!');
    console.log('   Closing in 5 seconds...');
    await new Promise(r => setTimeout(r, 5000));
    await adapter.stop();
    console.log('Done.');
  } catch (e: any) {
    console.error(`FAILED after ${Date.now() - start}ms:`, e.message?.substring(0, 500));
  }
  process.exit(0);
}

main();
