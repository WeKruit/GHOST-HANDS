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
   * Execute a single action item. Tries Tier 0 first (if action.tier === 0),
   * then escalates to Tier 3 on failure. If action.tier === 3, goes directly
   * to the LLM.
   */
  async execute(action: ActionItem): Promise<{ success: boolean; error?: string }> {
    const { field, value, tier } = action;

    // Tier 0 — try direct DOM manipulation first
    if (tier === 0) {
      try {
        const tier0Success = await this.executeTier0(field, value);
        if (tier0Success) {
          this.logger.debug('Tier 0 fill succeeded', {
            label: field.label,
            fieldType: field.fieldType,
            tier: 0,
          });
          return { success: true };
        }
      } catch (err) {
        this.logger.debug('Tier 0 fill threw, escalating to Tier 3', {
          label: field.label,
          fieldType: field.fieldType,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Tier 0 failed — escalate to Tier 3
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
      return { success: false, error: `LLM fill returned failure for "${field.label}"` };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn('Tier 3 LLM fill threw', {
        label: field.label,
        fieldType: field.fieldType,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }
  }

  // ── Tier 0 dispatcher ──────────────────────────────────────────────────

  /**
   * Route to the appropriate Tier 0 method based on field type.
   * Returns true on success, false on failure.
   */
  private async executeTier0(field: FieldModel, value: string): Promise<boolean> {
    switch (field.fieldType) {
      case 'text':
      case 'email':
      case 'phone':
      case 'number':
      case 'password':
      case 'textarea':
      case 'contenteditable':
        return this.fillText(field, value);

      case 'select':
        return this.fillSelect(field, value);

      case 'custom_dropdown':
      case 'typeahead':
        return this.fillCustomDropdown(field, value);

      case 'radio':
        return this.fillRadio(field, value);

      case 'aria_radio':
        return this.fillAriaRadio(field, value);

      case 'checkbox':
        return this.checkCheckbox(field);

      case 'date':
        return this.fillDate(field, value);

      default:
        this.logger.debug('No Tier 0 handler for field type', {
          label: field.label,
          fieldType: field.fieldType,
        });
        return false;
    }
  }

  // ── Tier 0 methods ($0) ────────────────────────────────────────────────

  /**
   * Fill a text input or textarea using the native value setter pattern.
   * React-compatible: dispatches input, change, and blur events so React
   * picks up the new value.
   */
  private async fillText(field: FieldModel, value: string): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      const filled = await this.page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return false;

        // Skip if already filled
        if (el.value && el.value.trim() !== '') return false;

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

      this.logger.debug('fillText result', { label: field.label, success: filled });
      return filled;
    } catch (err) {
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
  private async fillSelect(field: FieldModel, value: string): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      const filled = await this.page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return false;

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

        if (!bestOption) return false;

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

      this.logger.debug('fillSelect result', { label: field.label, success: filled });
      return filled;
    } catch (err) {
      this.logger.debug('fillSelect error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fill a Workday-style custom dropdown ("Select One" button).
   * Opens the dropdown, optionally types to filter, finds and clicks the
   * matching option, then closes any stray popup.
   */
  private async fillCustomDropdown(field: FieldModel, value: string): Promise<boolean> {
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

      // Step 5: Wait and close any stray popup
      if (clicked) {
        await this.page.waitForTimeout(300);
      }

      // Click empty space to close popup (coordinates well outside typical popups)
      await this.page.mouse.click(10, 10);
      await this.page.waitForTimeout(200);

      this.logger.debug('fillCustomDropdown result', { label: field.label, success: clicked });
      return clicked;
    } catch (err) {
      // Try to close any open popup before returning
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(200);

      this.logger.debug('fillCustomDropdown error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fill a native radio button group by matching the value to option labels.
   * Uses the field's groupKey (the `name` attribute) to find all radios in the group.
   */
  private async fillRadio(field: FieldModel, value: string): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      const clicked = await this.page.evaluate(({ groupKey, val }) => {
        if (!groupKey) return false;

        const radios = document.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${groupKey}"]`,
        );
        if (radios.length === 0) return false;

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

        if (!bestMatch) return false;

        bestMatch.click();
        bestMatch.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, { groupKey: field.groupKey || '', val: value });

      this.logger.debug('fillRadio result', { label: field.label, success: clicked });
      return clicked;
    } catch (err) {
      this.logger.debug('fillRadio error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fill an ARIA radiogroup (role="radio" children inside a role="radiogroup" container).
   * Used for custom radio implementations that don't use native <input type="radio">.
   */
  private async fillAriaRadio(field: FieldModel, value: string): Promise<boolean> {
    try {
      await this.scrollFieldIntoView(field);

      const clicked = await this.page.evaluate(({ sel, val }) => {
        const group = document.querySelector(sel);
        if (!group) return false;

        const radios = group.querySelectorAll('[role="radio"]');
        if (radios.length === 0) return false;

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

        return false;
      }, { sel: field.selector, val: value });

      this.logger.debug('fillAriaRadio result', { label: field.label, success: clicked });
      return clicked;
    } catch (err) {
      this.logger.debug('fillAriaRadio error', {
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
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
