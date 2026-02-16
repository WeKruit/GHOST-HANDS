# Phase 2: Hybrid Execution Engine (Cookbook + AI Agent)

**Date:** 2026-02-15
**Status:** Planning
**Goal:** 95% cost reduction on repeated tasks via self-learning cookbook system

---

## Vision

> "Let the agent understand the page first. If a preset cookbook/RPA is applicable, use it. On error, let the AI agent step in." — Adam

Today every job = full AI exploration ($0.003, ~8s, ~10 LLM calls).
After Phase 2: repeated jobs = cookbook replay ($0.0001, ~0.5s, 0-1 LLM calls).

---

## Execution Modes

The system supports **three distinct execution modes**. Each mode can run independently, and handlers choose which mode to use per job.

### Mode 1: Pure AI (Magnitude Agent)

**What:** Full vision-based AI agent. The agent looks at screenshots, reasons about the page, and takes actions. This is how GhostHands works today.

**When to use:**
- POC and capability development
- First-time visit to a new ATS platform
- Complex pages that resist cookbook automation
- Developer testing of new browser automation patterns

**Cost:** ~$0.003 per task, ~8s, ~10 LLM calls

**Code path:**
```typescript
// Direct adapter call — no engine, no cookbook
const result = await adapter.act(instruction, { prompt, data });
```

**This mode is always available.** The `CustomHandler` uses it exclusively. Developers can use it to test and validate Magnitude's raw capabilities against any URL without the engine layer. See [Developer Guide](./DEV-GUIDE-MAGNITUDE.md) for how to extend and test pure AI mode.

### Mode 2: Cookbook-Only (Deterministic RPA)

**What:** Replay a pre-recorded sequence of CSS selector actions. No LLM involved. Pure DOM interaction with template substitution.

**When to use:**
- Repeat visits to the same ATS platform
- High-volume batch applications
- When a healthy cookbook exists (health_score >= 70)

**Cost:** ~$0.0001 per task, ~0.5s, 0 LLM calls

**Code path:**
```typescript
const manual = await manualStore.lookup(url, taskType, platform);
const result = await cookbookExecutor.execute(page, manual, userData);
```

### Mode 3: Hybrid (Cookbook + AI Fallback)

**What:** Try cookbook first. If any step fails, AI agent takes over from the current page state. On AI success, save the trace as an updated cookbook.

**When to use:**
- Production workloads (default for `ApplyHandler`)
- When cookbook exists but page may have changed
- When reliability matters more than cost

**Cost:** $0.0001 if cookbook works, $0.003 if AI fallback triggers

**Code path:**
```typescript
const engine = new ExecutionEngine(observer, store, executor, recorder);
const result = await engine.execute(ctx); // handles mode selection internally
```

### Mode Selection per Handler

| Handler | Default Mode | Configurable? | Rationale |
|---------|-------------|---------------|-----------|
| `ApplyHandler` | Hybrid | Yes, via `input_data.execution_mode` | Most benefit from cookbooks; ATS forms are repetitive |
| `CustomHandler` | Pure AI | No | Tasks are too varied for cookbooks |
| `ScrapeHandler` | Hybrid | Yes | Many scrape targets have stable DOM |
| `FillFormHandler` | Hybrid | Yes | Forms are ideal for cookbook replay |

**Override via job input:**
```jsonc
{
  "job_type": "apply",
  "input_data": {
    "execution_mode": "ai_only",  // force pure AI (skip cookbook)
    "user_data": { ... }
  }
}
```

Valid values: `"auto"` (default, hybrid), `"ai_only"`, `"cookbook_only"`

---

## Architecture Overview

