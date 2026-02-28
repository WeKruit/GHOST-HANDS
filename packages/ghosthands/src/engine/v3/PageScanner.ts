/**
 * PageScanner — Full-page DOM scanner for the v2 hybrid execution engine.
 *
 * Scrolls through a page and builds a complete PageModel with every interactive
 * element. All element extraction happens inside page.evaluate() — no Node.js
 * DOM access. Uses string-based evaluate to avoid esbuild __name injection.
 */

import type { Page } from 'playwright';
import type {
  PageModel,
  FieldModel,
  ButtonModel,
  FieldType,
  FillStrategy,
  BoundingBox,
  ButtonRole,
} from './v2types';
import { detectPlatform, detectPageType } from '../PageObserver';
import { getLogger } from '../../monitoring/logger';

const MAX_SCROLL_ROUNDS = 15;
const VIEWPORT_OVERLAP = 0.7;

/**
 * Raw field data returned from page.evaluate() before being assigned scan IDs.
 * Mirrors FieldModel but without the `id` field (assigned after dedup).
 */
interface RawFieldData {
  selector: string;
  automationId?: string;
  fieldId?: string;
  name?: string;
  fieldType: FieldType;
  fillStrategy: FillStrategy;
  isRequired: boolean;
  isVisible: boolean;
  isDisabled: boolean;
  label: string;
  placeholder?: string;
  ariaLabel?: string;
  currentValue: string;
  isEmpty: boolean;
  options?: string[];
  groupKey?: string;
  boundingBox: BoundingBox;
  absoluteY: number;
  platformMeta?: Record<string, string>;
}

/**
 * Raw button data returned from page.evaluate().
 */
interface RawButtonData {
  selector: string;
  text: string;
  automationId?: string;
  role: ButtonRole;
  boundingBox: BoundingBox;
  isDisabled: boolean;
}

export class PageScanner {
  private logger = getLogger({ service: 'PageScanner' });

  constructor(
    private page: Page,
    private platform: string,
  ) {}

