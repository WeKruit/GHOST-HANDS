/**
 * Navigation helpers for Workday application flows.
 *
 * Handles clicking "Save and Continue", "Next", error recovery after
 * validation failures, and page load waiting.
 */

import type { MinimalAdapter } from './DesktopAdapterShim.js';
import { PAGE_TRANSITION_WAIT_MS } from './constants.js';
import {
  fillDateFieldsProgrammatically,
  hasEmptyVisibleFields,
} from './domFillers.js';
import { getLogger } from './desktopLogger.js';

/**
 * Wait for the page to settle after navigation.
 */
export async function waitForPageLoad(adapter: MinimalAdapter): Promise<void> {
  try {
    // Wait for network to settle
    await adapter.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    // Additional wait for JS rendering
    await adapter.page.waitForTimeout(PAGE_TRANSITION_WAIT_MS);
  } catch {
    // Non-fatal — page may already be loaded
  }
}

/**
 * Click "Save and Continue" / "Next" via direct Playwright DOM click.
 * This prevents the LLM act() from bleeding into the next page.
 *
 * SAFETY: If the only available button is "Submit", check if this is the review page
 * first. If it is, do NOT click — the main loop will detect "review" and stop.
 */
export async function clickSaveAndContinueDOM(adapter: MinimalAdapter): Promise<void> {
  const result = await adapter.page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));

    // Priority 1: Safe buttons that never submit the application
    const safePriorities = ['save and continue', 'next', 'continue'];
    for (const target of safePriorities) {
      const btn = buttons.find(b => (b.textContent?.trim().toLowerCase() || '') === target);
      if (btn) {
        (btn as HTMLElement).click();
        return 'clicked';
      }
    }
    // Partial match for safe buttons
    const fallback = buttons.find(b => {
      const text = b.textContent?.trim().toLowerCase() || '';
      return text.includes('save and continue') || text.includes('next');
    });
    if (fallback) {
      (fallback as HTMLElement).click();
      return 'clicked';
    }

    // Priority 2: "Submit" — but ONLY if this is NOT the review page.
    // The review page is a read-only summary with no editable form fields.
    const submitBtn = buttons.find(b => {
      const text = b.textContent?.trim().toLowerCase() || '';
      return text === 'submit' || text === 'submit application';
    });
    if (submitBtn) {
      // Check if this looks like the review page
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
      const isReviewHeading = headings.some(h => (h.textContent || '').toLowerCase().includes('review'));
      // Review pages have no editable inputs, no "Select One" dropdowns, no unchecked checkboxes
      const hasEditableInputs = document.querySelectorAll(
        'input[type="text"]:not([readonly]), textarea:not([readonly]), input[type="email"], input[type="tel"]'
      ).length > 0;
      const hasSelectOne = buttons.some(b => (b.textContent?.trim() || '') === 'Select One');
      const hasUncheckedRequired = document.querySelectorAll('input[type="checkbox"]:not(:checked)').length > 0;

      if (isReviewHeading || (!hasEditableInputs && !hasSelectOne && !hasUncheckedRequired)) {
        return 'review_detected';
      }

      (submitBtn as HTMLElement).click();
      return 'clicked';
    }

    return 'not_found';
  });

  if (result === 'review_detected') {
    getLogger().info('Review page detected, not clicking Submit');
    return;
  }

  if (result === 'not_found') {
    // Last resort: use LLM but with very strict instruction — NEVER click Submit
    getLogger().warn('DOM click failed, falling back to LLM act()');
    await adapter.act(
      'Click the "Save and Continue" button. Click ONLY that button and then STOP. Do absolutely nothing else. Do NOT click "Submit" or "Submit Application".',
    );
  }
}

/**
 * Click "Save and Continue" and check for Workday validation errors.
 * If errors are found, scroll to find unfilled required fields, fill them, and retry.
 */
