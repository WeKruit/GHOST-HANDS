/**
 * Smart scroll-and-fill logic for Workday forms.
 *
 * Fills visible fields, then programmatically scrolls down one viewport at a time,
 * filling any new fields that appear. Repeats until the bottom is reached.
 * Finally clicks "Save and Continue" / "Next".
 *
 * Strategy: DOM-first, LLM-fallback.
 *   1. Programmatically fill all dropdowns we can match (no LLM needed).
 *   2. Let the LLM handle remaining text fields and any dropdowns we couldn't match.
 *   3. Scroll down and repeat.
 *
 * Early-exit: If there are no empty fields visible (DOM check), skip the LLM
 * call entirely for that scroll round. This prevents the LLM from "triple-checking"
 * fields that are already filled.
 */

import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import { isActuallyReview } from './pageClassifier.js';
import {
  fillDropdownsProgrammatically,
  fillDateFieldsProgrammatically,
  checkRequiredCheckboxes,
  hasEmptyVisibleFields,
  centerNextEmptyField,
} from './domFillers.js';
import { clickNextWithErrorRecovery } from './navigation.js';
import { getLogger } from '../../../monitoring/logger.js';

/**
 * Fill visible fields with smart scrolling, then navigate to the next page.
 *
 * @param adapter - Browser automation adapter
 * @param fillPrompt - LLM prompt for filling fields
 * @param pageLabel - Human-readable label for logging
 * @param fullQAMap - Q&A map for programmatic dropdown filling
 * @returns 'done' if the page was filled and navigated, 'review_detected' if
 *          this is actually the review page (misclassified)
 */
export async function fillWithSmartScroll(
  adapter: BrowserAutomationAdapter,
  fillPrompt: string,
  pageLabel: string,
  fullQAMap: Record<string, string>,
): Promise<'done' | 'review_detected'> {
  const logger = getLogger();
  const MAX_SCROLL_ROUNDS = 10;
  const MAX_LLM_CALLS = 20; // Safety limit: raised because one-dropdown-per-turn needs more calls
  let llmCallCount = 0;

  // SAFETY: Quick check if this is actually the review page (misclassified).
  // If so, bail out immediately — the main loop will re-detect and stop.
  if (await isActuallyReview(adapter)) {
    logger.info('Review page detected, skipping fill logic', { pageLabel });
    return 'review_detected';
  }

  // Scroll to top first
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(500);

  // Dismiss/collapse any Workday error banners so the LLM doesn't get distracted by them.
  // We handle errors ourselves in clickNextWithErrorRecovery.
  await adapter.page.evaluate(() => {
    const errorBanners = document.querySelectorAll(
      '[data-automation-id="errorMessage"], [role="alert"]'
    );
    errorBanners.forEach(el => (el as HTMLElement).style.display = 'none');
    const errorSections = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(el => el.textContent?.includes('Errors Found'));
    errorSections.forEach(el => (el as HTMLElement).click());
  });
  await adapter.page.waitForTimeout(300);

  // Round 1: DOM-first dropdown fill + date fill, then LLM for text fields
  logger.debug('Round 1: DOM fill pass', { pageLabel });
  if (Object.keys(fullQAMap).length > 0) {
    const programmaticFilled = await fillDropdownsProgrammatically(adapter, fullQAMap);
    if (programmaticFilled > 0) {
      logger.debug('Programmatically filled dropdowns', { pageLabel, count: programmaticFilled });
    }
  }
  // DOM-first: fill date fields
  await fillDateFieldsProgrammatically(adapter);
  // DOM-first: check any required checkboxes (Terms & Conditions, Privacy, etc.)
  await checkRequiredCheckboxes(adapter);

  // Scroll back to top so the LLM assessment loop starts from the beginning of the page.
  // DOM fills above may have scrolled the page as they interacted with elements.
  await adapter.page.evaluate(() => window.scrollTo(0, 0));
  await adapter.page.waitForTimeout(400);

  // Check if there are empty fields remaining that need the LLM
  const needsLLM = await hasEmptyVisibleFields(adapter);
  if (needsLLM && llmCallCount < MAX_LLM_CALLS) {
    await centerNextEmptyField(adapter);
    logger.debug('LLM filling remaining fields', { pageLabel, round: 1, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
    await adapter.act(fillPrompt);
    llmCallCount++;
  } else if (llmCallCount >= MAX_LLM_CALLS) {
    logger.debug('LLM call limit reached, skipping', { pageLabel, maxLlmCalls: MAX_LLM_CALLS });
  } else {
    logger.debug('All visible fields filled, skipping LLM', { pageLabel });
  }

  // Scroll-and-fill loop
  for (let round = 2; round <= MAX_SCROLL_ROUNDS; round++) {
    const scrollBefore = await adapter.page.evaluate(() => window.scrollY);
    const scrollMax = await adapter.page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );

    if (scrollBefore >= scrollMax - 10) {
      logger.debug('Reached bottom of page', { pageLabel });
      break;
    }

    // Programmatic scroll: 65% of viewport height so we overlap and don't miss fields
    await adapter.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await adapter.page.waitForTimeout(800);

    const scrollAfter = await adapter.page.evaluate(() => window.scrollY);
    if (scrollAfter <= scrollBefore) {
      logger.debug('Cannot scroll further', { pageLabel });
      break;
    }

    logger.debug('Scrolled page', { pageLabel, scrollY: scrollAfter, round });

    // DOM-first: fill dropdowns, date fields, and checkboxes programmatically
    if (Object.keys(fullQAMap).length > 0) {
      const programmaticFilled = await fillDropdownsProgrammatically(adapter, fullQAMap);
      if (programmaticFilled > 0) {
        logger.debug('Programmatically filled dropdowns', { pageLabel, count: programmaticFilled });
      }
    }
    await fillDateFieldsProgrammatically(adapter);
    await checkRequiredCheckboxes(adapter);

    // Only invoke the LLM if there are still empty fields visible AND we haven't hit the limit
    if (llmCallCount >= MAX_LLM_CALLS) {
      logger.debug('LLM call limit reached, skipping round', { pageLabel, maxLlmCalls: MAX_LLM_CALLS, round });
      continue;
    }
    const stillNeedsLLM = await hasEmptyVisibleFields(adapter);
    if (stillNeedsLLM) {
      await centerNextEmptyField(adapter);
      logger.debug('LLM filling remaining fields', { pageLabel, round, llmCall: llmCallCount + 1, maxLlmCalls: MAX_LLM_CALLS });
      await adapter.act(fillPrompt);
      llmCallCount++;
    } else {
      logger.debug('All visible fields filled, skipping LLM', { pageLabel });
    }
  }

  logger.info('Page complete', { pageLabel, totalLlmCalls: llmCallCount });

  // Final: click the navigation button and handle validation errors
  await clickNextWithErrorRecovery(adapter, fillPrompt, pageLabel, fullQAMap);
  return 'done';
}
