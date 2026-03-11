import type { Page } from 'playwright';
import type { BrowserAutomationAdapter } from '../../adapters/types';
import { detectPageType, detectPlatform } from '../PageObserver';
import { PageScanner } from '../v3/PageScanner';
import { extractAXFields } from './axTreeExtractor';
import type { AXFieldNode, DurableFieldRecord, MergedPageObservation } from './mergedObserverTypes';
import { mergeObservations } from './observerMerger';
import { PLATFORM_GUARDRAILS } from './prompts';
import type { ActionHistoryEntry, PageDecisionContext } from './types';
import { PageDecisionContextSchema } from './types';

export type ObservationScope = 'current_view' | 'full_page_audit';

const MAX_AX_EXTRACTION_MS = 200;

type ExtractorResult<T> = {
  ok: boolean;
  value: T;
};

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function guardrailHintsFor(platform: string): string[] {
  const raw = PLATFORM_GUARDRAILS[platform] ?? PLATFORM_GUARDRAILS.other;
  return raw
    .split('\n')
    .map((line) => line.trim().replace(/^-+\s*/, ''))
    .filter(Boolean);
}

async function safeExtract<T>(fn: () => Promise<T>, fallback: T): Promise<ExtractorResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false, value: fallback };
  }
}

export class PageSnapshotBuilder {
  constructor(
    private readonly platform?: string,
    private readonly viewportOnly: boolean = true,
    private readonly scope: ObservationScope = 'current_view',
    private readonly adapter?: BrowserAutomationAdapter,
  ) {}