```
Job arrives (e.g., "Apply to Workday posting")
  │
  ▼
┌─────────────────────────────────────────────────┐
│              ExecutionEngine (NEW)                │
│                                                   │
│  Step 1: PAGE OBSERVATION                         │
│  ├─ DOM analysis (Stagehand-style)                │
│  ├─ Identify: forms, buttons, nav, page type      │
│  └─ Build page fingerprint (platform + structure)  │
│                                                   │
│  Step 2: MODE SELECTION                           │
│  ├─ Check execution_mode override                 │
│  ├─ If "ai_only" → skip to AI explore             │
│  ├─ If "cookbook_only" → fail if no cookbook        │
│  └─ If "auto" → lookup cookbook, decide            │
│                                                   │
│  Step 3: COOKBOOK LOOKUP                           │
│  ├─ Query gh_action_manuals by url_pattern        │
│  ├─ Filter by health_score > 70                   │
│  └─ Match task_pattern to job description          │
│                                                   │
│  Step 4: EXECUTION                                │
│  ├─ COOKBOOK FOUND (health > 70)                   │
│  │   → CookbookExecutor: replay steps             │
│  │   → Template substitution: {{first_name}}      │
│  │   → Verify each step succeeded                 │
│  │   → On step failure → FALLBACK to AI           │
│  │                                                │
│  └─ NO COOKBOOK (or ai_only mode)                  │
│      → AI Explorer: full Magnitude agent          │
│      → TraceRecorder captures every action         │
│      → On success → save as new cookbook           │
│                                                   │
│  Step 5: RESULT & LEARN                           │
│  ├─ Update cookbook health_score (success/failure)  │
│  ├─ Save new cookbook from successful AI trace      │
│  └─ Report cost savings vs full AI                │
└─────────────────────────────────────────────────┘
```

---

## Components to Build

### 1. PageObserver — Understand the page before acting

**Purpose:** Analyze the DOM to identify page type, form fields, buttons, and structure. This is the "eyes" — the agent's first look at the page BEFORE deciding what to do.

**Implementation:** Uses Playwright's DOM APIs directly (no LLM needed).

```typescript
interface PageObservation {
  url: string;
  platform: string;              // 'workday' | 'greenhouse' | 'lever' | etc
  pageType: string;              // 'login' | 'form' | 'multi-step' | 'confirmation'
  fingerprint: string;           // hash of page structure for matching

  forms: FormObservation[];      // detected forms
  buttons: ButtonObservation[];  // clickable actions
  navigation: NavObservation[];  // page navigation elements

  // For cookbook matching
  urlPattern: string;            // generalized: "*.myworkdayjobs.com/*/apply/*"
  structureHash: string;         // DOM structure fingerprint
}

interface FormObservation {
  selector: string;
  fields: FieldObservation[];
  submitButton?: string;
}

interface FieldObservation {
  selector: string;
  type: string;                  // 'text' | 'email' | 'select' | 'radio' | etc
  name: string;                  // input name attribute
  label: string;                 // associated label text
  required: boolean;
  placeholder?: string;
  options?: string[];            // for select/radio
}
```

**Key insight:** This is pure DOM traversal — no LLM calls needed. Fast and free.

### 2. ManualStore — CRUD for cookbooks in Supabase

**Purpose:** Store, retrieve, and manage action cookbooks (manuals) in `gh_action_manuals`.

**Table** (already defined in `supabase-migration.sql`):

```sql
CREATE TABLE gh_action_manuals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_pattern TEXT NOT NULL,
    task_pattern TEXT NOT NULL,
    platform TEXT,
    steps JSONB NOT NULL,
    health_score INTEGER DEFAULT 100,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    last_verified TIMESTAMPTZ,
    created_by TEXT
);
```

**Service API:**

```typescript
interface ManualStore {
  lookup(url: string, taskType: string, platform?: string): Promise<ActionManual | null>;
  saveFromTrace(trace: ActionTrace, metadata: TraceMetadata): Promise<ActionManual>;
  recordSuccess(manualId: string): Promise<void>;
  recordFailure(manualId: string): Promise<void>;
  get(id: string): Promise<ActionManual | null>;
}
```

### 3. CookbookExecutor — Deterministic step replay

**Purpose:** Replay a cookbook's steps using CSS selectors and direct DOM interaction. No LLM needed.

```typescript
interface ManualStep {
  order: number;
  selector: string;
  action: 'click' | 'type' | 'select' | 'wait' | 'navigate' | 'scroll';
  value?: string;                // literal or template: "{{first_name}}"
  description: string;
  waitAfter?: number;
  verification?: {
    type: 'element_visible' | 'url_changed' | 'text_present';
    value: string;
  };
}
```

### 4. TraceRecorder — Capture AI actions as replayable steps

**Purpose:** When the AI agent runs in explore mode, record every action to save as a cookbook.

