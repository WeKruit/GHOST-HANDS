# Chrome Extension (MV3) Technical Reference

> Comprehensive reference for building Valet's free-tier Chrome Extension using Manifest V3.
> The extension autofills job application forms on ATS pages (LinkedIn, Greenhouse, Lever, Workday, iCIMS, etc.), communicates with the Valet API, and renders a side panel React UI.

---

## Table of Contents

1. [MV3 Architecture](#1-mv3-architecture)
2. [Content Script Patterns for Form Filling](#2-content-script-patterns-for-form-filling)
3. [Messaging Architecture](#3-messaging-architecture)
4. [Storage Patterns](#4-storage-patterns)
5. [Authentication](#5-authentication)
6. [Build Toolchain](#6-build-toolchain)
7. [Overlay UI](#7-overlay-ui)
8. [Performance and Security](#8-performance-and-security)
9. [Chrome Web Store](#9-chrome-web-store)
10. [Monorepo Integration](#10-monorepo-integration)

---

## 1. MV3 Architecture

### 1.1 Content Script Isolated Worlds

Content scripts run in an **isolated world** — they share the DOM with the host page but have a separate JavaScript execution environment.

**Can access:**
- Full DOM (read/write elements, attributes, styles)
- `window.getComputedStyle()`, `MutationObserver`, `IntersectionObserver`
- Shadow DOM via `chrome.dom.openOrClosedShadowRoot()` (open AND closed)
- Cross-origin iframes (with `all_frames: true` + `match_origin_as_fallback: true`)
- Chrome extension APIs: `chrome.runtime`, `chrome.storage`, `chrome.i18n`

**Cannot access:**
- Host page's JavaScript variables, functions, or prototypes
- `window.fetch` / `XMLHttpRequest` of the host page (has own instances)
- Other extensions' content scripts
- Extension pages (popup, side panel, options) directly

```typescript
// Content script — lives in isolated world
// Can read DOM but not page JS variables
const nameField = document.querySelector<HTMLInputElement>('#firstName');
// nameField is accessible, but window.React is NOT (page's React instance)

// To access page JS, inject a script into the MAIN world:
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
document.head.appendChild(script);
```

**Main world injection** (for accessing React internals):
```json
// manifest.json — content_scripts with world: "MAIN"
{
  "content_scripts": [
    {
      "matches": ["*://boards.greenhouse.io/*"],
      "js": ["content-scripts/main-world.js"],
      "world": "MAIN",
      "run_at": "document_idle"
    }
  ]
}
```

### 1.2 Service Worker Lifecycle

The service worker replaces MV2's persistent background page. It is **event-driven** and subject to termination.

**Lifecycle:**
1. **Install** — Runs once when extension is installed or updated. Use `chrome.runtime.onInstalled`.
2. **Activate** — Ready to handle events.
3. **Idle timeout** — Terminated after **30 seconds** of inactivity (no events, no API calls).
4. **Wake up** — Re-instantiated when an event fires (message, alarm, etc.).

**State persistence rules:**
- Global variables are **lost** on termination — never store state in memory.
- Use `chrome.storage.session` for ephemeral per-session state.
- Use `chrome.storage.local` for persistent state.
- `chrome.alarms` survive service worker termination and wake it up.

```typescript
// background/service-worker.ts

// BAD: Global state is lost when SW terminates
let activeTaskId: string | null = null; // Gone after 30s idle!

// GOOD: Persist to storage
async function setActiveTask(taskId: string): Promise<void> {
  await chrome.storage.session.set({ activeTaskId: taskId });
}

async function getActiveTask(): Promise<string | null> {
  const { activeTaskId } = await chrome.storage.session.get('activeTaskId');
  return activeTaskId ?? null;
}

// Keep-alive strategies:
// 1. Active WebSocket connections reset the idle timer
// 2. Long-lived port connections (must send messages to keep alive)
// 3. chrome.alarms for periodic wake-ups (min 30s interval)

chrome.alarms.create('token-refresh', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'token-refresh') {
    await refreshAccessToken();
  }
});
```

**Keeping the service worker alive during form filling:**
```typescript
// During an active autofill operation, the content script
// maintains a port connection and sends periodic heartbeats
const port = chrome.runtime.connect({ name: 'autofill-session' });

// Content script sends progress updates (each resets the 30s timer)
port.postMessage({ type: 'PROGRESS', fieldsFilled: 5, total: 12 });

// Service worker listens
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'autofill-session') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'PROGRESS') {
        // Update storage, send to side panel, etc.
        chrome.storage.session.set({ fillProgress: msg });
      }
    });
  }
});
```

### 1.3 Side Panel API

The side panel provides a persistent UI alongside the browsed page. Available since Chrome 114.

**Manifest configuration:**
```json
{
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "permissions": ["sidePanel"]
}
```

**Opening programmatically:**
```typescript
// From service worker — open side panel for the active tab
chrome.sidePanel.open({ tabId: tab.id });

// Set panel behavior — open on action click instead of popup
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Conditionally enable/disable per URL
chrome.tabs.onUpdated.addListener(async (tabId, _info, tab) => {
  if (!tab.url) return;
  const isATS = ATS_URL_PATTERNS.some((p) => tab.url!.match(p));
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: isATS,
  });
});
```

**Communication: side panel <-> service worker:**
```typescript
// Side panel (React app) sends message to service worker
const response = await chrome.runtime.sendMessage({
  type: 'GET_FILL_STATUS',
  tabId: currentTabId,
});

// Service worker responds
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_FILL_STATUS') {
    getFillStatus(msg.tabId).then(sendResponse);
    return true; // Keep channel open for async response
  }
});
```

### 1.4 Popup (Quick Actions)

The popup is a small overlay on the toolbar icon. Use it for:
- Authentication status display
- Quick "Start Filling" button
- Settings shortcut
- Extension enable/disable toggle

```json
{
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  }
}
```

> **Note:** If using `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`, the popup is bypassed in favor of the side panel. Choose one or the other for the action click, or use the popup for unauthenticated state and side panel for authenticated state.

---

## 2. Content Script Patterns for Form Filling

### 2.1 Detecting ATS Platforms

**URL-based detection (manifest matches):**
```json
{
  "content_scripts": [
    {
      "matches": [
        "*://*.greenhouse.io/*",
        "*://boards.greenhouse.io/*",
        "*://jobs.lever.co/*",
        "*://*.myworkdayjobs.com/*",
        "*://*.myworkday.com/*",
        "*://*.icims.com/*",
        "*://*.linkedin.com/jobs/*",
        "*://*.linkedin.com/in/*/apply/*",
        "*://*.smartrecruiters.com/*",
        "*://*.jobvite.com/*",
        "*://*.ashbyhq.com/*",
        "*://*.rippling.com/*/careers/*"
      ],
      "js": ["content-scripts/detector.js"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_origin_as_fallback": true
    }
  ]
}
```

**DOM-based platform confirmation:**
```typescript
// content-scripts/platform-detector.ts
import type { Platform } from '@valet/shared/schemas';

interface PlatformSignal {
  platform: Platform;
  urlPatterns: RegExp[];
  domSignals: () => boolean;
}

const PLATFORM_SIGNALS: PlatformSignal[] = [
  {
    platform: 'greenhouse',
    urlPatterns: [/greenhouse\.io/, /boards\.greenhouse/],
    domSignals: () =>
      !!document.querySelector('#application_form') ||
      !!document.querySelector('[data-greenhouse]') ||
      !!document.querySelector('meta[content*="Greenhouse"]'),
  },
  {
    platform: 'lever',
    urlPatterns: [/jobs\.lever\.co/],
    domSignals: () =>
      !!document.querySelector('.application-form') ||
      !!document.querySelector('[data-qa="application-form"]'),
  },
  {
    platform: 'workday',
    urlPatterns: [/myworkdayjobs\.com/, /myworkday\.com/],
    domSignals: () =>
      !!document.querySelector('[data-automation-id]') ||
      !!document.querySelector('.WDOF') ||
      !!document.querySelector('div[data-uxi-widget-type]'),
  },
  {
    platform: 'linkedin',
    urlPatterns: [/linkedin\.com\/jobs/, /linkedin\.com.*\/apply/],
    domSignals: () =>
      !!document.querySelector('.jobs-easy-apply-content') ||
      !!document.querySelector('[data-test-modal-id="easy-apply-modal"]'),
  },
];

export function detectPlatform(): Platform {
  const url = window.location.href;

  for (const signal of PLATFORM_SIGNALS) {
    const urlMatch = signal.urlPatterns.some((p) => p.test(url));
    if (urlMatch && signal.domSignals()) {
      return signal.platform;
    }
  }

  return 'unknown';
}
```

### 2.2 Field Detection Heuristics

```typescript
// content-scripts/field-detector.ts

interface DetectedField {
  element: HTMLElement;
  fieldType: string;        // 'firstName', 'email', 'phone', etc.
  confidence: number;       // 0-1
  inputType: 'text' | 'select' | 'textarea' | 'radio' | 'checkbox' | 'file';
  label: string | null;
}

// Priority order for field identification:
// 1. name/id attributes (most reliable)
// 2. Associated <label> text
// 3. aria-label / aria-labelledby
// 4. placeholder text
// 5. Preceding text node / sibling label
// 6. data-* attributes (platform-specific)

const FIELD_PATTERNS: Record<string, RegExp[]> = {
  firstName: [
    /first.?name/i, /fname/i, /given.?name/i, /prénom/i,
  ],
  lastName: [
    /last.?name/i, /lname/i, /surname/i, /family.?name/i, /nom/i,
  ],
  email: [
    /e?.?mail/i, /email.?address/i, /courriel/i,
  ],
  phone: [
    /phone/i, /tel/i, /mobile/i, /cell/i, /téléphone/i,
  ],
  linkedinUrl: [
    /linkedin/i, /linked.?in.?url/i, /linkedin.?profile/i,
  ],
  resume: [
    /resume/i, /cv/i, /curriculum/i, /attach/i,
  ],
  coverLetter: [
    /cover.?letter/i, /lettre.?de.?motivation/i,
  ],
  salary: [
    /salary/i, /compensation/i, /pay/i, /wage/i,
  ],
  startDate: [
    /start.?date/i, /available/i, /earliest/i, /when.*start/i,
  ],
  workAuthorization: [
    /authorized/i, /visa/i, /sponsorship/i, /work.?auth/i, /legally/i,
  ],
  yearsExperience: [
    /years?.?(?:of)?.?experience/i, /experience.?years/i,
  ],
  location: [
    /location/i, /city/i, /address/i, /where.*located/i,
  ],
  gender: [
    /gender/i, /sex/i,
  ],
  ethnicity: [
    /ethnic/i, /race/i, /demographic/i,
  ],
  veteran: [
    /veteran/i, /military/i,
  ],
  disability: [
    /disability/i, /handicap/i, /accommodation/i,
  ],
};

function getFieldLabel(el: HTMLElement): string | null {
  // 1. Explicit <label for="...">
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label) return label.textContent?.trim() ?? null;
  }

  // 2. Wrapping <label>
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent?.trim() ?? null;

  // 3. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  // 4. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) return refEl.textContent?.trim() ?? null;
  }

  // 5. placeholder
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder;
  }

  // 6. Previous sibling or parent text
  const prev = el.previousElementSibling;
  if (prev && prev.textContent) return prev.textContent.trim();

  return null;
}

export function detectFields(root: Element = document.body): DetectedField[] {
  const inputs = root.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([type="submit"]), textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"]'
  );

  const detected: DetectedField[] = [];

  for (const el of inputs) {
    const label = getFieldLabel(el);
    const name = el.getAttribute('name') ?? '';
    const id = el.getAttribute('id') ?? '';
    const autocomplete = el.getAttribute('autocomplete') ?? '';
    const dataAutomationId = el.getAttribute('data-automation-id') ?? ''; // Workday
    const searchText = [name, id, label, autocomplete, dataAutomationId].join(' ');

    for (const [fieldType, patterns] of Object.entries(FIELD_PATTERNS)) {
      const match = patterns.some((p) => p.test(searchText));
      if (match) {
        detected.push({
          element: el,
          fieldType,
          confidence: name || id ? 0.9 : label ? 0.7 : 0.5,
          inputType: getInputType(el),
          label,
        });
        break; // First match wins
      }
    }
  }

  return detected;
}

function getInputType(el: HTMLElement): DetectedField['inputType'] {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'radio') return 'radio';
    if (el.type === 'checkbox') return 'checkbox';
    if (el.type === 'file') return 'file';
  }
  return 'text';
}
```

### 2.3 Filling React-Controlled Inputs

React intercepts native DOM property setters. Directly setting `.value` does NOT trigger React's `onChange`. The solution uses `Object.getOwnPropertyDescriptor` to call the native setter, then dispatches synthetic events.

```typescript
// content-scripts/fillers/react-input-filler.ts

/**
 * Fill a React-controlled <input> or <textarea> element.
 * Works with React 16+, 17, 18 (fiber-based).
 */
export function fillReactInput(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
): boolean {
  // Step 1: Get the native value setter from the prototype
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const nativeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (!nativeDescriptor?.set) {
    console.warn('[Valet] No native setter found for', element);
    return false;
  }

  // Step 2: Focus the element (some React forms validate on focus)
  element.focus();
  element.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

  // Step 3: Call the native setter (bypasses React's synthetic property)
  nativeDescriptor.set.call(element, value);

  // Step 4: Dispatch input + change events (React listens on these)
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // Step 5: Blur to trigger validation
  element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

  return element.value === value;
}

/**
 * Fill a React-controlled checkbox or radio button.
 */
export function fillReactCheckbox(
  element: HTMLInputElement,
  checked: boolean
): boolean {
  if (element.checked === checked) return true;

  // React overrides the 'checked' property on checkboxes
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'checked'
  );
  if (descriptor?.set) {
    descriptor.set.call(element, checked);
  }

  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  return element.checked === checked;
}
```

### 2.4 Filling Native and Custom Dropdowns

```typescript
// content-scripts/fillers/select-filler.ts

/**
 * Fill a native <select> element.
 */
export function fillNativeSelect(
  select: HTMLSelectElement,
  value: string
): boolean {
  // Try exact value match first
  const option = Array.from(select.options).find(
    (o) => o.value === value || o.textContent?.trim().toLowerCase() === value.toLowerCase()
  );

  if (!option) {
    // Fuzzy match: find closest option text
    const fuzzy = Array.from(select.options).find(
      (o) => o.textContent?.trim().toLowerCase().includes(value.toLowerCase())
    );
    if (!fuzzy) return false;
    select.value = fuzzy.value;
  } else {
    select.value = option.value;
  }

  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Fill a Workday custom dropdown (div-based with data-automation-id).
 * Workday uses a custom combobox pattern with virtualized lists.
 */
export async function fillWorkdayDropdown(
  trigger: HTMLElement,
  value: string
): Promise<boolean> {
  // Step 1: Click to open the dropdown
  trigger.click();
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

  // Step 2: Wait for dropdown list to render
  await waitForElement('[data-automation-id="promptOption"]', 2000);

  // Step 3: Type to filter (Workday supports type-ahead)
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[data-automation-id="searchBox"]'
  );
  if (searchInput) {
    fillReactInput(searchInput, value);
    await sleep(300); // Wait for filter to apply
  }

  // Step 4: Find and click the matching option
  const options = document.querySelectorAll('[data-automation-id="promptOption"]');
  for (const opt of options) {
    if (opt.textContent?.trim().toLowerCase().includes(value.toLowerCase())) {
      (opt as HTMLElement).click();
      return true;
    }
  }

  return false;
}

/**
 * Fill a Greenhouse/Lever custom dropdown (React Select pattern).
 * These typically use react-select or similar libraries.
 */
export async function fillReactSelectDropdown(
  container: HTMLElement,
  value: string
): Promise<boolean> {
  // Find the control element
  const control = container.querySelector('[class*="control"]') as HTMLElement;
  if (!control) return false;

  // Click to open
  control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  await sleep(200);

  // Find the input within the dropdown
  const input = container.querySelector('input') as HTMLInputElement;
  if (input) {
    fillReactInput(input, value);
    await sleep(300);
  }

  // Select first matching option
  const options = container.querySelectorAll('[class*="option"]');
  for (const opt of options) {
    if (opt.textContent?.trim().toLowerCase().includes(value.toLowerCase())) {
      (opt as HTMLElement).click();
      return true;
    }
  }

  return false;
}

// Utility helpers
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForElement(selector: string, timeout: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}
```

### 2.5 Shadow DOM Access

```typescript
// content-scripts/shadow-dom.ts

/**
 * Access shadow roots (both open AND closed) from content scripts.
 * chrome.dom.openOrClosedShadowRoot() is available in the isolated world.
 * Requires "dom" permission in manifest (no permission string needed —
 * it's automatically available in content scripts).
 */
export function queryShadowDOM(
  root: Element,
  selector: string
): Element | null {
  // Check direct children first
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // Traverse into shadow roots
  const shadowRoot = chrome.dom?.openOrClosedShadowRoot(root);
  if (shadowRoot) {
    const inShadow = shadowRoot.querySelector(selector);
    if (inShadow) return inShadow;

    // Recursively search shadow DOM children
    for (const child of shadowRoot.querySelectorAll('*')) {
      const found = queryShadowDOM(child, selector);
      if (found) return found;
    }
  }

  // Recursively search light DOM children with shadow roots
  for (const child of root.querySelectorAll('*')) {
    if (child.shadowRoot || chrome.dom?.openOrClosedShadowRoot(child)) {
      const found = queryShadowDOM(child, selector);
      if (found) return found;
    }
  }

  return null;
}
```

### 2.6 MutationObserver for Multi-Step Dynamic Forms

LinkedIn Easy Apply, Workday, and other ATS platforms use multi-step forms that dynamically render new fields.

```typescript
// content-scripts/form-observer.ts

interface FormObserverCallbacks {
  onFieldsAdded: (fields: HTMLElement[]) => void;
  onStepChanged: (stepIndex: number, stepLabel: string | null) => void;
  onFormSubmitted: () => void;
}

export class FormObserver {
  private observer: MutationObserver;
  private fillableSelectors =
    'input:not([type="hidden"]):not([type="submit"]), textarea, select, [role="combobox"]';

  constructor(
    private root: Element,
    private callbacks: FormObserverCallbacks
  ) {
    this.observer = new MutationObserver(this.handleMutations.bind(this));
  }

  start(): void {
    this.observer.observe(this.root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden', 'data-step'],
    });
  }

  stop(): void {
    this.observer.disconnect();
  }

  private handleMutations(mutations: MutationRecord[]): void {
    const addedFields: HTMLElement[] = [];

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if the node itself is a field
            if (node.matches(this.fillableSelectors)) {
              addedFields.push(node);
            }
            // Check children
            const fields = node.querySelectorAll<HTMLElement>(this.fillableSelectors);
            addedFields.push(...fields);

            // Detect step changes (LinkedIn Easy Apply)
            this.detectStepChange(node);
          }
        }
      }

      if (mutation.type === 'attributes') {
        this.detectStepChange(mutation.target as HTMLElement);
      }
    }

    if (addedFields.length > 0) {
      // Debounce slightly to batch rapid DOM changes
      requestAnimationFrame(() => {
        this.callbacks.onFieldsAdded(addedFields);
      });
    }
  }

  private detectStepChange(el: HTMLElement): void {
    // LinkedIn Easy Apply step indicators
    const stepIndicator = el.querySelector?.(
      '.jobs-easy-apply-content header, [data-test-step-header]'
    );
    if (stepIndicator) {
      const stepText = stepIndicator.textContent?.trim() ?? null;
      const stepIndex = this.getCurrentStepIndex();
      this.callbacks.onStepChanged(stepIndex, stepText);
    }
  }

  private getCurrentStepIndex(): number {
    // LinkedIn: count active step dots
    const dots = document.querySelectorAll(
      '.jobs-easy-apply-content .artdeco-completeness-meter-linear__progress-element'
    );
    // Generic: look for step number in URL or data attributes
    const stepParam = new URLSearchParams(window.location.search).get('step');
    if (stepParam) return parseInt(stepParam, 10);

    return dots.length;
  }
}

// Usage in content script
const observer = new FormObserver(document.body, {
  onFieldsAdded: (fields) => {
    console.log(`[Valet] ${fields.length} new fields detected`);
    // Trigger field detection + autofill
    chrome.runtime.sendMessage({
      type: 'NEW_FIELDS_DETECTED',
      count: fields.length,
    });
  },
  onStepChanged: (stepIndex, stepLabel) => {
    console.log(`[Valet] Step changed: ${stepIndex} - ${stepLabel}`);
    chrome.runtime.sendMessage({
      type: 'STEP_CHANGED',
      stepIndex,
      stepLabel,
    });
  },
  onFormSubmitted: () => {
    chrome.runtime.sendMessage({ type: 'FORM_SUBMITTED' });
  },
});

observer.start();
```

### 2.7 Iframe Handling

Many ATS platforms embed application forms in iframes (e.g., Workday inside an iframe on a company careers page).

```json
// manifest.json — inject into all frames
{
  "content_scripts": [
    {
      "matches": ["*://*.myworkdayjobs.com/*", "*://*.icims.com/*"],
      "js": ["content-scripts/ats-filler.js"],
      "all_frames": true,
      "match_origin_as_fallback": true,
      "run_at": "document_idle"
    }
  ]
}
```

```typescript
// content-scripts/iframe-handler.ts

/**
 * Content scripts injected with all_frames: true run independently
 * in each frame. They communicate via the service worker.
 *
 * The top frame orchestrates; iframes report their fields.
 */

const isTopFrame = window === window.top;

if (isTopFrame) {
  // Top frame: coordinate autofill across all frames
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'IFRAME_FIELDS_DETECTED') {
      // Aggregate fields from all frames
      console.log(`[Valet] Frame ${msg.frameId} has ${msg.fields.length} fields`);
    }
  });
} else {
  // Iframe: detect fields and report to service worker
  const fields = detectFields(document.body);
  if (fields.length > 0) {
    chrome.runtime.sendMessage({
      type: 'IFRAME_FIELDS_DETECTED',
      frameId: window.frameElement?.id ?? 'unknown',
      fields: fields.map((f) => ({
        fieldType: f.fieldType,
        confidence: f.confidence,
        inputType: f.inputType,
        label: f.label,
      })),
    });
  }
}
```

---

## 3. Messaging Architecture

### 3.1 One-Shot Messages (chrome.runtime.sendMessage)

Best for simple request/response patterns.

```typescript
// ─── Type-safe message definitions ───
// shared/extension-messages.ts (importable by all extension contexts)

interface GetProfileMessage {
  type: 'GET_PROFILE';
}

interface StartFillMessage {
  type: 'START_FILL';
  payload: {
    tabId: number;
    resumeId: string;
    profileData: Record<string, string>;
  };
}

interface FillProgressMessage {
  type: 'FILL_PROGRESS';
  payload: {
    fieldsFilled: number;
    totalFields: number;
    currentField: string;
  };
}

interface FillCompleteMessage {
  type: 'FILL_COMPLETE';
  payload: {
    fieldsFilled: number;
    skippedFields: string[];
    duration: number;
  };
}

interface FillErrorMessage {
  type: 'FILL_ERROR';
  payload: {
    code: string;
    message: string;
    field?: string;
  };
}

interface DetectFieldsMessage {
  type: 'DETECT_FIELDS';
  payload: {
    tabId: number;
  };
}

interface FieldsDetectedMessage {
  type: 'FIELDS_DETECTED';
  payload: {
    platform: string;
    fields: Array<{
      fieldType: string;
      confidence: number;
      label: string | null;
    }>;
  };
}

interface AuthStatusMessage {
  type: 'AUTH_STATUS';
}

interface AuthStatusResponse {
  authenticated: boolean;
  user?: { id: string; name: string; email: string };
  accessToken?: string;
}

// Discriminated union of all messages
type ExtensionMessage =
  | GetProfileMessage
  | StartFillMessage
  | FillProgressMessage
  | FillCompleteMessage
  | FillErrorMessage
  | DetectFieldsMessage
  | FieldsDetectedMessage
  | AuthStatusMessage;

// Response type map
type MessageResponseMap = {
  GET_PROFILE: Record<string, string> | null;
  START_FILL: { success: boolean };
  FILL_PROGRESS: void;
  FILL_COMPLETE: void;
  FILL_ERROR: void;
  DETECT_FIELDS: void;
  FIELDS_DETECTED: void;
  AUTH_STATUS: AuthStatusResponse;
};
```

**Type-safe message sender:**
```typescript
// lib/messaging.ts

export async function sendMessage<T extends ExtensionMessage>(
  message: T
): Promise<MessageResponseMap[T['type']]> {
  return chrome.runtime.sendMessage(message);
}

// Content script → Service worker
export async function sendToBackground<T extends ExtensionMessage>(
  message: T
): Promise<MessageResponseMap[T['type']]> {
  return chrome.runtime.sendMessage(message);
}

// Service worker → Content script in specific tab
export async function sendToTab<T extends ExtensionMessage>(
  tabId: number,
  message: T
): Promise<MessageResponseMap[T['type']]> {
  return chrome.tabs.sendMessage(tabId, message);
}
```

**Service worker message handler:**
```typescript
// background/message-handler.ts

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_PROFILE':
        handleGetProfile().then(sendResponse);
        return true; // Indicates async response

      case 'START_FILL':
        handleStartFill(message.payload).then(sendResponse);
        return true;

      case 'FIELDS_DETECTED':
        handleFieldsDetected(message.payload, sender.tab?.id);
        break;

      case 'AUTH_STATUS':
        handleAuthStatus().then(sendResponse);
        return true;

      default:
        console.warn('[Valet SW] Unknown message type:', (message as any).type);
    }
  }
);

async function handleGetProfile(): Promise<Record<string, string> | null> {
  const { profile } = await chrome.storage.local.get('profile');
  return profile ?? null;
}

async function handleStartFill(payload: StartFillMessage['payload']): Promise<{ success: boolean }> {
  try {
    await chrome.tabs.sendMessage(payload.tabId, {
      type: 'EXECUTE_FILL',
      payload: payload,
    } as ExtensionMessage);
    return { success: true };
  } catch (err) {
    console.error('[Valet SW] Fill failed:', err);
    return { success: false };
  }
}
```

### 3.2 Port-Based Long-Lived Connections

For streaming progress during autofill operations.

```typescript
// ─── Port message types ───
interface PortMessage {
  type: 'HEARTBEAT' | 'PROGRESS' | 'COMPLETE' | 'ERROR' | 'CANCEL';
  data?: unknown;
}

// ─── Content script side ───
// content-scripts/fill-session.ts

export class FillSession {
  private port: chrome.runtime.Port;

  constructor() {
    this.port = chrome.runtime.connect({ name: 'fill-session' });

    this.port.onMessage.addListener((msg: PortMessage) => {
      if (msg.type === 'CANCEL') {
        this.abort();
      }
    });

    this.port.onDisconnect.addListener(() => {
      console.log('[Valet] Fill session disconnected');
    });
  }

  reportProgress(fieldsFilled: number, totalFields: number, currentField: string): void {
    this.port.postMessage({
      type: 'PROGRESS',
      data: { fieldsFilled, totalFields, currentField },
    } satisfies PortMessage);
  }

  reportComplete(result: { fieldsFilled: number; duration: number }): void {
    this.port.postMessage({
      type: 'COMPLETE',
      data: result,
    } satisfies PortMessage);
    this.port.disconnect();
  }

  reportError(error: { code: string; message: string }): void {
    this.port.postMessage({
      type: 'ERROR',
      data: error,
    } satisfies PortMessage);
  }

  private abort(): void {
    // Stop filling, clean up
    this.port.disconnect();
  }
}

// ─── Service worker side ───
// background/fill-session-handler.ts

const activeSessions = new Map<number, chrome.runtime.Port>(); // tabId -> port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fill-session') return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  activeSessions.set(tabId, port);

  port.onMessage.addListener(async (msg: PortMessage) => {
    switch (msg.type) {
      case 'PROGRESS':
        // Forward to side panel via storage (side panel reads it)
        await chrome.storage.session.set({
          [`fill-progress-${tabId}`]: msg.data,
        });
        break;

      case 'COMPLETE':
        await chrome.storage.session.set({
          [`fill-progress-${tabId}`]: { ...msg.data, status: 'complete' },
        });
        activeSessions.delete(tabId);
        break;

      case 'ERROR':
        await chrome.storage.session.set({
          [`fill-progress-${tabId}`]: { ...msg.data, status: 'error' },
        });
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    activeSessions.delete(tabId);
  });
});
```

### 3.3 Side Panel Communication

The side panel is a full React app that communicates with the service worker and observes storage changes.

```typescript
// sidepanel/hooks/use-fill-progress.ts

import { useState, useEffect } from 'react';

interface FillProgress {
  fieldsFilled: number;
  totalFields: number;
  currentField: string;
  status?: 'complete' | 'error';
}

export function useFillProgress(tabId: number | null): FillProgress | null {
  const [progress, setProgress] = useState<FillProgress | null>(null);

  useEffect(() => {
    if (!tabId) return;

    const key = `fill-progress-${tabId}`;

    // Read initial state
    chrome.storage.session.get(key).then((result) => {
      if (result[key]) setProgress(result[key]);
    });

    // Listen for changes
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area === 'session' && changes[key]) {
        setProgress(changes[key].newValue ?? null);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [tabId]);

  return progress;
}
```

---

## 4. Storage Patterns

### 4.1 Storage Areas

| Area | Persistence | Quota | Use Case |
|------|------------|-------|----------|
| `chrome.storage.local` | Permanent (survives restart) | 10 MB (`unlimitedStorage` for more) | User profile, QA bank cache, settings |
| `chrome.storage.session` | Until browser close | 10 MB | Auth tokens, active fill state, temp data |
| `chrome.storage.sync` | Syncs across devices | 100 KB total, 8 KB per item | Preferences, small config |

### 4.2 Typed Storage Wrapper with Zod Validation

```typescript
// lib/storage.ts

import { z, type ZodType } from 'zod';

// ─── Storage schema definition ───
// Define all stored keys and their Zod schemas in one place

const storageSchemas = {
  // Auth
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenExpiresAt: z.number(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string(),
    avatarUrl: z.string().url().nullable(),
    subscriptionTier: z.enum(['free', 'starter', 'pro', 'enterprise']),
  }),

  // Profile data (cached from API for offline autofill)
  profileData: z.record(z.string()),

  // QA Bank (cached for offline access)
  qaBank: z.array(
    z.object({
      id: z.string().uuid(),
      category: z.string(),
      question: z.string(),
      answer: z.string(),
      usageMode: z.enum(['always_use', 'ask_each_time', 'decline_to_answer']),
    })
  ),

  // Resume data (cached parsed resume)
  activeResume: z.object({
    id: z.string().uuid(),
    filename: z.string(),
    parsedData: z.record(z.unknown()).nullable(),
  }),

  // Extension settings
  settings: z.object({
    autoFillEnabled: z.boolean(),
    showOverlay: z.boolean(),
    confidenceThreshold: z.number().min(0).max(100),
    excludedDomains: z.array(z.string()),
  }),

  // Fill session state (session storage)
  activeFillSession: z.object({
    tabId: z.number(),
    platform: z.string(),
    fieldsFilled: z.number(),
    totalFields: z.number(),
    startedAt: z.number(),
  }),
} as const;

type StorageSchemas = typeof storageSchemas;
type StorageKey = keyof StorageSchemas;
type StorageValue<K extends StorageKey> = z.infer<StorageSchemas[K]>;

// ─── Typed get/set/remove ───

type StorageArea = 'local' | 'session' | 'sync';

function getArea(area: StorageArea): chrome.storage.StorageArea {
  return chrome.storage[area];
}

export async function storageGet<K extends StorageKey>(
  key: K,
  area: StorageArea = 'local'
): Promise<StorageValue<K> | null> {
  const result = await getArea(area).get(key);
  const raw = result[key];
  if (raw === undefined || raw === null) return null;

  const schema = storageSchemas[key];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[Valet Storage] Invalid data for key "${key}":`, parsed.error);
    // Remove corrupt data
    await getArea(area).remove(key);
    return null;
  }

  return parsed.data as StorageValue<K>;
}

export async function storageSet<K extends StorageKey>(
  key: K,
  value: StorageValue<K>,
  area: StorageArea = 'local'
): Promise<void> {
  // Validate before writing
  const schema = storageSchemas[key];
  schema.parse(value); // Throws on invalid data
  await getArea(area).set({ [key]: value });
}

export async function storageRemove(
  key: StorageKey | StorageKey[],
  area: StorageArea = 'local'
): Promise<void> {
  await getArea(area).remove(key as string | string[]);
}

// ─── Typed change listener ───

export function onStorageChange<K extends StorageKey>(
  key: K,
  area: StorageArea,
  callback: (newValue: StorageValue<K> | null, oldValue: StorageValue<K> | null) => void
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    changedArea: string
  ) => {
    if (changedArea !== area || !(key in changes)) return;

    const change = changes[key]!;
    const schema = storageSchemas[key];

    const newParsed = change.newValue ? schema.safeParse(change.newValue) : null;
    const oldParsed = change.oldValue ? schema.safeParse(change.oldValue) : null;

    callback(
      newParsed?.success ? (newParsed.data as StorageValue<K>) : null,
      oldParsed?.success ? (oldParsed.data as StorageValue<K>) : null
    );
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
```

**Usage examples:**
```typescript
// Save user profile after login
await storageSet('user', {
  id: 'abc-123',
  email: 'user@example.com',
  name: 'Jane Doe',
  avatarUrl: null,
  subscriptionTier: 'free',
});

// Read profile data for autofill (null-safe)
const profile = await storageGet('profileData');
if (profile) {
  fillField('firstName', profile.firstName);
}

// Session storage for ephemeral state
await storageSet('activeFillSession', {
  tabId: 42,
  platform: 'greenhouse',
  fieldsFilled: 0,
  totalFields: 15,
  startedAt: Date.now(),
}, 'session');

// Watch for settings changes (e.g., from options page)
const unsubscribe = onStorageChange('settings', 'local', (newSettings) => {
  if (newSettings) {
    applySettings(newSettings);
  }
});
```

---

## 5. Authentication

### 5.1 Google OAuth via chrome.identity.launchWebAuthFlow

The extension uses the same Google OAuth flow as the web app, but via Chrome's identity API instead of a redirect.

```typescript
// background/auth.ts

const GOOGLE_CLIENT_ID = '108153440133-8oorgsj5m7u67fg68bulpr1akrs6ttet.apps.googleusercontent.com';
const API_BASE_URL = 'https://valet-api.fly.dev'; // or from storage

/**
 * Initiate Google OAuth login.
 * Uses launchWebAuthFlow which opens a browser popup for Google sign-in.
 */
export async function loginWithGoogle(): Promise<boolean> {
  const redirectUrl = chrome.identity.getRedirectURL();
  // Returns: https://<extension-id>.chromiumapp.org/

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });

    if (!responseUrl) return false;

    // Extract authorization code from redirect URL
    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');
    if (!code) return false;

    // Exchange code for tokens via Valet API
    // IMPORTANT: The redirectUri must match what Google expects.
    // For extensions, this is the chromiumapp.org URL.
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        redirectUri: redirectUrl,
      }),
    });

    if (!res.ok) return false;

    const data = await res.json();

    // Store tokens
    await storageSet('accessToken', data.accessToken, 'session');
    await storageSet('refreshToken', data.refreshToken, 'local');
    await storageSet('tokenExpiresAt', Date.now() + data.expiresIn * 1000, 'session');
    await storageSet('user', data.user, 'local');

    // Schedule token refresh
    scheduleTokenRefresh(data.expiresIn);

    return true;
  } catch (err) {
    console.error('[Valet] OAuth error:', err);
    return false;
  }
}

/**
 * NOTE: The extension's redirect URI (https://<ext-id>.chromiumapp.org/)
 * must be added to the Google Cloud Console → OAuth Client → Authorized redirect URIs.
 * The Valet API must also accept this redirectUri in the auth/google endpoint.
 */
```

### 5.2 Token Management

```typescript
// background/token-manager.ts

/**
 * Schedule a token refresh alarm.
 * chrome.alarms survive service worker termination.
 */
export function scheduleTokenRefresh(expiresInSeconds: number): void {
  // Refresh 5 minutes before expiry
  const refreshInMinutes = Math.max(
    (expiresInSeconds - 300) / 60,
    1 // At least 1 minute
  );

  chrome.alarms.create('token-refresh', {
    delayInMinutes: refreshInMinutes,
    periodInMinutes: refreshInMinutes, // Repeat
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'token-refresh') {
    await refreshAccessToken();
  }
});

export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = await storageGet('refreshToken', 'local');
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        // Refresh token expired — force re-login
        await logout();
      }
      return false;
    }

    const data = await res.json();
    await storageSet('accessToken', data.accessToken, 'session');
    await storageSet('refreshToken', data.refreshToken, 'local');
    await storageSet('tokenExpiresAt', Date.now() + data.expiresIn * 1000, 'session');

    scheduleTokenRefresh(data.expiresIn);
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  const refreshToken = await storageGet('refreshToken', 'local');
  const accessToken = await storageGet('accessToken', 'session');

  // Call API to blacklist refresh token (fire-and-forget)
  if (refreshToken) {
    fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }

  // Clear all auth state
  await storageRemove(['accessToken', 'tokenExpiresAt'], 'session');
  await storageRemove(['refreshToken', 'user', 'profileData', 'qaBank', 'activeResume'], 'local');
  chrome.alarms.clear('token-refresh');
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidToken(): Promise<string | null> {
  const token = await storageGet('accessToken', 'session');
  const expiresAt = await storageGet('tokenExpiresAt', 'session');

  if (token && expiresAt && Date.now() < expiresAt - 60_000) {
    return token; // Still valid (with 1-min buffer)
  }

  // Token expired or missing — try refresh
  const refreshed = await refreshAccessToken();
  if (refreshed) {
    return storageGet('accessToken', 'session');
  }

  return null; // Not authenticated
}
```

### 5.3 Authenticated API Calls from Service Worker

```typescript
// background/api.ts

