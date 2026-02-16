# Developer Guide: Extending Magnitude Browser Agent

**For:** Developers testing and building browser automation capabilities
**Scope:** Pure AI mode (Magnitude BrowserAgent), custom connectors, custom task handlers

---

## Quick Start

### Prerequisites

```bash
# 1. Install dependencies
cd packages/ghosthands
bun install

# 2. Set up environment
cp .env.example .env
# Edit .env with your keys (at minimum):
#   DATABASE_URL=postgresql://...
#   SILICONFLOW_API_KEY=sk-...
#   GH_MODEL=qwen-72b
```

### Run a test in 60 seconds

```bash
# Terminal 1: Start the worker
bun run worker -- --worker-id=dev

# Terminal 2: Submit a test job
bun run submit-test-job -- --worker-id=dev

# Or manage jobs from same terminal:
bun run job list
bun run job status <id>
bun run job logs <id>
```

### Single-terminal test

```bash
./test-worker.sh --worker-id=dev --keep
# After test completes, manage jobs with:
bun run job list
bun run job cancel --all
```

---

## How Magnitude Works

Magnitude is a **vision-based** browser automation agent. It:

1. Takes a **screenshot** of the current page
2. Sends it to a **vision-capable LLM** (Qwen 72B, GPT-4o, Claude, etc.)
3. The LLM decides what action to take (click, type, scroll, etc.)
4. Magnitude executes the action via Playwright (patchright)
5. Repeat until the task is done

**Key insight:** Magnitude uses **screenshots**, not DOM parsing. This means it works on any page regardless of framework, but requires a vision model (not text-only like DeepSeek).

### The Agent Loop

```
┌─── Agent Loop ───────────────────────────────┐
│                                               │
│  Screenshot → LLM "What should I do?"         │
│      ↓                                        │
│  LLM responds with Intent:                    │
│    { variant: 'click', target: 'Apply Now' }  │
│    { variant: 'type', target: 'First Name',   │
│      content: 'John' }                        │
│      ↓                                        │
│  Magnitude converts intent → web action       │
│  (finds element, clicks/types)                │
│      ↓                                        │
│  New screenshot → repeat                      │
│                                               │
│  Events emitted at each step:                 │
│    'thought'        → LLM reasoning           │
│    'actionStarted'  → about to act            │
│    'actionDone'     → action completed         │
│    'tokensUsed'     → cost tracking            │
│                                               │
└───────────────────────────────────────────────┘
```

---

## Architecture: How GhostHands Wraps Magnitude

```
┌─────────────────────────────────────────────────────┐
│                   JobExecutor                        │
│  Picks up jobs from queue, manages lifecycle         │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │              TaskHandler                     │    │
│  │  Per-job-type logic (apply, scrape, custom)  │    │
│  │                                              │    │
│  │  ┌───────────────────────────────────────┐  │    │
│  │  │      BrowserAutomationAdapter         │  │    │
│  │  │  (MagnitudeAdapter wraps BrowserAgent)│  │    │
│  │  │                                       │  │    │
│  │  │  .act(instruction)  → agent.act()     │  │    │
│  │  │  .extract(query)    → agent.extract() │  │    │
│  │  │  .page              → Playwright Page  │  │    │
│  │  │  .screenshot()      → page screenshot │  │    │
│  │  └───────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

**The adapter never modifies Magnitude.** It wraps `BrowserAgent` and exposes a clean interface. You extend the system at three levels:

| Level | What | Example |
|-------|------|---------|
| **Connector** | Extend the agent with new actions/instructions | Platform-specific form helpers |
| **TaskHandler** | Define how a job type is processed | New `job_type: "linkedin_apply"` |
| **Adapter** | Swap the browser engine entirely | Stagehand instead of Magnitude |

---

## Magnitude API Reference

### `startBrowserAgent(options)`

Creates and starts a BrowserAgent with a browser instance.

```typescript
import { startBrowserAgent } from 'magnitude-core';

const agent = await startBrowserAgent({
  // Target URL
  url: 'https://example.com',

  // LLM configuration (single or multi-model)
  llm: {
    provider: 'openai-generic',
    options: {
      model: 'Qwen/Qwen2.5-VL-72B-Instruct',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: process.env.SILICONFLOW_API_KEY,
    },
  },

  // Custom connectors (optional)
  connectors: [new MyConnector()],

  // System prompt (optional)
  prompt: 'You are helping fill out a job application form.',

  // Browser options (optional)
  browser: {
    // Default: launches new headed Chromium via patchright
    // headless: true,  // run without UI
    // cdp: 'ws://...',  // connect to remote browser
  },
});
```

### `BrowserAgent` (extends `Agent`)

```typescript
// Execute a natural language task
await agent.act('Click the Apply button');
await agent.act('Fill in the first name field with "John"');