Hooks into Magnitude's events:
- `actionStarted` → record action variant
- `actionDone` → query DOM for what was acted on, extract CSS selector
- `thought` → capture reasoning for debugging

### 5. ExecutionEngine — The decision maker

**Purpose:** Orchestrates the full flow: observe → lookup → execute (cookbook or AI) → learn.

The engine respects `execution_mode` overrides, making it possible to force pure AI mode even when a cookbook exists.

### 6. Error Recovery — Strategy switching mid-execution

| Scenario | Current Behavior | Phase 2 Behavior |
|----------|-----------------|-------------------|
| Cookbook step fails (selector not found) | N/A | AI takes over from current page state |
| Cookbook step fails (page changed) | N/A | Re-observe page, try updated selector, or AI |
| AI agent fails (timeout) | Retry whole job | Retry with fresh page observation |
| AI agent fails (captcha) | Retry | Flag for human review |
| New ATS version detected | Full AI every time | Invalidate old cookbook, AI explores, saves new |

**Health score degradation:** Degrades by 5 per failure (15 after 5+ failures). Below 70 = cookbook skipped. Below 30 = flagged for re-exploration.

---

## Extension Points for Developers

### Adding New Platforms (Pure AI POC)

Developers working on new ATS platform support should use **Pure AI mode** for initial capability validation. The workflow:

1. Use `bun run job:dev` or `submit-test-job.ts` to submit a job with `execution_mode: "ai_only"`
2. Watch the Magnitude agent interact with the page
3. Identify patterns, failure points, and form structures
4. Optionally create a custom connector for platform-specific logic
5. Once validated, let the engine record the trace as a cookbook

See [DEV-GUIDE-MAGNITUDE.md](./DEV-GUIDE-MAGNITUDE.md) for the full developer workflow.

### Adding Custom Connectors

Magnitude's `AgentConnector` interface allows developers to extend the agent with:
- **Custom actions** — new commands the agent can use (e.g., `workday:selectDropdown`)
- **Custom instructions** — prompt engineering for specific platforms
- **Custom observations** — additional context the agent sees each turn

These connectors work in all three execution modes. In hybrid mode, the engine uses the connector during AI fallback.

### Adding Custom TaskHandlers

New job types can be added by implementing the `TaskHandler` interface and registering in the registry. Each handler chooses its own execution mode.

```typescript
class MyNewHandler implements TaskHandler {
  readonly type = 'my_new_type';
  readonly description = 'Handle a new type of automation';

  async execute(ctx: TaskContext): Promise<TaskResult> {
    // Pure AI mode — just call adapter directly
    const result = await ctx.adapter.act('Do the thing', { prompt: ctx.dataPrompt });
    return { success: result.success, data: { mode: 'ai_only' } };
  }
}

// Register in taskHandlers/index.ts:
taskHandlerRegistry.register(new MyNewHandler());
```

---

## Implementation Order

### Phase 2a: Foundation (Week 1-2)
1. **PageObserver** — DOM analysis, platform detection, field discovery
2. **ManualStore** — CRUD operations against `gh_action_manuals`
3. **CookbookExecutor** — Step replay with template substitution
4. **Unit tests** for all three (TDD per CLAUDE.md)

### Phase 2b: Intelligence (Week 3-4)
5. **TraceRecorder** — Hook into Magnitude events, capture traces
6. **Trace-to-Cookbook converter** — Convert AI traces to replayable ManualSteps
7. **ExecutionEngine** — Decision logic + fallback orchestration
8. **Integration into TaskHandlers** — Wire engine into ApplyHandler (keep CustomHandler as pure AI)

### Phase 2c: Learning Loop (Week 5-6)
9. **Template detection** — Auto-detect which values should be `{{templates}}`
10. **Health score system** — Degradation, re-exploration triggers
11. **Cookbook versioning** — Handle ATS platform updates
12. **API endpoints** — Manual CRUD for debugging and manual management

### Phase 2d: Optimization (Week 7-8)
13. **Platform-specific cookbooks** — Pre-built for Workday, Greenhouse, Lever
14. **Multi-step form handling** — Navigate multi-page applications
15. **Metrics & reporting** — Cost savings dashboard, cookbook hit rates
16. **E2E tests** — Full loop: AI explore → save cookbook → replay cookbook

