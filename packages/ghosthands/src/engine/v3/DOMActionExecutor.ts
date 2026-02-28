/**
 * DOMActionExecutor — Tier 0 (Playwright, $0) + Tier 3 (Magnitude LLM, ~$0.01) form filler.
 *
 * Executes ActionItems against a Playwright page. Tier 0 methods use direct DOM
 * manipulation for zero-cost fills. When Tier 0 fails or the action is already
 * assigned Tier 3, falls back to the adapter's LLM-based act() method.
 */

import type { Page } from 'playwright';
import type { BrowserAutomationAdapter } from '../../adapters/types';
import type { ActionItem, FieldModel } from './v2types';
import { getLogger } from '../../monitoring/logger';

export class DOMActionExecutor {
  private readonly logger = getLogger();

  constructor(
    private page: Page,
    private adapter: BrowserAutomationAdapter,
  ) {}

  /**
   * Detect fatal browser errors that should abort the run, not be swallowed
   * as fast-escalation misses. These indicate the browser/page is gone.
   */
  private isFatalBrowserError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /target closed|browser has been closed|execution context was destroyed|page closed/i.test(msg);
  }

  /**
   * Execute a single action item. Tries Tier 0 first (if action.tier === 0),
   * then escalates to Tier 3 on failure. If action.tier === 3, goes directly
   * to the LLM.
   */
  async execute(action: ActionItem): Promise<{ success: boolean; error?: string }> {
    const { field, value, tier } = action;
    let tier0Error: string | undefined;

    // Tier 0 — try direct DOM manipulation first
    if (tier === 0) {
      try {
        const tier0Result = await this.executeTier0(field, value);
        if (tier0Result === true) {
          this.logger.debug('Tier 0 fill succeeded', {
            label: field.label,
            fieldType: field.fieldType,
            tier: 0,
          });
          return { success: true };
        }
        // 'already_filled' means the field has a value — that's success, not a failure.
        // Escalating to Magnitude for already-filled fields wastes LLM budget.
        if (tier0Result === 'already_filled') {
          this.logger.debug('Tier 0 field already filled, treating as success', {
            label: field.label,
            fieldType: field.fieldType,
          });
          return { success: true };
        }
        // Only 'not_found' and 'no_handler' should trigger fast escalation.
        if (tier0Result === 'not_found' || tier0Result === 'no_handler') {
          tier0Error = `element_not_found: "${field.label}" (${field.fieldType})`;
        } else {
          // 'no_match' — dropdown option not found, worth escalating
          tier0Error = `${tier0Result}: "${field.label}" (${field.fieldType})`;
        }
      } catch (err) {
        if (this.isFatalBrowserError(err)) throw err;
        tier0Error = err instanceof Error ? err.message : String(err);
        this.logger.debug('Tier 0 fill threw, escalating to Tier 3', {
          label: field.label,
          fieldType: field.fieldType,
          error: tier0Error,
        });
      }

      // When the adapter is a stub (DOMHand), skip Tier 3 entirely.
      // The stub adapter always fails with a generic error that masks the
      // original Tier 0 failure reason needed for fast escalation.
      if ((this.adapter as any).type === 'stub') {
        this.logger.debug('Skipping Tier 3 (stub adapter), returning Tier 0 error', {
          label: field.label,
          error: tier0Error,
        });
        return { success: false, error: tier0Error };
      }

      this.logger.debug('Tier 0 fill failed, escalating to Tier 3', {
        label: field.label,
        fieldType: field.fieldType,
      });
    }

    // Tier 3 — LLM-based fill
    try {
      const llmSuccess = await this.fillWithLLM(field, value);
      this.logger.debug('Tier 3 LLM fill result', {
        label: field.label,
        fieldType: field.fieldType,
        tier: 3,
        success: llmSuccess,
      });
      if (llmSuccess) {
        return { success: true };
      }
      // If Tier 3 also fails and we had a Tier 0 error, preserve it
      // so the orchestrator can use it for fast escalation classification.
      return { success: false, error: tier0Error ?? `LLM fill returned failure for "${field.label}"` };
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn('Tier 3 LLM fill threw', {
        label: field.label,
        fieldType: field.fieldType,
        error: errorMsg,
      });
      return { success: false, error: tier0Error ?? errorMsg };
    }
  }

  // ── Tier 0 dispatcher ──────────────────────────────────────────────────

  /**
   * Route to the appropriate Tier 0 method based on field type.
   * Returns true on success, or a typed failure reason string:
   *   - 'not_found': element not in DOM (should trigger fast escalation)
   *   - 'already_filled': element exists but already has a value (should NOT escalate)
   *   - 'no_match': element found but value matching failed (e.g. no option in dropdown)
   *   - 'no_handler': no Tier 0 handler for this field type (should trigger fast escalation)
   */
  private async executeTier0(field: FieldModel, value: string): Promise<true | 'not_found' | 'already_filled' | 'no_match' | 'no_handler'> {
    switch (field.fieldType) {
      case 'text':
      case 'email':
      case 'phone':
      case 'number':
      case 'password':
      case 'textarea':
      case 'contenteditable': {
        const result = await this.fillText(field, value);
        if (result === true) return true;
        if (result === 'already_filled') return 'already_filled';
        return 'not_found';
      }

      case 'select': {
        return await this.fillSelect(field, value);
      }

      case 'custom_dropdown':
      case 'typeahead': {
        return await this.fillCustomDropdown(field, value);
      }

      case 'radio': {
        return await this.fillRadio(field, value);
      }

      case 'aria_radio': {
        return await this.fillAriaRadio(field, value);
      }

      case 'checkbox': {
        const result = await this.checkCheckbox(field);
        return result || 'not_found';
      }

      case 'date': {
        const result = await this.fillDate(field, value);
        return result || 'not_found';
      }

      default:
        this.logger.debug('No Tier 0 handler for field type', {
          label: field.label,
          fieldType: field.fieldType,
        });
        return 'no_handler';
    }
  }

  // ── Tier 0 methods ($0) ────────────────────────────────────────────────

  /**
   * Fill a text input or textarea using the native value setter pattern.
   * React-compatible: dispatches input, change, and blur events so React
   * picks up the new value.
   */
  private async fillText(field: FieldModel, value: string): Promise<boolean | 'already_filled'> {
    try {
      await this.scrollFieldIntoView(field);

      const filled = await this.page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return 'not_found';

        // Skip if already filled WITH THE CORRECT value — not worth re-filling.
        // If the existing value is WRONG (stale from a previous session), overwrite it.
        const existing = (el.value || '').trim();
        if (existing !== '' && existing.toLowerCase() === val.trim().toLowerCase()) {
          return 'already_filled';
        }

        const proto =
          el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

        return true;
      }, { sel: field.selector, val: value });

      if (filled === 'already_filled') {
        this.logger.debug('fillText skipped (already filled)', { label: field.label });
        return 'already_filled';
      }
      const success = filled === true;
      this.logger.debug('fillText result', { label: field.label, success });
      return success;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('fillText error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fill a native <select> element by finding the best matching <option>
   * via normalized text comparison, then setting the value with native setter.
   */
  private async fillSelect(field: FieldModel, value: string): Promise<true | 'not_found' | 'no_match'> {
    try {
      await this.scrollFieldIntoView(field);

      const filled = await this.page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return 'not_found';

        const valLower = val.toLowerCase().trim();

        // Find the best matching option
        let bestOption: HTMLOptionElement | null = null;
        let bestScore = -1;
        const options = el.querySelectorAll('option');

        for (const opt of options) {
          const optText = (opt.textContent || '').trim().toLowerCase();
          const optValue = (opt.value || '').trim().toLowerCase();

          // Exact match on text or value — highest priority
          if (optText === valLower || optValue === valLower) {
            bestOption = opt;
            bestScore = 3;
            break;
          }
          // Option text starts with value
          if (optText.startsWith(valLower) && bestScore < 2) {
            bestOption = opt;
            bestScore = 2;
          }
          // Option text contains value
          if (optText.includes(valLower) && bestScore < 1) {
            bestOption = opt;
            bestScore = 1;
          }
          // Value contains option text (partial reverse match)
          if (optText.length > 2 && valLower.includes(optText) && bestScore < 0) {
            bestOption = opt;
            bestScore = 0;
          }
        }

        if (!bestOption) return 'no_match';

        // Use native setter for React compatibility
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, bestOption.value);
        } else {
          el.value = bestOption.value;
        }

        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));

        return true;
      }, { sel: field.selector, val: value });

      this.logger.debug('fillSelect result', { label: field.label, success: filled === true });
      return filled;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('fillSelect error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'not_found';
    }
  }

  /**
   * Fill a Workday-style custom dropdown ("Select One" button).
   * Opens the dropdown, optionally types to filter, finds and clicks the
   * matching option, then closes any stray popup.
   */
  private async fillCustomDropdown(field: FieldModel, value: string): Promise<true | 'not_found' | 'no_match'> {
    try {
      await this.scrollFieldIntoView(field);

      // Step 1: Click the dropdown button to open it
      const dropdownLocator = this.page.locator(field.selector).first();
      await dropdownLocator.click();
      await this.page.waitForTimeout(500);

      // Step 2: Look for a search/filter input in the popup and type to filter
      const hasSearchInput = await this.page.evaluate(() => {
        const popup =
          document.querySelector('[role="listbox"]') ||
          document.querySelector('[data-automation-id*="promptOption"]')?.closest('[role="dialog"], [class*="popup"], [class*="dropdown"]');
        if (!popup) return false;

        const searchInput = popup.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null;
        if (searchInput && searchInput.getBoundingClientRect().width > 0) {
          searchInput.focus();
          return true;
        }
        return false;
      });

      if (hasSearchInput) {
        await this.page.keyboard.type(value, { delay: 50 });
        await this.page.waitForTimeout(500);
      }

      // Step 3: Find and click the matching option
      let clicked = await this.clickMatchingOption(value);

      // Step 4: If exact match failed, try progressively shorter prefixes
      if (!clicked) {
        const fallbackTerms = this.generateFallbackTerms(value);
        for (const term of fallbackTerms) {
          // Clear and re-type if we have a search input
          if (hasSearchInput) {
            await this.page.keyboard.press('Control+a');
            await this.page.waitForTimeout(100);
            await this.page.keyboard.press('Backspace');
            await this.page.waitForTimeout(200);
            await this.page.keyboard.type(term, { delay: 50 });
            await this.page.waitForTimeout(500);
          }

          clicked = await this.clickMatchingOption(term);
          if (clicked) break;
        }
      }

      // Close any stray popup — only click empty space if dropdown was successfully opened.
      // Clicking at (10,10) on failure can interact with unrelated page elements.
      if (clicked) {
        await this.page.waitForTimeout(300);
        await this.page.mouse.click(10, 10);
        await this.page.waitForTimeout(200);
      } else {
        // Close popup without clicking arbitrary coordinates
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(200);
      }

      this.logger.debug('fillCustomDropdown result', { label: field.label, success: clicked });
      return clicked ? true : 'no_match';
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      // Try to close any open popup before returning
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(200);

      this.logger.debug('fillCustomDropdown error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      // Catch block = element interaction failed entirely → not_found
      return 'not_found';
    }
  }

  /**
   * Fill a native radio button group by matching the value to option labels.
   * Uses the field's groupKey (the `name` attribute) to find all radios in the group.
   */
  private async fillRadio(field: FieldModel, value: string): Promise<true | 'not_found' | 'no_match'> {
    try {
      await this.scrollFieldIntoView(field);

      const clicked = await this.page.evaluate(({ groupKey, val }) => {
        if (!groupKey) return 'not_found';

        const radios = document.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${groupKey}"]`,
        );
        if (radios.length === 0) return 'not_found';

        const valLower = val.toLowerCase().trim();

        // Build list of radio options with their labels
        const options: Array<{ radio: HTMLInputElement; label: string }> = [];
        for (const radio of radios) {
          let label = '';

          // Strategy 1: Associated <label> element
          if (radio.id) {
            const lbl = document.querySelector(`label[for="${radio.id}"]`);
            if (lbl) label = (lbl.textContent || '').trim();
          }
          // Strategy 2: Parent <label>
          if (!label) {
            const parentLabel = radio.closest('label');
            if (parentLabel) label = (parentLabel.textContent || '').trim();
          }
          // Strategy 3: Sibling text node
          if (!label && radio.nextSibling) {
            label = (radio.nextSibling.textContent || '').trim();
          }

          options.push({ radio, label });
        }

        // Find the best matching option
        let bestMatch: HTMLInputElement | null = null;

        // Exact match
        for (const opt of options) {
          if (opt.label.toLowerCase().trim() === valLower) {
            bestMatch = opt.radio;
            break;
          }
        }

        // Starts-with match
        if (!bestMatch) {
          for (const opt of options) {
            const optLower = opt.label.toLowerCase().trim();
            if (optLower.startsWith(valLower) || valLower.startsWith(optLower)) {
              bestMatch = opt.radio;
              break;
            }
          }
        }

        // Contains match
        if (!bestMatch) {
          for (const opt of options) {
            const optLower = opt.label.toLowerCase().trim();
            if (optLower.includes(valLower) || valLower.includes(optLower)) {
              bestMatch = opt.radio;
              break;
            }
          }
        }

        if (!bestMatch) return 'no_match';

        bestMatch.click();
        bestMatch.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, { groupKey: field.groupKey || '', val: value });

      this.logger.debug('fillRadio result', { label: field.label, success: clicked === true });
      return clicked;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('fillRadio error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'not_found';
    }
  }

  /**
   * Fill an ARIA radiogroup (role="radio" children inside a role="radiogroup" container).
   * Used for custom radio implementations that don't use native <input type="radio">.
   */
  private async fillAriaRadio(field: FieldModel, value: string): Promise<true | 'not_found' | 'no_match'> {
    try {
      await this.scrollFieldIntoView(field);

      const clicked = await this.page.evaluate(({ sel, val }) => {
        const group = document.querySelector(sel);
        if (!group) return 'not_found';

        const radios = group.querySelectorAll('[role="radio"]');
        if (radios.length === 0) return 'not_found';

        const valLower = val.toLowerCase().trim();

        // Build option list with text content
        const options: Array<{ el: HTMLElement; text: string }> = [];
        for (const radio of radios) {
          const text = (radio.textContent || '').trim();
          options.push({ el: radio as HTMLElement, text });
        }

        // Exact match
        for (const opt of options) {
          if (opt.text.toLowerCase().trim() === valLower) {
            opt.el.click();
            return true;
          }
        }

        // Starts-with match
        for (const opt of options) {
          const optLower = opt.text.toLowerCase().trim();
          if (optLower.startsWith(valLower) || valLower.startsWith(optLower)) {
            opt.el.click();
            return true;
          }
        }

        // Contains match
        for (const opt of options) {
          const optLower = opt.text.toLowerCase().trim();
          if (optLower.includes(valLower) || valLower.includes(optLower)) {
            opt.el.click();
            return true;
          }
        }

        return 'no_match';
      }, { sel: field.selector, val: value });

      this.logger.debug('fillAriaRadio result', { label: field.label, success: clicked === true });
      return clicked;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('fillAriaRadio error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'not_found';
    }
  }

  /**
   * Check a checkbox if it is not already checked.
   * Handles both native <input type="checkbox"> and ARIA role="checkbox".
   */
  private async checkCheckbox(field: FieldModel): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      const checked = await this.page.evaluate(({ sel }) => {
        const el = document.querySelector(sel);
        if (!el) return false;

        // Native checkbox
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          if (el.checked) return true; // Already checked
          el.click();
          return true;
        }

        // ARIA role="checkbox"
        if (el.getAttribute('role') === 'checkbox') {
          const isChecked = el.getAttribute('aria-checked') === 'true';
          if (isChecked) return true; // Already checked
          (el as HTMLElement).click();
          return true;
        }

        // Generic clickable element — try clicking it
        (el as HTMLElement).click();
        return true;
      }, { sel: field.selector });

      this.logger.debug('checkCheckbox result', { label: field.label, success: checked });
      return checked;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('checkCheckbox error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fill a date field by clicking it and typing the date digits.
   * Handles Workday's segmented MM/DD/YYYY date inputs where typing
   * continuously auto-advances through each segment.
   */
  private async fillDate(field: FieldModel, value: string): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      // Click the date field to focus it
      const focusClicked = await this.page.evaluate(({ sel }) => {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
        return true;
      }, { sel: field.selector });

      if (!focusClicked) {
        this.logger.debug('fillDate: element not found', { label: field.label });
        return false;
      }

      await this.page.waitForTimeout(300);

      // Type the date digits — Workday auto-advances from MM to DD to YYYY
      await this.page.keyboard.type(value, { delay: 50 });
      await this.page.waitForTimeout(200);

      // Tab to deselect and commit the value
      await this.page.keyboard.press('Tab');
      await this.page.waitForTimeout(200);

      this.logger.debug('fillDate result', { label: field.label, success: true });
      return true;
    } catch (err) {
      if (this.isFatalBrowserError(err)) throw err;
      this.logger.debug('fillDate error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── Tier 3 method (~$0.01) ─────────────────────────────────────────────

  /**
   * Fill a field using the adapter's LLM-based act() method.
   * This is the expensive fallback when DOM manipulation fails.
   */
  private async fillWithLLM(field: FieldModel, value: string): Promise<boolean> {
    const prompt = value
      ? `Fill ONLY the "${field.label}" field with "${value}". Click the field, type/select the value, then click whitespace to deselect. Do NOT interact with any other fields. Do NOT scroll. Do NOT navigate.`
      : `Look at the "${field.label}" field and fill it with the most appropriate value based on what you can see. Do NOT interact with any other fields. Do NOT scroll. Do NOT navigate.`;

    await this.scrollFieldIntoView(field);
    const result = await this.adapter.act(prompt);
    return result.success !== false;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Scroll a field's element into the center of the viewport and wait for
   * the scroll to settle.
   */
  private async scrollFieldIntoView(field: FieldModel): Promise<void> {
    await this.page.evaluate(
      (sel: string) =>
        document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'instant' }),
      field.selector,
    );
    await this.page.waitForTimeout(300);
  }

  /**
   * Find and click a matching option in an open dropdown/listbox popup.
   * Searches role="option", role="listbox" li, and Workday-specific
   * promptOption/selectOption elements.
   */
  private async clickMatchingOption(targetValue: string): Promise<boolean> {
    return this.page.evaluate((target: string) => {
      const targetLower = target.toLowerCase().trim();
      const options = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, ' +
          '[data-automation-id*="promptOption"], [data-automation-id*="selectOption"]',
      );

      // Pass 1: exact, starts-with, or contains match
      for (const opt of options) {
        const text = (opt.textContent || '').trim().toLowerCase();
        if (text === targetLower || text.startsWith(targetLower) || text.includes(targetLower)) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      // Pass 2: reverse contains (target contains option text)
      for (const opt of options) {
        const text = (opt.textContent || '').trim().toLowerCase();
        if (text.length > 2 && targetLower.includes(text)) {
          (opt as HTMLElement).click();
          return true;
        }
      }

      return false;
    }, targetValue);
  }

  /**
   * Generate progressively shorter fallback search terms from a multi-word value.
   * E.g., "Computer Science and Engineering" -> ["Computer Science", "Computer", "Engineering", "Science"]
   */
  private generateFallbackTerms(original: string): string[] {
    const stopWords = new Set(['of', 'and', 'in', 'the', 'a', 'an', 'for', 'to', 'with', 'or', 'at', 'by']);
    const words = original.split(/\s+/).filter(w => w.length > 1);
    const meaningfulWords = words.filter(w => !stopWords.has(w.toLowerCase()));

    // No fallbacks for single-word values
    if (meaningfulWords.length <= 1 && words.length <= 1) return [];

    const terms: string[] = [];

    // Strategy 1: Progressive prefixes (dropping trailing words)
    // "Computer Science and Engineering" -> "Computer Science"
    if (words.length > 2) {
      const prefix = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      if (prefix !== original) terms.push(prefix);
    }

    // Strategy 2: First meaningful word
    if (meaningfulWords.length > 0) {
      terms.push(meaningfulWords[0]);
    }

    // Strategy 3: Other meaningful words, longest first
    for (const word of meaningfulWords.slice(1).sort((a, b) => b.length - a.length)) {
      if (!terms.includes(word)) {
        terms.push(word);
      }
    }

    return terms;
  }
}
