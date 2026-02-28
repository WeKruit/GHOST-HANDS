/**
 * Stagehand v3 → Playwright API Compatibility Layer
 *
 * Our codebase uses adapter.page extensively with Playwright's Page and Locator
 * APIs. Stagehand v3 has its own Page/Locator classes that are similar but not
 * identical. These wrappers bridge the gap so existing handler code works
 * without modification.
 */

import type { Stagehand } from '@browserbasehq/stagehand';

// ── Types ───────────────────────────────────────────────────────────────

// Stagehand's Page type is accessed via stagehand.context.activePage().
// We use `any` for internal page references because the Stagehand Page
// class API is structurally compatible but not type-exported directly.

// ── FileChooserCompat ───────────────────────────────────────────────────

/**
 * Minimal FileChooser-like object compatible with Playwright's FileChooser.
 * Used with the page.on('filechooser') event interception.
 */
export class FileChooserCompat {
  constructor(
    private _page: any,
    private _backendNodeId: number,
  ) {}

  async setFiles(files: string | string[]): Promise<void> {
    const fileArr = Array.isArray(files) ? files : [files];
    try {
      await this._page.sendCDP('DOM.setFileInputFiles', {
        files: fileArr,
        backendNodeId: this._backendNodeId,
      });
    } catch {
      // Fallback: try to find file input and use locator.setInputFiles
      const locator = this._page.locator('input[type="file"]');
      await locator.setInputFiles(fileArr);
    }
  }
}

// ── StagehandLocatorCompat ──────────────────────────────────────────────

/**
 * Wraps Stagehand's Locator to provide Playwright-like .nth(), .first(),
 * .scrollIntoViewIfNeeded(), and child-locator chaining.
 *
 * When `_index` is null, methods delegate directly to the underlying Stagehand
 * Locator. When `_index` is set (via .nth() or .first()), methods use
 * page.evaluate() to target the specific Nth matching element.
 */
export class StagehandLocatorCompat {
  private _page: any;
  private _selector: string;
  private _index: number | null;

  constructor(page: any, selector: string, index: number | null = null) {
    this._page = page;
    this._selector = selector;
    this._index = index;
  }

  // ── Indexing ────────────────────────────────────────────────────────

  nth(n: number): StagehandLocatorCompat {
    return new StagehandLocatorCompat(this._page, this._selector, n);
  }

  first(): StagehandLocatorCompat {
    return this.nth(0);
  }

  last(): StagehandLocatorCompat {
    // Resolved lazily — count() is async so we can't compute here.
    // Use a sentinel value and resolve in interaction methods.
    return new StagehandLocatorCompat(this._page, this._selector, -1);
  }

  // ── Child locator chaining ──────────────────────────────────────────

  locator(childSelector: string): StagehandLocatorCompat {
    const combinedSelector = `${this._selector} ${childSelector}`;
    return new StagehandLocatorCompat(this._page, combinedSelector, this._index);
  }

  // ── Queries ─────────────────────────────────────────────────────────

  async count(): Promise<number> {
    return this._page.evaluate(
      (sel: string) => document.querySelectorAll(sel).length,
      this._selector,
    );
  }