---

## Integration Points

### Where it fits in JobExecutor

The ExecutionEngine slots in at step 10 of `JobExecutor.execute()`:

```typescript
// BEFORE (current — still works for CustomHandler):
const actResult = await adapter.act(job.task_description, { ... });

// AFTER (Phase 2 — for ApplyHandler, ScrapeHandler, FillFormHandler):
const engine = new ExecutionEngine(pageObserver, manualStore, cookbookExecutor, traceRecorder);
const result = await engine.execute(ctx);
```

**Important:** The engine is opt-in per handler. Handlers that don't need it continue calling `adapter.act()` directly. This preserves the ability to run pure AI mode for POC work.

### VALET Integration

No changes needed to VALET. The execution engine is internal to GhostHands workers.

VALET can optionally:
- Pass `execution_mode` in `input_data` to force a specific mode
- Read `result_data.mode` to see which mode was used
- Read `result_data.cost_savings_pct` to track savings

### Database

The `gh_action_manuals` table is already defined in `supabase-migration.sql`. Needs:
- Migration applied to live Supabase
- Additional indexes for URL pattern matching
- RLS policies for multi-tenant access

---

## Cost Impact

| Metric | Today (AI only) | After Phase 2 |
|--------|-----------------|---------------|
| First application to new ATS | $0.003, 8s | $0.003, 8s (same) |
| Repeat application (same ATS) | $0.003, 8s | $0.0001, 0.5s |
| 100 applications (10 unique ATS) | $0.30 | $0.039 |
| Monthly cost (1000 apps) | $3.00 | $0.13 |
| **Reduction** | — | **95.7%** |

---

## Key Design Decisions

### 1. Pure AI mode must always be available
Developers need unrestricted access to Magnitude's raw capabilities for testing, POC, and extending platform support. The engine layer is opt-in, never forced.

### 2. CSS selectors over XPath
CSS selectors are more stable across page renders. XPath breaks when DOM structure changes.

### 3. Health scores over binary success/failure
Gradual degradation allows cookbooks to survive occasional flakiness. A single failure shouldn't invalidate a cookbook that's worked 50 times.

### 4. Template detection for reusability
If we just save literal values ("John"), the cookbook only works for one user. Template detection (`{{first_name}}`) makes cookbooks reusable across all users.

### 5. Never modify Magnitude core
Per CLAUDE.md: all extensions via connectors/adapters. The ExecutionEngine wraps the adapter, never patches it.

### 6. Observe before acting
The observation step is free (pure DOM, no LLM). It tells us what platform we're on, whether the cookbook is still valid, and what fields exist.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/engine/PageObserver.ts` | **NEW** | DOM analysis and page fingerprinting |
| `src/engine/ManualStore.ts` | **NEW** | CRUD for gh_action_manuals |
| `src/engine/CookbookExecutor.ts` | **NEW** | Deterministic step replay |
| `src/engine/TraceRecorder.ts` | **NEW** | Capture AI actions as traces |
| `src/engine/ExecutionEngine.ts` | **NEW** | Decision logic + orchestration |
| `src/engine/templateResolver.ts` | **NEW** | `{{var}}` substitution |
| `src/engine/types.ts` | **NEW** | Shared interfaces |
| `src/engine/index.ts` | **NEW** | Exports |
| `src/workers/taskHandlers/applyHandler.ts` | **MODIFY** | Use ExecutionEngine |
| `src/workers/taskHandlers/types.ts` | **MODIFY** | Add engine to TaskContext |
| `src/workers/JobExecutor.ts` | **MODIFY** | Initialize engine components |
| `src/db/migrations/008_verify_manuals_table.sql` | **NEW** | Ensure table + indexes exist |
| `__tests__/unit/engine/` | **NEW** | Full test suite (TDD) |

---

## Human-in-the-Loop (HITL) Interaction System

### The Problem

Some situations can't be solved by AI or cookbooks:
- **CAPTCHA / reCAPTCHA** — bot detection challenges
- **2FA / MFA** — SMS codes, authenticator apps, email verification
- **"Are you human?"** — bot check interstitials
- **Complex screening questions** — ambiguous or subjective answers the user should decide
- **Login required** — platform needs the user's real credentials
- **Payment / legal** — terms acceptance, payment info

