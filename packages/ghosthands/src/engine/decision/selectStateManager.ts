import type { Page } from 'playwright';
import type { SelectOption, SelectStateModel } from './mergedObserverTypes';
import type { FieldSnapshot } from './types';
import { stableFieldKey } from './observerMerger';

const PLACEHOLDER_RE = /^(select|choose|pick|prefer not|--|—|\+\d{1,3}$)/i;
const EXACT_WAIT_MS = 250;
const OPEN_WAIT_MS = 300;

interface RawDiscoveredOption {
  label: string;
  value: string;
  disabled: boolean;
  optionSelector: string;
  hasHierarchy: boolean;
  setsize: number;
}

interface RawActiveListSnapshot {
  options: RawDiscoveredOption[];
  selectedOptions: string[];
  listboxSelector: string | null;
  isVirtualized: boolean;
  hasHierarchy: boolean;
}

interface RawButtonGroupOption {
  label: string;
  disabled: boolean;
  selected: boolean;
  optionSelector: string;
}

interface RawButtonGroupSnapshot {
  options: RawButtonGroupOption[];
  selectedOptions: string[];
}

interface RawNativeSelectOption {
  label: string;
  value: string;
  disabled: boolean;
  optionSelector: string;
}

interface RawNativeSelectSnapshot {
  options: RawNativeSelectOption[];
  selectedOptions: string[];
  isMultiSelect: boolean;
}

function normalizeSelectText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isPlaceholderLabel(value: string | null | undefined): boolean {
  return !value || PLACEHOLDER_RE.test((value || '').trim());
}