  /**
   * Perform a full-page scan: scroll through the entire page, extract all
   * interactive elements, deduplicate, and return a PageModel.
   */
  async scan(): Promise<PageModel> {
    const url = this.page.url();
    const pageType = await detectPageType(this.page);

    // Clean stale scan indices from prior scans
    await this.page.evaluate(`
      (() => {
        var tagged = document.querySelectorAll('[data-gh-scan-idx]');
        for (var i = 0; i < tagged.length; i++) {
          tagged[i].removeAttribute('data-gh-scan-idx');
        }
      })()
    `);

    // Get page dimensions
    const dimensions = await this.page.evaluate(`
      (() => {
        return {
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
        };
      })()
    `) as { scrollHeight: number; viewportHeight: number };

    // Scroll to top
    await this.page.evaluate('window.scrollTo(0, 0)');
    await this.page.waitForTimeout(200);

    const allFields: RawFieldData[] = [];
    const allButtons: RawButtonData[] = [];
    const seenSelectors = new Set<string>();
    const seenButtonSelectors = new Set<string>();
    let globalFieldIdx = 0;
    let scrollY = 0;
    let round = 0;

    const scrollStep = Math.max(
      100,
      Math.floor(dimensions.viewportHeight * (1 - VIEWPORT_OVERLAP)),
    );

    while (round < MAX_SCROLL_ROUNDS) {
      round++;

      const result = await this.extractVisibleElements(scrollY, globalFieldIdx);

      // Deduplicate fields by selector
      for (const field of result.fields) {
        if (!seenSelectors.has(field.selector)) {
          seenSelectors.add(field.selector);
          allFields.push(field);
          globalFieldIdx++;
        }
      }

      // Deduplicate buttons by selector
      for (const button of result.buttons) {
        if (!seenButtonSelectors.has(button.selector)) {
          seenButtonSelectors.add(button.selector);
          allButtons.push(button);
        }
      }

      // Check if we've scrolled past the bottom
      const nextY = scrollY + scrollStep;
      if (nextY >= dimensions.scrollHeight - dimensions.viewportHeight) {
        // One final extraction at the very bottom if we haven't reached it
        if (scrollY < dimensions.scrollHeight - dimensions.viewportHeight) {
          scrollY = dimensions.scrollHeight - dimensions.viewportHeight;
          await this.page.evaluate(`window.scrollTo(0, ${scrollY})`);
          await this.page.waitForTimeout(200);

          const bottomResult = await this.extractVisibleElements(scrollY, globalFieldIdx);
          for (const field of bottomResult.fields) {
            if (!seenSelectors.has(field.selector)) {
              seenSelectors.add(field.selector);
              allFields.push(field);
              globalFieldIdx++;
            }
          }
          for (const button of bottomResult.buttons) {
            if (!seenButtonSelectors.has(button.selector)) {
              seenButtonSelectors.add(button.selector);
              allButtons.push(button);
            }
          }
        }
        break;
      }

      scrollY = nextY;
      await this.page.evaluate(`window.scrollTo(0, ${scrollY})`);
      await this.page.waitForTimeout(200);
    }

    // Scroll back to top
    await this.page.evaluate('window.scrollTo(0, 0)');

    // Assign stable IDs ordered by absoluteY
    allFields.sort((a, b) => a.absoluteY - b.absoluteY);
    const fields: FieldModel[] = allFields.map((f, i) => ({
      ...f,
      id: `field-${i}`,
    }));

    // Try to extract a page label (heading)
    const pageLabel = await this.page.evaluate(`
      (() => {
        var h = document.querySelector('h1, [role="heading"][aria-level="1"], [data-automation-id="pageHeaderText"]');
        return h ? (h.textContent || '').trim() : '';
      })()
    `) as string;

    const model: PageModel = {
      url,
      platform: this.platform,
      pageType,
      fields,
      buttons: allButtons,
      pageLabel: pageLabel || undefined,
      scrollHeight: dimensions.scrollHeight,
      viewportHeight: dimensions.viewportHeight,
      timestamp: Date.now(),
    };

    this.logger.info('Page scan complete', {
      url,
      platform: this.platform,
      pageType,
      fieldCount: fields.length,
      buttonCount: allButtons.length,
      scrollRounds: round,
      pageLabel: pageLabel || '(none)',
    });

    return model;
  }