Today these all result in `failed` status with error codes like `captcha_blocked` or `login_required`. The job retries and fails again.

### The Solution: Pause + Notify + Handoff + Resume

```
Agent encounters blocker (CAPTCHA, 2FA, etc.)
  │
  ▼
┌─────────────────────────────────────────────────┐
│  1. DETECT                                       │
│     Agent or PageObserver detects blocker type    │
│     via DOM patterns, error classification,       │
│     or AI reasoning ("I see a CAPTCHA")          │
│                                                   │
│  2. PAUSE                                        │
│     agent.pause() — halts the action loop         │
│     Job status → 'paused'                        │
│     Take screenshot of blocker                    │
│                                                   │
│  3. NOTIFY VALET                                 │
│     POST callback_url with:                       │
│       status: 'needs_human'                       │
│       reason: 'captcha_detected'                  │
│       screenshot_url: '...'                       │
│       interaction_url: 'ws://cdp-endpoint'        │
│       interaction_expires_at: '+5 minutes'        │
│                                                   │
│  4. HUMAN TAKES OVER                             │
│     VALET shows notification to user              │
│     User connects to browser (CDP or VNC)         │
│     User solves CAPTCHA / enters 2FA code         │
│     User signals "done" via VALET UI              │
│                                                   │
│  5. RESUME                                       │
│     VALET calls POST /valet/resume/:jobId         │
│     agent.resume() — continues from paused state  │
│     Job status → 'running'                        │
│                                                   │
│  6. TIMEOUT (if human doesn't respond)            │
│     After interaction_timeout (default 5 min):    │
│     Job fails with 'human_timeout'                │
│     Browser cleaned up                            │
└─────────────────────────────────────────────────┘
```

### Blocker Detection

Blockers are detected at multiple levels:

**Level 1: Error classification (existing)**
The `ERROR_CLASSIFICATIONS` in JobExecutor already catches `captcha_blocked` and `login_required`. Instead of retrying, these now trigger the HITL flow.

**Level 2: PageObserver DOM patterns (Phase 2)**
```typescript
interface BlockerDetection {
  type: 'captcha' | '2fa' | 'login' | 'bot_check' | 'unknown';
  confidence: number;        // 0-1
  screenshot?: string;       // URL to screenshot of the blocker
  description: string;       // human-readable: "reCAPTCHA v2 detected"
  selectors?: string[];      // relevant DOM selectors
}

// DOM pattern matching (no LLM needed)
const BLOCKER_PATTERNS = [
  { type: 'captcha', selectors: ['iframe[src*="recaptcha"]', '.h-captcha', '#captcha'] },
  { type: '2fa', selectors: ['input[name*="otp"]', 'input[name*="code"]', '[data-automation-id*="verification"]'] },
  { type: 'login', selectors: ['input[type="password"]', 'form[action*="login"]', '#login-form'] },
  { type: 'bot_check', selectors: ['.challenge-running', '#challenge-stage', '.cf-browser-verification'] },
];
```

**Level 3: AI reasoning (during explore mode)**
The agent's `thought` events may contain phrases like "I see a CAPTCHA" or "It's asking for a verification code". These are pattern-matched to trigger HITL.

```typescript
const THOUGHT_BLOCKERS = [
  { pattern: /captcha|recaptcha|hcaptcha/i, type: 'captcha' },
  { pattern: /verification code|2fa|two.factor|authenticator/i, type: '2fa' },
  { pattern: /sign.?in|log.?in|password/i, type: 'login' },
  { pattern: /are you (a )?human|bot.?(check|detect)/i, type: 'bot_check' },
];
```

### Callback Payload (VALET Notification)

When a blocker is detected, GhostHands sends a callback to VALET:

```typescript
interface HumanInteractionCallback {
  job_id: string;
  valet_task_id: string | null;
  status: 'needs_human';
  interaction: {
    reason: 'captcha' | '2fa' | 'login' | 'bot_check' | 'screening_question';
    description: string;           // "reCAPTCHA detected on Workday application page"
    screenshot_url: string;        // screenshot of the blocker
    current_url: string;           // where the browser is stuck
    // Browser access for human takeover
    cdp_url?: string;              // ws://... for Chrome DevTools Protocol
    vnc_url?: string;              // VNC viewer URL (for cloud browsers)
    viewer_url?: string;           // web-based browser viewer
    // Timing
    paused_at: string;             // ISO timestamp
    expires_at: string;            // when the interaction times out
    timeout_seconds: number;       // how long to wait (default: 300)
  };
  progress: {
    step: string;
    progress_pct: number;
    actions_completed: number;
  };
}
```