function matchesSelectValue(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const current = normalizeSelectText(actual);
  const desired = normalizeSelectText(expected);
  if (!current || !desired) {
    return false;
  }
  return current === desired || current.includes(desired) || desired.includes(current);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeOptions(options: SelectOption[]): SelectOption[] {
  const seen = new Set<string>();
  const deduped: SelectOption[] = [];

  for (const option of options) {
    const key = `${option.hierarchyPath || option.value || option.label}::${option.normalizedLabel}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }

  return deduped;
}

function buildOption(
  label: string,
  value?: string,
  partial?: Partial<SelectOption>,
): SelectOption {
  const text = label.replace(/\s+/g, ' ').trim();
  return {
    label: text,
    normalizedLabel: normalizeSelectText(text),
    value: value ?? text,
    isPlaceholder: isPlaceholderLabel(text),
    disabled: partial?.disabled ?? false,
    hierarchyPath: partial?.hierarchyPath ?? null,
    optionSelector: partial?.optionSelector ?? null,
  };
}

function findBestOption(options: SelectOption[], value: string): SelectOption | null {
  const desired = normalizeSelectText(value);
  if (!desired) {
    return null;
  }

  const exact = options.find((option) =>
    option.normalizedLabel === desired ||
    normalizeSelectText(option.value) === desired ||
    normalizeSelectText(option.hierarchyPath) === desired,
  );
  if (exact) {
    return exact;
  }

  const startsWith = options.find((option) =>
    option.normalizedLabel.startsWith(desired) ||
    desired.startsWith(option.normalizedLabel) ||
    normalizeSelectText(option.value).startsWith(desired) ||
    desired.startsWith(normalizeSelectText(option.value)),
  );
  if (startsWith) {
    return startsWith;
  }

  return options.find((option) =>
    option.normalizedLabel.includes(desired) ||
    desired.includes(option.normalizedLabel) ||
    normalizeSelectText(option.value).includes(desired) ||
    desired.includes(normalizeSelectText(option.value)) ||
    normalizeSelectText(option.hierarchyPath).includes(desired) ||
    desired.includes(normalizeSelectText(option.hierarchyPath)),
  ) ?? null;
}

async function isDropdownPopupOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ff = (window as { __ff?: { queryOne?: (selector: string) => Element | null } }).__ff;
    const visible = (el: Element | null): boolean => {
      if (!el) {
        return false;
      }
      const node = el as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    if (visible(ff?.queryOne?.('[data-automation-id="activeListContainer"]') ?? null)) {
      return true;
    }

    const candidates = document.querySelectorAll(
      '[role="listbox"], [role="dialog"], [aria-modal="true"], [data-automation-id="activeListContainer"], [class*="dropdown"], [class*="select-dropdown"]',
    );
    return Array.from(candidates).some((candidate) => visible(candidate));
  }).catch(() => false);
}

async function dismissDropdown(page: Page): Promise<void> {
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }).catch(() => {});
  await page.waitForTimeout(150);
}

async function dismissDropdownIfOpen(page: Page): Promise<void> {
  if (!(await isDropdownPopupOpen(page))) {
    return;
  }
  await dismissDropdown(page);
}

async function clickComboboxTrigger(page: Page, selector: string): Promise<void> {
  const targetSelector = await page.evaluate((fieldSelector) => {
    const ff = (window as {
      __ff?: {
        queryAll?: (selector: string) => Element[];
        queryOne?: (selector: string) => Element | null;
        closestCrossRoot?: (node: Element, selector: string) => Element | null;
      };
    }).__ff;
    const queryAll = (sel: string): Element[] =>
      typeof ff?.queryAll === 'function' ? ff.queryAll(sel) : Array.from(document.querySelectorAll(sel));
    const queryOne = (sel: string): Element | null =>
      typeof ff?.queryOne === 'function' ? ff.queryOne(sel) : document.querySelector(sel);
    const closestCrossRoot = (node: Element, sel: string): Element | null =>
      typeof ff?.closestCrossRoot === 'function' ? ff.closestCrossRoot(node, sel) : node.closest(sel);

    const el = queryOne(fieldSelector) as HTMLElement | null;
    if (!el) {
      return null;
    }

    queryAll('[data-gh-select-trigger]').forEach((node) => {
      node.removeAttribute('data-gh-select-trigger');
    });

    let target: HTMLElement | null = null;

    if (el.tagName === 'INPUT') {
      const siblingToggle =
        (el.parentElement?.querySelector('button[aria-label*="Toggle"]') as HTMLElement | null) ||
        (closestCrossRoot(el, '.select-shell, .select__container, .field-wrapper')?.querySelector('button[aria-label*="Toggle"]') as HTMLElement | null);
      if (siblingToggle) {
        target = siblingToggle;
      }
    }

    if (!target && el.tagName === 'INPUT') {
      const control =
        closestCrossRoot(el, '[class*="select__control"]') ||
        closestCrossRoot(el, '[class*="control"]') ||
        closestCrossRoot(el, '[class*="select-shell"]') ||
        closestCrossRoot(el, '[role="combobox"]') ||
        closestCrossRoot(el, '[aria-haspopup="listbox"]');
      if (control) {
        target = control as HTMLElement;
      }
    }

    if (!target) {
      target = (
        el.querySelector(':scope > [role="combobox"]') ||
        el.querySelector(':scope > [aria-haspopup="listbox"]') ||
        el.querySelector(':scope > [class*="select__control"]') ||
        el.querySelector(':scope > [class*="control"]') ||
        el.querySelector(':scope > [class*="trigger"]') ||
        el.querySelector(':scope > button') ||
        el.querySelector(':scope > input') ||
        el
      ) as HTMLElement | null;
    }

    if (!target) {
      return null;
    }

    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    target.setAttribute('data-gh-select-trigger', 'active');
    return '[data-gh-select-trigger="active"]';
  }, selector);

  if (!targetSelector) {
    throw new Error(`Dropdown trigger not found for ${selector}`);
  }

  const trigger = page.locator(targetSelector).first();
  try {
    await trigger.scrollIntoViewIfNeeded();
  } catch {
    // Best effort.
  }

  let clicked = false;
  try {
    await trigger.click({ timeout: 2000 });
    clicked = true;
  } catch {
    // Focus fallback below.
  }

  if (!clicked) {
    try {
      await trigger.focus({ timeout: 1000 });
    } catch {
      await page.locator(selector).first().focus().catch(() => {});
    }
  }

  await page.waitForTimeout(250);
  let open = await isDropdownPopupOpen(page);
  if (!open) {
    await page.keyboard.press('Space').catch(() => {});
    await page.waitForTimeout(250);
    open = await isDropdownPopupOpen(page);
  }
  if (!open) {
    await page.keyboard.press('ArrowDown').catch(() => {});
  }
  await page.waitForTimeout(OPEN_WAIT_MS);
}

async function readSelectCurrentDisplay(page: Page, selector: string): Promise<string> {
  return page.evaluate((fieldSelector) => {
    const ff = (window as {
      __ff?: {
        queryOne?: (selector: string) => Element | null;
        closestCrossRoot?: (node: Element, selector: string) => Element | null;
      };
    }).__ff;
    const queryOne = (sel: string): Element | null =>
      typeof ff?.queryOne === 'function' ? ff.queryOne(sel) : document.querySelector(sel);
    const closestCrossRoot = (node: Element, sel: string): Element | null =>
      typeof ff?.closestCrossRoot === 'function' ? ff.closestCrossRoot(node, sel) : node.closest(sel);

    const el = queryOne(fieldSelector) as HTMLElement | null;
    if (!el) {
      return '';
    }

    const scopedContainer = closestCrossRoot(el, '[data-automation-id], .form-group, .field, .form-field');
    const selectedItem = scopedContainer?.querySelector(
      [
        '[data-automation-id="selectedItem"]',
        '[data-automation-id="multiSelectPill"]',
        '[aria-selected="true"]',
        '[class*="singleValue"]',
        '[class*="single-value"]',
        '[class*="value-container"] [class*="single"]',
      ].join(', '),
    );
    if (selectedItem) {
      return selectedItem.textContent?.trim() || '';
    }

    if (el.tagName === 'INPUT') {
      const inputValue = (el as HTMLInputElement).value.trim();
      if (inputValue) {
        return inputValue;
      }
    }

    const searchInput = el.querySelector('[data-automation-id="searchBox"], .wd-selectinput-search');
    if (searchInput) {
      const searchValue = (searchInput as HTMLInputElement).value.trim();
      if (searchValue) {
        return searchValue;
      }
    }

    const trigger = (
      scopedContainer?.querySelector(
        [
          '.custom-select-trigger',
          '.multi-select-trigger',
          '[class*="select-trigger"]',
          '[class*="singleValue"]',
          '[class*="single-value"]',
          '[class*="placeholder"]',
        ].join(', '),
      ) ||
      el.querySelector('.custom-select-trigger, .multi-select-trigger, [class*="select-trigger"]')
    );
    if (trigger) {
      return trigger.textContent?.trim() || '';
    }

    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[role="listbox"], [class*="dropdown"], [class*="select-dropdown"]').forEach((node) => {
      node.remove();
    });
    return clone.textContent?.trim() || '';
  }, selector).catch(() => '');
}

async function readNativeSelectedLabels(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((fieldSelector) => {
    const el = document.querySelector(fieldSelector) as HTMLSelectElement | null;
    if (!el) {
      return [];
    }
    return Array.from(el.selectedOptions)
      .map((option) => (option.textContent || '').trim())
      .filter(Boolean);
  }, selector).catch(() => []);
}

async function readActiveListOptions(page: Page): Promise<{
  options: SelectOption[];
  selectedOptions: string[];
  listboxSelector: string | null;
  isVirtualized: boolean;
  hasHierarchy: boolean;
}> {
  const raw: RawActiveListSnapshot = await page.evaluate(() => {
    const ff = (window as {
      __ff?: {
        queryOne?: (selector: string) => Element | null;
        queryAll?: (selector: string) => Element[];
      };
    }).__ff;
    const queryAll = (sel: string): Element[] =>
      typeof ff?.queryAll === 'function' ? ff.queryAll(sel) : Array.from(document.querySelectorAll(sel));
    const queryOne = (sel: string): Element | null =>
      typeof ff?.queryOne === 'function' ? ff.queryOne(sel) : document.querySelector(sel);
    const visible = (el: Element | null): boolean => {
      if (!el) {
        return false;
      }
      const node = el as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    queryAll('[data-gh-select-option]').forEach((node) => node.removeAttribute('data-gh-select-option'));
    queryAll('[data-gh-select-listbox]').forEach((node) => node.removeAttribute('data-gh-select-listbox'));

    let container = queryOne('[data-automation-id="activeListContainer"]');
    if (!visible(container)) {
      container = Array.from(queryAll('[role="listbox"]')).find((candidate) => visible(candidate)) ?? null;
    }

    let optionNodes: Element[] = [];
    if (container && visible(container)) {
      optionNodes = Array.from(container.querySelectorAll('[role="option"]'));
      if (optionNodes.length === 0) {
        optionNodes = Array.from(container.querySelectorAll('[data-automation-id="promptOption"], [data-automation-id="menuItem"], li'));
      }
    }

    if (optionNodes.length === 0) {
      optionNodes = queryAll('[role="option"]').filter((node) => visible(node));
    }

    if (optionNodes.length === 0) {
      const dropdowns = queryAll(
        '[class*="dropdown"]:not([style*="display: none"]), [class*="menu"]:not([style*="display: none"]), [class*="listbox"]:not([style*="display: none"])',
      );
      for (const dropdown of dropdowns) {
        if (!visible(dropdown)) {
          continue;
        }
        const items = Array.from(dropdown.querySelectorAll('li')).filter((node) => visible(node));
        if (items.length > 0) {
          container = dropdown;
          optionNodes = items;
          break;
        }
      }
    }

    if (container && visible(container)) {
      container.setAttribute('data-gh-select-listbox', 'active');
    }

    const listboxSelector = container && visible(container)
      ? container.id
        ? `#${CSS.escape(container.id)}`
        : container.getAttribute('data-automation-id')
          ? `[data-automation-id="${container.getAttribute('data-automation-id')}"]`
          : '[data-gh-select-listbox="active"]'
      : null;

    const selectedOptions: string[] = [];
    const options = optionNodes
      .map((node, index) => {
        const element = node as HTMLElement;
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length >= 200) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return null;
        }

        const disabled =
          element.getAttribute('aria-disabled') === 'true' ||
          element.hasAttribute('disabled');
        const selected =
          element.getAttribute('aria-selected') === 'true' ||
          element.getAttribute('aria-checked') === 'true' ||
          element.className.toLowerCase().includes('selected');
        if (selected) {
          selectedOptions.push(text);
        }

        const hasHierarchy =
          !!element.querySelector('svg.wd-icon-chevron-right-small') ||
          element.getAttribute('data-uxi-multiselectlistitem-hassidecharm') === 'true';

        element.setAttribute('data-gh-select-option', `opt-${index}`);
        return {
          label: text,
          value: element.getAttribute('data-value') || element.getAttribute('value') || text,
          disabled,
          optionSelector: `[data-gh-select-option="opt-${index}"]`,
          hasHierarchy,
          setsize: parseInt(element.getAttribute('aria-setsize') || '0', 10),
        };
      })
      .filter((option): option is RawDiscoveredOption => option !== null);

    const isVirtualized = options.some((option) => option.setsize > options.length) ||
      !!(container && (container as HTMLElement).scrollHeight > (container as HTMLElement).clientHeight + 20 && options.length > 0);
    const hasHierarchy = options.some((option) => option.hasHierarchy);

    return {
      options,
      selectedOptions,
      listboxSelector,
      isVirtualized,
      hasHierarchy,
    };
  });

  const options = dedupeOptions(
    raw.options.map((option) =>
      buildOption(option.label, option.value, {
        disabled: option.disabled,
        optionSelector: option.optionSelector,
      }),
    ),
  );

  return {
    options,
    selectedOptions: raw.selectedOptions,
    listboxSelector: raw.listboxSelector,
    isVirtualized: raw.isVirtualized,
    hasHierarchy: raw.hasHierarchy,
  };
}