  async textContent(): Promise<string | null> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          return i < els.length ? els[i].textContent : null;
        },
        { sel: this._selector, i: idx },
      );
    }
    return this._nativeLocator().textContent();
  }

  async innerText(): Promise<string> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          return i < els.length ? (els[i] as HTMLElement).innerText : '';
        },
        { sel: this._selector, i: idx },
      );
    }
    return this._nativeLocator().innerText();
  }

  async innerHTML(): Promise<string> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          return i < els.length ? els[i].innerHTML : '';
        },
        { sel: this._selector, i: idx },
      );
    }
    return this._nativeLocator().innerHTML();
  }

  async getAttribute(name: string): Promise<string | null> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i, attr }: { sel: string; i: number; attr: string }) => {
          const els = document.querySelectorAll(sel);
          return i < els.length ? els[i].getAttribute(attr) : null;
        },
        { sel: this._selector, i: idx, attr: name },
      );
    }
    return this._nativeLocator().getAttribute(name);
  }

  async isVisible(opts?: { timeout?: number }): Promise<boolean> {
    if (opts?.timeout) {
      // Poll for visibility within timeout
      const deadline = Date.now() + opts.timeout;
      while (Date.now() < deadline) {
        const visible = await this._checkVisible();
        if (visible) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    }
    return this._checkVisible();
  }

  async isHidden(): Promise<boolean> {
    return !(await this._checkVisible());
  }

  async isEnabled(): Promise<boolean> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i >= els.length) return false;
          return !(els[i] as HTMLInputElement).disabled;
        },
        { sel: this._selector, i: idx },
      );
    }
    return this._nativeLocator().isEnabled();
  }

  async isChecked(): Promise<boolean> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i >= els.length) return false;
          return (els[i] as HTMLInputElement).checked;
        },
        { sel: this._selector, i: idx },
      );
    }
    return this._nativeLocator().isChecked();
  }

  // ── Interaction ─────────────────────────────────────────────────────

  async click(opts?: { force?: boolean; timeout?: number }): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      const pos = await this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i >= els.length) return null;
          const rect = els[i].getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        },
        { sel: this._selector, i: idx },
      );
      if (!pos) throw new Error(`Element not found: ${this._selector}[${idx}]`);
      if (opts?.force) {
        // Force click via JS
        await this._page.evaluate(
          ({ sel, i }: { sel: string; i: number }) => {
            const els = document.querySelectorAll(sel);
            if (i < els.length) (els[i] as HTMLElement).click();
          },
          { sel: this._selector, i: idx },
        );
      } else {
        await this._page.click(pos.x, pos.y);
      }
      return;
    }
    if (opts?.force) {
      // Force click via JS on first match
      await this._page.evaluate(
        (sel: string) => {
          const el = document.querySelector(sel);
          if (el) (el as HTMLElement).click();
        },
        this._selector,
      );
    } else {
      await this._nativeLocator().click();
    }
  }

  async dblclick(): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      const pos = await this._getPosition(idx);
      if (!pos) return;
      // Stagehand Page doesn't have dblclick at coordinate level,
      // so simulate with evaluate
      await this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            const el = els[i] as HTMLElement;
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }
        },
        { sel: this._selector, i: idx },
      );
      return;
    }
    await this._nativeLocator().dblclick();
  }

  async hover(): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      const pos = await this._getPosition(idx);
      if (pos) await this._page.hover(pos.x, pos.y);
      return;
    }
    await this._nativeLocator().hover();
  }

  async fill(text: string): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      // Click to focus, then clear and type
      await this.click();
      // Clear existing value
      await this._page.evaluate(
        ({ sel, i, val }: { sel: string; i: number; val: string }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            const el = els[i] as HTMLInputElement;
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        { sel: this._selector, i: idx, val: text },
      );
      return;
    }
    await this._nativeLocator().fill(text);
  }

  async type(text: string, opts?: { delay?: number }): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      // Click to focus first
      await this.click();
      await this._page.type(text, opts);
      return;
    }
    await this._nativeLocator().type(text, opts);
  }

  async press(key: string, opts?: { delay?: number }): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      await this.click();
      await this._page.keyPress(key, opts);
      return;
    }
    await this._nativeLocator().press(key, opts);
  }

  async select(value: string | string[]): Promise<string[]> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      const val = Array.isArray(value) ? value[0] : value;
      await this._page.evaluate(
        ({ sel, i, v }: { sel: string; i: number; v: string }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            const select = els[i] as HTMLSelectElement;
            select.value = v;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        { sel: this._selector, i: idx, v: val },
      );
      return Array.isArray(value) ? value : [value];
    }
    return this._nativeLocator().select(value);
  }

  async check(): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      await this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            const el = els[i] as HTMLInputElement;
            if (!el.checked) {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.click();
            }
          }
        },
        { sel: this._selector, i: idx },
      );
      return;
    }
    await this._nativeLocator().check();
  }

  async uncheck(): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      await this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            const el = els[i] as HTMLInputElement;
            if (el.checked) {
              el.checked = false;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.click();
            }
          }
        },
        { sel: this._selector, i: idx },
      );
      return;
    }
    await this._nativeLocator().uncheck();
  }

  async setInputFiles(files: string | string[] | { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      // For indexed file inputs, just set on the nth match
      const fileArr = typeof files === 'string' ? [files] : files;
      // Try native locator first since setInputFiles is complex
      try {
        const nativeLocator = this._page.locator(this._selector);
        await nativeLocator.setInputFiles(fileArr);
      } catch {
        // Fallback: click to trigger file chooser
        await this.click();
      }
      return;
    }
    await this._nativeLocator().setInputFiles(files);
  }

  // ── Scroll ──────────────────────────────────────────────────────────

  async scrollIntoViewIfNeeded(): Promise<void> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      await this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i < els.length) {
            els[i].scrollIntoView({ block: 'center', behavior: 'instant' });
          }
        },
        { sel: this._selector, i: idx },
      );
    } else {
      await this._page.evaluate(
        (sel: string) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
        },
        this._selector,
      );
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Get the underlying Stagehand Locator (for non-indexed operations) */
  private _nativeLocator(): any {
    return this._page.locator(this._selector);
  }

  /** Resolve _index, handling -1 (last) sentinel */
  private async _resolveIndex(): Promise<number | null> {
    if (this._index === null) return null;
    if (this._index === -1) {
      const c = await this.count();
      return Math.max(0, c - 1);
    }
    return this._index;
  }

  /** Check visibility of the element */
  private async _checkVisible(): Promise<boolean> {
    const idx = await this._resolveIndex();
    if (idx !== null) {
      return this._page.evaluate(
        ({ sel, i }: { sel: string; i: number }) => {
          const els = document.querySelectorAll(sel);
          if (i >= els.length) return false;
          const el = els[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        },
        { sel: this._selector, i: idx },
      );
    }
    try {
      return await this._nativeLocator().isVisible();
    } catch {
      return false;
    }
  }

  /** Get center position of the element */
  private async _getPosition(idx: number): Promise<{ x: number; y: number } | null> {
    return this._page.evaluate(
      ({ sel, i }: { sel: string; i: number }) => {
        const els = document.querySelectorAll(sel);
        if (i >= els.length) return null;
        const rect = els[i].getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      },
      { sel: this._selector, i: idx },
    );
  }
}

