#!/usr/bin/env node
/**
 * Clear Workday Application Form
 *
 * Launches a browser with stored Google session, navigates to the Workday
 * application, and clears all form fields on every page so you can re-test
 * the worker from scratch.
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/clear-workday-form.ts
 *   npx tsx --env-file=.env src/scripts/clear-workday-form.ts --url=<workday-url>
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { SessionManager } from '../sessions/SessionManager.js';
import { createEncryptionFromEnv } from '../db/encryption.js';

const DEFAULT_URL =
  'https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/USA%2C-GA%2C-Atlanta/Software-Application-Engineer----US-Federal-_JR-0104403-1/apply/applyManually';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

function parseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  if (arg) return arg.split('=').slice(1).join('=');
  return DEFAULT_URL;
}

async function clearCurrentPage(page: any): Promise<number> {
  // Clear all visible text inputs and textareas
  const textCleared = await page.evaluate(() => {
    let count = 0;
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
    );
    for (const input of inputs) {
      if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
        const nativeInputValueSetter =
          Object.getOwnPropertyDescriptor(
            input.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype,
            'value',
          )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
      }
    }
    return count;
  });

  // Reset dropdowns — find all "Select One" buttons that have a selected value
  // Workday dropdowns show the selected value as button text; we need to clear them
  const dropdownsCleared = await page.evaluate(() => {
    let count = 0;
    // Workday uses buttons with data-automation-id containing "select" for dropdowns
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="listbox"], button[data-automation-id*="select"]'
    );
    for (const btn of buttons) {
      const text = btn.textContent?.trim() || '';
      // If button text is NOT "Select One", it has a selected value
      if (text && text !== 'Select One' && text !== '' && btn.offsetParent !== null) {
        count++;
      }
    }
    return count;
  });

  console.log(`  Cleared ${textCleared} text field(s), found ${dropdownsCleared} filled dropdown(s)`);

  // For dropdowns, we need to click each one and clear the selection
  // Workday dropdowns don't have a simple "clear" — we need to find the clear/delete button
  // or select a blank option. Let's try clicking the X/clear buttons.
  const xCleared = await page.evaluate(() => {
    let count = 0;
    // Workday often has a small "x" or clear button near dropdowns
    const clearButtons = document.querySelectorAll<HTMLElement>(
      '[data-automation-id*="delete"], [data-automation-id*="clear"], [aria-label="delete"], [aria-label="clear"]'
    );
    for (const btn of clearButtons) {
      if (btn.offsetParent !== null) {
        btn.click();
        count++;
      }
    }
    return count;
  });

  if (xCleared > 0) {
    console.log(`  Clicked ${xCleared} clear/delete button(s) for dropdowns`);
  }

  return textCleared + xCleared;
}

async function main() {
  const targetUrl = parseUrl();

  // Initialize session manager
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Need SUPABASE_URL and SUPABASE_SECRET_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const encryption = createEncryptionFromEnv();
  const sessionManager = new SessionManager({ supabase, encryption });

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-gpu', '--disable-blink-features=AutomationControlled'],
    timeout: 30_000,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Inject stored Google session
  const googleDomains = ['accounts.google.com', 'mail.google.com', 'google.com'];
  let injected = false;
  for (const domain of googleDomains) {
    if (injected) break;
    const session = await sessionManager.loadSession(TEST_USER_ID, domain);
    if (session) {
      const cookies = (session as any).cookies || [];
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        console.log(`Injected ${cookies.length} Google cookies (from ${domain})`);
        injected = true;
      }
    }
  }

  if (!injected) {
    console.warn('WARNING: No Google session found. You may need to sign in manually.');
  }

  console.log(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(3000);

  console.log('\n=== CLEARING FORM ===\n');

  // Detect which page we're on and clear it
  let pageNum = 0;
  const maxPages = 10; // safety limit

  while (pageNum < maxPages) {
    pageNum++;
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const pageLabel = pageText.includes('My Information')
      ? 'My Information'
      : pageText.includes('My Experience')
        ? 'My Experience'
        : pageText.includes('Application Questions')
          ? 'Application Questions'
          : pageText.includes('Voluntary Disclosures')
            ? 'Voluntary Disclosures'
            : pageText.includes('Self Identify')
              ? 'Self Identify'
              : pageText.includes('Review')
                ? 'Review'
                : `Page ${pageNum}`;

    console.log(`[Page ${pageNum}] ${pageLabel}`);

    if (pageLabel === 'Review') {
      console.log('  Reached review page — stopping.');
      break;
    }

    const cleared = await clearCurrentPage(page);

    if (cleared === 0) {
      console.log('  No fields to clear on this page.');
    }

    // Wait a moment for Workday to auto-save the cleared state
    await page.waitForTimeout(1500);

    // Try to click "Next" or "Save and Continue" to go to next page
    const nextClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase() || '';
        if (
          text === 'next' ||
          text === 'save and continue' ||
          text === 'continue'
        ) {
          btn.click();
          return text;
        }
      }
      return null;
    });

    if (nextClicked) {
      console.log(`  Clicked "${nextClicked}" — moving to next page...`);
      await page.waitForTimeout(3000);
    } else {
      console.log('  No next button found — stopping.');
      break;
    }
  }

  console.log('\n=== DONE ===');
  console.log('Browser left open so you can verify. Close the browser window when finished.');

  // Keep process alive until browser closes
  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