// Execute with additional context
await agent.act('Fill out the application form', {
  prompt: 'Use this data: first_name=John, last_name=Doe, email=john@example.com',
  data: { first_name: 'John' },
});

// Execute multiple steps
await agent.act([
  'Click the Apply button',
  'Fill in the first name with "John"',
  'Click Submit',
]);

// Extract structured data from the page
const result = await agent.extract('What is the confirmation number?', z.object({
  confirmation_id: z.string(),
  message: z.string(),
}));

// Direct page access (Playwright)
const currentUrl = agent.page.url();
await agent.page.goto('https://other-url.com');
const screenshot = await agent.page.screenshot();

// Pause/resume (useful for debugging)
agent.pause();   // agent stops at next step
agent.resume();  // agent continues

// Stop and clean up
await agent.stop();
```

### `Agent` Events

```typescript
agent.events.on('thought', (reasoning: string) => {
  console.log(`Agent thinking: ${reasoning}`);
});

agent.events.on('actionStarted', (action: Action) => {
  console.log(`Doing: ${action.variant}`);  // 'click', 'type', 'scroll'
});

agent.events.on('actionDone', (action: Action) => {
  console.log(`Done: ${action.variant}`);
});

agent.events.on('tokensUsed', (usage: ModelUsage) => {
  console.log(`Tokens: ${usage.inputTokens}in / ${usage.outputTokens}out`);
  console.log(`Cost: $${(usage.inputCost || 0) + (usage.outputCost || 0)}`);
});

agent.events.on('actStarted', (task: string) => {
  console.log(`Starting task: ${task}`);
});

agent.events.on('actDone', (task: string) => {
  console.log(`Finished task: ${task}`);
});
```

### `AgentConnector` Interface

Connectors extend the agent's capabilities without modifying its core loop.

```typescript
import { AgentConnector, ActionDefinition, createAction } from 'magnitude-core';
import { z } from 'zod';

export class MyConnector implements AgentConnector {
  id = 'my-platform';

  // Called when agent starts
  async onStart(): Promise<void> {
    console.log('Connector initialized');
  }

  // Called when agent stops
  async onStop(): Promise<void> {
    console.log('Connector cleaned up');
  }

  // Define custom actions the agent can use
  getActionSpace(): ActionDefinition<any>[] {
    return [
      createAction({
        name: 'my-platform:special-action',
        description: 'Do something platform-specific',
        schema: z.object({
          target: z.string(),
          value: z.string().optional(),
        }),
        resolver: async ({ input, agent }) => {
          // Access the browser page
          const page = (agent as any).page;
          await page.click(input.target);
          if (input.value) {
            await page.fill(input.target, input.value);
          }
        },
        render: (action) => `Special action on ${action.target}`,
      }),
    ];
  }

  // Inject instructions into the agent's system prompt
  async getInstructions(): Promise<string> {
    return `
You have access to my-platform:special-action for interacting with MyPlatform.
Use it when you encounter MyPlatform-specific UI elements.
    `.trim();
  }
}
```

### `ActionDefinition` — Creating Custom Actions

```typescript
import { createAction } from 'magnitude-core';
import { z } from 'zod';

const selectDropdownAction = createAction({
  // Action name — convention: "namespace:verb"
  name: 'workday:select-dropdown',

  // Description shown to the LLM
  description: 'Select a value from a Workday custom dropdown component',

  // Input schema (Zod)
  schema: z.object({
    dropdownLabel: z.string().describe('The label text of the dropdown'),
    value: z.string().describe('The value to select'),
  }),

  // Execution logic
  resolver: async ({ input, agent }) => {
    const page = (agent as any).page;

    // Workday dropdowns need special handling
    await page.click(`[data-automation-id="${input.dropdownLabel}"]`);
    await page.waitForSelector('[data-automation-id="selectWidget"]');
    await page.click(`text="${input.value}"`);
  },

  // How to display this action in logs
  render: (action) => `Select "${action.value}" from "${action.dropdownLabel}" dropdown`,
});
```

### `LLMClient` — Supported Providers

```typescript
// OpenAI-compatible (SiliconFlow, DeepSeek, Moonshot, etc.)
const llm = {
  provider: 'openai-generic',
  options: {
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-...',
    temperature: 0.1,
    headers: { 'X-Custom': 'value' },  // optional
  },
};