// ── StagehandContextCompat ──────────────────────────────────────────────

/**
 * Provides page.context() API via CDP commands.
 * Replaces Playwright's BrowserContext for session persistence and
 * multi-page management.
 */
export class StagehandContextCompat {
  constructor(
    private _stagehand: Stagehand,
    private _getActivePage: () => any,
  ) {}

  async storageState(): Promise<{ cookies: any[]; origins: any[] }> {
    const page = this._getActivePage();
    try {
      const result = await page.sendCDP('Network.getAllCookies') as { cookies: any[] };
      const origins = await page.evaluate(() => {
        try {
          const entries: { key: string; value: string }[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) entries.push({ key, value: localStorage.getItem(key) || '' });
          }
          return [{ origin: window.location.origin, localStorage: entries }];
        } catch {
          return [];
        }
      });
      return { cookies: result.cookies || [], origins };
    } catch {
      return { cookies: [], origins: [] };
    }
  }

  async addCookies(cookies: any[]): Promise<void> {
    const page = this._getActivePage();
    for (const cookie of cookies) {
      try {
        await page.sendCDP('Network.setCookie', cookie);
      } catch {
        // Best effort — some cookies may fail
      }
    }
  }

  browser(): { wsEndpoint: () => string; isConnected: () => boolean } {
    const stagehand = this._stagehand;
    return {
      wsEndpoint: () => {
        try { return stagehand.connectURL(); } catch { return ''; }
      },
      isConnected: () => {
        try { return !!stagehand.context.activePage(); } catch { return false; }
      },
    };
  }

  async newPage(url?: string): Promise<StagehandPageCompat> {
    const newSHPage = await this._stagehand.context.newPage(url);
    return new StagehandPageCompat(newSHPage, this._stagehand);
  }

  pages(): StagehandPageCompat[] {
    return this._stagehand.context.pages().map(
      (p: any) => new StagehandPageCompat(p, this._stagehand),
    );
  }
}

// ── StagehandPageCompat ─────────────────────────────────────────────────

/**
 * Wraps Stagehand's Page with Playwright-compatible API.
 * This is returned by adapter.page so all existing handler code works.
 */
