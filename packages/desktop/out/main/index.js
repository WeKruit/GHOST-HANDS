"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const supabaseJs = require("@supabase/supabase-js");
const http = require("http");
const zod = require("zod");
const crypto = require("crypto");
const IPC = {
  APPLY: "apply",
  CANCEL_APPLY: "cancel-apply",
  SAVE_PROFILE: "save-profile",
  GET_PROFILE: "get-profile",
  GET_HISTORY: "get-history",
  CLEAR_HISTORY: "clear-history",
  SELECT_RESUME: "select-resume",
  GET_RESUME_PATH: "get-resume-path",
  PROGRESS: "progress",
  IMPORT_COOKBOOK: "import-cookbook",
  GET_COOKBOOKS: "get-cookbooks",
  DELETE_COOKBOOK: "delete-cookbook",
  SIGN_IN_GOOGLE: "sign-in-google",
  SIGN_OUT: "sign-out",
  GET_SESSION: "get-session"
};
const defaults = {
  profile: null,
  resumePath: null,
  history: [],
  refreshToken: null
};
let data = { ...defaults };
let filePath = "";
function getFilePath() {
  if (!filePath) {
    const dir = electron.app.getPath("userData");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, "ghosthands-config.json");
  }
  return filePath;
}
function load() {
  try {
    const raw = fs.readFileSync(getFilePath(), "utf-8");
    data = { ...defaults, ...JSON.parse(raw) };
  } catch {
    data = { ...defaults };
  }
  return data;
}
function save() {
  fs.writeFileSync(getFilePath(), JSON.stringify(data, null, 2), "utf-8");
}
let loaded = false;
function ensureLoaded() {
  if (!loaded) {
    load();
    loaded = true;
  }
}
function getProfile() {
  ensureLoaded();
  return data.profile;
}
function saveProfile(profile) {
  ensureLoaded();
  data.profile = profile;
  save();
}
function getResumePath() {
  ensureLoaded();
  return data.resumePath;
}
function setResumePath(path2) {
  ensureLoaded();
  data.resumePath = path2;
  save();
}
function getHistory() {
  ensureLoaded();
  return data.history;
}
function addHistory(record) {
  ensureLoaded();
  data.history.unshift(record);
  data.history = data.history.slice(0, 100);
  save();
}
function updateHistory(id, updates) {
  ensureLoaded();
  const idx = data.history.findIndex((r) => r.id === id);
  if (idx !== -1) {
    data.history[idx] = { ...data.history[idx], ...updates };
    save();
  }
}
function clearHistory() {
  ensureLoaded();
  data.history = [];
  save();
}
function getRefreshToken$1() {
  ensureLoaded();
  return data.refreshToken;
}
function setRefreshToken(token) {
  ensureLoaded();
  data.refreshToken = token;
  save();
}
let supabase = null;
let currentSession = null;
let refreshTimer = null;
function getSupabaseClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY environment variable");
    }
    supabase = supabaseJs.createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: "pkce"
      }
    });
  }
  return supabase;
}
function toAuthSession(session) {
  const user = session.user;
  return {
    accessToken: session.access_token,
    user: {
      id: user.id,
      email: user.email ?? "",
      name: user.user_metadata?.full_name || user.user_metadata?.name,
      avatarUrl: user.user_metadata?.avatar_url
    },
    expiresAt: session.expires_at ?? 0
  };
}
function scheduleRefresh() {
  clearRefreshTimer();
  if (!currentSession?.expires_at) return;
  const expiresAtMs = currentSession.expires_at * 1e3;
  const refreshInMs = expiresAtMs - Date.now() - 6e4;
  if (refreshInMs <= 0) {
    refreshAccessToken();
    return;
  }
  refreshTimer = setTimeout(() => refreshAccessToken(), refreshInMs);
}
function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
async function refreshAccessToken() {
  if (!currentSession?.refresh_token) return;
  try {
    const client = getSupabaseClient();
    const { data: data2, error } = await client.auth.refreshSession({
      refresh_token: currentSession.refresh_token
    });
    if (error || !data2.session) {
      currentSession = null;
      return;
    }
    currentSession = data2.session;
    scheduleRefresh();
  } catch {
    currentSession = null;
  }
}
async function signInWithGoogle() {
  return new Promise((resolve) => {
    const client = getSupabaseClient();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Sign-in failed. You can close this tab.</h2></body></html>");
        server.close();
        resolve({ session: null, error: errorParam });
        return;
      }
      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>No authorization code received. You can close this tab.</h2></body></html>");
        server.close();
        resolve({ session: null, error: "No authorization code received" });
        return;
      }
      try {
        const { data: data2, error } = await client.auth.exchangeCodeForSession(code);
        if (error || !data2.session) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Authentication failed. You can close this tab.</h2></body></html>");
          server.close();
          resolve({ session: null, error: error?.message ?? "Failed to exchange code" });
          return;
        }
        currentSession = data2.session;
        scheduleRefresh();
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Signed in successfully! You can close this tab and return to GhostHands.</h2></body></html>");
        server.close();
        resolve({ session: toAuthSession(data2.session) });
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Something went wrong. You can close this tab.</h2></body></html>");
        server.close();
        resolve({ session: null, error: err.message });
      }
    });
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        resolve({ session: null, error: "Failed to start local server" });
        return;
      }
      const port = addr.port;
      const redirectTo = `http://127.0.0.1:${port}/callback`;
      const { data: data2, error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: true
        }
      });
      if (error || !data2.url) {
        server.close();
        resolve({ session: null, error: error?.message ?? "Failed to generate OAuth URL" });
        return;
      }
      electron.shell.openExternal(data2.url);
      setTimeout(() => {
        server.close();
        resolve({ session: null, error: "Sign-in timed out" });
      }, 5 * 60 * 1e3);
    });
  });
}
async function signOut() {
  clearRefreshTimer();
  if (currentSession) {
    try {
      const client = getSupabaseClient();
      await client.auth.signOut();
    } catch {
    }
  }
  currentSession = null;
}
function getSession() {
  if (!currentSession) return null;
  return toAuthSession(currentSession);
}
function getAccessToken() {
  return currentSession?.access_token ?? null;
}
function getRefreshToken() {
  return currentSession?.refresh_token ?? null;
}
async function tryRestoreSession(refreshToken) {
  try {
    const client = getSupabaseClient();
    const { data: data2, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data2.session) return null;
    currentSession = data2.session;
    scheduleRefresh();
    return toAuthSession(data2.session);
  } catch {
    return null;
  }
}
const STRATEGIES = [
  {
    name: "testId",
    build: (page, d) => d.testId ? page.getByTestId(d.testId) : null
  },
  {
    name: "role",
    build: (page, d) => d.role ? page.getByRole(d.role, d.name ? { name: d.name } : void 0) : null
  },
  {
    name: "ariaLabel",
    build: (page, d) => d.ariaLabel ? page.getByLabel(d.ariaLabel) : null
  },
  {
    name: "name",
    build: (page, d) => d.name && !d.role ? page.locator(`[name="${d.name}"]`) : null
  },
  {
    name: "id",
    build: (page, d) => d.id ? page.locator(`#${d.id}`) : null
  },
  {
    name: "text",
    build: (page, d) => d.text ? page.getByText(d.text, { exact: true }) : null
  },
  {
    name: "css",
    build: (page, d) => d.css ? page.locator(d.css) : null
  },
  {
    name: "xpath",
    build: (page, d) => d.xpath ? page.locator(d.xpath) : null
  }
];
class LocatorResolver {
  timeout;
  maxRetries;
  constructor(options) {
    this.timeout = options?.timeout ?? 3e3;
    this.maxRetries = options?.maxRetries ?? 1;
  }
  /**
   * Resolve a LocatorDescriptor to a Playwright Locator.
   * Tries strategies in priority order, returning the first one that finds a visible element.
   */
  async resolve(page, descriptor) {
    let attempts = 0;
    for (const strategy of STRATEGIES) {
      const locator = strategy.build(page, descriptor);
      if (!locator) continue;
      attempts++;
      const found = await this.tryLocator(locator);
      if (found) {
        return { locator, strategy: strategy.name, attempts };
      }
    }
    return { locator: null, strategy: "none", attempts };
  }
  /** Try to verify a locator resolves to at least one element, with retry for stale elements. */
  async tryLocator(locator) {
    let retriesLeft = this.maxRetries;
    while (true) {
      try {
        const count = await locator.count();
        return count === 1;
      } catch (err) {
        const isStale = err?.message?.includes("stale") || err?.message?.includes("detached") || err?.message?.includes("Element is not attached");
        if (isStale && retriesLeft > 0) {
          retriesLeft--;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        return false;
      }
    }
  }
}
function resolveTemplate(template, data2) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in data2 ? data2[key] : match;
  });
}
function resolveOptionalTemplate(value, data2) {
  if (value === void 0) return void 0;
  return resolveTemplate(value, data2);
}
class CookbookExecutor {
  resolver;
  defaultWaitAfter;
  logEvent;
  constructor(options) {
    this.resolver = new LocatorResolver({
      timeout: options?.resolverTimeout ?? 3e3
    });
    this.defaultWaitAfter = options?.defaultWaitAfter ?? 0;
    this.logEvent = options?.logEvent ?? null;
  }
  /**
   * Execute all steps of a manual in order.
   * Stops on first failure and returns the failed step index.
   */
  async executeAll(page, manual, userData = {}) {
    const sortedSteps = [...manual.steps].sort((a, b) => a.order - b.order);
    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i];
      if (this.logEvent) {
        await this.logEvent("cookbook_step_started", {
          step_index: i,
          total_steps: sortedSteps.length,
          action: step.action,
          description: step.description
        }).catch(() => {
        });
      }
      const result = await this.executeStep(page, step, userData);
      if (!result.success) {
        if (this.logEvent) {
          await this.logEvent("cookbook_step_failed", {
            step_index: i,
            total_steps: sortedSteps.length,
            action: step.action,
            error: result.error
          }).catch(() => {
          });
        }
        return {
          success: false,
          stepsCompleted: i,
          failedStepIndex: i,
          error: result.error
        };
      }
      if (this.logEvent) {
        await this.logEvent("cookbook_step_completed", {
          step_index: i,
          total_steps: sortedSteps.length,
          action: step.action,
          strategy: result.strategy
        }).catch(() => {
        });
      }
    }
    return { success: true, stepsCompleted: sortedSteps.length };
  }
  /**
   * Execute a single manual step.
   * Resolves the locator, performs the action, applies wait, then verifies.
   */
  async executeStep(page, step, userData = {}) {
    if (step.action === "navigate") {
      return this.executeNavigate(page, step, userData);
    }
    if (step.action === "wait") {
      return this.executeWait(step);
    }
    let resolved;
    try {
      resolved = await this.resolver.resolve(page, step.locator);
    } catch (err) {
      return { success: false, error: `Locator resolution failed: ${err.message}` };
    }
    if (!resolved.locator) {
      return {
        success: false,
        error: `No element found for step ${step.order}: ${step.description ?? step.action}`
      };
    }
    try {
      await this.performAction(resolved.locator, step, userData);
    } catch (err) {
      return {
        success: false,
        strategy: resolved.strategy,
        error: `Action "${step.action}" failed on step ${step.order}: ${err.message}`
      };
    }
    const waitMs = step.waitAfter ?? this.defaultWaitAfter;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return { success: true, strategy: resolved.strategy };
  }
  /** Perform the Playwright action on the resolved locator. */
  async performAction(locator, step, userData) {
    const value = resolveOptionalTemplate(step.value, userData);
    switch (step.action) {
      case "click":
        await locator.click();
        break;
      case "fill":
        if (value === void 0) throw new Error("fill action requires a value");
        await locator.fill(value);
        break;
      case "select":
        if (value === void 0) throw new Error("select action requires a value");
        await locator.selectOption(value);
        break;
      case "check":
        await locator.check();
        break;
      case "uncheck":
        await locator.uncheck();
        break;
      case "hover":
        await locator.hover();
        break;
      case "press":
        if (value === void 0) throw new Error("press action requires a value (key name)");
        await locator.press(value);
        break;
      case "scroll":
        await locator.scrollIntoViewIfNeeded();
        break;
      default:
        throw new Error(`Unsupported action: ${step.action}`);
    }
  }
  async executeNavigate(page, step, userData) {
    const url = resolveOptionalTemplate(step.value, userData);
    if (!url) {
      return { success: false, error: "navigate action requires a value (URL)" };
    }
    try {
      await page.goto(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Navigation failed: ${err.message}` };
    }
  }
  async executeWait(step) {
    const ms = step.value ? parseInt(step.value, 10) : step.waitAfter ?? 1e3;
    if (isNaN(ms) || ms < 0) {
      return { success: false, error: "wait action requires a valid duration in ms" };
    }
    await new Promise((r) => setTimeout(r, ms));
    return { success: true };
  }
}
class LocalManualStore {
  dir;
  constructor() {
    this.dir = path.join(electron.app.getPath("userData"), "manuals");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.seedBundled();
  }
  /**
   * Auto-seed bundled cookbooks from the source tree on first run.
   * Looks for cookbooks/ directory relative to the app root.
   * Only copies files that don't already exist in the store.
   */
  seedBundled() {
    const candidates = [
      path.join(path.dirname(path.dirname(__dirname)), "cookbooks"),
      // dev: out/main/ → ../../cookbooks
      path.join(electron.app.getAppPath(), "cookbooks"),
      // prod: app root
      path.join(path.dirname(path.dirname(path.dirname(__dirname))), "cookbooks")
      // fallback
    ];
    for (const cookbookDir of candidates) {
      if (!fs.existsSync(cookbookDir)) continue;
      let files;
      try {
        files = fs.readdirSync(cookbookDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(cookbookDir, file), "utf-8");
          const manual = JSON.parse(raw);
          const destPath = path.join(this.dir, `${manual.id}.json`);
          if (!fs.existsSync(destPath)) {
            fs.writeFileSync(destPath, raw, "utf-8");
          }
        } catch {
        }
      }
      break;
    }
  }
  /**
   * Look up the best-matching manual for a URL and task type.
   * Returns the manual with the highest health score among matches, or null.
   */
  lookup(url, taskType, platform) {
    const manuals = this.getAll();
    const candidates = manuals.filter((m) => m.task_pattern === taskType).filter((m) => !platform || m.platform === platform || m.platform === "other").filter((m) => m.health_score > 0).filter(
      (m) => (
        // Template (seed) cookbooks rely on platform + task_pattern filtering only;
        // recorded/actionbook manuals use exact URL pattern matching (staging parity).
        m.source === "template" || LocalManualStore.urlMatchesPattern(url, m.url_pattern)
      )
    ).sort((a, b) => b.health_score - a.health_score);
    return candidates[0] ?? null;
  }
  /** Save an ActionManual to disk as {id}.json. */
  save(manual) {
    const filePath2 = path.join(this.dir, `${manual.id}.json`);
    fs.writeFileSync(filePath2, JSON.stringify(manual, null, 2), "utf-8");
  }
  /** Load all manuals from disk. */
  getAll() {
    const manuals = [];
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, file), "utf-8");
        manuals.push(JSON.parse(raw));
      } catch {
      }
    }
    return manuals;
  }
  /** Remove a manual by ID. */
  remove(id) {
    const filePath2 = path.join(this.dir, `${id}.json`);
    try {
      fs.unlinkSync(filePath2);
      return true;
    } catch {
      return false;
    }
  }
  // ── Static URL matching helpers (from ManualStore) ────────────────────
  /**
   * Convert a concrete URL into a glob-style pattern.
   *
   * Example: https://acme.myworkdayjobs.com/en-US/careers/job/NYC/apply
   *       -> *.myworkdayjobs.com/[star]/careers/job/[star]/apply
   */
  static urlToPattern(url) {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split(".");
    let hostPattern;
    if (hostParts.length >= 3) {
      hostPattern = "*." + hostParts.slice(-2).join(".");
    } else {
      hostPattern = parsed.hostname;
    }
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const patternSegments = pathSegments.map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return "*";
      if (/^\d+$/.test(seg)) return "*";
      if (/^[a-z]{2}(-[A-Z]{2})?$/.test(seg)) return "*";
      return seg;
    });
    return hostPattern + "/" + patternSegments.join("/");
  }
  /**
   * Test whether a URL matches a glob-style pattern.
   * '*' matches any single path segment or subdomain part.
   */
  static urlMatchesPattern(url, pattern) {
    try {
      const parsed = new URL(url);
      const urlStr = parsed.hostname + parsed.pathname.replace(/\/$/, "");
      const patternStr = pattern.replace(/\/$/, "");
      const regexStr = "^" + patternStr.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$";
      return new RegExp(regexStr).test(urlStr);
    } catch {
      return false;
    }
  }
}
class TraceRecorder {
  page;
  events;
  userData;
  steps = [];
  recording = false;
  boundHandler = null;
  constructor(options) {
    this.page = options.page;
    this.events = options.events;
    this.userData = options.userData ?? {};
  }
  /** Start subscribing to agent events and recording steps. */
  start() {
    if (this.recording) return;
    this.boundHandler = (action) => {
      this.recordAction(action).catch(() => {
      });
    };
    this.events.on("actionDone", this.boundHandler);
    this.page.on("load", () => {
      this.helperInjected = false;
    });
    this.recording = true;
  }
  /** Stop subscribing to events. Recorded trace is preserved. */
  stopRecording() {
    if (!this.recording || !this.boundHandler) return;
    this.events.off("actionDone", this.boundHandler);
    this.boundHandler = null;
    this.recording = false;
  }
  /** Returns an ordered copy of the recorded ManualStep array. */
  getTrace() {
    return [...this.steps];
  }
  /** Whether the recorder is currently listening for events. */
  isRecording() {
    return this.recording;
  }
  // ── Private ────────────────────────────────────────────────────────
  async recordAction(action) {
    const stepAction = mapVariantToAction(action.variant);
    if (!stepAction) return;
    await this.ensureHelper();
    if (action.variant === "load") {
      const navAction = action;
      this.steps.push({
        order: this.steps.length,
        locator: { css: "body" },
        action: "navigate",
        value: navAction.url,
        healthScore: 1
      });
      return;
    }
    let elementInfo = null;
    const coordAction = action;
    if (coordAction.x !== void 0 && coordAction.y !== void 0) {
      elementInfo = await this.extractElementInfo(coordAction.x, coordAction.y);
    } else if (stepAction === "fill") {
      elementInfo = await this.extractActiveElementInfo();
    }
    if (!elementInfo) return;
    const locator = buildLocator(elementInfo);
    let value;
    if (action.variant === "type") {
      const typeAction = action;
      value = this.templatize(typeAction.content);
    }
    this.steps.push({
      order: this.steps.length,
      locator,
      action: stepAction,
      ...value !== void 0 && { value },
      healthScore: 1
    });
  }
  /**
   * Evaluate document.elementFromPoint(x, y) in the browser context
   * and extract all locator strategies from the found element.
   */
  async extractElementInfo(x, y) {
    try {
      return await this.page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          if (!el) return null;
          return window.__gh_extractLocator(el);
        },
        [x, y]
      );
    } catch {
      return null;
    }
  }
  /**
   * Use document.activeElement for keyboard events that lack coordinates.
   */
  async extractActiveElementInfo() {
    try {
      return await this.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        return window.__gh_extractLocator(el);
      });
    } catch {
      return null;
    }
  }
  /**
   * Inject the locator extraction helper into the page context once.
   * Called automatically before first use.
   */
  helperInjected = false;
  async ensureHelper() {
    if (this.helperInjected) return;
    await this.page.evaluate(() => {
      window.__gh_extractLocator = (el) => {
        const tag = el.tagName.toLowerCase();
        const elId = el.getAttribute("id") ?? "";
        const name = el.getAttribute("name") ?? "";
        const testId = el.getAttribute("data-testid") ?? "";
        const automationId = el.getAttribute("data-automation-id") ?? "";
        const role = el.getAttribute("role") ?? tag;
        const ariaLabel = el.getAttribute("aria-label") ?? "";
        const text = el.textContent?.trim().slice(0, 100) ?? "";
        let css = tag;
        if (automationId) {
          css = `${tag}[data-automation-id='${automationId}']`;
        } else if (elId) {
          css += `#${elId}`;
        }
        if (name) css += `[name="${name}"]`;
        const parts = [];
        let current = el;
        while (current && current !== document.documentElement) {
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (c) => c.tagName === current.tagName
            );
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
          } else {
            parts.unshift(current.tagName.toLowerCase());
          }
          current = parent;
        }
        const xpath = "/html/" + parts.join("/");
        return { testId, role, name, ariaLabel, id: elId, text, css, xpath };
      };
    });
    this.helperInjected = true;
  }
  /**
   * If the value matches a userData field value, return {{field_name}}.
   * Otherwise return the original value.
   */
  templatize(value) {
    for (const [fieldName, fieldValue] of Object.entries(this.userData)) {
      if (value === fieldValue) {
        return `{{${fieldName}}}`;
      }
    }
    return value;
  }
}
function mapVariantToAction(variant) {
  switch (variant) {
    case "click":
      return "click";
    case "type":
      return "fill";
    case "scroll":
      return "scroll";
    case "load":
      return "navigate";
    default:
      return null;
  }
}
function buildLocator(info) {
  const locator = {};
  if (info.testId) locator.testId = info.testId;
  if (info.role) locator.role = info.role;
  if (info.name) locator.name = info.name;
  if (info.ariaLabel) locator.ariaLabel = info.ariaLabel;
  if (info.id) locator.id = info.id;
  if (info.text) locator.text = info.text;
  if (info.css) locator.css = info.css;
  if (info.xpath) locator.xpath = info.xpath;
  return locator;
}
const PLATFORM_PATTERNS = [
  { platform: "workday", patterns: [/\.myworkdayjobs\.com/, /\.wd\d\.myworkdaysite\.com/] },
  { platform: "greenhouse", patterns: [/boards\.greenhouse\.io/, /job-boards\.greenhouse\.io/] },
  { platform: "lever", patterns: [/jobs\.lever\.co/] },
  { platform: "icims", patterns: [/\.icims\.com/] },
  { platform: "taleo", patterns: [/\.taleo\.net/] },
  { platform: "smartrecruiters", patterns: [/jobs\.smartrecruiters\.com/] },
  { platform: "linkedin", patterns: [/linkedin\.com\/jobs/] }
];
function detectPlatform(url) {
  for (const { platform, patterns } of PLATFORM_PATTERNS) {
    if (patterns.some((p) => p.test(url))) return platform;
  }
  return "other";
}
const BASE_RULES = `ABSOLUTE RULE #1 — ZERO SCROLLING: You must NEVER scroll the page — not even 1 pixel. No mouse wheel, no scroll actions, no Page Down. The system handles all scrolling.

ABSOLUTE RULE #2 — FULLY VISIBLE ONLY: Before interacting with ANY field, check that you can see the ENTIRE perimeter of its input box — all four edges must be fully visible on screen. If even one edge is cut off, that field is OFF LIMITS. Do not click it, do not type in it. When you run out of fully visible fields, STOP immediately. The system will scroll for you.

ABSOLUTE RULE #3 — ONE ATTEMPT PER FIELD: You may type into a given field AT MOST ONCE. After you type a value and click elsewhere, that field is DONE. Do NOT go back and re-type. Even if the field appears empty after you typed, trust that your input was registered and move to the next field.

ABSOLUTE RULE #4 — NO TAB KEY: NEVER press the Tab key to move between fields. Instead, after filling a field, CLICK on empty whitespace to deselect, then CLICK directly on the next field you want to fill.

ABSOLUTE RULE #5 — NEVER NAVIGATE: Do NOT click "Save and Continue", "Next", "Submit", "Back", or any navigation button. When you are done filling visible fields, simply STOP. The system handles navigation.`;
const FIELD_FILL_RULES = `1. If the field already has ANY value (even if formatted differently), SKIP IT entirely.
2. If the field is truly empty: CLICK on it, type/select the correct value, then CLICK on whitespace to deselect.
3. DROPDOWNS: CLICK the dropdown to open it, TYPE your desired answer to filter, WAIT for options to appear, then CLICK the matching option. Fill ONE dropdown at a time.
4. DATE FIELDS (MM/DD/YYYY): Click on the date field, type the full date as continuous digits with NO slashes (e.g. "02242026" for 02/24/2026).
5. CHECKBOXES: If you see a required checkbox (e.g. "I acknowledge..." or Terms & Conditions), click on it to check it.`;
function buildFillPrompt(profile, resumePath) {
  const lines = [
    `Name: ${profile.firstName} ${profile.lastName}`,
    `Email: ${profile.email}`,
    `Phone: ${profile.phone}`
  ];
  if (profile.address) {
    const parts = [profile.address, profile.city, profile.state, profile.zipCode].filter(Boolean);
    lines.push(`Address: ${parts.join(", ")}`);
  }
  if (profile.linkedIn) lines.push(`LinkedIn: ${profile.linkedIn}`);
  if (profile.education.length > 0) {
    lines.push("", "Education:");
    for (const edu of profile.education) {
      const years = edu.endDate ? `${edu.startDate}-${edu.endDate}` : `${edu.startDate}-present`;
      lines.push(`- ${edu.degree} in ${edu.field} from ${edu.school} (${years})`);
    }
  }
  if (profile.experience.length > 0) {
    lines.push("", "Work Experience:");
    for (const exp of profile.experience) {
      const dates = exp.endDate ? `${exp.startDate} - ${exp.endDate}` : `${exp.startDate} - present`;
      lines.push(`- ${exp.title} at ${exp.company} (${dates})`);
      lines.push(`  ${exp.description}`);
    }
  }
  if (resumePath) lines.push("", `Resume file path (upload if form asks): ${resumePath}`);
  if (profile.qaAnswers && Object.keys(profile.qaAnswers).length > 0) {
    lines.push("", "Pre-set answers for common questions:");
    for (const [question, answer] of Object.entries(profile.qaAnswers)) {
      lines.push(`Q: ${question}`, `A: ${answer}`);
    }
  }
  const dataBlock = lines.join("\n");
  return `${BASE_RULES}

Fill any EMPTY form fields that are FULLY visible on screen, from TOP to BOTTOM:
${FIELD_FILL_RULES}

If ALL visible fields already have values, STOP IMMEDIATELY — do nothing.

${dataBlock}`;
}
async function fillWithSmartScroll(agent, profile, emit, resumePath) {
  const MAX_ROUNDS = 10;
  const page = agent.page;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const fillPrompt = buildFillPrompt(profile, resumePath);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0) {
      const { scrollY, maxScroll } = await page.evaluate(() => ({
        scrollY: window.scrollY,
        maxScroll: document.documentElement.scrollHeight - window.innerHeight
      }));
      if (scrollY >= maxScroll - 10) {
        emit("status", "Reached bottom of form");
        break;
      }
    }
    emit("status", `Filling visible fields (section ${round + 1})...`);
    await agent.act(fillPrompt);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65)));
    await page.waitForTimeout(800);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    if (scrollAfter <= scrollBefore) {
      emit("status", "Reached bottom of form");
      break;
    }
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);
  emit("status", "Clicking Save and Continue...");
  await agent.act(
    'Click the "Save and Continue" or "Next" or "Submit" button at the bottom of the page. Do NOT scroll. If no such button is visible, STOP.'
  );
}
let activeAgent = null;
let manualStore = null;
function getManualStore() {
  if (!manualStore) {
    manualStore = new LocalManualStore();
  }
  return manualStore;
}
async function runApplication(params) {
  const { targetUrl, profile, resumePath, onProgress } = params;
  const emit = (type, message, extra) => {
    onProgress({ type, message, timestamp: Date.now(), ...extra });
  };
  const InputSchema = zod.z.object({
    first_name: zod.z.string().min(1, "First name is required"),
    last_name: zod.z.string().min(1, "Last name is required"),
    email: zod.z.string().email("Valid email is required")
  });
  const validation = InputSchema.safeParse({
    first_name: profile.firstName,
    last_name: profile.lastName,
    email: profile.email
  });
  if (!validation.success) {
    const errors = validation.error.issues.map((i) => i.message).join(", ");
    return { success: false, message: `Profile validation failed: ${errors}` };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { success: false, message: "ANTHROPIC_API_KEY environment variable is not set" };
  }
  try {
    emit("status", "Starting automation engine...");
    const { startBrowserAgent } = await import("magnitude-core");
    const agent = await startBrowserAgent({
      url: targetUrl,
      llm: {
        provider: "anthropic",
        options: {
          model: "claude-haiku-4-5-20251001",
          apiKey
        }
      },
      browser: {
        launchOptions: { headless: false }
      }
    });
    activeAgent = agent;
    emit("status", "Browser launched, navigating to application page...");
    agent.events.on("actionStarted", (action) => {
      emit("action", `Action: ${action.variant || "performing step"}`);
    });
    agent.events.on("thought", (reasoning) => {
      emit("thought", reasoning?.thought || reasoning?.message || String(reasoning));
    });
    const screenshotInterval = setInterval(async () => {
      try {
        if (agent.page) {
          const buf = await agent.page.screenshot();
          emit("screenshot", void 0, { screenshot: Buffer.from(buf).toString("base64") });
        }
      } catch {
      }
    }, 3e3);
    let cookbookSucceeded = false;
    const platform = detectPlatform(targetUrl);
    const store = getManualStore();
    const manual = store.lookup(targetUrl, "apply", platform);
    if (manual) {
      emit("status", `Cookbook found for ${platform} — replaying ${manual.steps.length} steps...`);
      cookbookSucceeded = await tryCookbookExecution(agent.page, manual, profile, emit);
    }
    let traceRecorder = null;
    if (!cookbookSucceeded) {
      if (manual) {
        emit("status", "Cookbook replay failed, falling back to LLM automation...");
      }
      const userData = buildUserData(profile);
      traceRecorder = new TraceRecorder({
        page: agent.page,
        events: agent.events,
        userData
      });
      traceRecorder.start();
      emit("status", "Recording actions for future cookbook...");
      emit("status", "Filling out application form...");
      if (platform === "workday") {
        const { runWorkdayPipeline } = await Promise.resolve().then(() => require("./chunks/workdayOrchestrator-Brj11oGW.js"));
        await runWorkdayPipeline(agent, profile, emit, resumePath);
      } else {
        await fillWithSmartScroll(agent, profile, emit, resumePath);
      }
    }
    clearInterval(screenshotInterval);
    try {
      const buf = await agent.page.screenshot();
      emit("screenshot", void 0, { screenshot: Buffer.from(buf).toString("base64") });
    } catch {
    }
    if (traceRecorder && traceRecorder.isRecording()) {
      traceRecorder.stopRecording();
      const trace = traceRecorder.getTrace();
      if (trace.length > 0) {
        try {
          const now = (/* @__PURE__ */ new Date()).toISOString();
          const newManual = {
            id: crypto.randomUUID(),
            url_pattern: LocalManualStore.urlToPattern(targetUrl),
            task_pattern: "apply",
            platform,
            steps: trace,
            health_score: 1,
            source: "recorded",
            created_at: now,
            updated_at: now
          };
          store.save(newManual);
          emit("status", `Cookbook saved (${trace.length} steps) — next run will be faster`);
        } catch {
        }
      }
    }
    emit("complete", "Application filled — browser open for manual review");
    return { success: true, message: "Application filled — browser open for manual review" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit("error", `Failed: ${message}`);
    emit("status", "Browser left open — you can fix the issue manually or cancel");
    return { success: false, message };
  }
}
async function cancelApplication() {
  if (activeAgent) {
    try {
      await activeAgent.stop();
    } catch {
    }
    activeAgent = null;
  }
}
async function tryCookbookExecution(page, manual, profile, emit) {
  const userData = buildUserData(profile);
  const totalSteps = manual.steps.length;
  const executor = new CookbookExecutor({
    resolverTimeout: 5e3,
    defaultWaitAfter: 300,
    logEvent: async (eventType, metadata) => {
      if (eventType === "cookbook_step_started") {
        const stepNum = metadata.step_index + 1;
        const desc = metadata.description || metadata.action;
        emit("status", `Cookbook step ${stepNum}/${totalSteps}: ${desc}`, {
          step: stepNum,
          totalSteps
        });
      }
    }
  });
  try {
    const result = await executor.executeAll(page, manual, userData);
    if (result.success) {
      emit("status", `Cookbook replay complete — all ${totalSteps} steps succeeded`);
      return true;
    }
    emit("status", `Cookbook failed at step ${(result.failedStepIndex ?? 0) + 1}/${totalSteps}: ${result.error}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("status", `Cookbook execution error: ${msg}`);
    return false;
  }
}
function buildUserData(profile) {
  const data2 = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`,
    email: profile.email,
    phone: profile.phone,
    linkedIn: profile.linkedIn || "",
    address: profile.address || "",
    city: profile.city || "",
    state: profile.state || "",
    zipCode: profile.zipCode || ""
  };
  if (profile.education.length > 0) {
    const edu = profile.education[0];
    data2.school = edu.school;
    data2.degree = edu.degree;
    data2.field = edu.field;
    data2.startYear = edu.startDate;
    data2.endYear = edu.endDate || "";
  }
  if (profile.experience.length > 0) {
    const exp = profile.experience[0];
    data2.company = exp.company;
    data2.jobTitle = exp.title;
    data2.startDate = exp.startDate;
    data2.endDate = exp.endDate || "";
    data2.jobDescription = exp.description;
  }
  if (profile.qaAnswers) {
    for (const [key, value] of Object.entries(profile.qaAnswers)) {
      data2[key] = value;
    }
  }
  return data2;
}
const LocatorDescriptorSchema = zod.z.object({
  testId: zod.z.string().optional(),
  role: zod.z.string().optional(),
  name: zod.z.string().optional(),
  ariaLabel: zod.z.string().optional(),
  id: zod.z.string().optional(),
  text: zod.z.string().optional(),
  css: zod.z.string().optional(),
  xpath: zod.z.string().optional()
}).refine(
  (data2) => Object.values(data2).some((v) => v !== void 0),
  { message: "LocatorDescriptor must have at least one strategy defined" }
);
const ManualStepSchema = zod.z.object({
  order: zod.z.number().int().nonnegative(),
  locator: LocatorDescriptorSchema,
  action: zod.z.enum(["click", "fill", "select", "check", "uncheck", "hover", "press", "navigate", "wait", "scroll"]),
  value: zod.z.string().optional(),
  description: zod.z.string().optional(),
  waitAfter: zod.z.number().nonnegative().optional(),
  verification: zod.z.string().optional(),
  healthScore: zod.z.number().min(0).max(1).default(1)
});
const ManualSourceSchema = zod.z.enum(["recorded", "actionbook", "template"]);
const ActionManualSchema = zod.z.object({
  id: zod.z.string().uuid(),
  url_pattern: zod.z.string(),
  task_pattern: zod.z.string(),
  platform: zod.z.string(),
  steps: zod.z.array(ManualStepSchema).min(1),
  health_score: zod.z.number().min(0).max(1).default(1),
  source: ManualSourceSchema,
  created_at: zod.z.string().datetime(),
  updated_at: zod.z.string().datetime()
});
const GH_API_URL = process.env.GH_API_URL || "http://localhost:3100";
async function fetchProfileFromApi() {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${GH_API_URL}/api/v1/gh/desktop/profile`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.profile ?? null;
  } catch {
    return null;
  }
}
async function syncProfileToApi(profile) {
  const token = getAccessToken();
  if (!token) return;
  try {
    await fetch(`${GH_API_URL}/api/v1/gh/desktop/profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(profile)
    });
  } catch {
  }
}
function registerIpcHandlers(getMainWindow) {
  electron.ipcMain.handle(IPC.SIGN_IN_GOOGLE, async () => {
    try {
      const result = await signInWithGoogle();
      if (result.session) {
        const refreshToken = getRefreshToken();
        if (refreshToken) setRefreshToken(refreshToken);
        return { success: true, session: result.session };
      }
      return { success: false, error: result.error };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle(IPC.SIGN_OUT, async () => {
    await signOut();
    setRefreshToken(null);
  });
  electron.ipcMain.handle(IPC.GET_SESSION, async () => {
    const session = getSession();
    if (session) return session;
    const refreshToken = getRefreshToken$1();
    if (refreshToken) {
      const restored = await tryRestoreSession(refreshToken);
      if (restored) {
        const newRefreshToken = getRefreshToken();
        if (newRefreshToken) setRefreshToken(newRefreshToken);
        return restored;
      }
      setRefreshToken(null);
    }
    return null;
  });
  electron.ipcMain.handle(IPC.GET_PROFILE, async () => {
    if (getAccessToken()) {
      const remote = await fetchProfileFromApi();
      if (remote) {
        saveProfile(remote);
        return remote;
      }
    }
    return getProfile();
  });
  electron.ipcMain.handle(IPC.SAVE_PROFILE, async (_event, profile) => {
    saveProfile(profile);
    await syncProfileToApi(profile);
  });
  electron.ipcMain.handle(IPC.SELECT_RESUME, async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await electron.dialog.showOpenDialog(win, {
      title: "Select Resume",
      filters: [{ name: "Documents", extensions: ["pdf", "doc", "docx"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const path2 = result.filePaths[0];
    setResumePath(path2);
    return path2;
  });
  electron.ipcMain.handle(IPC.GET_RESUME_PATH, () => getResumePath());
  electron.ipcMain.handle(IPC.APPLY, async (_event, url) => {
    const win = getMainWindow();
    const profile = getProfile();
    const resumePath = getResumePath();
    if (!profile) return { success: false, message: "Please set up your profile first" };
    const recordId = crypto.randomUUID();
    addHistory({
      id: recordId,
      url,
      company: extractCompanyFromUrl(url),
      jobTitle: "",
      status: "running",
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    const onProgress = (event) => {
      win?.webContents.send(IPC.PROGRESS, event);
    };
    const result = await runApplication({
      targetUrl: url,
      profile,
      resumePath: resumePath ?? void 0,
      onProgress
    });
    updateHistory(recordId, {
      status: result.success ? "success" : "failed",
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: result.success ? void 0 : result.message
    });
    return result;
  });
  electron.ipcMain.handle(IPC.CANCEL_APPLY, () => cancelApplication());
  electron.ipcMain.handle(IPC.GET_HISTORY, () => getHistory());
  electron.ipcMain.handle(IPC.CLEAR_HISTORY, () => clearHistory());
  electron.ipcMain.handle(IPC.IMPORT_COOKBOOK, async () => {
    const win = getMainWindow();
    if (!win) return { success: false, message: "No window available" };
    const result = await electron.dialog.showOpenDialog(win, {
      title: "Import Cookbook",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: "Cancelled" };
    }
    try {
      const raw = fs.readFileSync(result.filePaths[0], "utf-8");
      const parsed = JSON.parse(raw);
      const manual = ActionManualSchema.parse(parsed);
      getManualStore().save(manual);
      return { success: true, message: `Imported cookbook: ${manual.platform} — ${manual.url_pattern}` };
    } catch (err) {
      return { success: false, message: `Invalid cookbook file: ${err.message}` };
    }
  });
  electron.ipcMain.handle(IPC.GET_COOKBOOKS, () => {
    return getManualStore().getAll();
  });
  electron.ipcMain.handle(IPC.DELETE_COOKBOOK, (_event, id) => {
    return getManualStore().remove(id);
  });
}
function extractCompanyFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    const match = hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
    if (match) return match[1];
    const parts = hostname.split(".");
    return parts[0] === "www" ? parts[1] : parts[0];
  } catch {
    return "Unknown";
  }
}
if (electron.app.isPackaged) {
  const bundledBrowsers = path.join(process.resourcesPath, "playwright-browsers");
  if (fs.existsSync(bundledBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
}
function loadEnvFile(filePath2) {
  try {
    const content = fs.readFileSync(filePath2, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}
const packageRoot = path.join(__dirname, "../..");
const ghEnv = process.env.GH_ENV;
if (ghEnv) {
  loadEnvFile(path.join(packageRoot, `.env.${ghEnv}`));
}
loadEnvFile(path.join(packageRoot, ".env"));
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: "GhostHands",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      sandbox: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
registerIpcHandlers(() => mainWindow);
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  electron.app.quit();
});