async function collectVisibleOptionLabels(page: Page): Promise<SelectOption[]> {
  const all = new Map<string, SelectOption>();
  let lastFingerprint = '';

  for (let attempt = 0; attempt < 20; attempt++) {
    const snapshot = await readActiveListOptions(page);
    for (const option of snapshot.options) {
      const key = `${option.normalizedLabel}::${option.value}`;
      if (!all.has(key)) {
        all.set(key, option);
      }
    }

    if (!snapshot.isVirtualized) {
      break;
    }

    const advanced = await page.evaluate(() => {
      const container = document.querySelector('[data-gh-select-listbox="active"], [data-automation-id="activeListContainer"], [role="listbox"]') as HTMLElement | null;
      if (!container) {
        return false;
      }
      const before = container.scrollTop;
      container.scrollTop += 300;
      return container.scrollTop > before;
    }).catch(() => false);

    const fingerprint = Array.from(all.keys()).join('|');
    if (!advanced || fingerprint === lastFingerprint) {
      break;
    }
    lastFingerprint = fingerprint;
    await page.waitForTimeout(150);
  }

  return Array.from(all.values());
}

async function clickActiveListOption(page: Page, text: string, optionSelector?: string | null): Promise<boolean> {
  const exactRe = new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`, 'i');

  try {
    if (optionSelector) {
      const tagged = page.locator(optionSelector).first();
      if (await tagged.count() > 0) {
        await tagged.click({ timeout: 2000 });
        return true;
      }
    }

    const portal = page.locator('[data-automation-id="activeListContainer"]');
    if (await portal.count() > 0) {
      let option = portal.locator('[role="option"]').filter({ hasText: exactRe }).first();
      if (await option.count() === 0) {
        option = portal.locator('[data-automation-id="promptOption"], [data-automation-id="menuItem"]').filter({ hasText: exactRe }).first();
      }
      if (await option.count() > 0) {
        await option.click({ timeout: 2000 });
        return true;
      }
      option = portal.locator('[role="option"]').filter({ hasText: text }).first();
      if (await option.count() > 0) {
        await option.click({ timeout: 2000 });
        return true;
      }
    }

    const listbox = page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: exactRe }).first();
    if (await listbox.count() > 0) {
      await listbox.click({ timeout: 2000 });
      return true;
    }

    const anyOption = page.locator('[role="option"]:visible').filter({ hasText: exactRe }).first();
    if (await anyOption.count() > 0) {
      await anyOption.click({ timeout: 2000 });
      return true;
    }

    for (const containerSelector of [
      'ul:visible li',
      '[class*="dropdown"]:visible li',
      '[class*="menu"]:visible li',
      '[class*="select"]:visible li',
      '[class*="listbox"]:visible li',
    ]) {
      const item = page.locator(containerSelector).filter({ hasText: exactRe }).first();
      if (await item.count() > 0) {
        await item.click({ timeout: 2000 });
        return true;
      }
    }

    const substring = page.locator('[role="listbox"]:visible [role="option"]').filter({ hasText: text }).first();
    if (await substring.count() > 0) {
      await substring.click({ timeout: 2000 });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function readTypeaheadInputSelector(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((fieldSelector) => {
    document.querySelectorAll('[data-gh-select-input]').forEach((node) => {
      node.removeAttribute('data-gh-select-input');
    });

    const el = document.querySelector(fieldSelector) as HTMLElement | null;
    if (!el) {
      return null;
    }

    const input = (
      (el.matches('input') ? el : null) ||
      el.querySelector('input[type="text"], input:not([type]), [contenteditable="true"]') ||
      document.activeElement
    ) as HTMLElement | null;

    if (!input || !(input instanceof HTMLElement)) {
      return null;
    }

    input.setAttribute('data-gh-select-input', 'active');
    return '[data-gh-select-input="active"]';
  }, selector).catch(() => null);
}

async function discoverHierarchicalOptions(
  page: Page,
  triggerSelector: string,
): Promise<SelectOption[]> {
  const topLevel = await readActiveListOptions(page);
  if (!topLevel.hasHierarchy || topLevel.options.length === 0) {
    return topLevel.options;
  }

  const discovered: SelectOption[] = [];

  for (let index = 0; index < topLevel.options.length; index++) {
    const category = topLevel.options[index];
    if (category.disabled) {
      continue;
    }

    if (index > 0) {
      await clickComboboxTrigger(page, triggerSelector);
      await page.waitForTimeout(500);
    }

    const clicked = await clickActiveListOption(page, category.label, category.optionSelector);
    if (!clicked) {
      continue;
    }
    await page.waitForTimeout(800);

    const subOptions = await collectVisibleOptionLabels(page);
    for (const option of subOptions) {
      if (matchesSelectValue(option.label, category.label)) {
        continue;
      }
      discovered.push(buildOption(option.label, `${category.label} > ${option.label}`, {
        disabled: option.disabled,
        hierarchyPath: `${category.label} > ${option.label}`,
        optionSelector: option.optionSelector,
      }));
    }
  }

  return discovered.length > 0 ? dedupeOptions(discovered) : topLevel.options;
}

async function discoverNativeSelectState(
  page: Page,
  field: FieldSnapshot,
  variant: SelectStateModel['variant'],
): Promise<SelectStateModel> {
  const raw: RawNativeSelectSnapshot | null = await page.evaluate((fieldSelector) => {
    const el = document.querySelector(fieldSelector) as HTMLSelectElement | null;
    if (!el) {
      return null;
    }

    return {
      options: Array.from(el.options).map((option, index) => ({
        label: (option.textContent || '').trim(),
        value: option.value,
        disabled: option.disabled,
        selected: option.selected,
        optionSelector: `${fieldSelector} > option:nth-of-type(${index + 1})`,
      })),
      selectedOptions: Array.from(el.selectedOptions)
        .map((option) => (option.textContent || '').trim())
        .filter(Boolean),
      isMultiSelect: el.multiple,
    };
  }, field.selector);

  const options = raw?.options
    ? dedupeOptions(raw.options.map((option) =>
        buildOption(option.label, option.value, {
          disabled: option.disabled,
          optionSelector: option.optionSelector,
        }),
      ))
    : dedupeOptions((field.options || []).map((option) => buildOption(option)));

  const selectedOptions = raw?.selectedOptions?.length
    ? raw.selectedOptions
    : (!isPlaceholderLabel(field.currentValue) ? [field.currentValue] : []);

  return {
    fieldKey: stableFieldKey(field),
    variant,
    options,
    selectedOptions,
    isMultiSelect: raw?.isMultiSelect ?? false,
    isExpanded: false,
    triggerSelector: field.selector,
    listboxSelector: null,
    isVirtualized: false,
    discoveredAt: Date.now(),
  };
}

async function discoverButtonGroupState(
  page: Page,
  field: FieldSnapshot,
): Promise<SelectStateModel> {
  const raw = await page.evaluate((fieldSelector) => {
    const root = document.querySelector(fieldSelector) as HTMLElement | null;
    if (!root) {
      return null;
    }

    const buttons = Array.from(
      root.querySelectorAll('[role="radio"], [role="button"], button, input[type="radio"], label'),
    ) as HTMLElement[];
    const options = buttons
      .map((button, index) => {
        const label = (
          button.textContent ||
          (button as HTMLInputElement).value ||
          button.getAttribute('aria-label') ||
          ''
        ).replace(/\s+/g, ' ').trim();
        if (!label) {
          return null;
        }
        button.setAttribute('data-gh-select-option', `button-${index}`);
        const selected =
          button.getAttribute('aria-checked') === 'true' ||
          button.getAttribute('aria-pressed') === 'true' ||
          button.className.toLowerCase().includes('selected');
        return {
          label,
          disabled: button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled'),
          selected,
          optionSelector: `[data-gh-select-option="button-${index}"]`,
        };
      })
      .filter((option): option is RawButtonGroupOption => option !== null);

    return {
      options,
      selectedOptions: options.filter((option) => option.selected).map((option) => option.label),
    };
  }, field.selector).catch(() => null);

  return {
    fieldKey: stableFieldKey(field),
    variant: 'button_group',
    options: raw?.options
      ? dedupeOptions(raw.options.map((option) =>
          buildOption(option.label, option.label, {
            disabled: option.disabled,
            optionSelector: option.optionSelector,
          }),
        ))
      : dedupeOptions((field.options || []).map((option) => buildOption(option))),
    selectedOptions: raw?.selectedOptions?.length
      ? raw.selectedOptions
      : (!isPlaceholderLabel(field.currentValue) ? [field.currentValue] : []),
    isMultiSelect: false,
    isExpanded: false,
    triggerSelector: field.selector,
    listboxSelector: null,
    isVirtualized: false,
    discoveredAt: Date.now(),
  };
}

export function classifyDropdownVariant(field: FieldSnapshot): SelectStateModel['variant'] {
  const selector = normalizeSelectText(field.selector);
  const label = normalizeSelectText(field.label);

  if (field.fieldType === 'button_group' || field.fieldType === 'aria_radio' || field.fieldType === 'radio') {
    return 'button_group';
  }

  if (field.fieldType === 'typeahead') {
    return 'typeahead';
  }

  if (field.fieldType === 'select') {
    return 'native_select';
  }

  if (
    selector.includes('listbox') ||
    selector.includes('aria-haspopup="listbox"') ||
    selector.includes('role="listbox"')
  ) {
    return 'aria_listbox';
  }

  if (
    selector.includes('typeahead') ||
    selector.includes('autocomplete') ||
    selector.includes('searchbox') ||
    label.includes('skill') ||
    label.includes('skills')
  ) {
    return 'typeahead';
  }

  return 'custom_dropdown';
}

export async function discoverSelectState(
  page: Page,
  field: FieldSnapshot,
  forceDiscover = false,
): Promise<SelectStateModel> {
  const variant = classifyDropdownVariant(field);
  if (variant === 'native_select') {
    return discoverNativeSelectState(page, field, variant);
  }
  if (variant === 'button_group') {
    return discoverButtonGroupState(page, field);
  }

  const initiallyOpen = await isDropdownPopupOpen(page);
  const currentDisplay = await readSelectCurrentDisplay(page, field.selector);
  let options = dedupeOptions((field.options || []).map((option) => buildOption(option)));
  let listboxSelector: string | null = null;
  let isVirtualized = false;
  let selectedOptions = !isPlaceholderLabel(currentDisplay)
    ? [currentDisplay]
    : (!isPlaceholderLabel(field.currentValue) ? [field.currentValue] : []);
  let openedByUs = false;

  if (initiallyOpen || forceDiscover || options.length === 0) {
    if (!initiallyOpen) {
      await dismissDropdownIfOpen(page);
      await clickComboboxTrigger(page, field.selector);
      openedByUs = true;
    }

    const liveOptions = await readActiveListOptions(page);
    listboxSelector = liveOptions.listboxSelector;
    isVirtualized = liveOptions.isVirtualized;
    if (liveOptions.selectedOptions.length > 0) {
      selectedOptions = liveOptions.selectedOptions;
    }

    options = liveOptions.hasHierarchy
      ? await discoverHierarchicalOptions(page, field.selector)
      : (liveOptions.isVirtualized ? await collectVisibleOptionLabels(page) : liveOptions.options);

    if (options.length === 0) {
      options = dedupeOptions((field.options || []).map((option) => buildOption(option)));
    }
  }

  if (openedByUs && !initiallyOpen) {
    await dismissDropdownIfOpen(page);
  }

  return {
    fieldKey: stableFieldKey(field),
    variant,
    options,
    selectedOptions,
    isMultiSelect: selectedOptions.length > 1,
    isExpanded: initiallyOpen || openedByUs ? await isDropdownPopupOpen(page) : false,
    triggerSelector: field.selector,
    listboxSelector,
    isVirtualized,
    discoveredAt: Date.now(),
  };
}

async function selectNativeOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  try {
    await page.selectOption(select.triggerSelector, { label: value }, { timeout: 2000 });
    const selectedLabels = await readNativeSelectedLabels(page, select.triggerSelector);
    return {
      selected: selectedLabels.some((label) => matchesSelectValue(label, value)),
      method: 'native_label',
    };
  } catch {
    // Fuzzy fallback below.
  }

  const matchedValue = await page.evaluate(({ selector, text }) => {
    const el = document.querySelector(selector) as HTMLSelectElement | null;
    if (!el) {
      return null;
    }
    const lower = text.toLowerCase();
    for (const option of Array.from(el.options)) {
      const label = (option.textContent || '').trim().toLowerCase();
      if (label === lower || label.startsWith(lower) || lower.startsWith(label) || label.includes(lower)) {
        return option.value;
      }
    }
    return null;
  }, { selector: select.triggerSelector, text: value }).catch(() => null);

  if (!matchedValue) {
    return { selected: false, method: 'native_unmatched' };
  }

  try {
    await page.selectOption(select.triggerSelector, matchedValue, { timeout: 2000 });
    const selectedLabels = await readNativeSelectedLabels(page, select.triggerSelector);
    return {
      selected: selectedLabels.some((label) => matchesSelectValue(label, value)),
      method: 'native_fuzzy',
    };
  } catch {
    return { selected: false, method: 'native_failed' };
  }
}

async function selectButtonGroupOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  const match = findBestOption(select.options, value);
  const target = match?.optionSelector
    ? page.locator(match.optionSelector).first()
    : page
        .locator(`${select.triggerSelector} [role="radio"], ${select.triggerSelector} [role="button"], ${select.triggerSelector} button`)
        .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(match?.label || value)}\\s*$`, 'i') })
        .first();

  try {
    if (await target.count() > 0) {
      await target.click({ timeout: 2000 });
      return { selected: true, method: 'button_group_click' };
    }
  } catch {
    // Fall through.
  }

  return { selected: false, method: 'button_group_failed' };
}

