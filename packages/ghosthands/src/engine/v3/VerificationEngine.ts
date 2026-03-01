import type { Page } from 'playwright';
import type { FieldModel, VerificationResult } from './v2types';
import { getLogger } from '../../monitoring/logger';

const logger = getLogger({ service: 'verification-engine' });

/**
 * DOM readback verification engine for the v2 hybrid execution engine.
 *
 * After each fill action, reads back the DOM value and compares it to the
 * expected value to verify the fill succeeded. Uses fuzzy matching to
 * accommodate formatting differences across field types.
 */
export class VerificationEngine {
  constructor(private page: Page) {}

  /**
   * Verify that a field was filled with the expected value.
   *
   * 1. Read the current field value from the DOM
   * 2. Normalize both expected and actual values
   * 3. Compare using fuzzy matching
   * 4. Return VerificationResult with passed/failed and reason
   */
  async verify(field: FieldModel, expectedValue: string): Promise<VerificationResult> {
    const actual = await this.readFieldValue(field);
    const normalizedExpected = this.normalizeForComparison(expectedValue, field.fieldType);
    const normalizedActual = this.normalizeForComparison(actual, field.fieldType);
    const passed = this.fuzzyMatch(normalizedExpected, normalizedActual, field.fieldType);

    let reason: string | undefined;
    if (passed) {
      reason = 'Value matches expected';
    } else if (normalizedActual === '') {
      reason = `Field is empty — expected "${expectedValue}"`;
    } else {
      reason = `Mismatch — expected "${expectedValue}", got "${actual}"`;
    }

    const result: VerificationResult = {
      field,
      expected: expectedValue,
      actual,
      passed,
      reason,
    };

    if (passed) {
      logger.debug('Verification passed', {
        fieldLabel: field.label,
        fieldType: field.fieldType,
        expected: expectedValue,
        actual,
      });
    } else {
      logger.warn('Verification failed', {
        fieldLabel: field.label,
        fieldType: field.fieldType,
        selector: field.selector,
        expected: expectedValue,
        actual,
        reason,
      });
    }

    return result;
  }