export async function clickNextWithErrorRecovery(
  adapter: MinimalAdapter,
  fillPrompt: string,
  pageLabel: string,
  fullQAMap: Record<string, string>,
): Promise<void> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Scroll to bottom where the Save and Continue button lives
    await adapter.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await adapter.page.waitForTimeout(800);

    getLogger().debug('Clicking Save and Continue', { pageLabel, attempt });
    await clickSaveAndContinueDOM(adapter);

    // Wait for page response
    await adapter.page.waitForTimeout(2000);

    // Check for Workday validation error banner via DOM
    const hasErrors = await adapter.page.evaluate(() => {
      // Workday shows errors in a banner with class containing 'error' or in an element with role='alert'
      const errorBanner = document.querySelector(
        '[data-automation-id="errorMessage"], [role="alert"], .css-1fdonr0, [class*="WJLK"]'
      );
      if (errorBanner && errorBanner.textContent?.toLowerCase().includes('error')) return true;
      // Also check for text "Errors Found" anywhere visible
      const allText = document.body.innerText;
      return allText.includes('Errors Found') || allText.includes('Error -');
    });

    if (!hasErrors) {
      // No errors — page navigation succeeded
      getLogger().info('Save and Continue succeeded', { pageLabel });
      await waitForPageLoad(adapter);
      return;
    }

    getLogger().info('Validation errors detected, clicking error jump links', { pageLabel });

    // Scroll to top first so we see the error banner
    await adapter.page.evaluate(() => window.scrollTo(0, 0));
    await adapter.page.waitForTimeout(500);

    // Auto-click each error jump link to navigate to the missing field, then fill it
    const errorLinks = await adapter.page.evaluate(() => {
      // Workday error banners contain clickable links (usually <a> tags) that jump to the field
      const links = Array.from(document.querySelectorAll(
        '[data-automation-id="errorMessage"] a, [role="alert"] a, ' +
        '[class*="error"] a, [class*="WJLK"] a'
      ));
      // Also check for inline error links in the error summary
      const allLinks = document.querySelectorAll('a');
      for (const a of allLinks) {
        const text = (a.textContent || '').trim();
        const parent = a.closest('[data-automation-id="errorMessage"], [role="alert"]');
        if (parent && text.length > 5) links.push(a);
      }
      return links.length;
    });

    if (errorLinks > 0) {
      getLogger().info('Found error links, clicking each one', { pageLabel, errorLinks });
      // Click each error link one at a time, then fill the field it jumps to
      for (let linkIdx = 0; linkIdx < errorLinks; linkIdx++) {
        await adapter.page.evaluate((idx: number) => {
          const links = Array.from(document.querySelectorAll(
            '[data-automation-id="errorMessage"] a, [role="alert"] a'
          ));
          if (links[idx]) (links[idx] as HTMLElement).click();
        }, linkIdx);
        await adapter.page.waitForTimeout(800);

        // Now fill any empty field that's visible after jumping
        await fillDateFieldsProgrammatically(adapter);
      }
    }

    // Use LLM to handle any remaining errors the DOM couldn't fix
    await adapter.act(
      `There are validation errors on this page. Look for any error messages or fields highlighted in red. If you see clickable error links at the top of the page, click on each one — they will jump you directly to the missing field. Then fill in the correct value. For each missing/invalid field:
1. CLICK on the error link to jump to it, OR click directly on the field.
2. Fill in the correct value or select the correct option.
3. CLICK on empty whitespace to deselect.

${fillPrompt}`,
    );

    // Also do a full programmatic scroll pass to catch anything the LLM missed
    for (let scrollPass = 0; scrollPass < 5; scrollPass++) {
      const before = await adapter.page.evaluate(() => window.scrollY);
      const max = await adapter.page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      if (before >= max - 10) break;

      await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
      await adapter.page.waitForTimeout(800);

      const after = await adapter.page.evaluate(() => window.scrollY);
      if (after <= before) break;

      // Only invoke LLM if there are still empty fields
      const hasEmpty = await hasEmptyVisibleFields(adapter);
      if (hasEmpty) {
        await adapter.act(
          `If there are any EMPTY required fields visible on screen (marked with * or highlighted in red), CLICK on each one and fill it with the correct value. If ALL visible fields are already filled, do NOTHING — just stop immediately.

${fillPrompt}`,
        );
      }
    }
  }

  // After max retries, proceed anyway (let the main loop handle it)
  getLogger().warn('Still has errors after max retries, proceeding', { pageLabel, maxRetries: MAX_RETRIES });
  await waitForPageLoad(adapter);
}