  /**
   * Extract all interactive elements visible at the current scroll position.
   * Runs a single page.evaluate() call that returns raw field/button data.
   */
  private async extractVisibleElements(
    scrollY: number,
    startIdx: number,
  ): Promise<{ fields: RawFieldData[]; buttons: RawButtonData[] }> {
    const platform = this.platform;

    const result = await this.page.evaluate(`
      (() => {
        var fields = [];
        var buttons = [];
        var scrollY = ${scrollY};
        var startIdx = ${startIdx};
        var platform = ${JSON.stringify(platform)};
        var viewportHeight = window.innerHeight;
        var viewportWidth = window.innerWidth;
        var idx = startIdx;

        // ── Helpers ────────────────────────────────────────────────

        function isVisible(el) {
          if (!el) return false;
          var rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity) === 0) return false;
          if (el.getAttribute('aria-hidden') === 'true') return false;
          // Check if element is within or near the viewport
          if (rect.bottom < -50 || rect.top > viewportHeight + 50) return false;
          return true;
        }

        function getBBox(el) {
          var rect = el.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }

        function buildSelector(el, idx) {
          // Priority 1: id
          if (el.id) return '#' + CSS.escape(el.id);
          // Priority 2: data-testid
          var testId = el.getAttribute('data-testid');
          if (testId) return '[data-testid="' + testId + '"]';
          // Priority 3: data-automation-id (Workday)
          var autoId = el.getAttribute('data-automation-id');
          if (autoId) return '[data-automation-id="' + autoId + '"]';
          // Priority 4: existing scan idx
          var existing = el.getAttribute('data-gh-scan-idx');
          if (existing) return '[data-gh-scan-idx="' + existing + '"]';
          // Priority 5: tag with scan idx
          el.setAttribute('data-gh-scan-idx', String(idx));
          return '[data-gh-scan-idx="' + idx + '"]';
        }

        // ── Label extraction (8+ strategies) ──────────────────────

        function extractLabel(el) {
          var label = '';

          // Strategy 1: el.labels (HTMLInputElement.labels)
          if (!label && el.labels && el.labels.length > 0) {
            for (var li = 0; li < el.labels.length; li++) {
              var lt = (el.labels[li].textContent || '').trim();
              if (lt) { label = lt; break; }
            }
          }

          // Strategy 2: aria-label on element or closest ancestor
          if (!label) {
            var ariaLabel = el.getAttribute('aria-label');
            if (!ariaLabel || ariaLabel === 'Select One') {
              var ariaParent = el.closest('[aria-label]');
              if (ariaParent) ariaLabel = ariaParent.getAttribute('aria-label');
            }
            if (ariaLabel && ariaLabel !== 'Select One') {
              label = ariaLabel;
            }
          }

          // Strategy 3: aria-labelledby
          if (!label) {
            var labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
              var ids = labelledBy.split(/\\s+/);
              var parts = [];
              for (var ai = 0; ai < ids.length; ai++) {
                var refEl = document.getElementById(ids[ai]);
                if (refEl) {
                  var refText = (refEl.textContent || '').trim();
                  if (refText) parts.push(refText);
                }
              }
              if (parts.length > 0) label = parts.join(' ');
            }
          }

          // Strategy 4: placeholder attribute
          if (!label) {
            var ph = el.getAttribute('placeholder');
            if (ph) label = ph;
          }

          // Strategy 5: label[for="id"] lookup
          if (!label && el.id) {
            var forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (forLabel) {
              var forText = (forLabel.textContent || '').trim();
              if (forText) label = forText;
            }
          }

          // Strategy 6: parent container label
          if (!label) {
            var container = el.closest('[class*="field"], [class*="Field"], fieldset, [class*="form-group"], [class*="formGroup"], [data-automation-id]');
            if (container) {
              var containerLabel = container.querySelector('label, legend, [data-automation-id*="formLabel"], [data-automation-id*="label"], [data-automation-id*="questionText"]');
              if (containerLabel) {
                var clText = (containerLabel.textContent || '').trim();
                if (clText && clText !== 'Select One') label = clText;
              }
            }
          }

          // Strategy 7: preceding sibling
          if (!label) {
            var prev = el.previousElementSibling;
            if (!prev) {
              // Try parent's previous sibling
              var par = el.parentElement;
              if (par) prev = par.previousElementSibling;
            }
            if (prev) {
              var prevTag = (prev.tagName || '').toLowerCase();
              if (prevTag === 'label' || prevTag === 'span' || prevTag === 'div' || prevTag === 'p') {
                var prevText = (prev.textContent || '').trim();
                if (prevText && prevText.length < 200 && prevText !== 'Select One') {
                  label = prevText;
                }
              }
            }
          }

          // Strategy 8: walk up to find nearest ancestor with exactly 1 input/button
          if (!label) {
            var anc = el.parentElement;
            for (var up = 0; up < 15 && anc; up++) {
              var inputs = anc.querySelectorAll('input, select, textarea, button[aria-haspopup], [role="combobox"]');
              if (inputs.length === 1) {
                var ancText = (anc.textContent || '').trim();
                var elText = (el.textContent || '').trim();
                var cleaned = ancText;
                if (elText) cleaned = cleaned.replace(elText, '');
                cleaned = cleaned
                  .replace(/Required/gi, '')
                  .replace(/[*]/g, '')
                  .replace(/Select One/g, '')
                  .replace(/\\s+/g, ' ')
                  .trim();
                if (cleaned.length > 2 && cleaned.length < 300) {
                  label = cleaned;
                  break;
                }
              }
              anc = anc.parentElement;
            }
          }

          // Strategy 9: name or id fallback
          if (!label) {
            var nameAttr = el.getAttribute('name');
            if (nameAttr) {
              label = nameAttr
                .replace(/([A-Z])/g, ' $1')
                .replace(/[_-]/g, ' ')
                .trim();
            }
          }
          if (!label) {
            var idAttr = el.id;
            if (idAttr) {
              label = idAttr
                .replace(/([A-Z])/g, ' $1')
                .replace(/[_-]/g, ' ')
                .trim();
            }
          }

          // Clean up label
          label = label
            .replace(/\\s*\\*\\s*/g, ' ')
            .replace(/\\s*Required\\s*/gi, '')
            .replace(/\\s+/g, ' ')
            .trim();
          if (label.length > 200) label = label.substring(0, 200).trim();

          return label;
        }

        // ── Field type & fill strategy mapping ────────────────────

        function getFieldType(el) {
          var tag = (el.tagName || '').toLowerCase();

          if (tag === 'textarea') return 'textarea';
          if (tag === 'select') return 'select';

          if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';

          if (tag === 'input') {
            var type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'text' || type === '') return 'text';
            if (type === 'email') return 'email';
            if (type === 'tel') return 'phone';
            if (type === 'url') return 'text';
            if (type === 'number') return 'number';
            if (type === 'date') return 'date';
            if (type === 'password') return 'password';
            if (type === 'radio') return 'radio';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'file') return 'file';
            return 'text';
          }

          // Custom dropdown detection
          if (tag === 'button') {
            var btnText = (el.textContent || '').trim();
            if (btnText === 'Select One' && platform === 'workday') return 'custom_dropdown';
            if (el.getAttribute('aria-haspopup') === 'listbox') return 'custom_dropdown';
          }

          if (el.getAttribute('role') === 'combobox') return 'custom_dropdown';
          if (el.getAttribute('aria-haspopup') === 'listbox') return 'custom_dropdown';
          if (el.getAttribute('role') === 'radiogroup') return 'aria_radio';

          return 'unknown';
        }

        function getFillStrategy(fieldType) {
          switch (fieldType) {
            case 'text':
            case 'email':
            case 'phone':
            case 'number':
            case 'textarea':
            case 'contenteditable':
            case 'select':
              return 'native_setter';
            case 'custom_dropdown':
            case 'radio':
            case 'aria_radio':
              return 'click_option';
            case 'checkbox':
              return 'click';
            case 'file':
              return 'set_input_files';
            case 'date':
              return 'keyboard_type';
            default:
              return 'llm_act';
          }
        }

        // ── Extract options for selects / radios ──────────────────

        function extractOptions(el, fieldType) {
          if (fieldType === 'select') {
            var opts = el.querySelectorAll('option');
            var results = [];
            for (var o = 0; o < opts.length; o++) {
              var optText = (opts[o].textContent || '').trim();
              if (optText) results.push(optText);
            }
            return results.length > 0 ? results : undefined;
          }

          if (fieldType === 'radio') {
            var groupName = el.getAttribute('name');
            if (groupName) {
              var radios = document.querySelectorAll('input[type="radio"][name="' + CSS.escape(groupName) + '"]');
              var rOpts = [];
              for (var r = 0; r < radios.length; r++) {
                var rLabel = '';
                if (radios[r].labels && radios[r].labels.length > 0) {
                  rLabel = (radios[r].labels[0].textContent || '').trim();
                }
                if (!rLabel) {
                  rLabel = radios[r].getAttribute('value') || '';
                }
                if (rLabel) rOpts.push(rLabel);
              }
              return rOpts.length > 0 ? rOpts : undefined;
            }
          }

          if (fieldType === 'aria_radio') {
            var radioChildren = el.querySelectorAll('[role="radio"]');
            var arOpts = [];
            for (var ar = 0; ar < radioChildren.length; ar++) {
              var arText = (radioChildren[ar].textContent || '').trim();
              if (arText) arOpts.push(arText);
            }
            return arOpts.length > 0 ? arOpts : undefined;
          }

          return undefined;
        }

        // ── Collect radio groups (to avoid duplicates) ────────────
        var processedRadioGroups = {};

        // ── Scan interactive fields ───────────────────────────────

        // Standard inputs
        var inputSelectors = [
          'input[type="text"]',
          'input[type="email"]',
          'input[type="tel"]',
          'input[type="url"]',
          'input[type="number"]',
          'input[type="date"]',
          'input[type="password"]',
          'input[type="file"]',
          'input[type="checkbox"]',
          'input:not([type])',
          'textarea',
          'select',
        ].join(', ');

        var standardEls = document.querySelectorAll(inputSelectors);
        for (var si = 0; si < standardEls.length; si++) {
          var el = standardEls[si];
          if (!isVisible(el)) continue;
          if (el.disabled || el.readOnly) continue;
          if (el.getAttribute('type') === 'hidden') continue;

          var ft = getFieldType(el);

          // Skip password fields (handled separately for security)
          if (ft === 'password') continue;

          // Handle radio groups: only process each group once
          if (ft === 'radio') {
            var groupName = el.getAttribute('name') || '';
            if (groupName) {
              if (processedRadioGroups[groupName]) continue;
              processedRadioGroups[groupName] = true;
            }
          }

          var selector = buildSelector(el, idx);
          var autoId = el.getAttribute('data-automation-id') || undefined;
          var fieldLabel = extractLabel(el);
          var currentVal = '';
          if (el.tagName.toLowerCase() === 'select') {
            var selOpt = el.options ? el.options[el.selectedIndex] : null;
            currentVal = selOpt ? (selOpt.textContent || '').trim() : '';
          } else if (el.value !== undefined) {
            currentVal = el.value || '';
          }
          var opts = extractOptions(el, ft);

          var field = {
            selector: selector,
            automationId: autoId,
            fieldId: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            fieldType: ft,
            fillStrategy: getFillStrategy(ft),
            isRequired: el.required || el.getAttribute('aria-required') === 'true',
            isVisible: true,
            isDisabled: false,
            label: fieldLabel,
            placeholder: el.getAttribute('placeholder') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            currentValue: currentVal,
            isEmpty: !currentVal,
            options: opts,
            groupKey: ft === 'radio' ? (el.getAttribute('name') || undefined) : undefined,
            boundingBox: getBBox(el),
            absoluteY: Math.round(el.getBoundingClientRect().top + scrollY),
            platformMeta: undefined,
          };

          fields.push(field);
          idx++;
        }

        // Radio inputs (type="radio") that may not have been caught
        var radioEls = document.querySelectorAll('input[type="radio"]');
        for (var ri = 0; ri < radioEls.length; ri++) {
          var radio = radioEls[ri];
          if (!isVisible(radio)) continue;
          if (radio.disabled) continue;
          var rGroupName = radio.getAttribute('name') || '';
          if (rGroupName && processedRadioGroups[rGroupName]) continue;
          if (rGroupName) processedRadioGroups[rGroupName] = true;

          var rSelector = buildSelector(radio, idx);
          var rLabel = extractLabel(radio);
          var rOpts = extractOptions(radio, 'radio');

          fields.push({
            selector: rSelector,
            automationId: radio.getAttribute('data-automation-id') || undefined,
            fieldId: radio.id || undefined,
            name: radio.getAttribute('name') || undefined,
            fieldType: 'radio',
            fillStrategy: 'click_option',
            isRequired: radio.required || radio.getAttribute('aria-required') === 'true',
            isVisible: true,
            isDisabled: false,
            label: rLabel,
            placeholder: undefined,
            ariaLabel: radio.getAttribute('aria-label') || undefined,
            currentValue: '',
            isEmpty: true,
            options: rOpts,
            groupKey: rGroupName || undefined,
            boundingBox: getBBox(radio),
            absoluteY: Math.round(radio.getBoundingClientRect().top + scrollY),
            platformMeta: undefined,
          });
          idx++;
        }

        // Custom dropdowns: role="combobox", [aria-haspopup="listbox"] (non-button)
        var comboboxEls = document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]:not(button):not(select)');
        for (var ci = 0; ci < comboboxEls.length; ci++) {
          var cEl = comboboxEls[ci];
          if (!isVisible(cEl)) continue;
          if (cEl.getAttribute('disabled') !== null) continue;
          // Avoid re-processing elements already captured
          if (cEl.getAttribute('data-gh-scan-idx') !== null) continue;
          if (cEl.tagName.toLowerCase() === 'select') continue;
          if (cEl.tagName.toLowerCase() === 'input' && cEl.getAttribute('data-gh-scan-idx') !== null) continue;

          var cSelector = buildSelector(cEl, idx);
          var cLabel = extractLabel(cEl);

          fields.push({
            selector: cSelector,
            automationId: cEl.getAttribute('data-automation-id') || undefined,
            fieldId: cEl.id || undefined,
            name: cEl.getAttribute('name') || undefined,
            fieldType: 'custom_dropdown',
            fillStrategy: 'click_option',
            isRequired: cEl.getAttribute('aria-required') === 'true',
            isVisible: true,
            isDisabled: false,
            label: cLabel,
            placeholder: cEl.getAttribute('placeholder') || undefined,
            ariaLabel: cEl.getAttribute('aria-label') || undefined,
            currentValue: (cEl.textContent || '').trim(),
            isEmpty: !(cEl.textContent || '').trim(),
            options: undefined,
            groupKey: undefined,
            boundingBox: getBBox(cEl),
            absoluteY: Math.round(cEl.getBoundingClientRect().top + scrollY),
            platformMeta: undefined,
          });
          idx++;
        }

        // Workday "Select One" buttons
        if (platform === 'workday') {
          var allBtns = document.querySelectorAll('button');
          for (var wb = 0; wb < allBtns.length; wb++) {
            var wBtn = allBtns[wb];
            var wText = (wBtn.textContent || '').trim();
            if (wText !== 'Select One') continue;
            if (!isVisible(wBtn)) continue;
            if (wBtn.disabled) continue;
            // Skip if already tagged
            if (wBtn.getAttribute('data-gh-scan-idx') !== null) continue;

            var wSelector = buildSelector(wBtn, idx);
            var wLabel = extractLabel(wBtn);

            fields.push({
              selector: wSelector,
              automationId: wBtn.getAttribute('data-automation-id') || undefined,
              fieldId: wBtn.id || undefined,
              name: wBtn.getAttribute('name') || undefined,
              fieldType: 'custom_dropdown',
              fillStrategy: 'click_option',
              isRequired: wBtn.getAttribute('aria-required') === 'true',
              isVisible: true,
              isDisabled: false,
              label: wLabel,
              placeholder: undefined,
              ariaLabel: wBtn.getAttribute('aria-label') || undefined,
              currentValue: 'Select One',
              isEmpty: true,
              options: undefined,
              groupKey: undefined,
              boundingBox: getBBox(wBtn),
              absoluteY: Math.round(wBtn.getBoundingClientRect().top + scrollY),
              platformMeta: { widgetType: 'workday_select_one' },
            });
            idx++;
          }
        }

        // ARIA radio groups
        var radioGroups = document.querySelectorAll('[role="radiogroup"]');
        for (var rg = 0; rg < radioGroups.length; rg++) {
          var rgEl = radioGroups[rg];
          if (!isVisible(rgEl)) continue;
          // Skip if already tagged
          if (rgEl.getAttribute('data-gh-scan-idx') !== null) continue;

          var rgSelector = buildSelector(rgEl, idx);
          var rgLabel = extractLabel(rgEl);
          var rgOpts = extractOptions(rgEl, 'aria_radio');

          fields.push({
            selector: rgSelector,
            automationId: rgEl.getAttribute('data-automation-id') || undefined,
            fieldId: rgEl.id || undefined,
            name: rgEl.getAttribute('name') || undefined,
            fieldType: 'aria_radio',
            fillStrategy: 'click_option',
            isRequired: rgEl.getAttribute('aria-required') === 'true',
            isVisible: true,
            isDisabled: false,
            label: rgLabel,
            placeholder: undefined,
            ariaLabel: rgEl.getAttribute('aria-label') || undefined,
            currentValue: '',
            isEmpty: true,
            options: rgOpts,
            groupKey: rgSelector,
            boundingBox: getBBox(rgEl),
            absoluteY: Math.round(rgEl.getBoundingClientRect().top + scrollY),
            platformMeta: undefined,
          });
          idx++;
        }

        // Contenteditable elements
        var ceEls = document.querySelectorAll('[contenteditable="true"]');
        for (var ce = 0; ce < ceEls.length; ce++) {
          var ceEl = ceEls[ce];
          if (!isVisible(ceEl)) continue;
          // Skip if already tagged
          if (ceEl.getAttribute('data-gh-scan-idx') !== null) continue;

          var ceSelector = buildSelector(ceEl, idx);
          var ceLabel = extractLabel(ceEl);
          var ceText = (ceEl.textContent || '').trim();

          fields.push({
            selector: ceSelector,
            automationId: ceEl.getAttribute('data-automation-id') || undefined,
            fieldId: ceEl.id || undefined,
            name: ceEl.getAttribute('name') || undefined,
            fieldType: 'contenteditable',
            fillStrategy: 'native_setter',
            isRequired: ceEl.getAttribute('aria-required') === 'true',
            isVisible: true,
            isDisabled: false,
            label: ceLabel,
            placeholder: ceEl.getAttribute('placeholder') || ceEl.getAttribute('data-placeholder') || undefined,
            ariaLabel: ceEl.getAttribute('aria-label') || undefined,
            currentValue: ceText,
            isEmpty: !ceText,
            options: undefined,
            groupKey: undefined,
            boundingBox: getBBox(ceEl),
            absoluteY: Math.round(ceEl.getBoundingClientRect().top + scrollY),
            platformMeta: undefined,
          });
          idx++;
        }

        // ── Scan buttons ──────────────────────────────────────────

        var btnEls = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        for (var bi = 0; bi < btnEls.length; bi++) {
          var bEl = btnEls[bi];
          if (!isVisible(bEl)) continue;

          // Skip buttons already captured as fields (e.g., "Select One" buttons)
          if (bEl.getAttribute('data-gh-scan-idx') !== null) continue;
          // Skip combobox triggers — they are fields, not action buttons
          if (bEl.getAttribute('role') === 'combobox') continue;
          if (bEl.getAttribute('aria-haspopup') === 'listbox') continue;

          var bText = (bEl.textContent || bEl.getAttribute('value') || '').trim();
          // Skip empty buttons and very long text (likely not a real button label)
          if (!bText || bText.length > 100) continue;

          var bAutoId = bEl.getAttribute('data-automation-id') || undefined;

          // Classify button role
          var bRole = 'unknown';
          var bTextLower = bText.toLowerCase();
          if (bTextLower === 'save and continue' || bTextLower === 'next' || bTextLower === 'continue' || bTextLower.includes('save & continue')) {
            bRole = 'navigation';
          } else if (bTextLower === 'submit' || bTextLower === 'submit application' || bTextLower === 'apply') {
            bRole = 'submit';
          } else if (bTextLower === 'add' || bTextLower.startsWith('add ') || bTextLower === 'add another') {
            bRole = 'add';
          }

          // Build selector for button
          var bSelector = '';
          if (bEl.id) {
            bSelector = '#' + CSS.escape(bEl.id);
          } else if (bEl.getAttribute('data-testid')) {
            bSelector = '[data-testid="' + bEl.getAttribute('data-testid') + '"]';
          } else if (bAutoId) {
            bSelector = '[data-automation-id="' + bAutoId + '"]';
          } else {
            // Use text-based selector as fallback for buttons
            var bTag = bEl.tagName.toLowerCase();
            if (bTag === 'input') {
              bSelector = 'input[type="submit"][value="' + bText.replace(/"/g, '\\\\"') + '"]';
            } else {
              bSelector = bTag + ':has-text("' + bText.replace(/"/g, '\\\\"') + '")';
            }
          }

          buttons.push({
            selector: bSelector,
            text: bText,
            automationId: bAutoId,
            role: bRole,
            boundingBox: getBBox(bEl),
            isDisabled: bEl.disabled || bEl.getAttribute('aria-disabled') === 'true',
          });
        }

        return { fields: fields, buttons: buttons };
      })()
    `) as { fields: RawFieldData[]; buttons: RawButtonData[] };

    return result;
  }
}
