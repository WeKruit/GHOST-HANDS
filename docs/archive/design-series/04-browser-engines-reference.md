# 04 - Browser Engines Reference: Stagehand v3 & Magnitude

> Comprehensive technical reference for both browser automation engines used in Valet.
> Covers complete APIs, initialization patterns, CDP connection, error handling,
> performance characteristics, interop protocol, and known issues.

---

## Table of Contents

1. [Engine Overview & Selection](#1-engine-overview--selection)
2. [Stagehand v3 Complete API Reference](#2-stagehand-v3-complete-api-reference)
3. [Magnitude Complete API Reference](#3-magnitude-complete-api-reference)
4. [CDP Connection Patterns](#4-cdp-connection-patterns)
5. [Engine Interop & Switching Protocol](#5-engine-interop--switching-protocol)
6. [Error Handling Reference](#6-error-handling-reference)
7. [Performance & Cost Data](#7-performance--cost-data)
8. [Known Issues & Workarounds](#8-known-issues--workarounds)
9. [Best Practices](#9-best-practices)

---

## 1. Engine Overview & Selection

### Engine Comparison Matrix

| Aspect | Stagehand v3 | Magnitude |
|--------|-------------|-----------|
| **Approach** | DOM-first + accessibility tree | Vision-first (screenshot + pixel coordinates) |
| **Package** | `@browserbasehq/stagehand` (v3.0.x) | `magnitude-core` (v0.3.x) |
| **Underlying library** | CDP-direct (no Playwright dependency in v3) | Patchright (patched Playwright fork) |
| **Model requirements** | Any LLM (DOM mode), visually-grounded (CUA/hybrid) | Visually-grounded only (Claude Sonnet 4, Qwen 2.5 VL 72B) |
| **Speed** | Faster (text-only DOM analysis) | Slower (screenshot + LLM per action) |
| **Token cost** | Lower (text tokens) | Higher (image tokens per step) |
| **Shadow DOM** | Supported out-of-box in v3 | Native (sees rendered pixels) |
| **Canvas elements** | Cannot interact | Works naturally |
| **Anti-detection** | None built-in | Patchright patches: Runtime.enable, webdriver flag, etc. |
| **Benchmark** | ~98% on standard forms | 94% on WebVoyager |
| **License** | MIT | Apache 2.0 |

### When to Use Each Engine

| Scenario | Stagehand | Magnitude | Rationale |
|----------|:---------:|:---------:|-----------|
| Standard HTML forms (Greenhouse, Lever) | Primary | Fallback | DOM selectors reliable, faster, cheaper |
| LinkedIn Easy Apply | Primary | Fallback | Well-structured DOM |
| Workday portals | Fallback | Primary | Heavy shadow DOM, custom web components |
| Canvas-based assessments | No | Primary | No DOM nodes to select |
| SVG-rendered forms | No | Primary | No standard form semantics |
| Drag-and-drop interfaces | Hybrid mode | Primary | Pixel-coordinate drag natural |
| Aggressive anti-bot sites | Fallback | Primary | Patchright + vision avoids detection |
| Rich text editors (ContentEditable) | No | Primary | iframes + ContentEditable defeat DOM |
| High-volume batch applications | Primary | No | Lower cost per application |
| Unknown/new platforms | Primary | Fallback | Start cheap, escalate as needed |

---

## 2. Stagehand v3 Complete API Reference

### 2.1 Installation

```bash
pnpm add @browserbasehq/stagehand
```

No Playwright peer dependency in v3. Stagehand communicates directly with Chrome via CDP using a modular driver system.

### 2.2 Constructor: `new Stagehand(options)`

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

const stagehand = new Stagehand({
  // --- Required ---
  env: "LOCAL",                     // "LOCAL" | "BROWSERBASE"

  // --- Core Configuration ---
  model: "openai/gpt-4.1-mini",    // Default model for primitives (provider/model format)
  llmClient: customLLMClient,       // Custom LLM implementation (overrides model)
  systemPrompt: "...",              // Custom AI behavior guidance

  // --- Behavioral Options ---
  selfHeal: true,                   // Automatic error recovery (default: true)
  experimental: false,              // Enable experimental features (hybrid mode, streaming, abort)
  domSettleTimeout: 30000,          // Ms to wait for DOM stability after navigation
  cacheDir: "/tmp/stagehand-cache", // Directory for persistent action caching
  verbose: 1,                       // Logging level: 0 (silent), 1 (normal), 2 (debug)
  logInferenceToFile: false,        // Write LLM inferences to file
  logger: (message) => {},          // Custom logging function

  // --- Local Browser Launch Options ---
  localBrowserLaunchOptions: {
    cdpUrl: "ws://127.0.0.1:9222/...", // CDP WebSocket URL of running Chrome
    headless: true,                     // Run without visible window
    executablePath: "/usr/bin/chrome",  // Chrome binary path (unused with cdpUrl)
    port: 9222,                         // CDP debugging port
    viewport: { width: 1440, height: 900 },
    proxy: { server: "...", username: "...", password: "..." },
    chromiumSandbox: true,              // Chromium sandbox (false in Docker)
    ignoreHTTPSErrors: false,           // Accept invalid certs
    connectTimeoutMs: 30000,            // CDP connection timeout
    userDataDir: "/path/to/profile",    // Chrome profile directory
    args: ["--no-sandbox"],             // Extra Chrome flags
  },

  // --- Browserbase Cloud Options (when env: "BROWSERBASE") ---
  apiKey: "...",                    // Browserbase API key
  projectId: "...",                 // Browserbase project ID
});

await stagehand.init();
```

### 2.3 Properties

| Property | Type | Description |
|----------|------|-------------|
| `stagehand.page` | Page | Active page (shortcut to context.activePage()) |
| `stagehand.context` | V3Context | Browser context manager |
| `stagehand.context.pages()` | Page[] | All open pages |
| `stagehand.context.activePage()` | Page | Currently active page |
| `stagehand.context.newPage()` | Promise\<Page\> | Create new tab |
| `stagehand.metrics` | Promise\<StagehandMetrics\> | Token usage stats |
| `stagehand.history` | Promise\<HistoryEntry[]\> | All operations recorded |

### 2.4 Method: `act(instruction, options?)`

Executes an atomic browser action. Three invocation patterns:

```typescript
// Pattern 1: Natural language instruction
const result = await stagehand.act("click the Submit button");

// Pattern 2: Pre-observed Action object (no LLM call, deterministic)
const actions = await stagehand.observe("find the submit button");
const result = await stagehand.act(actions[0]);

// Pattern 3: Instruction with options
const result = await stagehand.act("fill the email with %email%", {
  model: "openai/gpt-4.1-mini",
  // OR model: { modelName: "openai/gpt-4.1-mini", apiKey: "...", baseURL: "..." },
  timeout: 15000,
  variables: { email: "secret@example.com" },  // NOT sent to LLM
  page: specificPageObject,
});
```

**Variable substitution** (`%varName%` syntax): Values injected into the DOM action but never included in the LLM prompt. Use for passwords, tokens, PII.

**Return: `ActResult`**

```typescript
interface ActResult {
  success: boolean;
  message: string;
  actionDescription: string;
  actions: Array<{
    selector: string;       // XPath
    description: string;
    method: string;         // click | fill | type | press | scroll | select
    arguments: unknown[];
  }>;
}
```

**Supported methods**: click, fill, type, press, scroll, select.

**Errors thrown**: `StagehandElementNotFoundError`, `StagehandClickError`, `StagehandEvalError`, `StagehandDomProcessError`, `StagehandIframeError`, `ContentFrameNotFoundError`, `XPathResolutionError`, `MissingLLMConfigurationError`.

### 2.5 Method: `observe(instruction, options?)`

Discovers actionable elements on the page without executing them. Returns `Action[]` objects that can be passed directly to `act()`.

```typescript
const actions = await stagehand.observe("find all form input fields");
// actions: Action[]

interface Action {
  selector: string;      // XPath
  description: string;   // Human-readable
  method: string;        // click, fill, type, press, etc.
  arguments: unknown[];
}

interface ObserveOptions {
  model?: string | { modelName: string; apiKey?: string; baseURL?: string };
  timeout?: number;
  selector?: string;  // XPath to focus observation scope
  page?: Page;
}
```

**Observe-then-act pattern** (caching-friendly, reduces LLM calls):

```typescript
const fields = await stagehand.observe("find all input fields in the form");
for (const field of fields) {
  await stagehand.act(field); // Deterministic, no LLM call
}
```

**Features**: Iframe and shadow DOM traversal supported automatically. No additional configuration needed.

### 2.6 Method: `extract(instruction, schema?, options?)`

Extracts structured data from the current page.

```typescript
import { z } from "zod/v3";

// With Zod schema (typed output)
const data = await stagehand.extract(
  "extract all form fields with labels, types, and required status",
  z.object({
    fields: z.array(z.object({
      label: z.string(),
      type: z.string(),
      required: z.boolean(),
      selector: z.string(),
    })),
  }),
);
// data is fully typed

// Without schema (unstructured)
const { extraction } = await stagehand.extract("extract the page title");

// With XPath selector (reduces token usage)
const header = await stagehand.extract(
  "extract the job title",
  z.object({ title: z.string() }),
  { selector: "//header" },
);

// Target specific page
const data = await stagehand.extract("extract data", schema, { page: page2 });
```

**Options**: `model?`, `timeout?`, `selector?` (XPath), `page?`.

### 2.7 Method: `agent(config)`

Creates an autonomous multi-step agent.

```typescript
const agent = stagehand.agent({
  mode: "dom",                    // "dom" | "cua" | "hybrid"
  model: "anthropic/claude-sonnet-4-5-20250929",
  executionModel: "openai/gpt-4.1-mini",  // Cheaper model for tool execution
  systemPrompt: "...",
  tools: customTools,             // Vercel AI SDK tool() definitions
  integrations: [mcpUrl],         // MCP server URLs for external tool access
  stream: true,                   // Enable streaming (requires experimental: true)
});
```

### 2.8 Agent Modes

| Feature | DOM | CUA | Hybrid |
|---------|:---:|:---:|:------:|
| **Streaming** | Yes | No | Yes |
| **Callbacks** | Yes | No | Yes |
| **Abort signals** | Yes | No | Yes |
| **Structured output** | Yes | No | Yes |
| **Message continuation** | Yes | No | Yes |
| **Tool exclusion** | Yes | No | Yes |
| **Coordinate actions** | No | Yes | Yes |
| **Model requirement** | Any LLM | CUA provider | Grounding-capable |

**DOM mode tools**: `act`, `fillForm`, `ariaTree`, `extract`, `goto`, `scroll`, `keys`, `navback`, `screenshot`, `think`, `wait`, `search`

**Hybrid mode tools** (adds to DOM): `click`, `type`, `dragAndDrop`, `clickAndHold`, `fillFormVision`

**CUA compatible models**: `anthropic/claude-sonnet-4-20250514`, `google/gemini-2.5-computer-use-preview`, `openai/computer-use-preview`

**Hybrid compatible models**: `google/gemini-3-flash-preview`, `anthropic/claude-sonnet-4-20250514`, `anthropic/claude-haiku-4-5-20251001`

### 2.9 Agent `execute(options)`

```typescript
const result = await agent.execute({
  instruction: "Fill out this job application form",
  maxSteps: 30,                        // Default: 20
  signal: abortController.signal,      // AbortSignal for cancellation
  messages: previousResult.messages,   // Continue from prior run
  output: z.object({                   // Structured output schema
    submitted: z.boolean(),
    confirmationId: z.string().optional(),
  }),
  excludeTools: ["screenshot"],
  highlightCursor: true,               // Visual debugging (CUA/hybrid)
  callbacks: {
    prepareStep: async (context) => context,
    onStepFinish: async (event) => {
      console.log(event.finishReason, event.toolCalls);
    },
    // Streaming-only callbacks:
    onChunk: async (chunk) => {},
    onFinish: (event) => {},
    onError: ({ error }) => {},
    onAbort: (event) => {},
  },
});
```

**Return: `AgentResult`**

```typescript
interface AgentResult {
  success: boolean;
  message: string;
  actions: AgentAction[];
  completed: boolean;
  output?: Record<string, unknown>;  // If output schema provided
  messages?: ModelMessage[];          // For continuation
  usage: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
    inference_time_ms: number;
  };
}
```

### 2.10 Custom Tools

Use Vercel AI SDK `tool()` helper:

```typescript
import { tool } from "ai";
import { z } from "zod/v3";

const agent = stagehand.agent({
  mode: "dom",
  model: "anthropic/claude-sonnet-4-5-20250929",
  tools: {
    lookupQABank: tool({
      description: "Look up a pre-written answer from the Q&A bank",
      inputSchema: z.object({
        question: z.string().describe("The question to look up"),
      }),
      execute: async ({ question }) => {
        const answer = qaBank.get(question);
        return { found: !!answer, answer: answer ?? null };
      },
    }),
    checkBudget: tool({
      description: "Check remaining token budget",
      inputSchema: z.object({}),
      execute: async () => ({
        remainingCents: budget.limit - budget.spent,
        shouldContinue: budget.limit - budget.spent > 5,
      }),
    }),
  },
});
```

### 2.11 Page Object Methods

The page object (`stagehand.page`) exposes CDP-backed methods:

| Category | Methods |
|----------|---------|
| **Navigation** | `goto(url)`, `reload()`, `goBack()`, `goForward()` |
| **Interaction** | `click(selector)`, `hover(selector)`, `scroll({direction})`, `dragAndDrop(from, to)`, `type(selector, text)`, `locator(selector)` |
| **Evaluation** | `evaluate(fn)`, `addInitScript(fn)` |
| **State** | `screenshot()`, `setViewportSize({width, height})`, `waitForLoadState(state)`, `url()`, `title()` |
| **Events** | `on("console", handler)`, `once(event, handler)`, `off(event, handler)` |
| **Deep Locator** | `page.deepLocator(xpath)` -- targets elements across shadow DOM and iframes |

### 2.12 Caching Behavior

Stagehand v3 auto-caches discovered elements and actions:

- **Cache key**: Page URL + instruction text + DOM structure hash
- **First run**: LLM call -> finds XPath -> executes -> caches result
- **Subsequent runs**: Cache hit -> executes directly (no LLM call)
- **Invalidation**: Automatic when DOM structure changes after navigation
- **Persistence**: Set `cacheDir` in constructor for disk-based caching across runs

### 2.13 Streaming

```typescript
const stagehand = new Stagehand({ env: "LOCAL", experimental: true });
await stagehand.init();

const agent = stagehand.agent({
  model: "anthropic/claude-sonnet-4-5-20250929",
  stream: true,
});

const streamResult = await agent.execute({
  instruction: "Fill the form",
  maxSteps: 20,
});

// Consume text stream
for await (const delta of streamResult.textStream) {
  process.stdout.write(delta);
}

// Get final result
const finalResult = await streamResult.result;
```

### 2.14 `close()`

```typescript
await stagehand.close();
// OR force close (kills browser process)
await stagehand.close({ force: true });
```

---

## 3. Magnitude Complete API Reference

### 3.1 Installation

```bash
pnpm add magnitude-core
# For testing (dev only):
pnpm add -D magnitude-test
```

Magnitude uses Patchright (patched Playwright fork) under the hood. Patchright is installed automatically.

### 3.2 `startBrowserAgent(options?)`

```typescript
import { startBrowserAgent } from "magnitude-core";

const agent = await startBrowserAgent({
  // --- Initial Navigation ---
  url: "https://jobs.lever.co/company/apply",

  // --- Agent Configuration ---
  prompt: "You are filling out a job application form.",
  narrate: true,  // Console narration of agent thoughts/actions
  virtualScreenDimensions: { width: 1280, height: 720 },
  minScreenshots: 3,  // Screenshots retained in context for prompt caching

  // --- LLM Configuration (single provider) ---
  llm: {
    provider: "anthropic",
    options: {
      model: "claude-sonnet-4-20250514",
      apiKey: process.env.ANTHROPIC_API_KEY,
      temperature: 0.0,
    },
  },

  // --- LLM Configuration (multi-role array) ---
  llm: [
    {
      provider: "anthropic",
      options: { model: "claude-sonnet-4-20250514" },
      roles: ["act"],  // Visually-grounded model for browser interactions
    },
    {
      provider: "google-ai",
      options: { model: "gemini-2.5-flash" },
      roles: ["extract", "query"],  // Fast model for data extraction
    },
  ],

  // --- Browser Configuration ---
  browser: {
    // Connect to existing Chrome via CDP
    cdp: "ws://127.0.0.1:9222/devtools/browser/abc123",

    // OR launch options for new browser
    launchOptions: {
      headless: false,
      args: ["--disable-gpu", "--no-sandbox"],
    },
    contextOptions: {
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 ...",
    },
  },
});
```

### 3.3 LLM Roles

Magnitude separates LLM responsibilities into three configurable roles:

| Role | Purpose | Requirements | Recommended |
|------|---------|-------------|-------------|
| **act** | Browser interactions (click, type, navigate) | Visually grounded, strong reasoning | Claude Sonnet 4 |
| **extract** | Structured data extraction from pages | Fast, does not need visual grounding | Gemini 2.5 Flash |
| **query** | Answer questions about observed data | Moderate reasoning | Gemini 2.5 Flash |

**Compatible models for `act` role** (must be visually grounded):
- Claude Sonnet 4 (`claude-sonnet-4-20250514`)
- Qwen 2.5 VL 72B (via OpenRouter)

**Incompatible for `act` role** (not visually grounded):
- OpenAI GPT-4o/4.1 series
- Gemini models
- Llama models

### 3.4 Supported LLM Providers

| Provider ID | Required Options | Auth |
|-------------|-----------------|------|
| `anthropic` | model, apiKey? | `ANTHROPIC_API_KEY` env |
| `openai` | model, apiKey? | `OPENAI_API_KEY` env |
| `openai-generic` | model, baseUrl, apiKey? | Custom (OpenRouter, Ollama) |
| `google-ai` | model, apiKey? | `GOOGLE_API_KEY` env |
| `vertex-ai` | model, location, projectId? | gcloud auth |
| `aws-bedrock` | model | AWS env vars |
| `azure-openai` | resourceName, deploymentId, apiVersion, apiKey | Azure credentials |

**Default**: If no LLM configured and `ANTHROPIC_API_KEY` is set, uses Claude Sonnet 4 automatically.

### 3.5 Method: `agent.act(description, options?)`

```typescript
// Simple action
await agent.act("Click the 'Next' button");

// With data substitution
await agent.act("Fill in the first name field with {firstName}", {
  data: { firstName: "Jane" },
});

// With additional LLM instructions
await agent.act("Upload the resume file", {
  prompt: "The upload button may be a drag-and-drop zone.",
});

// Multi-step action
await agent.act("Select 'United States' from the country dropdown, then select 'California' from the state dropdown");
```

**Parameters**:
- `description` (string, required): Natural language action with optional `{placeholder}` syntax
- `options.data` (string | Record\<string, string\>): Values for placeholders
- `options.prompt` (string): Additional LLM context for this action

### 3.6 Method: `agent.extract(instructions, schema)`

```typescript
import { z } from "zod";

const fields = await agent.extract(
  "List all visible form fields with their current values",
  z.array(z.object({
    label: z.string().describe("The visible label"),
    type: z.enum(["text", "select", "checkbox", "radio", "file", "textarea"]),
    required: z.boolean().describe("Whether marked as required"),
    currentValue: z.string().describe("Current value or empty string"),
  })),
);
// fields.data -> typed array
```

**Parameters**:
- `instructions` (string, required): What to extract
- `schema` (ZodSchema, required): Output structure definition

**Tip**: Adding `.describe()` to schema fields significantly improves extraction accuracy.

### 3.7 Method: `agent.nav(url)`

```typescript
await agent.nav("https://jobs.lever.co/company/apply/12345");
```

### 3.8 Method: `agent.stop()`

```typescript
await agent.stop(); // Closes browser, releases all resources
```

### 3.9 Properties

| Property | Type | Description |
|----------|------|-------------|
| `agent.page` | Playwright Page | Underlying Patchright/Playwright page |
| `agent.context` | BrowserContext | Underlying Patchright/Playwright context |

These allow direct Playwright operations when the agent API is insufficient:

```typescript
// Direct Playwright for file uploads
const [fileChooser] = await Promise.all([
  agent.page.waitForEvent("filechooser"),
  agent.act("Click the upload button"),
]);
await fileChooser.setFiles("/path/to/resume.pdf");

// Direct evaluation
const title = await agent.page.evaluate(() => document.title);

// Cookies
const cookies = await agent.context.cookies();
```

### 3.10 Magnitude Test Runner (`magnitude-test`)

For visual regression and end-to-end testing:

```typescript
import { test } from "magnitude-test";

test("Greenhouse form fills correctly", async (agent) => {
  await agent.nav("https://boards.greenhouse.io/test/jobs/12345");
  await agent.act("Fill first name with 'Jane'");
  await agent.act("Fill last name with 'Doe'");

  // Visual assertion
  await agent.check("The first name field shows 'Jane'");
  await agent.check("The last name field shows 'Doe'");
});
```

### 3.11 Patchright Anti-Detection Features

Magnitude uses Patchright (not stock Playwright), which patches:

| Detection Vector | Stock Playwright | Patchright |
|-----------------|-----------------|------------|
| `Runtime.enable` CDP command | Sent on page load | **Eliminated** (isolated ExecutionContexts) |
| `navigator.webdriver` | `true` | **`false`** |
| `--enable-automation` flag | Present | **Removed** |
| `Console.enable` CDP | Active | **Disabled** (trade-off: no console.log capture) |
| Closed Shadow DOM | Cannot pierce | **Can interact** |

**Passes**: Cloudflare Turnstile, DataDome, Kasada, Akamai, PerimeterX, Fingerprint.com, Shape Security.

**Limitation**: `console.log` capture disabled. Use `page.evaluate()` return values for debugging.

---

## 4. CDP Connection Patterns

### 4.1 Connection Topology

```
AdsPower API -> Start Browser -> Returns cdpUrl (ws://127.0.0.1:<port>/...)
                                        |
                            Only ONE active client at a time
                                        |
                        +---------------+---------------+
                        |                               |
                   Stagehand                       Magnitude
                   (CDP direct)                    (Patchright CDP)
```

### 4.2 Stagehand CDP Connection

```typescript
const stagehand = new Stagehand({
  env: "LOCAL",
  localBrowserLaunchOptions: {
    cdpUrl: session.cdpUrl,  // ws://127.0.0.1:port/devtools/browser/id
    headless: false,
    connectTimeoutMs: 30_000,
  },
});
await stagehand.init();
```

Stagehand v3 connects directly to the CDP WebSocket. It can attach to existing pages and contexts. Disconnection (via `stagehand.close()`) drops the WebSocket only -- does NOT kill the browser process.

### 4.3 Magnitude CDP Connection

```typescript
const agent = await startBrowserAgent({
  browser: {
    cdp: session.cdpUrl,  // ws://127.0.0.1:port/devtools/browser/id
  },
  llm: { provider: "anthropic", options: { model: "claude-sonnet-4-20250514" } },
});
```

Magnitude creates a new browser context on the connected browser. Disconnection (via `agent.stop()`) drops the context -- does NOT kill the browser process.

### 4.4 CDP Connection Differences

| Aspect | Stagehand | Magnitude |
|--------|-----------|-----------|
| Connection method | `localBrowserLaunchOptions.cdpUrl` | `browser.cdp` |
| Browser context | Attaches to existing contexts | Creates new context |
| Page reuse | Can connect to existing pages | Navigates from scratch in new context |
| Anti-detect preservation | AdsPower fingerprint preserved | AdsPower fingerprint preserved |
| Session persistence | Can resume mid-flow | Must re-navigate from URL |
| Underlying protocol | CDP-direct (no Playwright) | Patchright (patched Playwright) |

### 4.5 CDP Mutex Pattern

Only one automation client can be connected at a time. Use `async-mutex`:

```typescript
import { Mutex, withTimeout } from "async-mutex";

const cdpMutex = withTimeout(
  new Mutex(),
  30_000,
  new Error("CDP mutex timeout: another operation held the lock for >30s"),
);

// All connect/disconnect operations go through the mutex
await cdpMutex.runExclusive(async () => {
  await disconnectCurrent();
  await connectNew();
});
```

---

## 5. Engine Interop & Switching Protocol

### 5.1 What Survives an Engine Switch

The AdsPower browser process continues running. Everything in the browser survives:

| State | Survives | Reason |
|-------|:--------:|--------|
| Cookies | Yes | Browser process |
| localStorage / sessionStorage | Yes | Browser process |
| IndexedDB | Yes | Browser process |
| Current URL | Yes | Page stays loaded |
| DOM state | Yes | Page still rendered |
| Form field values | Yes | DOM nodes persist |
| Scroll position | Yes | Browser maintains |
| Page JS state | Yes | JS heap in browser |
| Auth sessions | Yes | Cookie/token-based |

### 5.2 What Does NOT Survive

| State | Survives | Mitigation |
|-------|:--------:|------------|
| Engine element cache | No | Re-observe after switch |
| Stagehand action history | No | Store in workflow context |
| Magnitude agent memory | No | Re-initialize with instructions |
| Playwright page event listeners | No | Re-attach post-connect |
| Network interceptors | No | Re-register if needed |
| Engine retry counters | No | Track in SandboxController |

### 5.3 Switch Protocol (8 Steps)

```
1. Detect Failure   -> Record failure, increment counter
2. Decide to Switch -> Check threshold exceeded or forced switch
3. Capture State    -> Get URL, title, scroll via CDP /json/list + page.evaluate
4. Disconnect       -> Close CDP client only, NOT the browser
5. Verify Browser   -> HTTP GET /json/version must return 200
6. Connect New      -> Stagehand.init() or startBrowserAgent()
7. Verify Engine    -> page.url() returns valid URL
8. Resume State     -> Navigate to saved URL if different, restore scroll
```

### 5.4 Failure Types That Trigger Switch

```typescript
type FailureType =
  | "selector_not_found"    // DOM element doesn't exist
  | "selector_ambiguous"    // Multiple matches, wrong one clicked
  | "action_no_effect"      // Click/type had no visible result
  | "shadow_dom_blocked"    // Cannot pierce shadow root
  | "iframe_unreachable"    // Nested iframe context failed
  | "canvas_element"        // Target inside <canvas>
  | "dynamic_rendering"     // Client-side rendering defeats observe()
  | "timeout"               // Operation exceeded time limit
  | "anti_bot_detected"     // Challenge page appeared
  | "unknown";
```

### 5.5 Fallback Cascade

```
Stagehand DOM   -> retry 2x    -> 15s timeout per attempt
    |
Stagehand CUA   -> retry 1x    -> 30s timeout per attempt
    |
Magnitude       -> retry 2x    -> 30s timeout per attempt
    |
Human (VNC)     -> retry 1x    -> 120s timeout
```

Total cascade timeout: 5 minutes.

### 5.6 Platform-to-Engine Mapping

| Platform | Primary | Fallback Order |
|----------|---------|---------------|
| LinkedIn | Stagehand DOM | CUA -> Magnitude -> Human |
| Greenhouse | Stagehand DOM | CUA -> Magnitude -> Human |
| Lever | Stagehand DOM | CUA -> Magnitude -> Human |
| Workday | Magnitude | Stagehand CUA -> Human |
| Unknown | Stagehand DOM | CUA -> Magnitude -> Human |

---

## 6. Error Handling Reference

### 6.1 Stagehand Error Types

| Error Class | When | Recovery |
|-------------|------|----------|
| `StagehandElementNotFoundError` | `act()` cannot find target element | Re-observe, use broader instruction, fallback to vision |
| `StagehandClickError` | Click fails (element obscured, detached) | Wait for DOM settle, retry, scroll into view |
| `StagehandEvalError` | JavaScript evaluation fails in page | Retry, check page loaded |
| `StagehandDomProcessError` | DOM parsing/processing fails | Wait for settle, retry |
| `StagehandIframeError` | Cannot access iframe content | Check same-origin, try deepLocator |
| `ContentFrameNotFoundError` | Target frame not found | Wait for frame load |
| `XPathResolutionError` | XPath selector invalid/stale | Re-observe to get fresh selector |
| `MissingLLMConfigurationError` | No model configured for operation | Provide model in constructor or options |
| `AgentAbortError` | Abort signal triggered | Catch, save progress, clean up |

### 6.2 Stagehand CDP Recovery

```typescript
async function withCdpRecovery<T>(
  createStagehand: () => Promise<Stagehand>,
  operation: (stagehand: Stagehand) => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let stagehand = await createStagehand();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(stagehand);
    } catch (error) {
      const isCdpError =
        error.message.includes("WebSocket") ||
        error.message.includes("Target closed") ||
        error.message.includes("Protocol error") ||
        error.message.includes("Connection refused");

      if (!isCdpError || attempt === maxRetries) throw error;

      await stagehand.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      stagehand = await createStagehand();
    }
  }
}
```

### 6.3 Magnitude Error Patterns

| Error Pattern | When | Recovery |
|---------------|------|----------|
| Coordinate miss | LLM identifies wrong pixel position | Wait for page stabilize, retry with more specific prompt |
| Rate limit (429) | LLM API rate limited | Exponential backoff: 2^attempt * 1000ms |
| Context overflow | Too many screenshots in context | Reduce minScreenshots, clear context |
| Page navigation failure | URL unreachable | Retry once, check URL validity |
| Patchright compatibility | Version mismatch with Chrome | Pin patchright version matching AdsPower Chrome |

```typescript
async function executeWithRetry(
  agent: Awaited<ReturnType<typeof startBrowserAgent>>,
  instruction: string,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await agent.act(instruction);
      return;
    } catch (error) {
      const err = error as Error;

      if (err.message.includes("coordinate") || err.message.includes("target")) {
        await agent.page.waitForTimeout(1000); // Page stabilize
        continue;
      }
      if (err.message.includes("rate_limit") || err.message.includes("429")) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      if (err.message.includes("context_length") || err.message.includes("token")) {
        throw new Error(`Context overflow on attempt ${attempt}: ${err.message}`);
      }
      throw error; // Unknown error, don't retry
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${instruction}`);
}
```

### 6.4 LLM Fallback Pattern (Stagehand)

```typescript
async function actWithFallback(
  stagehand: Stagehand,
  instruction: string,
): Promise<ActResult> {
  try {
    return await stagehand.act(instruction, { timeout: 15_000 });
  } catch {
    return await stagehand.act(instruction, {
      model: { modelName: "openai/gpt-4.1-mini" },
      timeout: 10_000,
    });
  }
}
```

---

## 7. Performance & Cost Data

### 7.1 Latency per Operation

| Operation | Stagehand (cached) | Stagehand (uncached) | Magnitude |
|-----------|:------------------:|:--------------------:|:---------:|
| `act()` simple click | ~50ms | ~1-3s | ~2-5s |
| `act()` form fill | ~100ms | ~2-4s | ~3-6s |
| `extract()` single field | N/A | ~1-2s | ~2-4s |
| `extract()` full form | N/A | ~3-5s | ~4-8s |
| `observe()` | N/A | ~1-3s | N/A |
| Agent step (1 tool call) | ~200ms | ~2-5s | ~3-8s |
| Full form fill (10 fields) | ~2s (cached) | ~20-40s | ~30-60s |

### 7.2 Token Cost per Operation

| Operation | Stagehand (DOM) | Magnitude (Vision) |
|-----------|:---------------:|:------------------:|
| Single `act()` | ~500-1K input tokens | ~2-5K input tokens (image) |
| Single `extract()` | ~1-3K input tokens | ~2-5K input tokens (image) |
| Agent step | ~1-2K tokens | ~3-8K tokens |
| Full application (10 fields) | ~15-30K tokens | ~40-80K tokens |

### 7.3 Estimated Cost per Application

| Engine | Model | Estimated Cost |
|--------|-------|:-------------:|
| Stagehand DOM (cached) | GPT-4.1 mini | $0.01-0.03 |
| Stagehand DOM (uncached) | Claude Sonnet 4.5 | $0.03-0.08 |
| Stagehand Agent | Claude Sonnet 4.5 + GPT-4.1 mini | $0.05-0.15 |
| Magnitude (full) | Claude Sonnet 4 | $0.08-0.15 |
| Magnitude (cached plan) | Claude Sonnet 4 (executor only) | $0.02-0.04 |
| Magnitude (multi-role) | Claude Sonnet 4 + Gemini Flash | $0.03-0.08 |

### 7.4 Caching Impact

| Scenario | Without Cache | With Cache | Savings |
|----------|:------------:|:----------:|:-------:|
| Fill 10 fields (same form) | 10 LLM calls | 1 LLM call | 90% tokens |
| Multi-page form (5 pages) | 50 LLM calls | ~10 calls | 80% tokens |
| Retry after error | Full re-run | Cached | 95% tokens |

---

## 8. Known Issues & Workarounds

### 8.1 Stagehand Known Issues

| Issue | Description | Workaround |
|-------|-------------|------------|
| **#1390 - Unhandled rejection crash** | `process.once('unhandledRejection')` causes server crash on second CDP session error. Download targets that open new tabs trigger -32001 "Session not found" errors. | Change to `process.on()` or wrap in try/catch. Monitor for fix in v3.1+. |
| **#1392 - Playwright page resolution** | When passing a manually-connected Playwright page via `connectOverCDP`, `StagehandInitError: Failed to resolve V3 Page` occurs. | Use `cdpUrl` in constructor instead of passing external page objects. |
| **#1381 - Cloudflare Workers incompatible** | Internal CDP uses Node.js `ws` package, incompatible with Workers runtime. | Run in Node.js environments only (EC2, Fly.io). |
| **#435 - WebSocket connection closed** | "WebSocket was closed before connection established" with code=1006 when connecting to Browserbase. | Add retry logic with delay. Check CDP endpoint is ready before connecting. |
| **CDP disconnect on tab close** | If a tab closes during an act() call, CDP session ID becomes invalid. | Wrap operations in CDP recovery handler (see Section 6.2). |
| **Playwright version conflicts** | Both Stagehand v3 and Magnitude use different browser automation libraries. In v3, Stagehand no longer depends on Playwright directly, reducing conflict risk. | v3 eliminates this concern. If using older versions alongside Magnitude, ensure no peerDep conflicts. |

### 8.2 Magnitude Known Issues

| Issue | Description | Workaround |
|-------|-------------|------------|
| **Rate limiting on parallel** | Running multiple agents in parallel triggers "Too many requests" from LLM providers. | Run tasks sequentially with delays between them. |
| **Browser crashes on parallel** | Multiple real Chrome instances crash under load. | Use sequential execution or limit concurrent agents. |
| **Console.log disabled** | Patchright disables `Console.enable` CDP command for anti-detection. | Use `page.evaluate()` return values for debugging. No `page.on('console')`. |
| **Firefox/WebKit unsupported** | Patchright is Chromium-only. | Always use Chromium (via AdsPower, which is Chromium-only). |
| **Coordinate accuracy on small targets** | Elements < 15px may be hard for LLM to target precisely. | Increase `virtualScreenDimensions` resolution. Add `prompt` with specific guidance. |
| **Dynamic layout shifts** | If page layout changes between screenshot and action, coordinates miss. | Set `minScreenshots` >= 3 for context. Add explicit waits before actions. |
| **New context on CDP connect** | Magnitude creates a new browser context when connecting via CDP, not attaching to existing pages. | Must re-navigate to target URL after engine switch. Form data in DOM survives (same browser process). |

---

## 9. Best Practices

### 9.1 Stagehand Best Practices

1. **Use observe-then-act for batch operations**: Discover fields once, execute deterministically without LLM calls.

2. **Enable caching with `cacheDir`**: Share cache across Hatchet task runs for the same application flow to save 80-90% on tokens.

3. **Use `%variables%` for sensitive data**: Passwords, tokens, and PII are never sent to the LLM.

4. **Set `domSettleTimeout`**: Default 30s may be too long. For fast sites, 3-5s is sufficient. For slow SPAs, 10s.

5. **Prefer DOM mode agent**: Start with DOM mode (cheapest, fastest). Only escalate to CUA/hybrid when DOM fails.

6. **Scope extractions with `selector`**: Use XPath selectors to reduce DOM sent to LLM. `{ selector: "//form" }` vs whole page.

7. **Use `executionModel`**: Set a cheaper model (GPT-4.1 mini) for tool execution while keeping the expensive model (Claude Sonnet 4.5) for agent planning.

8. **Handle AbortController for budget**: Wire budget checks to `controller.abort()` to prevent runaway token spend.

9. **Multi-page support**: Use `stagehand.context.pages()` to handle popups and new tabs. Target specific pages with `{ page }` option.

10. **Use `deepLocator(xpath)` for shadow DOM**: v3's deepLocator targets elements across shadow DOM boundaries and iframes natively.

### 9.2 Magnitude Best Practices

1. **Use role-based LLM configuration**: Put Claude Sonnet 4 on `act` role only. Use Gemini Flash for `extract` and `query` to cut costs 60-70%.

2. **Add `.describe()` to Zod schema fields**: Significantly improves extraction accuracy.

3. **Set `virtualScreenDimensions` to match actual viewport**: Prevents coordinate scaling issues.

4. **Use `prompt` option for difficult actions**: Provide additional context when the default instruction is ambiguous.

5. **Access `agent.page` for file uploads**: Use direct Playwright API for `waitForEvent("filechooser")` + `setFiles()`.

6. **Plan saving for known platforms**: Cache plans per platform + form type for 60-75% cost reduction on repeat applications.

7. **Keep `minScreenshots` >= 3**: Ensures prompt caching efficiency and provides context for multi-step reasoning.

8. **Sequential execution for reliability**: Avoid parallel agents to prevent rate limits and browser crashes.

### 9.3 Interop Best Practices

1. **Always use CDP mutex**: Never have two engines connected simultaneously. Use `async-mutex` with timeout.

2. **Capture state before switching**: Save URL, scroll position, and form progress before disconnecting an engine.

3. **Re-navigate after Magnitude switch**: Magnitude creates a new context. Re-navigate to the saved URL and verify page matches.

4. **Store progress externally**: Keep form fill progress in Hatchet workflow context, not in engine memory.

5. **Verify browser alive before new connection**: HTTP GET `cdpUrl/json/version` must return 200 before connecting.

6. **Log all engine switches**: Track from/to/reason/duration for analytics and adaptive engine selection.

7. **Total cascade timeout of 5 minutes**: Don't let the fallback cascade run indefinitely. Budget your time across levels.

---

## References

- [Stagehand Documentation](https://docs.stagehand.dev/v3/)
- [Stagehand GitHub](https://github.com/browserbase/stagehand)
- [Stagehand npm](https://www.npmjs.com/package/@browserbasehq/stagehand) (v3.0.8)
- [Stagehand Claude.md](https://github.com/browserbase/stagehand/blob/main/claude.md)
- [Magnitude Documentation](https://docs.magnitude.run/)
- [Magnitude GitHub](https://github.com/magnitudedev/magnitude)
- [Magnitude npm](https://www.npmjs.com/package/magnitude-core) (v0.3.x)
- [Patchright GitHub](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- [Valet Automation Types](../../packages/shared/src/types/automation.ts)
- [Valet Stagehand Integration](../integration/02-stagehand-integration.md)
- [Valet Magnitude Integration](../integration/03-magnitude-integration.md)
- [Valet Engine Switching](../integration/04-engine-switching.md)