  async buildSnapshot(
    page: Page,
    actionHistory: ActionHistoryEntry[] = [],
  ): Promise<PageDecisionContext> {
    const url = page.url();
    const normalizedHint = (this.platform || '').trim().toLowerCase();
    const platform =
      !normalizedHint || normalizedHint === 'other' || normalizedHint === 'generic' || normalizedHint === 'unknown'
        ? detectPlatform(url)
        : this.platform!;
    const scanner = new PageScanner(page, platform);

    // Inject shadow DOM traversal helpers so repeater detection and fingerprinting
    // can reach elements inside shadow roots (SmartRecruiters, Workday, etc.)
    await this.injectShadowDOMHelpers(page);

    const scanResult = await safeExtract(
      async () => this.scope === 'current_view' ? scanner.scanCurrentViewport() : scanner.scan(),
      {
        url,
        platform,
        pageType: 'unknown',
        pageLabel: undefined,
        fields: [],
        buttons: [],
        scrollHeight: 0,
        viewportHeight: 0,
        timestamp: Date.now(),
      } as Awaited<ReturnType<PageScanner['scan']>>,
    );

    const [
      titleResult,
      pageTypeResult,
      headingsResult,
      quickProbeResult,
      repeatersResult,
      fingerprintResult,
      blockerResult,
      stepContextResult,
    ] = await Promise.all([
      safeExtract(async () => page.title(), ''),
      safeExtract(async () => detectPageType(page), scanResult.value.pageType ?? 'unknown'),
      safeExtract(async () => this.extractHeadings(page), [] as string[]),
      safeExtract(async () => this.quickProbeVisibleControls(page), {
        headings: [] as string[],
        fields: [] as PageDecisionContext['fields'],
        buttons: [] as PageDecisionContext['buttons'],
        fieldCount: 0,
        filledCount: 0,
      }),
      safeExtract(async () => this.detectRepeaters(page), [] as PageDecisionContext['repeaters']),
      safeExtract(async () => this.extractFingerprint(page), {
        heading: scanResult.value.pageLabel ?? '',
        fieldCount: scanResult.value.fields.length,
        filledCount: scanResult.value.fields.filter((field) => !field.isEmpty).length,
        activeStep: '',
        hash: hashString(
          `${scanResult.value.pageLabel ?? ''}|${scanResult.value.fields.length}|${scanResult.value.fields.filter((field) => !field.isEmpty).length}`,
        ),
      }),
      safeExtract(async () => this.detectBlocker(page), {
        detected: false,
        type: null,
        confidence: 0,
      }),
      safeExtract(async () => this.extractStepContext(page), null),
    ]);

    const totalExtractors = 9;
    const successfulExtractors = [
      scanResult.ok,
      titleResult.ok,
      pageTypeResult.ok,
      headingsResult.ok,
      quickProbeResult.ok,
      repeatersResult.ok,
      fingerprintResult.ok,
      blockerResult.ok,
      stepContextResult.ok,
    ].filter(Boolean).length;

    const snapshot: PageDecisionContext = {
      url,
      title: titleResult.value,
      platform,
      pageType: pageTypeResult.value || scanResult.value.pageType || 'unknown',
      headings: headingsResult.value,
      fields: scanResult.value.fields.map((field, ordinalIndex) => ({
        id: field.id,
        selector: field.selector,
        label: field.label || field.name || field.fieldId || field.id,
        fieldType: field.fieldType,
        ordinalIndex,
        isRequired: field.isRequired,
        isVisible: field.isVisible,
        isDisabled: field.isDisabled,
        isEmpty: field.isEmpty,
        currentValue: field.currentValue ?? '',
        options: field.options,
        groupKey: field.groupKey,
      })),
      buttons: scanResult.value.buttons.map((button) => ({
        selector: button.selector,
        text: button.text,
        role: button.role,
        isDisabled: button.isDisabled,
        automationId: button.automationId,
      })),
      stepContext: stepContextResult.value,
      repeaters: repeatersResult.value,
      fingerprint: fingerprintResult.value,
      blocker: blockerResult.value,
      actionHistory: actionHistory.slice(-10),
      guardrailHints: guardrailHintsFor(platform),
      observationConfidence: Math.min(1, successfulExtractors / totalExtractors),
      observedAt: Date.now(),
    };

    if (this.scope === 'current_view') {
      if (snapshot.headings.length === 0 && quickProbeResult.value.headings.length > 0) {
        snapshot.headings = quickProbeResult.value.headings.slice(0, 25);
      }

      const mergedFields = new Map(snapshot.fields.map((field) => [field.selector, field] as const));
      for (const field of quickProbeResult.value.fields) {
        if (!mergedFields.has(field.selector)) {
          mergedFields.set(field.selector, field);
        }
      }
      snapshot.fields = Array.from(mergedFields.values());
      snapshot.fields.forEach((field, idx) => { field.ordinalIndex = idx; });

      const mergedButtons = new Map(snapshot.buttons.map((button) => [button.selector, button] as const));
      for (const button of quickProbeResult.value.buttons) {
        if (!mergedButtons.has(button.selector)) {
          mergedButtons.set(button.selector, button);
        }
      }
      snapshot.buttons = Array.from(mergedButtons.values());

      snapshot.fingerprint.fieldCount = Math.max(
        snapshot.fingerprint.fieldCount,
        quickProbeResult.value.fieldCount,
        snapshot.fields.length,
      );
      snapshot.fingerprint.filledCount = Math.max(
        snapshot.fingerprint.filledCount,
        quickProbeResult.value.filledCount,
        snapshot.fields.filter((field) => !field.isEmpty).length,
      );
      snapshot.fingerprint.hash = hashString(
        `${snapshot.fingerprint.heading}|fields:${snapshot.fingerprint.fieldCount}|filled:${snapshot.fingerprint.filledCount}|active:${snapshot.fingerprint.activeStep}`,
      );
    }

    // Filter to viewport-visible elements only to avoid exposing offscreen
    // submit buttons and future-step CTAs to the LLM prematurely.
    // Current-view scans are already limited to the visible viewport.
    if (this.viewportOnly && this.scope !== 'current_view') {
      const visibleSelectors = await this.getViewportVisibleSelectors(page, [
        ...snapshot.fields.map((f) => f.selector),
        ...snapshot.buttons.map((b) => b.selector),
      ]);
      snapshot.fields = snapshot.fields.filter((f) => visibleSelectors.has(f.selector));
      snapshot.buttons = snapshot.buttons.filter((b) => visibleSelectors.has(b.selector));
    }

    return PageDecisionContextSchema.parse(snapshot);
  }

  async buildMergedSnapshot(
    page: Page,
    actionHistory: ActionHistoryEntry[] = [],
    durableContext: Map<string, DurableFieldRecord> = new Map(),
    tiebreakerFn?: Parameters<typeof mergeObservations>[3],
    domSnapshotOverride?: PageDecisionContext,
    adapter: Parameters<typeof mergeObservations>[5] = this.adapter,
  ): Promise<MergedPageObservation> {
    const domSnapshot = domSnapshotOverride ?? await this.buildSnapshot(page, actionHistory);
    const axFields = await Promise.race<AXFieldNode[]>([
      extractAXFields(page).catch(() => []),
      new Promise<AXFieldNode[]>((resolve) => {
        setTimeout(() => resolve([]), MAX_AX_EXTRACTION_MS);
      }),
    ]);

    return mergeObservations(domSnapshot, axFields, durableContext, tiebreakerFn, page, adapter);
  }