  /**
   * Read the current value of a field from the DOM via page.evaluate().
   * Returns '' if the element is not found or an error occurs.
   */
  private async readFieldValue(field: FieldModel): Promise<string> {
    try {
      switch (field.fieldType) {
        case 'text':
        case 'email':
        case 'phone':
        case 'number':
        case 'textarea':
        case 'password':
        case 'date': {
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
              return el?.value ?? '';
            },
            field.selector,
          );
          return value;
        }

        case 'select': {
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLSelectElement | null;
              if (!el) return '';
              const selected = el.options[el.selectedIndex];
              return selected?.text ?? '';
            },
            field.selector,
          );
          return value;
        }

        case 'custom_dropdown': {
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLElement | null;
              if (!el) return '';
              const text = (el.textContent ?? '').trim();
              // Common placeholder texts that indicate no selection
              const placeholders = ['select one', 'select...', 'select', 'choose one', 'choose...', '--', ''];
              if (placeholders.includes(text.toLowerCase())) return '';
              return text;
            },
            field.selector,
          );
          return value;
        }

        case 'radio': {
          const value = await this.page.evaluate(
            (args: { selector: string; groupKey?: string; name?: string }) => {
              // Try to find the radio group by name or groupKey
              const groupName = args.groupKey ?? args.name;
              if (!groupName) {
                // Fall back to checking the element itself
                const el = document.querySelector(args.selector) as HTMLInputElement | null;
                if (!el) return '';
                const name = el.name;
                if (!name) return el.checked ? (el.value || 'checked') : '';
                const checked = document.querySelector(`input[name="${CSS.escape(name)}"]:checked`) as HTMLInputElement | null;
                if (!checked) return '';
                // Find the label for the checked radio
                const label = checked.labels?.[0]?.textContent?.trim()
                  ?? checked.closest('label')?.textContent?.trim()
                  ?? checked.value
                  ?? '';
                return label;
              }
              const checked = document.querySelector(`input[name="${CSS.escape(groupName)}"]:checked`) as HTMLInputElement | null;
              if (!checked) return '';
              const label = checked.labels?.[0]?.textContent?.trim()
                ?? checked.closest('label')?.textContent?.trim()
                ?? checked.value
                ?? '';
              return label;
            },
            { selector: field.selector, groupKey: field.groupKey, name: field.name },
          );
          return value;
        }

        case 'aria_radio': {
          const value = await this.page.evaluate(
            (args: { selector: string; groupKey?: string }) => {
              // Find the radio group container
              let container: Element | null = null;
              if (args.groupKey) {
                container = document.querySelector(args.groupKey);
              }
              if (!container) {
                // Try to find the group from the element's parent [role="radiogroup"]
                const el = document.querySelector(args.selector);
                container = el?.closest('[role="radiogroup"]') ?? document.documentElement;
              }
              if (!container) return '';
              const checked = container.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;
              if (!checked) return '';
              return (checked.textContent ?? '').trim();
            },
            { selector: field.selector, groupKey: field.groupKey },
          );
          return value;
        }

        case 'checkbox': {
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLInputElement | null;
              if (!el) return '';
              return el.checked ? 'checked' : '';
            },
            field.selector,
          );
          return value;
        }

        case 'contenteditable': {
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLElement | null;
              return el?.textContent ?? '';
            },
            field.selector,
          );
          return value;
        }

        default: {
          // For unknown/file/typeahead/upload_button types, attempt basic value read
          const value = await this.page.evaluate(
            (selector: string) => {
              const el = document.querySelector(selector) as HTMLInputElement | null;
              return el?.value ?? el?.textContent ?? '';
            },
            field.selector,
          );
          return value;
        }
      }
    } catch (err) {
      logger.debug('Failed to read field value', {
        fieldLabel: field.label,
        selector: field.selector,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  /**
   * Normalize a value for comparison based on field type.
   *
   * - Trim whitespace
   * - Lowercase
   * - Collapse multiple spaces
   * - Phone: strip to digits only
   * - Date: extract digits only
   * - Select/dropdown: trim and lowercase
   */
  private normalizeForComparison(value: string, fieldType: string): string {
    let normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');

    if (fieldType === 'phone') {
      // Strip to digits only
      normalized = normalized.replace(/[^0-9]/g, '');
    } else if (fieldType === 'date') {
      // Extract just digits (strip slashes, dashes, dots)
      normalized = normalized.replace(/[^0-9]/g, '');
    }
    // select and custom_dropdown already handled by trim + lowercase above

    return normalized;
  }

  /**
   * Fuzzy matching to determine if a fill succeeded.
   *
   * Different field types have different tolerance for formatting differences.
   */
  private fuzzyMatch(expected: string, actual: string, fieldType: string): boolean {
    // If both are empty, nothing was filled
    if (expected === '' && actual === '') return false;

    // If actual is empty but expected is not, fill failed
    if (actual === '' && expected !== '') return false;

    // Exact match after normalization
    if (expected === actual) return true;

    // Checkbox: any truthy expected value + actual is 'checked'
    if (fieldType === 'checkbox') {
      const truthyValues = ['true', 'yes', '1', 'checked', 'on'];
      return truthyValues.includes(expected) && actual === 'checked';
    }

    // Phone numbers: compare last 7 digits
    if (fieldType === 'phone') {
      const expectedDigits = expected.replace(/[^0-9]/g, '');
      const actualDigits = actual.replace(/[^0-9]/g, '');
      if (expectedDigits.length >= 7 && actualDigits.length >= 7) {
        const expectedLast7 = expectedDigits.slice(-7);
        const actualLast7 = actualDigits.slice(-7);
        return expectedLast7 === actualLast7;
      }
      // Fall through to other checks if fewer than 7 digits
    }

    // Dates: compare digit-only versions
    if (fieldType === 'date') {
      const expectedDigits = expected.replace(/[^0-9]/g, '');
      const actualDigits = actual.replace(/[^0-9]/g, '');
      if (expectedDigits.length > 0 && expectedDigits === actualDigits) return true;
    }

    // Select / custom_dropdown: contains or starts-with matching
    if (fieldType === 'select' || fieldType === 'custom_dropdown') {
      // Contains match: actual contains expected or expected contains actual
      if (actual.includes(expected) || expected.includes(actual)) return true;
      // Starts-with match for long option text
      if (actual.startsWith(expected) || expected.startsWith(actual)) return true;
    }

    // General contains match for dropdowns and radios
    if (fieldType === 'radio' || fieldType === 'aria_radio') {
      if (actual.includes(expected) || expected.includes(actual)) return true;
    }

    // Contains match: normalized actual contains normalized expected (or vice versa)
    // Useful for text fields where the displayed value may have extra context
    if (actual.includes(expected) || expected.includes(actual)) return true;

    return false;
  }
}