export async function apiCall<T>(
  path: string,
  options: RequestInit = {}
): Promise<T | null> {
  const token = await getValidToken();
  if (!token) return null;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    // Token invalid despite refresh — logout
    await logout();
    return null;
  }

  if (!res.ok) return null;
  return res.json();
}

// Fetch and cache user profile for autofill
export async function syncProfileData(): Promise<void> {
  const profile = await apiCall<Record<string, string>>('/api/v1/users/me/profile');
  if (profile) {
    await storageSet('profileData', profile);
  }

  const qaBank = await apiCall<{ data: Array<any> }>('/api/v1/qa-bank');
  if (qaBank) {
    await storageSet('qaBank', qaBank.data);
  }
}
```

---

## 6. Build Toolchain

### 6.1 WXT Framework (Recommended over CRXJS)

**Why WXT over CRXJS:**
- WXT is actively maintained (CRXJS maintenance is uncertain — may be archived)
- WXT provides file-based routing for entrypoints
- Built-in HMR for all extension contexts
- TypeScript-first with auto-generated types
- Better monorepo support
- Built on Vite internally

**Installation:**
```bash
# In apps/extension
pnpm add -D wxt @wxt-dev/module-react
pnpm add react react-dom
pnpm add -D @types/react @types/react-dom
```

### 6.2 WXT Project Structure

```
apps/extension/
  wxt.config.ts              # WXT configuration
  tsconfig.json
  package.json
  entrypoints/               # WXT auto-discovers entrypoints
    background.ts            # Service worker
    popup/                   # Popup React app
      index.html
      main.tsx
      App.tsx
    sidepanel/               # Side panel React app
      index.html
      main.tsx
      App.tsx
    content-scripts/
      ats-detector.ts        # Runs on all ATS pages
      form-filler.ts         # Form filling logic
      overlay.ts             # Injected UI overlay
      overlay.css
  lib/                       # Shared extension utilities
    messaging.ts
    storage.ts
    auth.ts
    api.ts
  components/                # Shared React components (extension-specific)
    FillProgress.tsx
    FieldBadge.tsx
  public/
    icons/
      icon-16.png
      icon-32.png
      icon-48.png
      icon-128.png