  private async quickProbeVisibleControls(
    page: Page,
  ): Promise<{
    headings: string[];
    fields: PageDecisionContext['fields'];
    buttons: PageDecisionContext['buttons'];
    fieldCount: number;
    filledCount: number;
  }> {
    return page.evaluate((scope: ObservationScope) => {
      const ff = (window as Window & { __ff?: any }).__ff;
      const qAll = <T extends Element = HTMLElement>(selector: string): T[] =>
        ff?.queryAll?.(selector) ?? Array.from(document.querySelectorAll<T>(selector));
      const inView = (node: Element | null): node is HTMLElement => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (node.getAttribute('aria-hidden') === 'true') return false;
        if (scope === 'current_view') {
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }
        return true;
      };
      const buildSelector = (el: Element, prefix: string, idx: number): string => {
        const id = el.getAttribute('id');
        if (id) return `#${CSS.escape(id)}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const autoId = el.getAttribute('data-automation-id');
        if (autoId) return `[data-automation-id="${CSS.escape(autoId)}"]`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const marker = `${prefix}-${idx}`;
        el.setAttribute('data-gh-quick-probe', marker);
        return `[data-gh-quick-probe="${marker}"]`;
      };
      const labelFor = (el: Element): string => {
        const direct = (
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          ('labels' in el && (el as HTMLInputElement).labels && (el as HTMLInputElement).labels![0]?.textContent) ||
          ''
        ).trim();
        if (direct) return direct.replace(/\s+/g, ' ').trim();
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          const text = (label?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) return text.replace(/\*/g, '').trim();
        }
        const previous = el.previousElementSibling;
        const prevText = (previous?.textContent || '').replace(/\s+/g, ' ').trim();
        if (prevText) return prevText.replace(/\*/g, '').trim();
        const name = el.getAttribute('name') || el.getAttribute('id') || el.tagName.toLowerCase();
        return name.replace(/[_-]/g, ' ').replace(/([A-Z])/g, ' $1').replace(/\s+/g, ' ').trim();
      };

      const headings = Array.from(
        new Set(
          qAll<HTMLElement>('h1, h2, h3, h4, legend, [role="heading"]')
            .filter((node) => inView(node))
            .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean),
        ),
      ).slice(0, 25);

      let filledCount = 0;
      const fields = qAll<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"]',
      )
        .filter((node) => inView(node) && !node.hasAttribute('disabled'))
        .map((node, index) => {
          const tag = node.tagName.toLowerCase();
          const rawType = (node.getAttribute('type') || '').toLowerCase();
          const fieldType: PageDecisionContext['fields'][number]['fieldType'] =
            tag === 'textarea'
              ? 'textarea'
              : tag === 'select'
                ? 'select'
                : tag === 'input' && rawType === 'email'
                  ? 'email'
                  : tag === 'input' && rawType === 'tel'
                    ? 'phone'
                    : tag === 'input' && rawType === 'number'
                      ? 'number'
                      : tag === 'input' && rawType === 'date'
                        ? 'date'
                        : tag === 'input' && rawType === 'password'
                          ? 'password'
                          : rawType === 'checkbox'
                            ? 'checkbox'
                            : node.getAttribute('role') === 'combobox'
                              ? 'custom_dropdown'
                              : tag === 'input' || tag === 'div'
                                ? 'text'
                                : 'unknown';
          const currentValue =
            tag === 'input' || tag === 'textarea' || tag === 'select'
              ? ((node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '')
              : (node.textContent || '').trim();
          const isEmpty = !currentValue.trim();
          if (!isEmpty) filledCount += 1;
          return {
            id: `quick-field-${index}`,
            selector: buildSelector(node, 'field', index),
            label: labelFor(node) || `Field ${index + 1}`,
            fieldType,
            ordinalIndex: index,
            isRequired:
              node.getAttribute('aria-required') === 'true' ||
              (tag === 'input' || tag === 'textarea' || tag === 'select'
                ? (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).required
                : false),
            isVisible: true,
            isDisabled: false,
            isEmpty,
            currentValue,
          };
        });

      const buttons = qAll<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"]')
        .filter((node) => inView(node) && node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('disabled'))
        .map((node, index) => {
          const text = (
            node.textContent ||
            (node as HTMLInputElement).value ||
            node.getAttribute('aria-label') ||
            ''
          ).replace(/\s+/g, ' ').trim();
          return {
            selector: buildSelector(node, 'button', index),
            text,
            role: (
              /apply|submit/i.test(text)
                ? 'submit'
                : /continue|next|save/i.test(text)
                  ? 'navigation'
                  : /add/i.test(text)
                    ? 'add'
                    : 'unknown'
            ) as PageDecisionContext['buttons'][number]['role'],
            isDisabled: false,
          };
        })
        .filter((button) => button.text.length > 0);

      return {
        headings,
        fields,
        buttons,
        fieldCount: fields.length,
        filledCount,
      };
    }, this.scope);
  }

  /**
   * Returns the set of selectors that are within the current viewport bounds.
   */
  private async getViewportVisibleSelectors(
    page: Page,
    selectors: string[],
  ): Promise<Set<string>> {
    try {
      const visible = await page.evaluate((sels: string[]) => {
        const vh = window.innerHeight;
        const result: string[] = [];
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            // Element is at least partially in viewport
            if (rect.bottom > 0 && rect.top < vh && rect.width > 0 && rect.height > 0) {
              result.push(sel);
            }
          } catch { /* skip invalid selectors */ }
        }
        return result;
      }, selectors);
      return new Set(visible);
    } catch {
      // On failure, include all elements (safe fallback)
      return new Set(selectors);
    }
  }

  private async extractHeadings(page: Page): Promise<string[]> {
    return page.evaluate((scope: ObservationScope) => {
      const ff = (window as Window & { __ff?: any }).__ff;
      const selectors = 'h1, h2, h3, h4, legend, [role="heading"]';
      const nodes: HTMLElement[] = ff?.queryAll?.(selectors) ?? Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const visible = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (scope === 'current_view' && (rect.bottom <= 0 || rect.top >= window.innerHeight)) return false;
        const style = window.getComputedStyle(node);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          node.getAttribute('aria-hidden') !== 'true'
        );
      });

      return Array.from(new Set(
        visible
          .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      )).slice(0, 25);
    }, this.scope);
  }

  private async detectRepeaters(page: Page): Promise<PageDecisionContext['repeaters']> {
    return page.evaluate(() => {
      const repeaters: PageDecisionContext['repeaters'] = [];
      const addPattern = /^\+?\s*add\b/i;
      const ff = (window as Window & { __ff?: any }).__ff;

      const queryAll = (selector: string): HTMLElement[] =>
        Array.from(ff?.queryAll?.(selector) ?? document.querySelectorAll<HTMLElement>(selector));

      const rootParent = (node: Node | null): Element | null => {
        if (!node) return null;
        if (ff?.rootParent) return ff.rootParent(node);
        return (node as Element).parentElement ?? null;
      };

      const closestCrossRoot = (el: Element | null, selector: string): Element | null => {
        if (!el) return null;
        if (ff?.closestCrossRoot) return ff.closestCrossRoot(el, selector);
        return el.closest(selector);
      };

      const isWithinCrossRoot = (node: Element | null, ancestor: Element | null): boolean => {
        let current: Element | null = node;
        while (current) {
          if (current === ancestor) return true;
          current = rootParent(current);
        }
        return false;
      };

      const queryWithinCrossRoot = (ancestor: Element | null, selector: string): HTMLElement[] => {
        if (!ancestor) return [];
        return queryAll(selector).filter((candidate) => isWithinCrossRoot(candidate, ancestor));
      };

      const buttons = queryAll('button, [role="button"], a.add-btn, .add-btn');

      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const style = window.getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (button.getAttribute('aria-hidden') === 'true') continue;
        if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') continue;

        const text = (button.textContent || '').trim();
        if (!addPattern.test(text)) continue;

        const card = closestCrossRoot(
          button,
          '.card, .section, [class*="section"], [class*="card"], [data-automation-id*="Section"], [data-automation-id*="panel"], [class*="Panel"], [class*="panel"]',
        );

        let label = '';
        if (card) {
          const heading = queryWithinCrossRoot(
            card,
            'h2, h3, h4, [class*="heading"], [class*="title"], [data-automation-id*="sectionHeader"], [data-automation-id*="Title"], legend, [class*="legend"]',
          )[0];
          label = heading?.textContent?.trim() || '';
        }

        if (!label) {
          let current: Element | null = rootParent(button);
          while (current && !label) {
            const prev = current.previousElementSibling;
            if (prev) {
              if (['H2', 'H3', 'H4', 'LEGEND'].includes(prev.tagName)) {
                label = prev.textContent?.trim() || '';
              }
              const header = queryWithinCrossRoot(
                prev,
                '[data-automation-id*="sectionHeader"], [data-automation-id*="Title"]',
              )[0];
              if (header) label = header.textContent?.trim() || '';
            }
            current = rootParent(current);
            if (current === card) break;
          }
        }

        if (!label) {
          label = button.getAttribute('aria-label')?.trim() || text;
        }

        let currentCount = 0;
        if (card) {
          const allText = card.textContent || '';
          const sectionBase = label.replace(/\s*\d+$/, '').trim();
          if (sectionBase) {
            const numberedRe = new RegExp(
              `${sectionBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+`,
              'gi',
            );
            const matches = allText.match(numberedRe);
            if (matches) {
              currentCount = new Set(matches.map((match) => match.trim().toLowerCase())).size;
            }
          }

          if (currentCount === 0) {
            const list = queryWithinCrossRoot(
              card,
              '.repeater-list, [class*="repeater"], [class*="entries"], [data-automation-id*="itemList"], [data-automation-id*="entryList"]',
            )[0];
            if (list) currentCount = list.children.length;
          }

          if (currentCount === 0) {
            const groups = queryWithinCrossRoot(card, 'fieldset, [class*="entry"], [class*="item-group"]');
            if (groups.length > 0) currentCount = groups.length;
          }

          if (currentCount === 0) {
            const inputs = queryWithinCrossRoot(card, 'input[type="text"], textarea');
            currentCount = inputs.some((input) => (input as HTMLInputElement).value.trim()) ? 1 : 0;
          }
        }

        const marker = `gh-decision-repeater-${repeaters.length}`;
        button.setAttribute('data-gh-decision-repeater', marker);
        repeaters.push({
          label,
          addButtonSelector: `[data-gh-decision-repeater="${marker}"]`,
          currentCount,
        });
      }

      return repeaters;
    });
  }

  private async extractFingerprint(
    page: Page,
  ): Promise<PageDecisionContext['fingerprint']> {
    const fingerprint = await page.evaluate((scope: ObservationScope) => {
      const ff = (window as Window & { __ff?: any }).__ff;
      const qAll = <T extends Element = HTMLElement>(selector: string): T[] =>
        ff?.queryAll?.(selector) ?? Array.from(document.querySelectorAll<T>(selector));
      const inCurrentView = (node: Element | null): boolean => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (scope === 'current_view') {
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }
        return true;
      };

      const headingNode = qAll<HTMLElement>('h1, h2, h3, [role="heading"]').find((node) => inCurrentView(node)) ?? null;
      const heading = (headingNode?.textContent || '').trim().substring(0, 60);

      const fields = qAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="hidden"]), select, textarea',
      );
      let fieldCount = 0;
      let filledCount = 0;
      for (const field of fields) {
        if (inCurrentView(field)) {
          fieldCount++;
          if (field.value && field.value.trim()) filledCount++;
        }
      }

      const activeSelectors = [
        '[aria-current="step"]',
        '[aria-current="true"]',
        '.active-step',
        '.current-step',
        'li.active',
        'a.active',
        '[class*="activeSection"]',
        '[class*="currentSection"]',
      ];
      let activeStep = '';
      for (const selector of activeSelectors) {
        const active = document.querySelector<HTMLElement>(selector);
        if (active) {
          activeStep = (active.textContent || '').trim().substring(0, 40);
          break;
        }
      }

      return { heading, fieldCount, filledCount, activeStep };
    }, this.scope);

    const base = `${fingerprint.heading}|fields:${fingerprint.fieldCount}|filled:${fingerprint.filledCount}|active:${fingerprint.activeStep}`;
    return {
      ...fingerprint,
      hash: hashString(base),
    };
  }

  private async detectBlocker(
    page: Page,
  ): Promise<PageDecisionContext['blocker']> {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const passwordField = document.querySelector<HTMLInputElement>('input[type="password"]');

      const captchaSignals = [
        'captcha',
        'recaptcha',
        'hcaptcha',
        'turnstile',
        'not a robot',
        'verify you are human',
      ];
      const verificationSignals = [
        'verification code',
        'security code',
        'two-factor',
        '2fa',
      ];

      if (captchaSignals.some((signal) => bodyText.includes(signal))) {
        return {
          detected: true,
          type: 'captcha',
          confidence: 0.95,
        };
      }

      if (verificationSignals.some((signal) => bodyText.includes(signal))) {
        return {
          detected: true,
          type: 'verification',
          confidence: 0.75,
        };
      }

      if (passwordField && /sign in|log in|login|password/i.test(bodyText)) {
        return {
          detected: true,
          type: 'login',
          confidence: 0.7,
        };
      }

      return {
        detected: false,
        type: null,
        confidence: 0,
      };
    });
  }

  private async extractStepContext(
    page: Page,
  ): Promise<PageDecisionContext['stepContext']> {
    return page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const textMatch = bodyText.match(/\b(step)\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
      if (textMatch) {
        return {
          label: textMatch[0],
          current: Number(textMatch[2]),
          total: Number(textMatch[3]),
        };
      }

      const progressBar = document.querySelector<HTMLElement>('[role="progressbar"][aria-valuenow][aria-valuemax]');
      if (progressBar) {
        const current = Number(progressBar.getAttribute('aria-valuenow') || 0);
        const total = Number(progressBar.getAttribute('aria-valuemax') || 0);
        if (current > 0 && total > 0) {
          return {
            label: progressBar.getAttribute('aria-label') || progressBar.textContent?.trim() || 'progress',
            current,
            total,
          };
        }
      }

      const steps = Array.from(document.querySelectorAll<HTMLElement>(
        '[aria-current="step"], [data-step], li[class*="step"], div[class*="step"], [class*="progress-step"]',
      )).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      if (steps.length > 1) {
        const currentIndex = steps.findIndex((step) =>
          step.getAttribute('aria-current') === 'step' ||
          step.getAttribute('aria-current') === 'true' ||
          /active|current/i.test(step.className),
        );
        if (currentIndex >= 0) {
          return {
            label: steps[currentIndex].textContent?.trim() || `Step ${currentIndex + 1}`,
            current: currentIndex + 1,
            total: steps.length,
          };
        }
      }

      return null;
    });
  }

  /**
   * Inject window.__ff shadow DOM traversal helpers into the page context
   * so that repeater detection, fingerprinting, and heading extraction
   * can pierce shadow roots (critical for SmartRecruiters, Workday, etc.)
   */
  private async injectShadowDOMHelpers(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        if ((window as any).__ff) return; // Already injected

        function collectShadowRoots(node: Node): ShadowRoot[] {
          const roots: ShadowRoot[] = [];
          if (node instanceof Element && node.shadowRoot) {
            roots.push(node.shadowRoot);
          }
          for (const child of Array.from(node.childNodes)) {
            roots.push(...collectShadowRoots(child));
          }
          return roots;
        }

        function queryAll<T extends Element = HTMLElement>(selector: string): T[] {
          const results = new Set<T>();
          const queue: (Document | ShadowRoot)[] = [document];
          while (queue.length > 0) {
            const root = queue.shift()!;
            for (const el of Array.from(root.querySelectorAll<T>(selector))) {
              results.add(el);
            }
            // Discover shadow roots within this root
            for (const el of Array.from(root.querySelectorAll('*'))) {
              if (el.shadowRoot) queue.push(el.shadowRoot);
            }
          }
          return Array.from(results);
        }

        function rootParent(node: Node | null): Element | null {
          if (!node) return null;
          const parent = node.parentNode;
          if (!parent) return null;
          if (parent instanceof ShadowRoot) return parent.host;
          return parent instanceof Element ? parent : null;
        }

        function closestCrossRoot(el: Element | null, selector: string): Element | null {
          let current: Element | null = el;
          while (current) {
            const match = current.closest(selector);
            if (match) return match;
            const root = current.getRootNode();
            if (root instanceof ShadowRoot) {
              current = root.host;
            } else {
              break;
            }
          }
          return null;
        }

        (window as any).__ff = { queryAll, rootParent, closestCrossRoot };
      });
    } catch {
      // Non-fatal — fall back to document-only queries
    }
  }
}