async function verifySelection(page: Page, triggerSelector: string, value: string): Promise<boolean> {
  const display = await readSelectCurrentDisplay(page, triggerSelector);
  if (matchesSelectValue(display, value)) {
    return true;
  }

  const selectedLabels = await readNativeSelectedLabels(page, triggerSelector);
  return selectedLabels.some((label) => matchesSelectValue(label, value));
}

async function selectHierarchicalOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  const [category, optionValue] = value.split(' > ', 2);
  if (!category || !optionValue) {
    return { selected: false, method: 'hierarchy_invalid' };
  }

  await dismissDropdownIfOpen(page);
  await clickComboboxTrigger(page, select.triggerSelector);
  await page.waitForTimeout(500);

  const categoryClicked = await clickActiveListOption(page, category);
  if (!categoryClicked) {
    await dismissDropdownIfOpen(page);
    return { selected: false, method: 'hierarchy_category_failed' };
  }

  await page.waitForTimeout(800);
  const exact = await clickActiveListOption(page, optionValue);
  if (exact) {
    await page.waitForTimeout(EXACT_WAIT_MS);
    const selected = await verifySelection(page, select.triggerSelector, optionValue);
    await dismissDropdownIfOpen(page);
    return { selected, method: 'hierarchy_click' };
  }

  const visible = await collectVisibleOptionLabels(page);
  const fuzzy = findBestOption(visible, optionValue);
  if (fuzzy) {
    const clicked = await clickActiveListOption(page, fuzzy.label, fuzzy.optionSelector);
    await page.waitForTimeout(EXACT_WAIT_MS);
    const selected = clicked && await verifySelection(page, select.triggerSelector, fuzzy.label);
    await dismissDropdownIfOpen(page);
    return { selected, method: clicked ? 'hierarchy_fuzzy' : 'hierarchy_failed' };
  }

  await dismissDropdownIfOpen(page);
  return { selected: false, method: 'hierarchy_unmatched' };
}