### VALET Resume Endpoint

New endpoint for VALET to signal "human is done":

```
POST /api/v1/gh/valet/resume/:jobId
```

**Request:**
```jsonc
{
  "action": "resume",        // or "cancel" if user gives up
  "resolution": "solved",    // what the human did
  "notes": "Solved CAPTCHA"  // optional human notes
}
```

**Response:**
```jsonc
{
  "job_id": "abc-123",
  "status": "running",       // resumed
  "resumed_at": "2026-02-16T..."
}
```

**Implementation:**
```typescript
valet.post('/resume/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const body = await c.req.json();

  // Verify job is actually paused
  const { rows } = await pool.query(
    'SELECT id, status, worker_id FROM gh_automation_jobs WHERE id = $1::UUID',
    [jobId]
  );

  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  if (rows[0].status !== 'paused') {
    return c.json({ error: 'not_paused', message: `Job is ${rows[0].status}, not paused` }, 409);
  }

  if (body.action === 'cancel') {
    // User gave up — cancel the job
    await pool.query(
      `UPDATE gh_automation_jobs SET status = 'cancelled', completed_at = NOW() WHERE id = $1`,
      [jobId]
    );
    return c.json({ job_id: jobId, status: 'cancelled' });
  }

  // Signal the worker to resume via Postgres NOTIFY
  await pool.query(`NOTIFY gh_job_resume, '${jobId}'`);

  // Log the interaction
  await pool.query(
    `INSERT INTO gh_job_events (job_id, event_type, message, metadata)
     VALUES ($1, 'human_resumed', $2, $3)`,
    [jobId, body.notes || 'Human resolved blocker', JSON.stringify({ resolution: body.resolution })]
  );

  return c.json({ job_id: jobId, status: 'running', resumed_at: new Date().toISOString() });
});
```

### Worker-Side: Pause + Wait + Resume

In `JobExecutor`, the HITL flow hooks into the existing error handling:

```typescript
// In JobExecutor.execute(), when a blocker is detected:

private async requestHumanIntervention(
  job: AutomationJob,
  adapter: BrowserAutomationAdapter,
  blocker: BlockerDetection,
  progress: ProgressTracker,
): Promise<'resumed' | 'cancelled' | 'timeout'> {
  // 1. Pause the agent
  // (Magnitude's agent.pause() stops the action loop but keeps browser alive)

  // 2. Take screenshot
  const screenshot = await adapter.screenshot();
  const screenshotUrl = await this.uploadScreenshot(job.id, 'blocker', screenshot);

  // 3. Update job status to 'paused'
  await this.supabase
    .from('gh_automation_jobs')
    .update({
      status: 'paused',
      status_message: `Waiting for human: ${blocker.description}`,
    })
    .eq('id', job.id);

  await this.logJobEvent(job.id, 'human_intervention_requested', {
    blocker_type: blocker.type,
    description: blocker.description,
    screenshot_url: screenshotUrl,
  });

  // 4. Notify VALET via callback
  if (job.callback_url) {
    await callbackNotifier.notifyInteraction(job.callback_url, {
      job_id: job.id,
      valet_task_id: job.valet_task_id || null,
      status: 'needs_human',
      interaction: {
        reason: blocker.type,
        description: blocker.description,
        screenshot_url: screenshotUrl,
        current_url: await adapter.getCurrentUrl(),
        paused_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        timeout_seconds: 300,
      },
    });
  }

  // 5. Wait for resume signal (Postgres LISTEN) or timeout
  const timeoutMs = 300_000; // 5 minutes
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), timeoutMs);

    // Listen for resume notification from VALET
    this.listenForResume(job.id, (action) => {
      clearTimeout(timeout);
      resolve(action === 'cancel' ? 'cancelled' : 'resumed');
    });
  });
}
```

### VALET Status Response (Updated)

