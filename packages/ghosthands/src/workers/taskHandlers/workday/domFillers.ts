/**
 * DOM-based programmatic fill functions for Workday forms.
 *
 * These functions fill form fields (dropdowns, dates, checkboxes, text fields)
 * directly via DOM manipulation, bypassing the LLM for cost efficiency.
 */

import type { BrowserAutomationAdapter } from '../../../adapters/types.js';
import { getLogger } from '../../../monitoring/logger.js';

/**
 * Programmatically fill Workday dropdowns that still show "Select One".
 * Bypasses the LLM entirely — uses DOM queries to find options and click them.
 */
export async function fillDropdownsProgrammatically(
  adapter: BrowserAutomationAdapter,
  fullQAMap: Record<string, string>,
): Promise<number> {
  // Step 1: Scan page for all unfilled dropdowns and find their question labels.
  // Uses a string-based evaluate to avoid Bun/esbuild __name injection into browser context.
  const dropdownInfos: Array<{ index: number; label: string }> = await adapter.page.evaluate(`
    (() => {
      var results = [];
      var buttons = document.querySelectorAll('button');
      var idx = 0;

      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var text = (btn.textContent || '').trim();
        if (text !== 'Select One') continue;

        var rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        btn.setAttribute('data-gh-dropdown-idx', String(idx));

        var labelText = '';

        // Strategy 1: aria-label on the button or a close ancestor
        if (!labelText) {
          var ariaLabel = btn.getAttribute('aria-label');
          if (!ariaLabel || ariaLabel === 'Select One') {
            var ariaParent = btn.closest('[aria-label]');
            if (ariaParent) ariaLabel = ariaParent.getAttribute('aria-label');
          }
          if (ariaLabel && ariaLabel !== 'Select One') {
            labelText = ariaLabel;
          }
        }

        // Strategy 2: Walk up to find a <label> tag
        if (!labelText) {
          var node = btn.parentElement;
          for (var d = 0; d < 10 && node; d++) {
            var lbl = node.querySelector('label');
            if (lbl && (lbl.textContent || '').trim() && (lbl.textContent || '').trim() !== 'Select One') {
              labelText = (lbl.textContent || '').trim();
              break;
            }
            node = node.parentElement;
          }
        }

        // Strategy 3: data-automation-id labels (Workday-specific)
        if (!labelText) {
          var daParent = btn.closest('[data-automation-id]');
          if (daParent) {
            var labelEls = daParent.querySelectorAll('[data-automation-id*="formLabel"], [data-automation-id*="label"], [data-automation-id*="questionText"]');
            for (var le = 0; le < labelEls.length; le++) {
              var t = (labelEls[le].textContent || '').trim();
              if (t && t !== 'Select One' && t.length > 3) {
                labelText = t;
                break;
              }
            }
          }
        }

        // Strategy 4 (NEW): Find the nearest ancestor that acts as a "question container"
        // by walking up until we find one that has exactly one "Select One" button.
        // That ancestor's text content (minus the button text) is the question label.
        // This is the most reliable strategy for Application Questions pages where
        // each question is wrapped in a container div with nested sub-divs.
        if (!labelText) {
          var ancestor = btn.parentElement;
          for (var up = 0; up < 12 && ancestor; up++) {
            // Count how many "Select One" buttons are inside this ancestor
            var selectBtns = ancestor.querySelectorAll('button');
            var selectOneCount = 0;
            for (var sb = 0; sb < selectBtns.length; sb++) {
              if ((selectBtns[sb].textContent || '').trim() === 'Select One') selectOneCount++;
            }
            // If this ancestor contains exactly 1 "Select One" button (ours),
            // its text is likely the question + "Select One" + maybe "Required"
            if (selectOneCount === 1) {
              var fullText = (ancestor.textContent || '').trim();
              // Remove "Select One", "Required", asterisks
              var cleaned = fullText
                .replace(/Select One/g, '')
                .replace(/Required/gi, '')
                .replace(/[*]/g, '')
                .trim();
              // Only accept if there's meaningful question text remaining
              if (cleaned.length > 8) {
                labelText = cleaned;
                break;
              }
            }
            ancestor = ancestor.parentElement;
          }
        }

        // Strategy 5: Walk up and check preceding siblings
        if (!labelText) {
          var container = btn.parentElement;
          for (var u = 0; u < 8 && container; u++) {
            var prev = container.previousElementSibling;
            if (prev) {
              var pt = (prev.textContent || '').trim();
              if (pt && pt.length > 5 && pt !== 'Select One' && pt !== 'Required') {
                labelText = pt;
                break;
              }
            }
            container = container.parentElement;
          }
        }

        // Strategy 6: Look at all text in parent divs (up to 6 levels), skipping
        // any text that belongs to other dropdown buttons
        if (!labelText) {
          var parentNode = btn.parentElement;
          for (var p = 0; p < 6 && parentNode; p++) {
            var childNodes = parentNode.childNodes;
            for (var cn = 0; cn < childNodes.length; cn++) {
              var child = childNodes[cn];
              if (child === btn) continue;
              if (child.contains && child.contains(btn)) continue;
              var candidateText = '';
              if (child.nodeType === 3) {
                candidateText = (child.textContent || '').trim();
              } else if (child.nodeType === 1) {
                var tag = (child.tagName || '').toLowerCase();
                if (tag === 'button' || tag === 'input' || tag === 'select') continue;
                candidateText = (child.textContent || '').trim();
              }
              if (candidateText && candidateText.length > 5
                  && candidateText !== 'Select One'
                  && candidateText !== 'Required') {
                labelText = candidateText;
                break;
              }
            }
            if (labelText) break;
            parentNode = parentNode.parentElement;
          }
        }

        // Strategy 7: Relaxed container search — accept containers with 2-3 "Select One"
        // buttons and look at text that appears BEFORE this specific button in DOM order.
        // Also check for Workday's aria-describedby or aria-labelledby references.
        if (!labelText) {
          // Try aria-describedby / aria-labelledby on the button
          var describedBy = btn.getAttribute('aria-describedby') || btn.getAttribute('aria-labelledby');
          if (describedBy) {
            var ids = describedBy.split(/\\s+/);
            for (var di = 0; di < ids.length; di++) {
              var el = document.getElementById(ids[di]);
              if (el) {
                var txt = (el.textContent || '').trim();
                if (txt && txt.length > 5 && txt !== 'Select One') {
                  labelText = txt;
                  break;
                }
              }
            }
          }
        }
        if (!labelText) {
          // Walk up further (up to 15 levels) and find any container with
          // meaningful text before this button
          var anc = btn.parentElement;
          for (var w = 0; w < 15 && anc; w++) {
            var ancText = (anc.textContent || '');
            // Must have substantial text beyond just button/boilerplate text
            var stripped = ancText
              .replace(/Select One/g, '')
              .replace(/Required/gi, '')
              .replace(/[*]/g, '')
              .trim();
            if (stripped.length > 15 && stripped.length < 2000) {
              // Extract just the first substantial sentence/question
              var sentences = stripped.split(/[.?!\\n]/).filter(function(s) { return s.trim().length > 10; });
              if (sentences.length > 0) {
                labelText = sentences[0].trim();
                break;
              }
            }
            anc = anc.parentElement;
          }
        }

        // Strategy 8: Positional — find text blocks geometrically ABOVE the button.
        // This catches cases where the question text is in a separate div/paragraph
        // that is NOT an ancestor of the dropdown button (e.g. Workday Application Questions).
        if (!labelText) {
          var btnRect = btn.getBoundingClientRect();
          var bestDist = 9999;
          var bestText = '';
          // Check all block-level text elements
          var textEls = document.querySelectorAll('p, div, span, label, h1, h2, h3, h4, h5, li');
          for (var te = 0; te < textEls.length; te++) {
            var tel = textEls[te];
            // Skip if it contains or is the button
            if (tel.contains(btn) || tel === btn) continue;
            // Skip if it's inside any dropdown
            if (tel.closest('[role="listbox"]')) continue;
            var telRect = tel.getBoundingClientRect();
            // Must be above or at the same level as the button (within 300px)
            if (telRect.bottom > btnRect.top) continue;
            var dist = btnRect.top - telRect.bottom;
            if (dist > 300) continue;
            var telText = (tel.textContent || '').trim();
            // Skip boilerplate
            if (!telText || telText.length < 10 || telText === 'Select One' || telText === 'Required') continue;
            // Skip if this element has children with more specific text (avoid grabbing huge parent text)
            if (tel.children.length > 5) continue;
            // Prefer the closest text block above the button
            if (dist < bestDist) {
              bestDist = dist;
              bestText = telText;
            }
          }
          if (bestText) {
            labelText = bestText;
          }
        }

        // Clean up: remove trailing asterisks, "Required", excess whitespace
        labelText = labelText
          .replace(/\\s*\\*\\s*/g, ' ')
          .replace(/\\s*Required\\s*/gi, '')
          .replace(/\\s+/g, ' ')
          .replace(/Select One/g, '')
          .trim();
        // Truncate very long labels (keep first 200 chars for matching)
        if (labelText.length > 200) {
          labelText = labelText.substring(0, 200).trim();
        }

        results.push({ index: idx, label: labelText });
        idx++;
      }

      return results;
    })()
  `);

  if (dropdownInfos.length === 0) return 0;

  const logger = getLogger();
  logger.debug('Found unfilled dropdowns', { count: dropdownInfos.length, dropdowns: dropdownInfos.map(i => ({ index: i.index, label: i.label || '(empty)' })) });

  let filled = 0;

  for (const info of dropdownInfos) {
    const answer = findBestDropdownAnswer(info.label, fullQAMap);
    if (!answer) {
      logger.debug('No answer matched for dropdown', { label: info.label });
      continue;
    }

    // Verify the button still shows "Select One" (may have been filled by a prior iteration)
    const btn = adapter.page.locator(`button[data-gh-dropdown-idx="${info.index}"]`);
    const stillUnfilled = await btn.textContent().catch(() => '');
    if (!stillUnfilled?.includes('Select One')) continue;

    logger.debug('Programmatically filling dropdown', { label: info.label, answer });

    // Scroll into view and click to open.
    // Use dispatchEvent as backup since Workday's overlapping dropdowns sometimes
    // cause Playwright coordinate-based clicks to open the wrong popup.
    await btn.scrollIntoViewIfNeeded();
    await adapter.page.waitForTimeout(200);

    // Click using Playwright locator (element-targeted, not coordinate)
    await btn.click();
    await adapter.page.waitForTimeout(600);

    // Find and click the matching option in the opened listbox
    let clicked = await clickDropdownOption(adapter, answer);

    // If the option wasn't found, the wrong dropdown might have opened.
    // Close it and retry with a JS dispatchEvent directly on the DOM element.
    if (!clicked) {
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(300);

      logger.debug('Retrying dropdown with dispatchEvent', { label: info.label });
      await adapter.page.evaluate((idx: string) => {
        const el = document.querySelector(`button[data-gh-dropdown-idx="${idx}"]`);
        if (el) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }, String(info.index));
      await adapter.page.waitForTimeout(600);

      clicked = await clickDropdownOption(adapter, answer);
    }

    if (clicked) {
      filled++;
      await adapter.page.waitForTimeout(500);
    } else {
      // Close the dropdown and move on
      await adapter.page.keyboard.press('Escape');
      await adapter.page.waitForTimeout(300);
      logger.warn('Dropdown option not found', { answer, label: info.label });
    }
  }

  // Clean up temporary attributes
  await adapter.page.evaluate(() => {
    document.querySelectorAll('[data-gh-dropdown-idx]').forEach(el => {
      el.removeAttribute('data-gh-dropdown-idx');
    });
  });

  return filled;
}