```

### 6.3 WXT Configuration

```typescript
// apps/extension/wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',

  manifest: {
    name: 'Valet - Job Application Autofill',
    description: 'Autofill job applications on LinkedIn, Greenhouse, Lever, Workday, and more.',
    version: '1.0.0',
    permissions: [
      'storage',
      'activeTab',
      'sidePanel',
      'alarms',
      'identity',
    ],
    host_permissions: [
      '*://*.greenhouse.io/*',
      '*://boards.greenhouse.io/*',
      '*://jobs.lever.co/*',
      '*://*.myworkdayjobs.com/*',
      '*://*.myworkday.com/*',
      '*://*.icims.com/*',
      '*://*.linkedin.com/*',
      '*://*.smartrecruiters.com/*',
      '*://*.jobvite.com/*',
      '*://*.ashbyhq.com/*',
      'https://valet-api.fly.dev/*',
      'https://valet-api-stg.fly.dev/*',
    ],
    oauth2: {
      client_id: '108153440133-8oorgsj5m7u67fg68bulpr1akrs6ttet.apps.googleusercontent.com',
      scopes: ['openid', 'email', 'profile'],
    },
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
    action: {
      default_popup: 'popup/index.html',
    },
    content_scripts: [
      {
        matches: [
          '*://*.greenhouse.io/*',
          '*://jobs.lever.co/*',
          '*://*.myworkdayjobs.com/*',
          '*://*.icims.com/*',
          '*://*.linkedin.com/jobs/*',
          '*://*.smartrecruiters.com/*',
        ],
        js: ['content-scripts/ats-detector.ts'],
        run_at: 'document_idle',
        all_frames: true,
        match_origin_as_fallback: true,
      },
    ],
  },

  // Vite configuration for monorepo imports
  vite: () => ({
    resolve: {
      alias: {
        '@': '/apps/extension',
      },
    },
    // Allow importing from monorepo packages
    optimizeDeps: {
      include: ['@valet/shared', '@valet/ui'],
    },
    build: {
      // Ensure proper chunking for content scripts
      rollupOptions: {
        output: {
          // Content scripts must be single files (no dynamic imports)
          inlineDynamicImports: false,
        },
      },
    },
  }),
});
```

### 6.4 Package.json for Monorepo Integration

```json
{
  "name": "@valet/extension",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@valet/shared": "workspace:*",
    "@valet/contracts": "workspace:*",
    "@valet/ui": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zod": "^3.23.0",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "wxt": "^0.19.0",
    "@wxt-dev/module-react": "^1.1.0",
    "@types/chrome": "^0.0.270",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

### 6.5 HMR During Development

WXT provides HMR for all extension contexts:
- **Content scripts**: Full HMR — edit and see changes on the page without reloading the extension
- **Side panel / Popup**: Standard Vite HMR
- **Service worker**: Automatic reload on change

```bash
# Start development
cd apps/extension
pnpm dev
# Opens Chrome with the extension loaded from .output/chrome-mv3-dev/
# HMR active for all entrypoints
```

### 6.6 Production Build and CWS Packaging

```bash
# Build for production
pnpm build
# Output: apps/extension/.output/chrome-mv3/

# Create .zip for Chrome Web Store upload
pnpm zip
# Output: apps/extension/.output/valet-job-application-autofill-1.0.0-chrome.zip
```

---

## 7. Overlay UI

### 7.1 Shadow DOM Encapsulation

The extension injects a floating UI overlay on ATS pages. Shadow DOM prevents the host page's CSS from affecting our UI and vice versa.

```typescript
// content-scripts/overlay.ts

import overlayCSS from './overlay.css?inline'; // WXT supports ?inline for CSS

export function createOverlayRoot(): ShadowRoot {
  // Create host element
  const host = document.createElement('valet-overlay');
  host.style.cssText = `
    all: initial;
    position: fixed;
    z-index: 2147483647;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
    pointer-events: none;
  `;

  // Attach shadow root (open for debugging)
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject styles into shadow DOM
  const style = document.createElement('style');
  style.textContent = overlayCSS;
  shadow.appendChild(style);

  // Add Tailwind reset (scoped to shadow)
  const tailwindReset = document.createElement('style');
  tailwindReset.textContent = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      color: #1a1a1a;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
  `;
  shadow.appendChild(tailwindReset);

  document.body.appendChild(host);
  return shadow;
}
```

### 7.2 Floating Action Button

```typescript
// content-scripts/floating-button.ts