The `/valet/status/:jobId` response now includes interaction info when paused:

```jsonc
{
  "job_id": "abc-123",
  "status": "paused",
  "status_message": "Waiting for human: reCAPTCHA detected",
  "interaction": {                        // NEW — only present when status=paused
    "reason": "captcha",
    "description": "reCAPTCHA v2 detected on application page",
    "screenshot_url": "https://...",
    "current_url": "https://company.workday.com/apply",
    "paused_at": "2026-02-16T06:30:00Z",
    "expires_at": "2026-02-16T06:35:00Z",
    "timeout_seconds": 300
  },
  "progress": { "step": "filling_form", "progress_pct": 45 },
  "timestamps": { ... }
}
```

### Integration with Execution Modes

| Mode | HITL Behavior |
|------|---------------|
| **Pure AI** | On blocker detection in agent thoughts → pause + notify |
| **Cookbook** | On step failure matching blocker patterns → pause + notify |
| **Hybrid** | Cookbook fails → AI tries → AI detects blocker → pause + notify |

### Error Codes Updated

| Error Code | Before | After |
|------------|--------|-------|
| `captcha_blocked` | Retry → fail | Pause → notify VALET → wait for human |
| `login_required` | Retry → fail | Pause → notify VALET → wait for human |
| `2fa_required` | N/A (new) | Pause → notify VALET → wait for human |
| `bot_check` | N/A (new) | Pause → notify VALET → wait for human |
| `human_timeout` | N/A (new) | Human didn't respond within timeout → fail |
| `human_cancelled` | N/A (new) | Human chose to cancel → cancel |

### Database Changes

```sql
-- New columns for interaction tracking
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS interaction_type TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS interaction_data JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ DEFAULT NULL;
```

### Implementation Order

This feature spans Phase 2b and 2c:

1. **Blocker detection** (DOM patterns + thought patterns) — Phase 2b
2. **Pause + screenshot** — Phase 2b
3. **Callback notification** (extend `CallbackNotifier`) — Phase 2b
4. **Resume endpoint** (`POST /valet/resume/:jobId`) — Phase 2b
5. **VALET status response** (include interaction info) — Phase 2b
6. **Postgres LISTEN for resume signal** — Phase 2c
7. **Timeout handling** — Phase 2c
8. **CDP/VNC URL generation** (for browser handoff) — Phase 2d

### VALET Action Items

- [ ] Handle `needs_human` callback — show notification to user
- [ ] Build browser viewer UI (connect to CDP or show screenshot)
- [ ] Add "I'm done" / "Cancel" buttons → call `POST /valet/resume/:jobId`
- [ ] Handle `human_timeout` → show "automation timed out waiting" message
- [ ] (Optional) Show live browser via CDP WebSocket or VNC

---

## Open Questions

1. **Selector stability:** How often do ATS platforms change their DOM?
2. **Multi-page forms:** Workday has 3-5 page applications. How do cookbooks handle page navigation?
3. **Dynamic content:** Conditional fields (e.g., visa sponsorship → extra fields). How do cookbooks handle branching?
4. **Cookbook sharing:** Per-user, per-org, or global? Global = fastest learning but privacy concerns.
5. **Browser handoff:** CDP vs VNC vs web viewer? CDP is most powerful but requires WebSocket proxy. VNC is simpler but lower fidelity.
6. **Interaction timeout:** 5 minutes default — is this enough? Should it be configurable per job?
7. **Multi-blocker:** What if human solves CAPTCHA but then hits 2FA? Do we pause again?

---

## References

- [CLAUDE.md](../CLAUDE.md) — ManualConnector spec, connector interface, cost targets
- [DEV-GUIDE-MAGNITUDE.md](./DEV-GUIDE-MAGNITUDE.md) — Developer guide for extending Magnitude
- [Team 3 Prompt](archive/Prompt%20for%20Team%203_%20The%20Brain%20(Self-Learning%20Core).md) — Original self-learning system design
- [supabase-migration.sql](../supabase-migration.sql) — gh_action_manuals table schema
- [Manus Browser Operator](https://manus.im/features/manus-browser-operator) — Hybrid cloud+local approach inspiration
- [Magnitude Docs](https://docs.magnitude.run) — Upstream BrowserAgent API
