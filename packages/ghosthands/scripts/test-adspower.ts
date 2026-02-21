/**
 * Quick smoke test: AdsPower → Patchright CDP → BrowserContext
 *
 * Usage: bun run scripts/test-adspower.ts
 *
 * Requires:
 *   - AdsPower running locally
 *   - ADSPOWER_API_BASE, ADSPOWER_API_KEY, ADSPOWER_PROFILE_ID in .env
 */

import { AdsPowerClient } from '../src/connectors/AdsPowerClient';

// Load .env
const envPath = new URL('../.env', import.meta.url).pathname;
const envFile = await Bun.file(envPath).text();
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  const val = trimmed.slice(eqIdx + 1);
  if (!process.env[key]) {
    process.env[key] = val;
  }
}

const baseUrl = process.env.ADSPOWER_API_BASE;
const apiKey = process.env.ADSPOWER_API_KEY;
const profileId = process.env.ADSPOWER_PROFILE_ID;

if (!baseUrl || !profileId) {
  console.error('Missing ADSPOWER_API_BASE or ADSPOWER_PROFILE_ID in .env');
  process.exit(1);
}

const client = new AdsPowerClient({ baseUrl, apiKey });

try {
  console.log(`[1/4] Connecting to AdsPower profile ${profileId} via Patchright CDP...`);
  const { context, cdpUrl } = await client.connectContext(profileId);
  console.log(`  → CDP URL: ${cdpUrl}`);
  console.log(`  → Context pages: ${context.pages().length}`);

  console.log(`\n[2/4] Navigating to google.com...`);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://www.google.com');
  const title = await page.title();
  console.log(`  → Page title: "${title}"`);

  console.log(`\n[3/4] Verifying profile is active...`);
  const isActive = await client.isActive(profileId);
  console.log(`  → ${isActive ? 'Active' : 'NOT active'}`);

  console.log(`\n[4/4] Stopping browser...`);
  await client.stopBrowser(profileId);
  console.log(`  → Stopped`);

  console.log('\n--- AdsPower + Patchright integration test PASSED ---');
} catch (err) {
  console.error('\n--- FAILED ---');
  console.error(err);
  // Cleanup
  try { await client.stopBrowser(profileId); } catch {}
  process.exit(1);
}
