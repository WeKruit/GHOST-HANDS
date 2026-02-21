#!/usr/bin/env node
/**
 * Quick test: can we launch patchright chromium from this runtime?
 */
import { chromium } from 'playwright';

async function main() {
  console.log('Testing browser launch...');
  const start = Date.now();
  try {
    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-gpu', '--disable-blink-features=AutomationControlled'],
      timeout: 30_000,
    });
    console.log(`Browser launched in ${Date.now() - start}ms`);
    const page = await browser.newPage();
    await page.goto('https://example.com', { timeout: 15_000 });
    console.log('Page title:', await page.title());
    await browser.close();
    console.log('SUCCESS: Browser works!');
  } catch (e: any) {
    console.error('FAILED:', e.message?.substring(0, 300));
  }
}

main();
