/**
 * TraceRecorder — Records browser actions as ManualStep sequences.
 *
 * Desktop-adapted version: subscribes directly to magnitude-core agent events
 * (not the adapter layer), getting full action payloads with x/y coordinates.
 *
 * Template detection: if a typed value matches a userData field value,
 * the value is stored as {{field_name}} for replayability.
 */

import type { Page } from 'playwright';
import type { ManualStep, LocatorDescriptor } from './types';

// ── Config ─────────────────────────────────────────────────────────────

export interface TraceRecorderOptions {
  /** Magnitude agent's page for DOM queries */
  page: Page;
  /** Magnitude agent's event emitter */
  events: { on(event: string, fn: (...args: any[]) => void): void; off(event: string, fn: (...args: any[]) => void): void };
  /** User data for template detection. Keys = field names, values = field values. */
  userData?: Record<string, string>;
}

// ── Magnitude action event shapes ──────────────────────────────────────
// Variants match magnitude-core's WebAction types (click, type, scroll, load)

interface ClickAction {
  variant: 'click';
  x: number;
  y: number;
}

interface TypeAction {
  variant: 'type';
  x: number;
  y: number;
  content: string;
}

interface ScrollAction {
  variant: 'scroll';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

interface NavAction {
  variant: 'load';
  url: string;
}

type ActionEvent = ClickAction | TypeAction | ScrollAction | NavAction | { variant: string; [key: string]: any };

// ── Element info returned by page.evaluate ────────────────────────────

interface ElementInfo {
  testId: string;
  role: string;
  name: string;
  ariaLabel: string;
  id: string;
  text: string;
  css: string;
  xpath: string;
}

// ── TraceRecorder ──────────────────────────────────────────────────────

export class TraceRecorder {
  private readonly page: Page;
  private readonly events: TraceRecorderOptions['events'];
  private readonly userData: Record<string, string>;
  private steps: ManualStep[] = [];
  private recording = false;
  private boundHandler: ((action: ActionEvent) => void) | null = null;

  constructor(options: TraceRecorderOptions) {
    this.page = options.page;
    this.events = options.events;
    this.userData = options.userData ?? {};
  }

  /** Start subscribing to agent events and recording steps. */
  start(): void {
    if (this.recording) return;

    this.boundHandler = (action: ActionEvent) => {
      this.recordAction(action).catch(() => {});
    };
    this.events.on('actionDone', this.boundHandler);

    // Re-inject helper after page navigation destroys it
    this.page.on('load', () => { this.helperInjected = false; });

    this.recording = true;
  }

  /** Stop subscribing to events. Recorded trace is preserved. */
  stopRecording(): void {
    if (!this.recording || !this.boundHandler) return;

    this.events.off('actionDone', this.boundHandler);
    this.boundHandler = null;
    this.recording = false;
  }

  /** Returns an ordered copy of the recorded ManualStep array. */
  getTrace(): ManualStep[] {
    return [...this.steps];
  }

  /** Whether the recorder is currently listening for events. */
  isRecording(): boolean {
    return this.recording;
  }

  // ── Private ────────────────────────────────────────────────────────

  private async recordAction(action: ActionEvent): Promise<void> {
    const stepAction = mapVariantToAction(action.variant);
    if (!stepAction) return;

    // Ensure helper is injected before any DOM queries
    await this.ensureHelper();

    // Navigation does not need element lookup
    if (action.variant === 'load') {
      const navAction = action as NavAction;
      this.steps.push({
        order: this.steps.length,
        locator: { css: 'body' },
        action: 'navigate',
        value: navAction.url,
        healthScore: 1.0,
      });
      return;
    }

    // Resolve element — mouse actions use coordinates, keyboard uses activeElement
    let elementInfo: ElementInfo | null = null;
    const coordAction = action as { x?: number; y?: number };

    if (coordAction.x !== undefined && coordAction.y !== undefined) {
      elementInfo = await this.extractElementInfo(coordAction.x, coordAction.y);
    } else if (stepAction === 'fill') {
      // keyboard:type has no coordinates — use the currently focused element
      elementInfo = await this.extractActiveElementInfo();
    }

    if (!elementInfo) return;

    const locator = buildLocator(elementInfo);
    let value: string | undefined;

    if (action.variant === 'type') {
      const typeAction = action as TypeAction;
      value = this.templatize(typeAction.content);
    }

    this.steps.push({
      order: this.steps.length,
      locator,
      action: stepAction,
      ...(value !== undefined && { value }),
      healthScore: 1.0,
    });
  }

