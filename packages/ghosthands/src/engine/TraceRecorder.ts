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

// ── Magnitude action event shapes (namespaced variants) ──────────────

interface MouseClickAction {
  variant: 'mouse:click' | 'mouse:double_click' | 'mouse:right_click';
  x: number;
  y: number;
}

interface KeyboardTypeAction {
  variant: 'keyboard:type';
  content: string;
}

interface KeyboardKeyAction {
  variant: 'keyboard:enter' | 'keyboard:tab' | 'keyboard:backspace' | 'keyboard:select_all';
}

interface MouseScrollAction {
  variant: 'mouse:scroll';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

interface BrowserNavAction {
  variant: 'browser:nav';
  url: string;
}

interface WaitAction {
  variant: 'wait';
}

// Legacy simplified variants (backward compat with tests / older adapters)
interface LegacyClickAction {
  variant: 'click';
  x: number;
  y: number;
}

interface LegacyTypeAction {
  variant: 'type';
  x: number;
  y: number;
  content: string;
}

interface LegacyScrollAction {
  variant: 'scroll';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

interface LegacyLoadAction {
  variant: 'load';
  url: string;
}

type ActionEvent =
  | MouseClickAction
  | KeyboardTypeAction
  | KeyboardKeyAction
  | MouseScrollAction
  | BrowserNavAction
  | WaitAction
  | LegacyClickAction
  | LegacyTypeAction
  | LegacyScrollAction
  | LegacyLoadAction
  | { variant: string; [key: string]: any };

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

// ── Skipped variants (no-op, no step recorded) ────────────────────────

const SKIPPED_VARIANTS = new Set([
  'mouse:drag',
  'browser:nav:back',
  'browser:tab:new',
  'browser:tab:close',
  'browser:tab:switch',
]);

function isSkippedVariant(variant: string): boolean {
  if (SKIPPED_VARIANTS.has(variant)) return true;
  // Match browser:tab:* wildcard
  if (variant.startsWith('browser:tab:')) return true;
  return false;
}

// ── TraceRecorder ──────────────────────────────────────────────────────

export class TraceRecorder {
  private readonly adapter: BrowserAutomationAdapter;
  private readonly userData: Record<string, string>;
  private steps: ManualStep[] = [];
  private recording = false;
  private boundHandler: ((action: ActionEvent) => void) | null = null;
  private lastClickInfo: { x: number; y: number; elementInfo: ElementInfo } | null = null;

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

  /** Clear all recorded steps and last-click state. */
  reset(): void {
    this.steps = [];
    this.lastClickInfo = null;
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
    const { variant } = action;

    // Skip variants we don't record
    if (isSkippedVariant(variant)) return;

    const stepAction = mapVariantToAction(variant);
    if (!stepAction) return;

    // ── Navigation (no elementFromPoint needed) ──

    if (variant === 'load' || variant === 'browser:nav') {
      const navAction = action as { url: string };
      const step: ManualStep = {
        order: this.steps.length,
        locator: { css: 'body' },
        action: 'navigate',
        value: navAction.url,
        healthScore: 1.0,
      };
      this.steps.push(step);
      return;
    }

    // ── Wait ──

    if (variant === 'wait') {
      const step: ManualStep = {
        order: this.steps.length,
        locator: { css: 'body' },
        action: 'wait',
        healthScore: 1.0,
      };
      this.steps.push(step);
      return;
    }

    // ── Keyboard key presses (enter, tab, backspace, select_all) ──

    if (variant.startsWith('keyboard:') && variant !== 'keyboard:type') {
      const keyName = mapVariantToKeyName(variant);
      if (!keyName) return;

      // Use last-clicked element for locator, or fallback to body
      const locator: LocatorDescriptor = this.lastClickInfo
        ? buildLocator(this.lastClickInfo.elementInfo)
        : { css: 'body' };

      const step: ManualStep = {
        order: this.steps.length,
        locator,
        action: 'press',
        value: keyName,
        healthScore: 1.0,
      };
      this.steps.push(step);
      return;
    }

    // ── keyboard:type — uses lastClickInfo instead of elementFromPoint ──

    if (variant === 'keyboard:type' || variant === 'type') {
      const typeAction = action as { content: string; x?: number; y?: number };
      let elementInfo: ElementInfo | null = null;

      if (variant === 'type' && typeAction.x !== undefined && typeAction.y !== undefined) {
        // Legacy variant: has coordinates, use elementFromPoint
        elementInfo = await this.extractElementInfo(typeAction.x, typeAction.y);
      } else {
        // Magnitude variant: no coordinates, use last-clicked element
        elementInfo = this.lastClickInfo?.elementInfo ?? null;
      }

      if (!elementInfo) return;

      const locator = buildLocator(elementInfo);
      const value = this.templatize(typeAction.content);

      const step: ManualStep = {
        order: this.steps.length,
        locator,
        action: 'fill',
        value,
        healthScore: 1.0,
      };
      this.steps.push(step);
      return;
    }

    // ── Click and scroll — actions with coordinates ──

    const coordAction = action as { x: number; y: number };
    if (coordAction.x === undefined || coordAction.y === undefined) return;

    const elementInfo = await this.extractElementInfo(coordAction.x, coordAction.y);
    if (!elementInfo) return;

    // Track last click for subsequent keyboard:type events
    if (stepAction === 'click') {
      this.lastClickInfo = { x: coordAction.x, y: coordAction.y, elementInfo };
    }

    const locator = buildLocator(elementInfo);

    const step: ManualStep = {
      order: this.steps.length,
      locator,
      action: stepAction,
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

/** Map Magnitude action variant to ManualStep action. Supports both namespaced and legacy names. */
function mapVariantToAction(variant: string): ManualStep['action'] | null {
  switch (variant) {
    // Magnitude namespaced variants
    case 'mouse:click':
    case 'mouse:double_click':
    case 'mouse:right_click':
      return 'click';
    case 'keyboard:type':
      return 'fill';
    case 'keyboard:enter':
    case 'keyboard:tab':
    case 'keyboard:backspace':
    case 'keyboard:select_all':
      return 'press';
    case 'mouse:scroll':
      return 'scroll';
    case 'browser:nav':
      return 'navigate';
    case 'wait':
      return 'wait';

    // Legacy simplified variants (backward compat)
    case 'click': return 'click';
    case 'type': return 'fill';
    case 'scroll': return 'scroll';
    case 'load': return 'navigate';

    default: return null;
  }
}

/** Map keyboard variant to key name for press action value. */
function mapVariantToKeyName(variant: string): string | null {
  switch (variant) {
    case 'keyboard:enter': return 'Enter';
    case 'keyboard:tab': return 'Tab';
    case 'keyboard:backspace': return 'Backspace';
    case 'keyboard:select_all': return 'Control+A';
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