async function selectCustomOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  if (value.includes(' > ')) {
    return selectHierarchicalOption(page, select, value);
  }

  await dismissDropdownIfOpen(page);
  await clickComboboxTrigger(page, select.triggerSelector);
  await page.waitForTimeout(600);

  const match = findBestOption(select.options, value);
  if (match) {
    const clicked = await clickActiveListOption(page, match.label, match.optionSelector);
    if (clicked) {
      await page.waitForTimeout(EXACT_WAIT_MS);
      const selected = await verifySelection(page, select.triggerSelector, match.hierarchyPath || match.label);
      await dismissDropdownIfOpen(page);
      if (selected) {
        return { selected: true, method: 'custom_option_click' };
      }
    }
  }

  if (select.variant === 'typeahead') {
    const inputSelector = await readTypeaheadInputSelector(page, select.triggerSelector);
    if (inputSelector) {
      await page.locator(inputSelector).first().fill('');
      await page.locator(inputSelector).first().type(value.slice(0, 80), { delay: 40 });
    } else {
      await page.keyboard.type(value.slice(0, 80), { delay: 40 });
    }
    await page.waitForTimeout(800);

    const typedClick = await clickActiveListOption(page, value);
    if (typedClick) {
      await page.waitForTimeout(EXACT_WAIT_MS);
      const selected = await verifySelection(page, select.triggerSelector, value);
      await dismissDropdownIfOpen(page);
      if (selected) {
        return { selected: true, method: 'typeahead_click' };
      }
    }
  }

  const liveOptions = select.isVirtualized ? await collectVisibleOptionLabels(page) : (await readActiveListOptions(page)).options;
  const fuzzy = findBestOption(liveOptions, value);
  if (fuzzy) {
    const clicked = await clickActiveListOption(page, fuzzy.label, fuzzy.optionSelector);
    if (clicked) {
      await page.waitForTimeout(EXACT_WAIT_MS);
      const selected = await verifySelection(page, select.triggerSelector, fuzzy.hierarchyPath || fuzzy.label);
      await dismissDropdownIfOpen(page);
      if (selected) {
        return { selected: true, method: 'custom_fuzzy_click' };
      }
    }
  }

  const fallback = await page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) {
      return null;
    }
    let native = el.querySelector('select') as HTMLSelectElement | null;
    if (!native) {
      native = el.nextElementSibling?.tagName === 'SELECT'
        ? el.nextElementSibling as HTMLSelectElement
        : null;
    }
    if (!native) {
      return null;
    }
    return native.id ? `#${CSS.escape(native.id)}` : null;
  }, select.triggerSelector).catch(() => null);

  if (fallback) {
    const nativeResult = await selectNativeOption(page, {
      ...select,
      variant: 'native_select',
      triggerSelector: fallback,
    }, value);
    if (nativeResult.selected) {
      await dismissDropdownIfOpen(page);
      return { selected: true, method: `custom_${nativeResult.method}` };
    }
  }

  await dismissDropdownIfOpen(page);
  return { selected: false, method: 'custom_failed' };
}