import { createRoot } from 'react-dom/client';
import { FloatingButton } from '../components/FloatingButton';

export function mountFloatingButton(shadow: ShadowRoot): void {
  const container = document.createElement('div');
  container.id = 'valet-fab-root';
  container.style.pointerEvents = 'auto';
  shadow.appendChild(container);

  const root = createRoot(container);
  root.render(<FloatingButton />);
}
```

```typescript
// components/FloatingButton.tsx

import { useState, useCallback } from 'react';

export function FloatingButton() {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const handleClick = useCallback(() => {
    if (!isDragging) {
      // Open side panel
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    }
  }, [isDragging]);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: `${position.y}px`,
        right: `${position.x}px`,
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        backgroundColor: '#6366f1',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'transform 0.15s ease',
        zIndex: 2147483647,
      }}
      onClick={handleClick}
      title="Valet - Autofill this application"
    >
      {/* Valet logo or icon */}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}
```

### 7.3 Per-Field Badges

Show a small badge next to each detected field indicating Valet can fill it.

```typescript
// components/FieldBadge.tsx

interface FieldBadgeProps {
  field: {
    fieldType: string;
    confidence: number;
    element: HTMLElement;
  };
  onFill: () => void;
}

export function FieldBadge({ field, onFill }: FieldBadgeProps) {
  const rect = field.element.getBoundingClientRect();

  return (
    <div
      style={{
        position: 'fixed',
        top: `${rect.top + rect.height / 2 - 10}px`,
        left: `${rect.right + 4}px`,
        width: '20px',
        height: '20px',
        borderRadius: '4px',
        backgroundColor: field.confidence > 0.8 ? '#22c55e' : '#f59e0b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: '10px',
        color: 'white',
        fontWeight: 'bold',
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
        pointerEvents: 'auto',
      }}
      onClick={onFill}
      title={`Click to fill: ${field.fieldType}`}
    >
      V
    </div>
  );
}
```

### 7.4 Avoiding Style Conflicts

Key principles for overlay UI:
1. **Shadow DOM isolation** — All extension UI lives inside a shadow root
2. **`all: initial`** on the host element — Resets all inherited styles
3. **Inline critical styles** — Don't rely on external stylesheets loading
4. **High z-index** — `2147483647` (max 32-bit int) ensures overlay is on top
5. **`pointer-events: none`** on container, `auto` on interactive elements — Don't block page interaction
6. **Avoid global selectors** — Never inject `<style>` into the host page document

---

## 8. Performance and Security

### 8.1 Minimizing Content Script Impact

```typescript
// content-scripts/ats-detector.ts
// This is the entry point — keep it minimal!

