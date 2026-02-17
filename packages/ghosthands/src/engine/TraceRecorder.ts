/**
 * TraceRecorder — Records browser actions as ManualStep sequences.
 *
 * Subscribes to adapter events (actionDone) and reverse-lookups DOM elements
 * at pixel coordinates using document.elementFromPoint(x, y). Extracts all
 * available locator strategies into a LocatorDescriptor.
 *
 * Template detection: if a typed value matches a user_data field value,
 * the value is stored as {{field_name}} for replayability.
 */

import type { BrowserAutomationAdapter, AdapterEvent } from '../adapters/types';
import type { ManualStep, LocatorDescriptor } from './types';

// ── Config ─────────────────────────────────────────────────────────────

export interface TraceRecorderOptions {
  /** The adapter whose events to record */
  adapter: BrowserAutomationAdapter;
  /** User data for template detection. Keys = field names, values = field values. */
  userData?: Record<string, string>;
}

// ── Magnitude action event shapes ──────────────────────────────────────

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

interface LoadAction {
  variant: 'load';
  url: string;
}

type ActionEvent = ClickAction | TypeAction | ScrollAction | LoadAction | { variant: string; [key: string]: any };

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
  private readonly adapter: BrowserAutomationAdapter;
  private readonly userData: Record<string, string>;
  private steps: ManualStep[] = [];
  private recording = false;
  private boundHandler: ((action: ActionEvent) => void) | null = null;

  constructor(options: TraceRecorderOptions) {
    this.adapter = options.adapter;
    this.userData = options.userData ?? {};
  }

  /** Start subscribing to adapter events and recording steps. */
  start(): void {
    if (this.recording) return;

    this.boundHandler = (action: ActionEvent) => {
      this.handleActionDone(action);
    };
    this.adapter.on('actionDone' as AdapterEvent, this.boundHandler);
    this.recording = true;
  }

  /** Stop subscribing to events. Recorded trace is preserved. */
  stopRecording(): void {
    if (!this.recording || !this.boundHandler) return;

    this.adapter.off('actionDone' as AdapterEvent, this.boundHandler);
    this.boundHandler = null;
    this.recording = false;
  }

  /** Returns an ordered copy of the recorded ManualStep array. */
  getTrace(): ManualStep[] {
    return [...this.steps];
  }

  /** Clear all recorded steps. */
  reset(): void {
    this.steps = [];
  }

  /** Whether the recorder is currently listening for events. */
  isRecording(): boolean {
    return this.recording;
  }

  // ── Private ────────────────────────────────────────────────────────

  private handleActionDone(action: ActionEvent): void {
    // Fire-and-forget async recording (we don't block the event loop)
    this.recordAction(action).catch(() => {
      // Best-effort: silently skip failed recordings
    });
  }

  private async recordAction(action: ActionEvent): Promise<void> {
    const stepAction = mapVariantToAction(action.variant);
    if (!stepAction) return;

    // Navigation does not need elementFromPoint
    if (action.variant === 'load') {
      const loadAction = action as LoadAction;
      const step: ManualStep = {
        order: this.steps.length,
        locator: { css: 'body' },
        action: 'navigate',
        value: loadAction.url,
        healthScore: 1.0,
      };
      this.steps.push(step);
      return;
    }

    // Actions with coordinates need elementFromPoint
    const coordAction = action as { x: number; y: number; content?: string };
    if (coordAction.x === undefined || coordAction.y === undefined) return;

    const elementInfo = await this.extractElementInfo(coordAction.x, coordAction.y);
    if (!elementInfo) return;

    const locator = buildLocator(elementInfo);
    let value: string | undefined;

    if (action.variant === 'type') {
      const typeAction = action as TypeAction;
      value = this.templatize(typeAction.content);
    }

    const step: ManualStep = {
      order: this.steps.length,
      locator,
      action: stepAction,
      ...(value !== undefined && { value }),
      healthScore: 1.0,
    };

    this.steps.push(step);
  }

  /**
   * Evaluate document.elementFromPoint(x, y) in the browser context
   * and extract all locator strategies from the found element.
   */
  private async extractElementInfo(x: number, y: number): Promise<ElementInfo | null> {
    try {
      return await this.adapter.page.evaluate(
        ([px, py]: [number, number]) => {
          const el = document.elementFromPoint(px, py);
          if (!el) return null;

          const tag = el.tagName.toLowerCase();
          const elId = el.getAttribute('id') ?? '';
          const name = el.getAttribute('name') ?? '';
          const testId = el.getAttribute('data-testid') ?? '';
          const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
          const ariaLabel = el.getAttribute('aria-label') ?? '';
          const text = el.textContent?.trim().slice(0, 100) ?? '';

          // Build a basic CSS selector
          let css = tag;
          if (elId) css += `#${elId}`;
          if (name) css += `[name="${name}"]`;

          // Build basic XPath
          let xpath = '';
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
          xpath = '/html/' + parts.join('/');

          return { testId, role, name, ariaLabel, id: elId, text, css, xpath };
        },
        [x, y] as [number, number],
      );
    } catch {
      return null;
    }
  }

  /**
   * If the value matches a user_data field value, return {{field_name}}.
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
    case 'click': return 'click';
    case 'type': return 'fill';
    case 'scroll': return 'scroll';
    case 'load': return 'navigate';
    default: return null;
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