// Anthropic
const llm = {
  provider: 'anthropic',
  options: { model: 'claude-sonnet-4-5-20250929', apiKey: 'sk-ant-...' },
};

// OpenAI native
const llm = {
  provider: 'openai',
  options: { model: 'gpt-4o', apiKey: 'sk-...' },
};

// Google AI
const llm = {
  provider: 'google-ai',
  options: { model: 'gemini-2.5-flash', apiKey: '...' },
};

// Multi-model (different models for different tasks)
const llms = [
  {
    provider: 'openai-generic',
    options: { model: 'Qwen/Qwen2.5-VL-72B-Instruct', baseUrl: '...', apiKey: '...' },
    roles: ['act'],      // heavy reasoning
  },
  {
    provider: 'openai-generic',
    options: { model: 'Qwen/Qwen2.5-VL-7B-Instruct', baseUrl: '...', apiKey: '...' },
    roles: ['extract', 'query'],  // cheap extraction
  },
];
```

---

## Available Models

GhostHands ships with a model config at `src/config/models.config.json`. Use the `GH_MODEL` env var or `--model` flag to select:

| Alias | Provider | Vision | Cost (in/out per M) | Notes |
|-------|----------|--------|---------------------|-------|
| `qwen-7b` | SiliconFlow | Yes | $0.05 / $0.15 | Cheapest vision model |
| `qwen-32b` | SiliconFlow | Yes | $0.26 / $0.78 | |
| `qwen-72b` | SiliconFlow | Yes | $0.25 / $0.75 | **Default** — best value |
| `qwen3-8b` | SiliconFlow | Yes | $0.07 / $0.27 | Next-gen, lightweight |
| `qwen3-32b` | SiliconFlow | Yes | $0.14 / $0.55 | |
| `qwen3-235b` | SiliconFlow | Yes | $0.34 / $1.37 | Most capable, MoE |
| `gpt-4o` | OpenAI | Yes | $2.50 / $10.00 | High quality, expensive |
| `gpt-4o-mini` | OpenAI | Yes | $0.15 / $0.60 | |
| `claude-sonnet` | Anthropic | Yes | $3.00 / $15.00 | Premium tier |
| `claude-haiku` | Anthropic | Yes | $0.80 / $4.00 | |
| `glm-5` | Zhipu | Yes | $0.50 / $0.50 | |
| `deepseek-chat` | DeepSeek | **No** | $0.27 / $1.10 | No vision — won't work |

**Presets:** `speed` (qwen-7b), `balanced` (qwen-72b), `quality` (qwen3-235b), `premium` (gpt-4o)

```bash
# Select model
GH_MODEL=qwen-72b bun run worker
bun run worker -- --model=qwen3-235b
```

---

## Developer Workflows

### 1. Testing a new ATS platform

Goal: Validate that Magnitude can handle a specific ATS (e.g., Lever, iCIMS).

```bash
# 1. Start worker
bun run worker -- --worker-id=dev