export default defineContentScript({
  matches: ['*://*.greenhouse.io/*', '*://jobs.lever.co/*' /* ... */],
  runAt: 'document_idle', // Don't block page load
  main() {
    // Step 1: Quick check — is this an application page?
    const platform = detectPlatform();
    if (platform === 'unknown') return; // Exit early, don't load more code

    // Step 2: Notify service worker (lazy-load heavy code only when needed)
    chrome.runtime.sendMessage({
      type: 'ATS_PAGE_DETECTED',
      payload: { platform, url: window.location.href },
    });

    // Step 3: Dynamically import the heavy form-filling module
    // This keeps the initial content script payload small
    import('./form-filler').then(({ initFormFiller }) => {
      initFormFiller(platform);
    });
  },
});
```

**Performance guidelines:**
- Use `document_idle` for `run_at` — never `document_start` unless absolutely necessary
- Keep the initial content script under 50KB
- Dynamically import heavy modules (form filler, overlay UI) only when on an application page
- Use `requestIdleCallback` for non-critical DOM scanning
- Debounce MutationObserver callbacks
- Don't poll the DOM — use MutationObserver exclusively

### 8.2 CSP Compliance

Chrome Extension MV3 enforces strict CSP:
- **No `eval()`** or `new Function()`
- **No inline scripts** — All JS must be in separate files
- **No remote code** — All code must be bundled in the extension
- **`wasm-unsafe-eval`** allowed if needed

```json
// manifest.json — CSP is auto-set by MV3, but can be customized:
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