  /**
   * Evaluate document.elementFromPoint(x, y) in the browser context
   * and extract all locator strategies from the found element.
   */
  private async extractElementInfo(x: number, y: number): Promise<ElementInfo | null> {
    try {
      return await this.page.evaluate(
        ([px, py]: [number, number]) => {
          const el = document.elementFromPoint(px, py);
          if (!el) return null;
          return (window as any).__gh_extractLocator(el);
        },
        [x, y] as [number, number],
      );
    } catch {
      return null;
    }
  }

  /**
   * Use document.activeElement for keyboard events that lack coordinates.
   */
  private async extractActiveElementInfo(): Promise<ElementInfo | null> {
    try {
      return await this.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        return (window as any).__gh_extractLocator(el);
      });
    } catch {
      return null;
    }
  }

  /**
   * Inject the locator extraction helper into the page context once.
   * Called automatically before first use.
   */
  private helperInjected = false;
  private async ensureHelper(): Promise<void> {
    if (this.helperInjected) return;
    await this.page.evaluate(() => {
      (window as any).__gh_extractLocator = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const elId = el.getAttribute('id') ?? '';
        const name = el.getAttribute('name') ?? '';
        const testId = el.getAttribute('data-testid') ?? '';
        const automationId = el.getAttribute('data-automation-id') ?? '';
        const role = el.getAttribute('role') ?? tag;
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        const text = el.textContent?.trim().slice(0, 100) ?? '';

        // Build CSS selector — prefer data-automation-id for Workday
        let css = tag;
        if (automationId) {
          css = `${tag}[data-automation-id='${automationId}']`;
        } else if (elId) {
          css += `#${elId}`;
        }
        if (name) css += `[name="${name}"]`;

        // Build basic XPath
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (c: Element) => c.tagName === current!.tagName,
            );
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
          } else {
            parts.unshift(current.tagName.toLowerCase());
          }
          current = parent;
        }
        const xpath = '/html/' + parts.join('/');

        return { testId, role, name, ariaLabel, id: elId, text, css, xpath };
      };
    });
    this.helperInjected = true;
  }

  /**
   * If the value matches a userData field value, return {{field_name}}.
   * Otherwise return the original value.
   */
  private templatize(value: string): string {
    for (const [fieldName, fieldValue] of Object.entries(this.userData)) {
      if (value === fieldValue) {
        return `{{${fieldName}}}`;
      }
    }
    return value;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Map Magnitude action variant to ManualStep action. */
function mapVariantToAction(variant: string): ManualStep['action'] | null {
  switch (variant) {
    case 'click':
      return 'click';
    case 'type':
      return 'fill';
    case 'scroll':
      return 'scroll';
    case 'load':
      return 'navigate';
    default:
      return null;
  }
}

/** Build a LocatorDescriptor from extracted element info, omitting empty strings. */
function buildLocator(info: ElementInfo): LocatorDescriptor {
  const locator: Partial<LocatorDescriptor> = {};

  if (info.testId) locator.testId = info.testId;
  if (info.role) locator.role = info.role;
  if (info.name) locator.name = info.name;
  if (info.ariaLabel) locator.ariaLabel = info.ariaLabel;
  if (info.id) locator.id = info.id;
  if (info.text) locator.text = info.text;
  if (info.css) locator.css = info.css;
  if (info.xpath) locator.xpath = info.xpath;

  return locator as LocatorDescriptor;
}