# 2. Submit a custom job (direct DB, no API needed)
bun -e "
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(\`
  INSERT INTO gh_automation_jobs (
    user_id, job_type, target_url, task_description, input_data, timeout_seconds, target_worker_id
  ) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'custom',
    'https://jobs.lever.co/example/apply',
    'Navigate to the application form. Identify all form fields. Fill in the first name with Test and last name with User. Do NOT submit.',
    '{\"user_data\": {\"first_name\": \"Test\", \"last_name\": \"User\", \"email\": \"test@example.com\"}}',
    300,
    'dev'
  )
  RETURNING id
\`);
await c.end();
"

# 3. Watch the agent work (visible browser window on your machine)
bun run job list
bun run job logs <id>
```

### 2. Writing a custom connector

Goal: Add platform-specific helpers for a complex ATS.

```typescript
// src/connectors/workdayConnector.ts
import { AgentConnector, ActionDefinition, createAction } from 'magnitude-core';
import { z } from 'zod';

export class WorkdayConnector implements AgentConnector {
  id = 'workday';

  getActionSpace(): ActionDefinition<any>[] {
    return [
      createAction({
        name: 'workday:fill-section',
        description: 'Fill a Workday form section. Workday uses custom components that require special handling.',
        schema: z.object({
          section: z.string().describe('Section name like "My Information", "My Experience"'),
          data: z.record(z.string()).describe('Key-value pairs to fill'),
        }),
        resolver: async ({ input, agent }) => {
          const page = (agent as any).page;

          // Workday sections are collapsible — expand first
          const sectionHeader = await page.$(`text="${input.section}"`);
          if (sectionHeader) {
            const isExpanded = await sectionHeader.getAttribute('aria-expanded');
            if (isExpanded === 'false') {
              await sectionHeader.click();
              await page.waitForTimeout(500);
            }
          }

          // Fill fields within section
          for (const [key, value] of Object.entries(input.data)) {
            const field = await page.$(`[data-automation-id="${key}"]`);
            if (field) {
              await field.fill(value);
            }
          }
        },
        render: (a) => `Fill Workday section "${a.section}" with ${Object.keys(a.data).length} fields`,
      }),
    ];
  }

  async getInstructions(): Promise<string> {
    return `
You are working with a Workday application portal.
Workday has custom dropdown components — use workday:fill-section for form sections.
Workday forms are multi-page — look for "Next" or "Continue" buttons between sections.
    `.trim();
  }
}
```

**Use it in a test:**

```typescript
import { startBrowserAgent } from 'magnitude-core';
import { WorkdayConnector } from './connectors/workdayConnector';
import { loadModelConfig } from './config/models';

const llm = loadModelConfig();

const agent = await startBrowserAgent({
  url: 'https://company.myworkdayjobs.com/en-US/careers/apply',
  llm: llm.llmClient as any,
  connectors: [new WorkdayConnector()],
  prompt: 'Apply to this Workday job posting. Fill all required fields.',
});

await agent.act('Fill out the application form', {
  prompt: 'first_name=John, last_name=Doe, email=john@doe.com',
});

await agent.stop();
```

### 3. Writing a custom TaskHandler

Goal: Add a new job type that the worker processes.

```typescript
// src/workers/taskHandlers/linkedinHandler.ts
import { z } from 'zod';
import type { TaskHandler, TaskContext, TaskResult, ValidationResult } from './types.js';

export class LinkedInHandler implements TaskHandler {
  readonly type = 'linkedin_apply';
  readonly description = 'Apply to a job via LinkedIn Easy Apply';

  validate(inputData: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!inputData.user_data?.linkedin_email) {
      errors.push('user_data.linkedin_email is required for LinkedIn');
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(ctx: TaskContext): Promise<TaskResult> {
    const { job, adapter, progress } = ctx;

    // Step 1: Navigate and act
    const result = await adapter.act(
      'Apply to this LinkedIn job using Easy Apply. Fill all required fields.',
      {
        prompt: ctx.dataPrompt,
        data: job.input_data.user_data,
      }
    );

    if (!result.success) {
      return { success: false, error: result.message };
    }

    // Step 2: Verify submission
    const verification = await adapter.extract(
      'Was the application submitted? Look for confirmation messages.',
      z.object({
        submitted: z.boolean(),
        confirmation: z.string().optional(),
      })
    );

    return {
      success: verification.submitted,
      data: verification,
    };
  }
}
```

**Register it:**

```typescript
// src/workers/taskHandlers/index.ts
import { LinkedInHandler } from './linkedinHandler.js';

export function registerBuiltinHandlers(): void {
  taskHandlerRegistry.register(new ApplyHandler());
  taskHandlerRegistry.register(new ScrapeHandler());
  taskHandlerRegistry.register(new FillFormHandler());
  taskHandlerRegistry.register(new CustomHandler());
  taskHandlerRegistry.register(new LinkedInHandler());  // NEW
}
```

**Submit a job for it:**

```bash
bun -e "
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query(\`
  INSERT INTO gh_automation_jobs (
    user_id, job_type, target_url, task_description, input_data, timeout_seconds
  ) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'linkedin_apply',
    'https://www.linkedin.com/jobs/view/1234567890',
    'Apply to this job via LinkedIn Easy Apply',
    '{\"user_data\": {\"linkedin_email\": \"john@doe.com\", \"first_name\": \"John\"}}',
    300
  )
  RETURNING id
\`);
await c.end();
"
```

### 4. Standalone script (no worker, no DB)

For quick experimentation without the full GhostHands stack:

```typescript
// scripts/experiment.ts
import { startBrowserAgent } from 'magnitude-core';
import { loadModelConfig } from '../config/models.js';

const llm = loadModelConfig(); // reads GH_MODEL or defaults to qwen-72b

console.log(`Using model: ${llm.alias} (${llm.providerName})`);

const agent = await startBrowserAgent({
  url: 'https://www.google.com',
  llm: llm.llmClient as any,
});

// Watch the agent think
agent.events.on('thought', (t) => console.log(`Thought: ${t}`));
agent.events.on('actionStarted', (a) => console.log(`Action: ${a.variant}`));

// Do something
await agent.act('Search for "best coffee shops in SF" and click on the first result');

// Extract data
const result = await agent.extract('What is the name and rating of the place shown?', z.object({
  name: z.string(),
  rating: z.string().optional(),
}));

console.log('Result:', result);

await agent.stop();
```

```bash
bun scripts/experiment.ts
```

---

## Debugging Tips

### See the browser

By default, Magnitude runs **headed** (visible browser). On macOS, you'll see the Chromium window. On Linux/Windows servers, you may need:

```bash
# Run with visible display (Linux with X11)
DISPLAY=:0 bun run worker

# Or use headless mode
GH_HEADLESS=true bun run worker
```

### Verbose logging

```bash
# See Magnitude's internal logs
DEBUG=magnitude:* bun run worker

# See all agent thoughts and actions
bun run job logs <id>
```

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `unknown variant 'image_url'` | Model doesn't support vision | Switch to a vision model: `GH_MODEL=qwen-72b` |
| `ECONNREFUSED` | LLM API unreachable | Check API key and base URL |
| `target closed` | Browser crashed | Check memory; try headless mode |
| `timeout` | Task took too long | Increase `timeout_seconds` or simplify the task |
| `Budget exceeded` | Cost limit hit | Increase budget or use cheaper model |

### Playwright inspector

For debugging page interactions:

```typescript
// Add to your connector or script:
await page.pause(); // Opens Playwright Inspector — step through actions
```

---

## Testing

### Unit tests

```bash
bun run test:unit                    # All unit tests
bun vitest run __tests__/unit/mytest  # Specific test
```

### Test with mock adapter

For testing handler logic without a real browser:

```typescript
import { MockAdapter } from '../../adapters/mock';

const adapter = new MockAdapter();
// MockAdapter emits fake events, no real browser
```

### Integration tests

```bash
bun run test:integration  # Needs DATABASE_URL, SUPABASE_URL
```

### Full E2E test

```bash
./test-worker.sh --worker-id=test --keep
# Watch the browser, check results with:
bun run job status <id>
bun run job logs <id>
```

---

## File Map

```
packages/ghosthands/src/
├── adapters/
│   ├── types.ts          # BrowserAutomationAdapter interface
│   ├── magnitude.ts      # Wraps BrowserAgent
│   ├── mock.ts           # For testing
│   └── index.ts          # Factory: createAdapter()
│
├── config/
│   ├── models.ts         # Model resolution (alias → LLMClient config)
│   ├── models.config.json # All model definitions + presets
│   └── env.ts            # Environment config with Zod validation
│
├── workers/
│   ├── main.ts           # Worker entry: --worker-id, shutdown handling
│   ├── JobPoller.ts      # LISTEN/NOTIFY job pickup
│   ├── JobExecutor.ts    # Job lifecycle: start → execute → complete/fail
│   ├── costControl.ts    # Budget enforcement per task + per user
│   ├── progressTracker.ts # Step-by-step progress
│   └── taskHandlers/
│       ├── registry.ts   # TaskHandlerRegistry singleton
│       ├── types.ts      # TaskHandler, TaskContext, TaskResult interfaces
│       ├── index.ts      # registerBuiltinHandlers()
│       ├── applyHandler.ts
│       ├── customHandler.ts
│       ├── scrapeHandler.ts
│       └── fillFormHandler.ts
│
├── connectors/           # YOUR custom connectors go here
│   └── (workdayConnector.ts, etc.)
│
├── engine/               # Phase 2: Hybrid execution engine
│   └── (coming soon)
│
└── scripts/
    ├── job.ts            # CLI: list/status/cancel/retry/logs
    ├── submit-test-job.ts
    └── kill-workers.ts
```

---

## Patchright vs Chromium

GhostHands uses **patchright** (aliased as `playwright` in package.json):

```json
"playwright": "npm:patchright@^1.52.0"
```

Patchright is a patched fork of Playwright that uses the same Chromium browser but removes bot-detection markers:
- `navigator.webdriver` flag removed
- Automation-related HTTP headers stripped
- Fingerprinting countermeasures

**This means:** ATS platforms (Workday, Greenhouse, etc.) see a normal browser, not an automation tool. The Playwright API is identical — all docs at [playwright.dev](https://playwright.dev) apply.

---

## Rules

1. **Never modify `magnitude-core`** — extend via connectors only
2. **All new tables must use `gh_` prefix** — shared DB with VALET
3. **Vision models required** — DeepSeek, Minimax M2.5 won't work (no image support)
4. **Write tests first** — TDD per CLAUDE.md
5. **No hardcoded secrets** — use `.env` and `process.env`
6. **Use `bun run job` for debugging** — not raw SQL queries