export class StagehandPageCompat {
  private _stagehandPage: any;
  private _contextCompat: StagehandContextCompat;
  private _filechooserHandlers: Array<(chooser: FileChooserCompat) => void | Promise<void>> = [];
  private _filechooserSetup = false;

  constructor(stagehandPage: any, stagehand: Stagehand) {
    this._stagehandPage = stagehandPage;
    this._contextCompat = new StagehandContextCompat(stagehand, () => this._stagehandPage);
  }

  // ── Direct pass-through ─────────────────────────────────────────────

  async evaluate<R = unknown, Arg = unknown>(
    fn: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg,
  ): Promise<R> {
    return this._stagehandPage.evaluate(fn, arg);
  }

  async screenshot(opts?: any): Promise<Buffer> {
    return this._stagehandPage.screenshot(opts);
  }

  url(): string {
    return this._stagehandPage.url();
  }

  async goto(url: string, opts?: any): Promise<any> {
    return this._stagehandPage.goto(url, opts);
  }

  async reload(opts?: any): Promise<any> {
    return this._stagehandPage.reload(opts);
  }

  async waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    opts?: { timeout?: number },
  ): Promise<void> {
    return this._stagehandPage.waitForLoadState(state, opts?.timeout);
  }

  async waitForSelector(selector: string, opts?: any): Promise<boolean> {
    return this._stagehandPage.waitForSelector(selector, opts);
  }

  async close(): Promise<void> {
    return this._stagehandPage.close();
  }

  async title(): Promise<string> {
    return this._stagehandPage.title();
  }

  frameLocator(selector: string): any {
    return this._stagehandPage.frameLocator(selector);
  }

  // ── Compatibility shims ─────────────────────────────────────────────

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Playwright-compatible keyboard namespace */
  get keyboard(): { press: (key: string, opts?: { delay?: number }) => Promise<void>; type: (text: string, opts?: { delay?: number }) => Promise<void> } {
    const page = this._stagehandPage;
    return {
      press: (key: string, opts?: { delay?: number }) => page.keyPress(key, opts),
      type: (text: string, opts?: { delay?: number }) => page.type(text, opts),
    };
  }

  /** Returns a StagehandLocatorCompat that provides Playwright-like locator API */
  locator(selector: string): StagehandLocatorCompat {
    return new StagehandLocatorCompat(this._stagehandPage, selector);
  }

  /** Returns the StagehandContextCompat for session/cookie operations */
  context(): StagehandContextCompat {
    return this._contextCompat;
  }

  /**
   * Event handler — supports 'filechooser' event via CDP interception.
   * Other events are stored but may not fire.
   */
  on(event: string, handler: (...args: any[]) => void): this {
    if (event === 'filechooser') {
      this._filechooserHandlers.push(handler as (chooser: FileChooserCompat) => void);
      if (!this._filechooserSetup) {
        this._setupFileChooserInterception();
        this._filechooserSetup = true;
      }
    }
    // For other events, silently accept (console, etc.)
    return this;
  }

  off(event: string, _handler: (...args: any[]) => void): this {
    if (event === 'filechooser') {
      this._filechooserHandlers = this._filechooserHandlers.filter(h => h !== _handler);
    }
    return this;
  }

  // ── File chooser interception via CDP ───────────────────────────────

  private async _setupFileChooserInterception(): Promise<void> {
    try {
      await this._stagehandPage.sendCDP('Page.setInterceptFileChooserDialog', { enabled: true });

      // Listen for CDP events via the page's frame session
      const frame = this._stagehandPage.mainFrame();
      if (frame?.session?.on) {
        frame.session.on('Page.fileChooserOpened', async (params: any) => {
          const compat = new FileChooserCompat(this._stagehandPage, params?.backendNodeId ?? 0);
          for (const handler of this._filechooserHandlers) {
            try { await handler(compat); } catch { /* best effort */ }
          }
        });
      }
    } catch {
      // CDP file chooser interception not available — file uploads will rely
      // on explicit locator.setInputFiles() calls in handlers
    }
  }

  /** Access underlying Stagehand page for advanced operations */
  get _raw(): any {
    return this._stagehandPage;
  }
}