**What this means for Valet:**
- Zod schemas work fine (no eval)
- React works fine (no inline scripts needed with bundler)
- Cannot load JS from CDN — everything must be bundled
- `@valet/ui` components work as-is (they're bundled)

### 8.3 Minimal Permissions Principle

Request only what's needed, and use optional permissions where possible:

```json
{
  "permissions": [
    "storage",       // Required: cache profile data locally
    "activeTab",     // Required: access current tab DOM
    "sidePanel",     // Required: side panel UI
    "alarms",        // Required: token refresh scheduling
    "identity"       // Required: Google OAuth flow
  ],
  "optional_permissions": [
    "tabs"           // Optional: needed for multi-tab fill tracking
  ],
  "host_permissions": [
    // Only ATS domains — NOT <all_urls>
    "*://*.greenhouse.io/*",
    "*://jobs.lever.co/*",
    "*://*.myworkdayjobs.com/*",
    "*://*.icims.com/*",
    "*://*.linkedin.com/jobs/*",
    // API server
    "https://valet-api.fly.dev/*"
  ]
}
```

**Permission justifications (for CWS review):**
- `storage`: Caches user profile data and preferences for offline autofill
- `activeTab`: Accesses the current page DOM to detect and fill application forms
- `sidePanel`: Provides the main extension UI for managing autofill
- `alarms`: Schedules periodic token refresh for authenticated API access
- `identity`: Enables Google Sign-In for user authentication
- `host_permissions` on ATS domains: Required to inject content scripts that detect and fill forms

### 8.4 Data Privacy

**What stays local (never sent to server):**
- DOM content of pages (only field types/labels sent, never field values)
- Browsing history / URLs visited
- Cookies or session data from ATS sites
- Extension usage analytics (unless user opts in)

**What goes to the Valet API:**
- Authentication tokens (Google OAuth code exchange)
- User profile data (name, email, resume — user-provided)
- QA bank entries (user-created)
- Task creation (job URL, platform detected)
- Fill completion stats (fields filled count, duration — no PII)

**Content script data isolation:**
```typescript
// NEVER send raw form data to the server
// Only send structured, anonymized metadata
chrome.runtime.sendMessage({
  type: 'FILL_COMPLETE',
  payload: {
    platform: 'greenhouse',
    fieldsFilled: 12,
    totalFields: 15,
    skippedFields: ['coverLetter', 'referral', 'customQuestion'],
    duration: 4500, // ms
    // NO field values, NO page content, NO DOM snapshots
  },
});
```

---

## 9. Chrome Web Store

### 9.1 Publishing Requirements

- **Developer account**: $5 one-time registration fee
- **Two-step verification**: Required on the developer account
- **Privacy policy**: Must be hosted at a public URL and linked in the CWS listing
- **Permission justification**: Each permission must be justified in the developer dashboard
- **Single purpose**: Extension must have a single, clear purpose (autofilling job applications)

### 9.2 Review Timeline

- Most submissions are reviewed within **24 hours**
- Over 90% complete within **3 days**
- If pending > 3 weeks, contact developer support
- Updates to existing extensions with minor changes are faster
- New permissions or significant changes may trigger a more thorough review

### 9.3 Privacy Policy Requirements

The extension must have a privacy policy if it handles ANY user data. The policy must cover:
- What data is collected
- How data is used
- How data is stored and secured
- Data sharing with third parties
- User rights (deletion, export)
- Contact information

Since Valet handles user profile data, resume data, and authenticates with Google, a privacy policy is **required**.

### 9.4 Permission Warnings

Users see these warnings on install:

| Permission | Warning Shown |
|-----------|---------------|
| `storage` | None |
| `activeTab` | None (only on click) |
| `sidePanel` | None |
| `alarms` | None |
| `identity` | None |
| Host permissions (specific domains) | "Read and change your data on [domains]" |

**Key insight:** Using specific host permissions (not `<all_urls>`) significantly reduces the warning severity. Users see "Read and change your data on greenhouse.io, lever.co, ..." which is much less alarming than "Read and change all your data on all websites."

### 9.5 CWS Listing Best Practices

- Screenshots showing the extension in action on different ATS pages
- Short description (132 chars max for search): "Autofill job applications on LinkedIn, Greenhouse, Lever, Workday, and 20+ ATS platforms."
- Detailed description explaining the value proposition
- Demo video (optional but recommended)
- Category: "Productivity"

---

## 10. Monorepo Integration

### 10.1 Importing Shared Packages

The extension imports from `@valet/shared` and `@valet/ui` just like the web app:

```typescript
// In content scripts or side panel
import type { Platform, TaskStatus } from '@valet/shared/schemas';
import { platform, taskStatus } from '@valet/shared/schemas';
import { Button, Card } from '@valet/ui';
```

### 10.2 Workspace Configuration

```json
// Root pnpm-workspace.yaml — add extension
packages:
  - 'packages/*'
  - 'apps/*'
```

```json
// Root turbo.json — add extension pipeline
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".output/**"]
    },
    "@valet/extension#dev": {
      "dependsOn": ["@valet/shared#build", "@valet/ui#build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

### 10.3 Shared Types Between Extension and API

The extension uses the same Zod schemas and ts-rest contracts as the web app for type safety:

```typescript
// Extension uses the same auth schema for token management
import type { AuthTokenResponse, RefreshTokenResponse } from '@valet/shared/schemas';

// Extension uses the same API contract types for fetch calls
import type { apiContract } from '@valet/contracts';

// Profile and QA bank schemas ensure storage validation matches API
import { parsedResumeData, qaEntrySchema, userPreferences } from '@valet/shared/schemas';
```

### 10.4 Code Sharing Strategy

| Code | Shared Package | Extension-Specific |
|------|---------------|-------------------|
| Zod schemas | `@valet/shared` | - |
| API contracts | `@valet/contracts` | - |
| UI components | `@valet/ui` | Overlay components (Shadow DOM) |
| Auth types | `@valet/shared` | `chrome.identity` flow |
| API client | - | Service worker fetch (no React Query) |
| Storage | - | `chrome.storage` wrapper |
| Messaging | - | `chrome.runtime` typed messages |

The extension does **not** use `@ts-rest/react-query` (the web app's API client). Instead, it uses plain `fetch` in the service worker with the same Zod schemas for validation. This keeps the extension bundle smaller and avoids React Query overhead in the service worker context.

---

## References

- [Chrome Extension MV3 Documentation](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Chrome Extension Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [chrome.sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Message Passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [chrome.identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [chrome.dom API](https://developer.chrome.com/docs/extensions/reference/api/dom)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [WXT Framework](https://wxt.dev/)
- [CRXJS Vite Plugin](https://github.com/crxjs/chrome-extension-tools)
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Chrome Web Store Review Process](https://developer.chrome.com/docs/webstore/review-process)
- [Longer Extension Service Worker Lifetimes](https://developer.chrome.com/blog/longer-esw-lifetimes)
- [React Controlled Input Filling (Issue #14694)](https://github.com/facebook/react/issues/14694)
- [Shadow DOM Encapsulation for Chrome Extensions](https://medium.com/outreach-prague/develop-chrome-extensions-using-react-typescript-and-shadow-dom-1e112935a735)
- [WXT vs CRXJS Comparison (2025)](https://redreamality.com/blog/the-2025-state-of-browser-extension-frameworks-a-comparative-analysis-of-plasmo-wxt-and-crxjs/)
- [Monorepo Setup with WXT](https://weberdominik.com/blog/monorepo-wxt-nextjs/)