/**
 * Find and click a dropdown option matching the target answer.
 * Strategy: 1) Check if option is already visible in DOM, 2) Type answer + Enter
 * to trigger Workday's search/filter, wait for results, then click match,
 * 3) If not found, use LLM to scroll through the dropdown and find/click it.
 */
export async function clickDropdownOption(
  adapter: BrowserAutomationAdapter,
  targetAnswer: string,
): Promise<boolean> {
  // Wait for the options popup to appear
  await adapter.page
    .waitForSelector(
      '[role="listbox"], [role="option"], [data-automation-id*="promptOption"]',
      { timeout: 3000 },
    )
    .catch(() => {});

  // For multi-step answers like "Website → then select ...", use only the first part
  let searchText = targetAnswer;
  if (targetAnswer.includes('\u2192')) {
    searchText = targetAnswer.split('\u2192')[0].trim();
  }

  // Phase 1: Check if the option is already visible in the DOM and click it
  const directClick = await adapter.page.evaluate((target: string) => {
    const targetLower = target.toLowerCase();
    const options = document.querySelectorAll(
      '[role="option"], [role="listbox"] li, ' +
        '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
    );

    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || '';
      if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
        (opt as HTMLElement).click();
        return true;
      }
    }
    // Also check if target contains option text (for partial matches)
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || '';
      if (text.length > 2 && targetLower.includes(text)) {
        (opt as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, searchText);

  if (directClick) return true;

  // Phase 2: Type the answer text and press Enter so Workday updates the dropdown list
  getLogger().debug('Dropdown: typing search text and pressing Enter', { searchText });
  await adapter.page.keyboard.type(searchText, { delay: 50 });
  await adapter.page.keyboard.press('Enter');
  // Wait for Workday to process the search and update the dropdown options
  await adapter.page.waitForTimeout(1000);

  // Check if the correct option is now visible after Enter
  const typedMatch = await adapter.page.evaluate((target: string) => {
    const targetLower = target.toLowerCase();
    const options = document.querySelectorAll(
      '[role="option"], [role="listbox"] li, ' +
        '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
    );
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || '';
      if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
        (opt as HTMLElement).click();
        return true;
      }
    }
    // Also try partial match
    for (const opt of options) {
      const text = opt.textContent?.trim().toLowerCase() || '';
      if (text.length > 2 && targetLower.includes(text)) {
        (opt as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, searchText);

  if (typedMatch) return true;

  // Phase 2b: Try fallback search terms if the exact match wasn't found.
  // E.g., "Business Analytics" → try "Business", then "Analytics"
  const fallbackTerms = generateFallbackSearchTerms(searchText);
  if (fallbackTerms.length > 0) {
    getLogger().debug('Trying fallback search terms for dropdown', { original: searchText, fallbacks: fallbackTerms });

    for (const fallback of fallbackTerms) {
      // Clear the current search text
      await adapter.page.keyboard.press('Control+a');
      await adapter.page.waitForTimeout(100);
      await adapter.page.keyboard.press('Backspace');
      await adapter.page.waitForTimeout(300);

      // Type the fallback term and press Enter
      await adapter.page.keyboard.type(fallback, { delay: 50 });
      await adapter.page.keyboard.press('Enter');
      await adapter.page.waitForTimeout(1000);

      // Check if a matching option appeared
      const fallbackMatch = await adapter.page.evaluate((term: string) => {
        const termLower = term.toLowerCase();
        const options = document.querySelectorAll(
          '[role="option"], [role="listbox"] li, ' +
            '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
        );
        // First pass: option text starts with, equals, or contains the fallback term
        for (const opt of options) {
          const text = opt.textContent?.trim().toLowerCase() || '';
          if (text === termLower || text.startsWith(termLower) || text.includes(termLower)) {
            (opt as HTMLElement).click();
            return true;
          }
        }
        // Second pass: fallback term contains option text (partial match)
        for (const opt of options) {
          const text = opt.textContent?.trim().toLowerCase() || '';
          if (text.length > 2 && termLower.includes(text)) {
            (opt as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, fallback);

      if (fallbackMatch) {
        getLogger().debug('Fallback search term matched', { original: searchText, matchedFallback: fallback });
        return true;
      }
    }
  }

  // Phase 3: The correct option is not visible after typing + Enter + fallback terms.
  // Use the LLM to scroll through the dropdown options (click the scrollbar)
  // and find then click the correct option.
  getLogger().debug('Dropdown option not found after search and fallbacks, using LLM to scroll', { searchText });

  const firstWord = searchText.split(/\s+/)[0] || searchText;
  const llmScrollPrompt = [
    `A dropdown menu is currently open on the page.`,
    `I need to find and select the option "${searchText}" (or the closest match).`,
    `IMPORTANT: The exact value "${searchText}" may NOT exist in this dropdown.`,
    `Strategy: First, try clearing the search field and typing a shorter term (e.g., just "${firstWord}" instead of "${searchText}"). Press Enter and wait for results. Then click the closest matching option.`,
    `If that doesn't work, scroll through the dropdown (minimum 20px per scroll) and select the closest matching option you can find.`,
    `Do NOT scroll through the entire list more than once. If you've scrolled through without finding an exact match, pick the best available option.`,
    `Do NOT click outside the dropdown or close it — only search, scroll within it, and select an option.`,
  ].join('\n');

  try {
    await adapter.act(llmScrollPrompt);
    await adapter.page.waitForTimeout(500);

    // Verify the LLM successfully selected something (dropdown should now be closed)
    const dropdownClosed = await adapter.page.evaluate(() => {
      const listbox = document.querySelector('[role="listbox"]');
      if (!listbox) return true;
      const rect = (listbox as HTMLElement).getBoundingClientRect();
      return rect.width === 0 || rect.height === 0;
    });

    if (dropdownClosed) {
      getLogger().debug('Dropdown LLM scroll+select succeeded');
      return true;
    }
  } catch (err) {
    getLogger().warn('Dropdown LLM scroll attempt failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return false;
}

/**
 * Generate fallback search terms for when an exact dropdown match isn't found.
 * Given a multi-word value, returns shorter/broader terms to try.
 *
 * E.g., "Business Analytics" → ["Business", "Analytics"]
 * E.g., "Computer Science and Engineering" → ["Computer", "Engineering", "Science"]
 */
export function generateFallbackSearchTerms(original: string): string[] {
  const stopWords = new Set(['of', 'and', 'in', 'the', 'a', 'an', 'for', 'to', 'with', 'or', 'at', 'by']);
  const words = original.split(/\s+/).filter(w => w.length > 1);
  const meaningfulWords = words.filter(w => !stopWords.has(w.toLowerCase()));

  // No fallbacks for single-word values — the original is already as short as it gets
  if (meaningfulWords.length <= 1 && words.length <= 1) return [];

  const terms: string[] = [];

  // Strategy 1: First meaningful word (usually the primary category)
  // "Business Analytics" → "Business"
  if (meaningfulWords.length > 0) {
    terms.push(meaningfulWords[0]);
  }

  // Strategy 2: Other meaningful words, longest first for specificity
  // "Business Analytics" → "Analytics"
  for (const word of meaningfulWords.slice(1).sort((a, b) => b.length - a.length)) {
    if (!terms.includes(word)) {
      terms.push(word);
    }
  }

  return terms;
}

/**
 * Programmatically fill date fields (MM/DD/YYYY format) on the page.
 * Workday date inputs are segmented (separate MM, DD, YYYY parts) but if you
 * click on the MM part and type the full date as digits (e.g. "02182026"),
 * Workday auto-advances through the segments.
 */
export async function fillDateFieldsProgrammatically(
  adapter: BrowserAutomationAdapter,
): Promise<number> {
  // Find all empty date inputs on the page
  const dateFields = await adapter.page.evaluate(`
    (() => {
      var results = [];
      // Workday date fields have input[placeholder*="MM"] or input[data-automation-id*="date"]
      var dateInputs = document.querySelectorAll(
        'input[placeholder*="MM"], input[data-automation-id*="dateSectionMonth"], input[aria-label*="Month"], input[aria-label*="date"]'
      );
      for (var i = 0; i < dateInputs.length; i++) {
        var inp = dateInputs[i];
        var rect = inp.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // Check if the date field is empty (MM part hasn't been filled)
        if (inp.value && inp.value.trim() !== '' && inp.value !== 'MM') continue;
        // Tag it for Playwright locator
        inp.setAttribute('data-gh-date-idx', String(i));
        // Try to find the label text for this date field
        var label = '';
        var ancestor = inp.parentElement;
        for (var up = 0; up < 8 && ancestor; up++) {
          var labels = ancestor.querySelectorAll('label, [data-automation-id*="formLabel"]');
          for (var l = 0; l < labels.length; l++) {
            var t = (labels[l].textContent || '').trim();
            if (t && t.length > 3) { label = t; break; }
          }
          if (label) break;
          // Also check text content of ancestor if it's small enough
          var allText = (ancestor.textContent || '').trim();
          if (allText.length > 5 && allText.length < 200 && !allText.includes('Select One')) {
            label = allText.replace(/MM.*YYYY/g, '').replace(/[*]/g, '').replace(/Required/gi, '').trim();
            if (label.length > 5) break;
            label = '';
          }
          ancestor = ancestor.parentElement;
        }
        results.push({ index: i, label: label });
      }
      return results;
    })()
  `) as Array<{ index: number; label: string }>;

  if (dateFields.length === 0) return 0;

  // Get today's date in MMDDYYYY format
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = String(now.getFullYear());
  const todayDigits = `${mm}${dd}${yyyy}`;

  let filled = 0;
  for (const field of dateFields) {
    const labelLower = field.label.toLowerCase();
    let dateValue = todayDigits; // Default: today's date

    // Check if the Q&A map has a specific date answer
    if (labelLower.includes('graduation') || labelLower.includes('expected')) {
      // Expected graduation date: May 2027 → 05/01/2027
      dateValue = '05012027';
    } else if (labelLower.includes('start')) {
      dateValue = '08012023';
    } else if (labelLower.includes('end')) {
      dateValue = '05012027';
    }
    // "today's date", "current date", "signature date" → use actual today

    getLogger().debug('Filling date field', { label: field.label || 'date field', date: `${dateValue.substring(0,2)}/${dateValue.substring(2,4)}/${dateValue.substring(4)}` });

    // Use JavaScript to scroll, focus, and click the date input.
    // Playwright's locator.click() fails with "element is outside of the viewport"
    // on Workday's spinbutton date inputs, so we bypass it entirely.
    const clicked = await adapter.page.evaluate((idx: string) => {
      const el = document.querySelector(`input[data-gh-date-idx="${idx}"]`) as HTMLInputElement;
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.click();
      return true;
    }, String(field.index));

    if (!clicked) {
      getLogger().warn('Could not find date input', { fieldIndex: field.index });
      continue;
    }

    await adapter.page.waitForTimeout(300);
    // Type digits — Workday auto-advances from MM to DD to YYYY
    await adapter.page.keyboard.type(dateValue, { delay: 80 });
    await adapter.page.waitForTimeout(200);
    // Tab to deselect
    await adapter.page.keyboard.press('Tab');
    await adapter.page.waitForTimeout(200);
    filled++;
  }

  // Clean up temporary attributes
  await adapter.page.evaluate(() => {
    document.querySelectorAll('[data-gh-date-idx]').forEach(el => {
      el.removeAttribute('data-gh-date-idx');
    });
  });

  return filled;
}

/**
 * Programmatically check any required checkboxes (Terms & Conditions, Privacy, etc.)
 * that are visible and unchecked.
 */
export async function checkRequiredCheckboxes(
  adapter: BrowserAutomationAdapter,
): Promise<number> {
  const checked = await adapter.page.evaluate(`
    (() => {
      var count = 0;
      var checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (var i = 0; i < checkboxes.length; i++) {
        var cb = checkboxes[i];
        if (cb.checked) continue;
        var rect = cb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // Check if this is a required/important checkbox
        var parent = cb.closest('div, label, fieldset');
        var parentText = (parent ? parent.textContent : '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('i have read')) {
          cb.click();
          count++;
        }
      }
      return count;
    })()
  `) as number;

  if (checked > 0) {
    getLogger().debug('Checked required checkboxes', { count: checked });
  }
  return checked;
}

/**
 * Programmatically fill text input fields by matching their labels to the QA map.
 * Handles fields like "Please enter your name:" that are not dropdowns or dates.
 */
export async function fillTextFieldsProgrammatically(
  adapter: BrowserAutomationAdapter,
  fullQAMap: Record<string, string>,
): Promise<number> {
  // Find empty text inputs/textareas with their labels
  const textFields = await adapter.page.evaluate(`
    (() => {
      var results = [];
      var inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        var rect = inp.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < 20 || rect.height < 10) continue;
        if (inp.disabled || inp.readOnly) continue;
        if (inp.type === 'hidden') continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        // Skip date segments
        var ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        // Skip inputs inside dropdowns
        if (inp.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"]')) continue;
        // Skip if already has a value
        if (inp.value && inp.value.trim() !== '') continue;
        // Tag for Playwright
        inp.setAttribute('data-gh-text-idx', String(i));
        // Find label text
        var label = '';
        // Try aria-label
        label = inp.getAttribute('aria-label') || '';
        if (!label || label.length < 5) {
          // Try associated label element
          var id = inp.id;
          if (id) {
            var lbl = document.querySelector('label[for="' + id + '"]');
            if (lbl) label = (lbl.textContent || '').trim();
          }
        }
        if (!label || label.length < 5) {
          // Try positional: find text above by Y coordinate
          var inpRect = inp.getBoundingClientRect();
          var bestDist = 9999;
          var bestLabel = '';
          var candidates = document.querySelectorAll('label, p, div, span, h3, h4');
          for (var c = 0; c < candidates.length; c++) {
            var cel = candidates[c];
            if (cel.contains(inp)) continue;
            var cr = cel.getBoundingClientRect();
            if (cr.bottom > inpRect.top) continue;
            var d = inpRect.top - cr.bottom;
            if (d > 200) continue;
            var ct = (cel.textContent || '').trim();
            if (!ct || ct.length < 5 || ct === 'Select One' || ct === 'Required') continue;
            if (cel.children.length > 5) continue;
            if (d < bestDist) { bestDist = d; bestLabel = ct; }
          }
          if (bestLabel) label = bestLabel;
        }
        label = label.replace(/[*]/g, '').replace(/Required/gi, '').replace(/\\s+/g, ' ').trim();
        results.push({ index: i, label: label });
      }
      return results;
    })()
  `) as Array<{ index: number; label: string }>;

  if (textFields.length === 0) return 0;

  let filled = 0;
  for (const field of textFields) {
    const answer = findBestDropdownAnswer(field.label, fullQAMap);
    if (!answer || answer === 'today') continue; // Skip date answers

    getLogger().debug('Filling text field', { label: field.label, answer });
    const input = adapter.page.locator(`[data-gh-text-idx="${field.index}"]`);
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await adapter.page.waitForTimeout(200);
    await input.click();
    await adapter.page.waitForTimeout(200);
    await input.fill(answer);
    await adapter.page.waitForTimeout(200);
    await adapter.page.keyboard.press('Tab');
    await adapter.page.waitForTimeout(200);
    filled++;
  }

  // Clean up
  await adapter.page.evaluate(() => {
    document.querySelectorAll('[data-gh-text-idx]').forEach(el => {
      el.removeAttribute('data-gh-text-idx');
    });
  });

  return filled;
}

/**
 * Check whether the currently visible viewport has any empty form fields.
 * Returns true if there are empty text inputs, textareas, or unfilled dropdowns.
 * Used to decide whether to invoke the LLM (expensive) or skip.
 */
export async function hasEmptyVisibleFields(
  adapter: BrowserAutomationAdapter,
): Promise<boolean> {
  const result = await adapter.page.evaluate(() => {
    const emptyFields: string[] = [];

    // Check text inputs and textareas
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea'
    );
    for (const input of inputs) {
      // Only check visible, enabled fields
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (input.disabled || input.readOnly) continue;
      if (input.type === 'hidden') continue;
      // Check if it's in the viewport
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      // Skip Workday date segment inputs (MM, DD, YYYY) — they're handled by fillDateFieldsProgrammatically
      const placeholder = input.placeholder?.toUpperCase() || '';
      if (placeholder === 'MM' || placeholder === 'DD' || placeholder === 'YYYY') continue;

      // Skip inputs that are inside a dropdown/listbox container (internal to Workday dropdowns)
      const inDropdown = input.closest('[role="listbox"], [role="combobox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]');
      if (inDropdown) continue;

      // Skip very small inputs (< 20px wide) — likely hidden internal inputs
      if (rect.width < 20 || rect.height < 10) continue;

      // Skip inputs with aria-hidden
      if (input.getAttribute('aria-hidden') === 'true') continue;

      // Skip inputs inside elements with display:none or opacity:0
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // Skip optional/internal fields that are always empty or handled by dropdown widgets
      const automationId = input.getAttribute('data-automation-id') || '';
      const fieldName = input.name || input.id || '';
      const fieldLabel = input.getAttribute('aria-label') || '';
      const fieldIdentifier = (automationId + ' ' + fieldName + ' ' + fieldLabel).toLowerCase();
      if (fieldIdentifier.includes('extension') || fieldIdentifier.includes('countryphone') ||
          fieldIdentifier.includes('country-phone') || fieldIdentifier.includes('phonecode') ||
          fieldIdentifier.includes('middlename') || fieldIdentifier.includes('middle-name') ||
          fieldIdentifier.includes('middle name')) continue;

      if (!input.value || input.value.trim() === '') {
        // Build a debug label for this empty field
        const label = input.getAttribute('aria-label')
          || input.getAttribute('data-automation-id')
          || input.name
          || input.id
          || `${input.tagName}[${input.type || 'text'}]`;
        emptyFields.push(label);
      }
    }

    // Check for unfilled dropdowns ("Select One" buttons)
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.trim();
      if (text !== 'Select One') continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      emptyFields.push(`dropdown:"Select One"`);
    }

    // Check for unchecked required checkboxes (e.g. Terms & Conditions, Privacy acknowledgment)
    const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.checked) continue;
      const rect = cb.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      // Check if it's a required checkbox (look for "Required" or * near it)
      const parent = cb.closest('div, label, fieldset');
      const parentText = (parent?.textContent || '').toLowerCase();
      if (parentText.includes('acknowledge') || parentText.includes('terms') ||
          parentText.includes('agree') || parentText.includes('privacy') ||
          parentText.includes('required') || parentText.includes('*')) {
        emptyFields.push(`checkbox:"${parentText.substring(0, 60)}..."`);
      }
    }

    // Check for unanswered radio button groups
    const radioGroups = new Set<string>();
    document.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(r => {
      if (r.name) radioGroups.add(r.name);
    });
    for (const groupName of radioGroups) {
      const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${groupName}"]`);
      const anyChecked = Array.from(radios).some(r => r.checked);
      if (!anyChecked) {
        // Check if at least one radio in this group is visible
        for (const r of radios) {
          const rect = r.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight) {
            emptyFields.push(`radio:${groupName}`);
            break;
          }
        }
      }
    }

    return emptyFields;
  });

  if (result.length > 0) {
    getLogger().debug('Found empty visible fields', { count: result.length, fields: result });
    return true;
  }
  return false;
}

/**
 * Nudge the first empty field in the current viewport to the center of the screen.
 *
 * IMPORTANT: Only considers fields already within (or near) the current viewport.
 * This prevents fighting with fillWithSmartScroll's progressive top-down scrolling —
 * we never yank the viewport backwards to a field above the current scroll position.
 */
export async function centerNextEmptyField(
  adapter: BrowserAutomationAdapter,
): Promise<boolean> {
  // Uses a string-based evaluate to avoid Bun's __name injection into browser context.
  const centered = await adapter.page.evaluate(`
    (() => {
      var vh = window.innerHeight;

      // 1. Empty text inputs / textareas
      var inputs = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
      );
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.disabled || inp.readOnly) continue;
        if (inp.type === 'hidden') continue;
        var rect = inp.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Only consider fields in or near the current viewport
        if (!(rect.bottom > 0 && rect.top < vh * 1.2)) continue;
        // Skip date segment inputs
        var ph = (inp.placeholder || '').toUpperCase();
        if (ph === 'MM' || ph === 'DD' || ph === 'YYYY') continue;
        // Skip internal dropdown inputs
        if (inp.closest('[role="listbox"], [data-automation-id*="dropdown"], [data-automation-id*="selectWidget"]')) continue;
        // Skip hidden via CSS
        var style = window.getComputedStyle(inp);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (inp.getAttribute('aria-hidden') === 'true') continue;
        // Skip optional internal fields
        var ident = ((inp.getAttribute('data-automation-id') || '') + ' ' + (inp.name || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        if (ident.includes('extension') || ident.includes('countryphone') || ident.includes('phonecode') || ident.includes('middlename') || ident.includes('middle name') || ident.includes('middle-name')) continue;

        if (!inp.value || inp.value.trim() === '') {
          inp.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      // 2. Unfilled dropdowns ("Select One" buttons)
      var buttons = document.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        var text = (btn.textContent || '').trim();
        if (text !== 'Select One') continue;
        var bRect = btn.getBoundingClientRect();
        if (bRect.width === 0 || bRect.height === 0) continue;
        if (!(bRect.bottom > 0 && bRect.top < vh * 1.2)) continue;
        var bStyle = window.getComputedStyle(btn);
        if (bStyle.display === 'none' || bStyle.visibility === 'hidden') continue;
        btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }

      // 3. Unchecked required checkboxes
      var checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
      for (var k = 0; k < checkboxes.length; k++) {
        var cb = checkboxes[k];
        var cRect = cb.getBoundingClientRect();
        if (cRect.width === 0 && cRect.height === 0) continue;
        if (!(cRect.bottom > 0 && cRect.top < vh * 1.2)) continue;
        var parent = cb.closest('div, label, fieldset');
        var parentText = (parent ? parent.textContent : '').toLowerCase();
        if (parentText.includes('acknowledge') || parentText.includes('terms') ||
            parentText.includes('agree') || parentText.includes('privacy') ||
            parentText.includes('required') || parentText.includes('*')) {
          cb.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        }
      }

      return false;
    })()
  `) as boolean;

  if (centered) {
    await adapter.page.waitForTimeout(300);
  }
  return centered;
}

/**
 * Find the best matching answer for a dropdown label from the Q&A map.
 * Uses multi-pass fuzzy matching: exact → contains → keyword overlap → stem overlap.
 */
export function findBestDropdownAnswer(
  label: string,
  qaMap: Record<string, string>,
): string | null {
  if (!label) return null;

  const labelLower = label.toLowerCase().replace(/\*/g, '').trim();
  if (labelLower.length < 2) return null;

  // Pass 1: Exact match (case-insensitive)
  for (const [q, a] of Object.entries(qaMap)) {
    if (q.toLowerCase() === labelLower) return a;
  }

  // Pass 2: Label contains the Q&A key
  for (const [q, a] of Object.entries(qaMap)) {
    if (labelLower.includes(q.toLowerCase())) return a;
  }

  // Pass 3: Q&A key contains the label (for short labels like "Gender", "State")
  for (const [q, a] of Object.entries(qaMap)) {
    if (q.toLowerCase().includes(labelLower) && labelLower.length > 3) return a;
  }

  // Pass 4: Significant word overlap (for rephrased questions)
  const labelWords = new Set(labelLower.split(/\s+/).filter(w => w.length > 3));
  let bestMatch: { answer: string; overlap: number } | null = null;

  for (const [q, a] of Object.entries(qaMap)) {
    const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = qWords.filter(w => labelWords.has(w)).length;
    if (overlap >= 3 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }

  if (bestMatch) return bestMatch.answer;

  // Pass 5: Stem-based overlap — strip common suffixes (ing, ed, s, tion, etc.)
  // so "relocating" matches "relocate", "restrictions" matches "restriction", etc.
  const stem = (word: string) =>
    word.replace(/(ating|ting|ing|tion|sion|ment|ness|able|ible|ed|ly|er|est|ies|es|s)$/i, '');
  const labelStems = new Set(
    labelLower.split(/\s+/).filter(w => w.length > 3).map(stem),
  );
  bestMatch = null;

  for (const [q, a] of Object.entries(qaMap)) {
    const qStems = q.toLowerCase().split(/\s+/).filter(w => w.length > 3).map(stem);
    const overlap = qStems.filter(s => labelStems.has(s)).length;
    if (overlap >= 2 && (!bestMatch || overlap > bestMatch.overlap)) {
      bestMatch = { answer: a, overlap };
    }
  }

  if (bestMatch) return bestMatch.answer;

  return null;
}