async function selectAriaListboxOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  await dismissDropdownIfOpen(page);
  await clickComboboxTrigger(page, select.triggerSelector);
  await page.waitForTimeout(500);

  try {
    await page.locator(select.triggerSelector).first().focus({ timeout: 1000 });
  } catch {
    // Best effort.
  }

  const liveOptions = (await readActiveListOptions(page)).options;
  const target = findBestOption(liveOptions, value);
  if (target) {
    for (let index = 0; index < liveOptions.length + 2; index++) {
      const active = await page.evaluate(() => {
        const focused = document.activeElement as HTMLElement | null;
        if (!focused) {
          return '';
        }
        const activeId = focused.getAttribute('aria-activedescendant');
        if (activeId) {
          const activeNode = document.getElementById(activeId);
          return (activeNode?.textContent || '').replace(/\s+/g, ' ').trim();
        }
        const selectedNode = document.querySelector('[role="option"][aria-selected="true"]');
        return (selectedNode?.textContent || '').replace(/\s+/g, ' ').trim();
      }).catch(() => '');

      if (matchesSelectValue(active, target.label)) {
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(EXACT_WAIT_MS);
        const selected = await verifySelection(page, select.triggerSelector, target.label);
        await dismissDropdownIfOpen(page);
        if (selected) {
          return { selected: true, method: 'aria_keyboard' };
        }
        break;
      }

      await page.keyboard.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(120);
    }
  }

  const clicked = target ? await clickActiveListOption(page, target.label, target.optionSelector) : false;
  if (clicked) {
    await page.waitForTimeout(EXACT_WAIT_MS);
    const selected = await verifySelection(page, select.triggerSelector, target?.label || value);
    await dismissDropdownIfOpen(page);
    return { selected, method: 'aria_click_fallback' };
  }

  await dismissDropdownIfOpen(page);
  return { selected: false, method: 'aria_failed' };
}

export async function selectOption(
  page: Page,
  select: SelectStateModel,
  value: string,
): Promise<{ selected: boolean; method: string }> {
  if (select.selectedOptions.some((selected) => matchesSelectValue(selected, value))) {
    return { selected: true, method: 'already_selected' };
  }

  switch (select.variant) {
    case 'native_select':
      return selectNativeOption(page, select, value);
    case 'button_group':
      return selectButtonGroupOption(page, select, value);
    case 'typeahead':
    case 'custom_dropdown':
      return selectCustomOption(page, select, value);
    case 'aria_listbox':
      return selectAriaListboxOption(page, select, value);
    default:
      return { selected: false, method: 'unsupported_variant' };
  }
}
