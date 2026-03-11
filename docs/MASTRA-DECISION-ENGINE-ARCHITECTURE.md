# Mastra Decision Engine — Architecture Document

**Author:** Backend Architect
**Date:** 2026-03-11
**Branch:** `feat/octo-mastra-decision-engine`
**Status:** Design Phase

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Baseline](#2-current-architecture-baseline)
3. [New Mastra Workflow Design](#3-new-mastra-workflow-design)
4. [LLM Decision Call Design](#4-llm-decision-call-design)
5. [Execution Cascade Design](#5-execution-cascade-design)
6. [Termination Conditions](#6-termination-conditions)
7. [Desktop Entry Point Changes](#7-desktop-entry-point-changes)
8. [Worker Entry Point Changes](#8-worker-entry-point-changes)
9. [Workflow State Schema Changes](#9-workflow-state-schema-changes)
10. [File Changes Inventory](#10-file-changes-inventory)
11. [Migration Path](#11-migration-path)
12. [Risk Assessment](#12-risk-assessment)
13. [Appendix: Sequence Diagrams](#13-appendix-sequence-diagrams)

---

## 1. Executive Summary

Today the Mastra workflow has two steps: `check_blockers_checkpoint` and `execute_handler`. The `execute_handler` step delegates entirely to `SmartApplyHandler.execute()`, which runs a monolithic ~700-line page loop that interleaves observation, form filling, navigation, stuck detection, and platform-specific heuristics all inside a single function.

This design replaces `execute_handler` with a **page decision loop** (`page_decision_loop`) that runs inside a single Mastra step but is internally structured as a repeating observe-decide-act cycle. An LLM decision call examines the current page state and chooses from a constrained action schema. Actions are executed via a three-tier cascade: DOM -> Stagehand -> Magnitude. The loop terminates on confirmation, review, error, stuck detection, or budget exhaustion.

**Key design decisions:**

- The loop runs inside a **single Mastra step** (not one step per page iteration). Rationale: Mastra suspend/resume serializes state to Postgres, which adds ~200ms latency per transition and prevents holding non-serializable objects (Playwright Page, adapter). The loop needs sub-second iteration.
- HITL suspend points are added **within the loop** at blocker detection points, using the same `suspend()` mechanism already proven in `check_blockers_checkpoint`.
- SmartApplyHandler remains as a **fallback** behind a feature flag during rollout.
- The v3 engine's `DOMHand`, `StagehandHand`, and `MagnitudeHand` are reused directly as the execution cascade.

---

## 2. Current Architecture Baseline

### 2.1 Mastra Workflow (2 steps)

```
buildApplyWorkflow(RuntimeContext)
  |
  v
[Step 1] check_blockers_checkpoint
  - BlockerDetector.detectWithAdapter()
  - HITL suspend/resume (Mastra suspend())
  - Reads resolution_data from DB
  - Injects resolution via adapter.act()
  |
  v
[Step 2] execute_handler
  - Builds TaskContext from RuntimeContext
  - Calls rt.handler.execute(ctx) -- usually SmartApplyHandler
  - Maps TaskResult to WorkflowState
  - Sets final status: completed | failed | awaiting_review
```

### 2.2 SmartApplyHandler Page Loop (what we are replacing)

```
while (pagesProcessed < 15):
  1. waitForPageLoad()
  2. dismissCookieBanner()
  3. detectPage() -- platform-specific page type detection
  4. getPageFingerprint() -- stuck detection
  5. Branch on page_type:
     - job_listing: click Apply button
     - login/account_creation: handle credentials
     - questions/basic_info/...: fillFormOnPage()
     - review: stop for manual review
     - confirmation: mark success
  6. After fill: detect next-page navigation
  7. Update pageContext snapshots
```

### 2.3 Existing v3 Engine (partially built, not wired)

The `packages/ghosthands/src/engine/v3/` directory contains:

- `LayerHand` (abstract base): observe(), process(), execute(), review(), throwError()
- `DOMHand` ($0/action): PageScanner + FieldMatcher + DOMActionExecutor
- `StagehandHand` ($0.0005/action): Stagehand a11y observe + DOM fill
- `MagnitudeHand` ($0.005/action): Screenshot + vision LLM agent
- `SectionOrchestrator`: Per-page loop that groups fields into sections, fills cheapest-first with escalation

These layers are mature but not yet wired into any production path.

### 2.4 Entry Points

| Entry Point | Path | Current Behavior |
|---|---|---|
| **Hosted Worker** | `jobExecutor.ts` -> `executeMastraWorkflow()` | Builds RuntimeContext, creates Mastra workflow, handles suspend/resume/finalization |
| **Desktop (direct)** | `packages/engine/src/runApplication.ts` | Launches magnitude-core directly, cookbook-first, LLM fallback. No Mastra. |
| **Desktop (brokered)** | `packages/engine/src/desktop.ts` -> `broker.submitSmartApply()` | Submits to hosted API, does not run locally |

---

## 3. New Mastra Workflow Design

### 3.1 Workflow Shape

```
buildApplyWorkflow(RuntimeContext)
  |
  v
[Step 1] check_blockers_checkpoint     (UNCHANGED)
  |
  v
[Step 2] page_decision_loop            (NEW -- replaces execute_handler)
  |
  Internal loop (runs within execute()):
  |
  |  repeat:
  |    1. PageObserver.observe(page)    -> PageSnapshot
  |    2. buildDecisionContext()         -> DecisionContext
  |    3. LLM decision call             -> DecisionAction
  |    4. Platform guardrails           -> possibly override action
  |    5. Execute via cascade           -> ActionResult
  |    6. Record in action history
  |    7. Check termination
  |  until: terminal state
```

### 3.2 Why a Single Step (Not Per-Iteration Steps)

**Arguments for per-iteration steps:**
- Each page iteration becomes a durable checkpoint
- Easier to inspect workflow history in Mastra dashboard

**Arguments against (decisive):**
- **Latency**: Mastra serialize/deserialize via PostgresStore adds ~150-300ms per step boundary. At 15 pages with multiple actions per page, this adds 5-10 seconds.
- **Non-serializable state**: The Playwright Page, adapter, CostTracker, and Stagehand instance cannot be serialized. They are currently passed via closure through RuntimeContext. Making each iteration a step would require re-establishing browser context at each step boundary.
- **Browser session continuity**: The browser session must stay alive across the entire loop. Mastra step boundaries are designed for points where the process can be suspended indefinitely.
- **Precedent**: The current `execute_handler` already runs the entire SmartApplyHandler in a single step.

**Decision**: Single step with internal loop. Suspend points for HITL are explicit `suspend()` calls at blocker detection points within the loop, exactly as `check_blockers_checkpoint` does today.

### 3.3 HITL Suspend/Resume Within the Loop

When the decision engine detects a blocker during page observation (or via the existing `BlockerDetector`), it suspends the workflow:

```typescript
// Inside page_decision_loop execute():
if (observation.blockers.length > 0) {
  // Update job status, notify VALET
  await pauseJob(rt.supabase, state.jobId);
  await sendNeedsHumanCallback(rt, state, blockerInfo);

  state.hitl = { blocked: true, ... };
  state.decisionLoop.lastObservation = serializeObservation(observation);

  return await suspend({ blockerType, pageUrl });
}
```

On resume, the step receives `resumeData`, injects the resolution (credentials, 2FA code), re-observes the page, and continues the loop.

### 3.4 Decision Loop State Persistence

The decision loop maintains state that must survive HITL suspend/resume but does NOT need to survive process crashes (the browser session is lost on crash anyway). This state lives in the WorkflowState schema (serializable):

```typescript
decisionLoop: z.object({
  // Current iteration count
  iteration: z.number().int().nonnegative().default(0),

  // Page tracking
  pagesProcessed: z.number().int().nonnegative().default(0),
  currentPageFingerprint: z.string().nullable().default(null),
  previousPageFingerprint: z.string().nullable().default(null),
  samePageCount: z.number().int().nonnegative().default(0),

  // Action history (last N actions for LLM context window)
  actionHistory: z.array(z.object({
    iteration: z.number(),
    action: z.string(),        // e.g., "fill_form", "click_next", "login"
    target: z.string(),        // e.g., "first_name field", "Next button"
    result: z.enum(['success', 'partial', 'failed', 'skipped']),
    layer: z.enum(['dom', 'stagehand', 'magnitude']).nullable(),
    costUsd: z.number(),
    durationMs: z.number(),
    fieldsAttempted: z.number().optional(),
    fieldsFilled: z.number().optional(),
    pageFingerprint: z.string(),
    timestamp: z.number(),
  })).default([]),

  // Cost tracking for budget enforcement
  loopCostUsd: z.number().default(0),

  // Termination
  terminalState: z.enum([
    'running',
    'confirmation',
    'review_page',
    'submitted',
    'stuck',
    'budget_exceeded',
    'error',
    'max_iterations',
  ]).default('running'),

  terminationReason: z.string().nullable().default(null),
})
```

---

## 4. LLM Decision Call Design

### 4.1 Model Selection

| Quality Preset | Model | Cost/call | Rationale |
|---|---|---|---|
| `speed` | `claude-haiku-4-5-20251001` | ~$0.001 | Fast, cheap. Good enough for form-filling decisions on standard ATS sites. |
| `balanced` | `claude-haiku-4-5-20251001` | ~$0.001 | Same model; quality comes from better prompting and more retries. |
| `quality` | `claude-sonnet-4-20250514` | ~$0.003 | For complex/non-standard application forms where Haiku makes wrong decisions. |

**Default: Haiku.** The decision call is a structured classification task with a constrained output schema. Haiku excels at this. Sonnet is reserved for the `quality` preset or when Haiku produces consecutive decision failures.

### 4.2 Structured Output Format

Use Anthropic's **tool_use** (function calling) to get constrained structured output. This is more reliable than JSON mode for enforcing the exact schema.

```typescript
const DECISION_TOOL = {
  name: 'page_decision',
  description: 'Decide the next action to take on the current page of a job application.',
  input_schema: {
    type: 'object',
    required: ['action', 'reasoning'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'fill_form',          // Fill visible form fields with user data
          'click_next',         // Click a navigation button (Next, Continue, Save & Continue)
          'click_apply',        // Click an Apply button on a job listing
          'click_submit',       // NEVER used autonomously -- only with user confirmation
          'upload_resume',      // Trigger file upload for resume
          'select_option',      // Select a specific dropdown/radio option
          'dismiss_popup',      // Close a modal/popup/cookie banner
          'scroll_down',        // Scroll to reveal more content
          'login',              // Fill login credentials
          'create_account',     // Fill account creation form
          'enter_verification', // Enter 2FA/verification code
          'wait_and_retry',     // Page is loading or transitioning
          'stop_for_review',    // Stop and hand off to user for review
          'mark_complete',      // Application appears submitted/confirmed
          'report_blocked',     // Cannot proceed (CAPTCHA, unexpected state)
        ],
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of why this action was chosen (1-2 sentences).',
      },
      target: {
        type: 'string',
        description: 'What element or section to act on (e.g., "Next button", "email field", "resume upload").',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in this decision (0.0 to 1.0).',
        minimum: 0.0,
        maximum: 1.0,
      },
      fields_to_fill: {
        type: 'array',
        description: 'For fill_form action: which field labels to prioritize.',
        items: { type: 'string' },
      },
    },
  },
};
```

### 4.3 System Prompt Structure

```
SYSTEM PROMPT (cached, ~1200 tokens):

You are a job application navigation agent. You observe the current state of
a job application page and decide the single best next action.

## Rules
1. NEVER click Submit/Apply unless the action is 'click_apply' (for job listings)
   or 'stop_for_review' (for review pages before submission).
2. If the page has unfilled required fields, choose 'fill_form'.
3. If all visible fields are filled and there is a Next/Continue button, choose 'click_next'.
4. If you see a review/summary page, choose 'stop_for_review'.
5. If you see a confirmation page ("application submitted"), choose 'mark_complete'.
6. If you see a login form, choose 'login'.
7. If you see CAPTCHA or a blocker you cannot handle, choose 'report_blocked'.
8. Prefer the simplest action. Do not over-think.

## Platform Guardrails
{platform_guardrails}

## User Profile Summary
Name: {first_name} {last_name}
Email: {email}
(additional profile summary...)

USER MESSAGE (per-iteration, ~500-2000 tokens):

## Current Page State
URL: {current_url}
Page Type (detected): {page_type}
Platform: {platform}
Page Fingerprint: {fingerprint}

## Visible Form Fields ({field_count} fields)
{field_list_with_labels_types_values_required}

## Visible Buttons
{button_list}

## Action History (last 5 actions)
{recent_action_history}

## Budget
Spent: ${spent_usd} / ${budget_usd} remaining
Iteration: {iteration} / {max_iterations}
Same page count: {same_page_count}
```

### 4.4 Platform Guardrail Hints

Platform guardrails are injected into the system prompt based on detected platform:

```typescript
const PLATFORM_GUARDRAILS: Record<string, string> = {
  workday: `
    - Workday uses multi-step SPAs. The URL rarely changes between pages.
    - After filling a section, look for "Save & Continue" or section nav buttons.
    - Workday dropdowns are custom (not native <select>). When filling, click the
      dropdown trigger first, then select the option text.
    - Never attempt to navigate away from the Workday iframe.
  `,
  greenhouse: `
    - Greenhouse has a single-page form. Scroll down to find all sections.
    - The Apply button may be at the top. After clicking, the page transforms
      into a form without URL change.
    - File upload is via a standard file input.
  `,
  lever: `
    - Lever has a simple single-page form.
    - Resume upload is usually the first field.
    - EEO questions are at the bottom.
  `,
  // ... other platforms
  other: `
    - Unknown ATS platform. Proceed cautiously.
    - Look for standard form patterns (text inputs, selects, file uploads).
    - If stuck, scroll down to check for hidden content.
  `,
};
```

### 4.5 Decision Call Implementation

```typescript
// packages/ghosthands/src/engine/decision/PageDecisionEngine.ts

export interface DecisionContext {
  url: string;
  platform: string;
  pageType: string;
  fingerprint: string;
  fields: FormFieldSummary[];
  buttons: ButtonSummary[];
  actionHistory: ActionHistoryEntry[];
  budgetRemaining: number;
  budgetTotal: number;
  iteration: number;
  maxIterations: number;
  samePageCount: number;
  profileSummary: string;
}

export interface DecisionResult {
  action: DecisionAction;
  reasoning: string;
  target?: string;
  confidence: number;
  fieldsToFill?: string[];
  tokenUsage: { input: number; output: number };
  costUsd: number;
  durationMs: number;
}

export class PageDecisionEngine {
  private client: Anthropic;
  private model: string;

  constructor(config: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model || 'claude-haiku-4-5-20251001';
  }

  async decide(context: DecisionContext): Promise<DecisionResult> {
    const start = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 300,
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: buildUserMessage(context) }],
      tools: [DECISION_TOOL],
      tool_choice: { type: 'tool', name: 'page_decision' },
    });

    // Extract structured decision from tool_use response
    const toolUse = response.content.find(b => b.type === 'tool_use');
    // ... parse and validate ...
  }
}
```

---

## 5. Execution Cascade Design

### 5.1 Action Routing

Each `DecisionAction` maps to an execution strategy that uses the three-tier cascade:

```
DecisionAction -> ActionExecutor -> DOM -> Stagehand -> Magnitude
```

| Decision Action | Primary Executor | Cascade Behavior |
|---|---|---|
| `fill_form` | SectionOrchestrator (v3) | DOMHand -> StagehandHand -> MagnitudeHand per field |
| `click_next` | DOM click -> Stagehand act -> Magnitude act | Single element cascade |
| `click_apply` | DOM click -> Stagehand act -> Magnitude act | Single element cascade |
| `upload_resume` | DOM file input -> Stagehand act | File chooser handler pre-attached |
| `select_option` | DOMHand -> StagehandHand | For dropdowns/radios |
| `dismiss_popup` | DOM click -> Stagehand act | Target the close/dismiss button |
| `scroll_down` | page.evaluate() scroll | No cascade needed ($0) |
| `login` | formFiller credentials flow | Existing credential injection |
| `create_account` | formFiller + credential generation | Existing account creation flow |
| `enter_verification` | adapter.act() for code entry | HITL or auto-resolve |
| `wait_and_retry` | setTimeout + re-observe | No action, just delay |

### 5.2 SectionOrchestrator Integration for fill_form

The existing `SectionOrchestrator` from v3 already implements the per-field escalation cascade. For `fill_form` actions:

```typescript
async executeFillForm(
  page: Page,
  adapter: BrowserAutomationAdapter,
  userProfile: Record<string, unknown>,
  ctx: LayerContext,
): Promise<FillActionResult> {
  // Reuse existing v3 layers
  const domHand = new DOMHand();
  const stagehandHand = new StagehandHand(adapter);
  const magnitudeHand = new MagnitudeHand(adapter);

  const orchestrator = new SectionOrchestrator(
    [domHand, stagehandHand, magnitudeHand],
    {
      maxAttemptsPerLayer: 2,
      layerOrder: ['dom', 'stagehand', 'magnitude'],
      fastEscalationErrors: ['element_not_found', 'element_not_visible'],
    },
  );

  return orchestrator.run(ctx);
}
```

### 5.3 Single-Element Cascade (for clicks, navigation)

```typescript
async executeClickAction(
  page: Page,
  adapter: BrowserAutomationAdapter,
  target: string,           // button text or selector hint from decision
  actionType: string,       // 'click_next', 'click_apply', 'dismiss_popup'
): Promise<ClickActionResult> {

  // Tier 1: DOM — try to find and click by selector/text
  const domResult = await tryDOMClick(page, target);
  if (domResult.success) return { ...domResult, layer: 'dom', costUsd: 0 };

  // Tier 2: Stagehand — semantic click via a11y tree
  if (adapter.observe) {
    const stagehandResult = await tryStagehandClick(adapter, target);
    if (stagehandResult.success) return { ...stagehandResult, layer: 'stagehand', costUsd: 0.0005 };
  }

  // Tier 3: Magnitude — full vision agent click
  const prompt = `Click the "${target}" button`;
  await adapter.act(prompt);
  return { success: true, layer: 'magnitude', costUsd: 0.005 };
}
```

### 5.4 Timeout and Retry Policy

| Layer | Per-Action Timeout | Max Retries | Escalation Trigger |
|---|---|---|---|
| DOM | 5s | 1 | element_not_found, element_not_visible |
| Stagehand | 15s | 1 | timeout, element_not_interactable |
| Magnitude | 30s | 0 | This is the last resort. Failures go to stuck detection. |

**Global timeout per iteration**: 60s. If an iteration exceeds this, it is recorded as a failure and the decision engine decides whether to retry or give up.

---

## 6. Termination Conditions

### 6.1 Termination Detection

```typescript
function checkTermination(
  observation: PageSnapshot,
  decision: DecisionResult,
  loopState: DecisionLoopState,
  budgetUsd: number,
): TerminationResult | null {

  // 1. Confirmation page — application submitted
  if (decision.action === 'mark_complete') {
    return { type: 'confirmation', reason: decision.reasoning };
  }

  // 2. Review page — stop for user review
  if (decision.action === 'stop_for_review') {
    return { type: 'review_page', reason: decision.reasoning };
  }

  // 3. Blocker — needs human intervention
  if (decision.action === 'report_blocked') {
    return { type: 'blocked', reason: decision.reasoning };
  }

  // 4. Stuck loop — same page fingerprint for too many iterations
  if (loopState.samePageCount >= 6) {
    return { type: 'stuck', reason: `Same page for ${loopState.samePageCount} iterations` };
  }

  // 5. Budget exceeded
  if (loopState.loopCostUsd >= budgetUsd) {
    return { type: 'budget_exceeded', reason: `Cost ${loopState.loopCostUsd} >= budget ${budgetUsd}` };
  }

  // 6. Max iterations
  if (loopState.iteration >= MAX_ITERATIONS) {
    return { type: 'max_iterations', reason: `Reached ${MAX_ITERATIONS} iterations` };
  }

  // 7. Error accumulation — 3+ consecutive failures
  const recentFailures = loopState.actionHistory
    .slice(-3)
    .filter(a => a.result === 'failed');
  if (recentFailures.length >= 3) {
    return { type: 'error', reason: '3 consecutive action failures' };
  }

  return null; // Continue
}
```

### 6.2 Termination Handling

| Termination Type | WorkflowState.status | Job Status | VALET Callback |
|---|---|---|---|
| `confirmation` | `completed` | `completed` | `notifyCompleted` with success data |
| `review_page` | `awaiting_review` | `awaiting_review` | `notifyAwaitingReview` |
| `blocked` | `suspended` | `paused` | `notifyHumanNeeded` |
| `stuck` | `awaiting_review` | `awaiting_review` | `notifyAwaitingReview` with stuck metadata |
| `budget_exceeded` | `failed` | `failed` | `notifyFailed` with error_code: `budget_exceeded` |
| `max_iterations` | `awaiting_review` | `awaiting_review` | `notifyAwaitingReview` with iteration data |
| `error` | `failed` | `failed` | `notifyFailed` with error details |

### 6.3 Confirmation Page Detection

The LLM decides `mark_complete` based on page content signals, but we add heuristic verification:

```typescript
function verifyConfirmationPage(observation: PageSnapshot): boolean {
  const bodyText = observation.bodyTextSnippet.toLowerCase();
  const confirmationSignals = [
    'application submitted',
    'application received',
    'thank you for applying',
    'successfully submitted',
    'your application has been',
    'we have received your application',
  ];
  return confirmationSignals.some(signal => bodyText.includes(signal));
}
```

---

## 7. Desktop Entry Point Changes

### 7.1 Current Desktop Path

`runApplication()` in `packages/engine/src/runApplication.ts`:
1. Launches magnitude-core browser agent directly
2. Attempts cookbook replay
3. Falls back to `agent.act(taskPrompt)` -- a single monolithic LLM call
4. No Mastra, no decision engine, no structured observation

### 7.2 New Desktop Path

The desktop path gains a **decision engine mode** that runs the same observe-decide-act loop without Mastra (no Postgres needed):

```typescript
// packages/engine/src/runApplication.ts

export async function runApplication(config: EngineConfig, params: RunParams): Promise<RunResult> {
  // Feature flag: use decision engine or legacy path
  if (config.useDecisionEngine) {
    return runWithDecisionEngine(config, params);
  }
  return runLegacy(config, params);  // Current implementation
}

async function runWithDecisionEngine(config: EngineConfig, params: RunParams): Promise<RunResult> {
  const { targetUrl, profile, resumePath, manualStore, onProgress } = params;
  const emit = (type, message, extra) => onProgress({ type, message, timestamp: Date.now(), ...extra });

  // 1. Launch browser (same as current)
  const { startBrowserAgent } = await import('magnitude-core');
  const agent = await startBrowserAgent({ url: targetUrl, ... });

  // 2. Create decision engine (no Mastra/Postgres needed)
  const decisionEngine = new PageDecisionEngine({
    apiKey: config.anthropicApiKey,
    model: config.model,
  });

  // 3. Create execution layers
  // (DOM hand doesn't need adapter, Stagehand/Magnitude need the adapter wrapper)

  // 4. Run decision loop (standalone, no Mastra)
  const loopRunner = new DecisionLoopRunner({
    decisionEngine,
    page: agent.page,
    profile: buildUserData(profile),
    budget: config.budgetUsd ?? 1.0,
    onProgress: emit,
    manualStore,
    resumePath,
  });

  const result = await loopRunner.run();

  emit('complete', result.success ? 'Application filled' : `Failed: ${result.error}`);
  return result;
}
```

### 7.3 Minimal Engine Package Changes

The engine package (`packages/engine`) needs:

1. **New export**: `DecisionLoopRunner` -- a standalone (non-Mastra) version of the loop
2. **New dependency**: The `PageDecisionEngine` class (shared between engine and ghosthands)
3. **EngineConfig extension**: Add `useDecisionEngine?: boolean` and `budgetUsd?: number`

The `DecisionLoopRunner` is a **pure logic class** that takes a Playwright Page, user profile, and decision engine. It does not depend on Mastra, Supabase, or any server-side infrastructure.

### 7.4 Backward Compatibility

- `EngineConfig.useDecisionEngine` defaults to `false`
- The existing `runApplication()` path is unchanged
- Desktop app can opt in by setting the flag
- No changes to `LocalWorkerManager`, `GhostHandsBrokerClient`, or broker API

---

## 8. Worker Entry Point Changes

### 8.1 Current Hosted Worker Path

```
jobExecutor.executeJob()
  |-- execution_mode === 'mastra' --> executeMastraWorkflow()
  |     |-- buildApplyWorkflow(rt)
  |     |-- mastra.addWorkflow() / getWorkflow()
  |     |-- run.start() / run.resume()
  |     |-- HITL wait loop
  |     |-- Finalization
  |
  |-- execution_mode !== 'mastra' --> legacy path
        |-- handler.execute(ctx)
        |-- Direct finalization
```

### 8.2 New Hosted Worker Path

```
jobExecutor.executeJob()
  |-- execution_mode === 'mastra_decision' --> executeMastraWorkflow() (new workflow)
  |     |-- buildApplyWorkflow(rt)  <-- now uses page_decision_loop step
  |     |-- Same Mastra plumbing (unchanged)
  |     |-- run.start() / run.resume()
  |     |-- HITL wait loop (unchanged)
  |     |-- Finalization (extended for decision loop metadata)
  |
  |-- execution_mode === 'mastra' --> executeMastraWorkflow() (current, SmartApplyHandler)
  |
  |-- execution_mode === 'smart_apply' | default --> legacy path
```

### 8.3 SmartApplyHandler as Fallback

SmartApplyHandler is NOT removed. It remains available via:

1. `execution_mode: 'smart_apply'` -- explicit legacy mode
2. `execution_mode: 'mastra'` -- current Mastra path with SmartApplyHandler
3. Feature flag `GH_DECISION_ENGINE_ENABLED=false` disables the new path globally

The migration path:
1. **Phase 1**: `mastra_decision` is opt-in via execution_mode
2. **Phase 2**: `mastra_decision` becomes default for `mastra` mode, old handler becomes `mastra_legacy`
3. **Phase 3**: SmartApplyHandler deprecated, decision engine is the only path

### 8.4 Finalization Changes

The existing finalization logic in `executeMastraWorkflow()` extracts `WorkflowState` from the Mastra result and maps it to job status. The decision loop adds new metadata:

```typescript
// In finalization, after extracting finalState:
if (finalState.decisionLoop) {
  const dl = finalState.decisionLoop;
  // Persist decision engine metrics
  await this.supabase
    .from('gh_automation_jobs')
    .update({
      metadata: {
        ...job.metadata,
        decision_engine: {
          iterations: dl.iteration,
          pages_processed: dl.pagesProcessed,
          terminal_state: dl.terminalState,
          total_actions: dl.actionHistory.length,
          cost_breakdown: {
            decision_calls: dl.actionHistory.filter(a => a.action === 'decision').length,
            dom_actions: dl.actionHistory.filter(a => a.layer === 'dom').length,
            stagehand_actions: dl.actionHistory.filter(a => a.layer === 'stagehand').length,
            magnitude_actions: dl.actionHistory.filter(a => a.layer === 'magnitude').length,
          },
        },
      },
    })
    .eq('id', job.id);
}
```

---

## 9. Workflow State Schema Changes

### 9.1 Extended WorkflowState (types.ts)

```typescript
export const workflowState = z.object({
  // ... existing fields unchanged ...
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
  targetUrl: z.string().url(),
  platform: z.string().default('other'),
  qualityPreset: z.enum(['speed', 'balanced', 'quality']),
  budgetUsd: z.number(),
  handler: z.object({ /* unchanged */ }),
  hitl: z.object({ /* unchanged */ }),
  metrics: z.object({ /* unchanged */ }),
  status: z.enum([ /* unchanged */ ]),

  // NEW: Decision loop state
  decisionLoop: z.object({
    iteration: z.number().int().nonnegative().default(0),
    pagesProcessed: z.number().int().nonnegative().default(0),
    currentPageFingerprint: z.string().nullable().default(null),
    previousPageFingerprint: z.string().nullable().default(null),
    samePageCount: z.number().int().nonnegative().default(0),
    actionHistory: z.array(z.object({
      iteration: z.number(),
      action: z.string(),
      target: z.string(),
      result: z.enum(['success', 'partial', 'failed', 'skipped']),
      layer: z.enum(['dom', 'stagehand', 'magnitude']).nullable(),
      costUsd: z.number(),
      durationMs: z.number(),
      fieldsAttempted: z.number().optional(),
      fieldsFilled: z.number().optional(),
      pageFingerprint: z.string(),
      timestamp: z.number(),
    })).default([]),
    loopCostUsd: z.number().default(0),
    terminalState: z.enum([
      'running', 'confirmation', 'review_page', 'submitted',
      'stuck', 'budget_exceeded', 'error', 'max_iterations',
    ]).default('running'),
    terminationReason: z.string().nullable().default(null),
  }).optional(), // Optional for backward compat with existing execute_handler step
});
```

### 9.2 Trimming Action History

To keep serialized state within reasonable bounds (Mastra stores in Postgres):

- Maximum 50 entries in `actionHistory`
- Oldest entries are evicted when the array exceeds 50
- LLM context window only receives the last 10 entries

---

## 10. File Changes Inventory

### 10.1 New Files to Create

| File | Purpose |
|---|---|
| `packages/ghosthands/src/engine/decision/PageDecisionEngine.ts` | LLM decision call implementation |
| `packages/ghosthands/src/engine/decision/DecisionLoopRunner.ts` | Standalone decision loop (shared by Mastra and desktop) |
| `packages/ghosthands/src/engine/decision/types.ts` | DecisionAction, DecisionContext, DecisionResult types |
| `packages/ghosthands/src/engine/decision/prompts.ts` | System prompt builder, platform guardrails |
| `packages/ghosthands/src/engine/decision/terminationDetector.ts` | Termination condition checks |
| `packages/ghosthands/src/engine/decision/actionExecutor.ts` | Routes DecisionAction to execution cascade |
| `packages/ghosthands/src/engine/decision/pageSnapshotBuilder.ts` | Builds DecisionContext from page observation |
| `packages/ghosthands/src/engine/decision/index.ts` | Barrel export |
| `packages/ghosthands/src/workflows/mastra/steps/pageDecisionLoop.ts` | New Mastra step wrapping the loop |
| `packages/ghosthands/src/__tests__/unit/engine/decision/pageDecisionEngine.test.ts` | Unit tests |
| `packages/ghosthands/src/__tests__/unit/engine/decision/terminationDetector.test.ts` | Unit tests |
| `packages/ghosthands/src/__tests__/unit/engine/decision/actionExecutor.test.ts` | Unit tests |

### 10.2 Files to Modify

| File | Changes |
|---|---|
| `packages/ghosthands/src/workflows/mastra/types.ts` | Add `decisionLoop` to WorkflowState schema |
| `packages/ghosthands/src/workflows/mastra/applyWorkflow.ts` | Add `page_decision_loop` step, make `execute_handler` conditional |
| `packages/ghosthands/src/workflows/mastra/steps/factory.ts` | Add `buildPageDecisionLoop()` step builder |
| `packages/ghosthands/src/workers/jobExecutor.ts` | Add `mastra_decision` execution_mode routing, extend finalization |
| `packages/engine/src/types.ts` | Add `useDecisionEngine`, `budgetUsd` to EngineConfig |
| `packages/engine/src/runApplication.ts` | Add `runWithDecisionEngine()` path |
| `packages/engine/src/index.ts` | Export decision engine types |

### 10.3 Files to Deprecate (not remove)

| File | Status |
|---|---|
| `packages/ghosthands/src/workers/taskHandlers/smartApplyHandler.ts` | Mark as `@deprecated` in Phase 3. Still used by `mastra` and `smart_apply` execution modes. |

---

## 11. Migration Path

### Phase 1: Build and Shadow Test (2-3 weeks)

1. Implement `PageDecisionEngine`, `DecisionLoopRunner`, `actionExecutor`
2. Create `page_decision_loop` Mastra step
3. Wire `execution_mode: 'mastra_decision'` in jobExecutor
4. Add feature flag `GH_DECISION_ENGINE_ENABLED` (default: false)
5. Shadow test: run decision engine alongside SmartApplyHandler, log decisions without executing
6. Compare decision accuracy against SmartApplyHandler's actual actions

**Rollout**: Internal testing only. All production jobs use SmartApplyHandler.

### Phase 2: Opt-In with Guardrails (1-2 weeks)

1. Enable `mastra_decision` for specific platforms (start with greenhouse, lever -- simpler ATS)
2. Add per-user opt-in via execution_mode in job creation
3. Monitor: decision accuracy, cost per job, completion rate, stuck rate
4. Add auto-fallback: if decision engine fails 3x, fall back to SmartApplyHandler for the job

**Rollout**: 10% of jobs on supported platforms.

### Phase 3: Default Path (1-2 weeks)

1. Make `mastra_decision` the default for `execution_mode: 'mastra'`
2. SmartApplyHandler available via `execution_mode: 'smart_apply_legacy'`
3. Monitor for regressions

**Rollout**: 100% of new jobs.

### Phase 4: Desktop Integration (parallel)

1. Add `useDecisionEngine` to desktop EngineConfig
2. Wire `DecisionLoopRunner` in `runApplication()`
3. Desktop app opts in via settings toggle

---

## 12. Risk Assessment

### 12.1 High Risk

| Risk | Impact | Mitigation |
|---|---|---|
| **LLM decision hallucination** | Wrong action (e.g., clicking Submit instead of Next) | Constrained tool_use schema; guardrail layer that blocks `click_submit` unless explicit user confirmation; heuristic double-check on dangerous actions |
| **Cost regression** | Decision engine LLM calls add cost on top of execution | Haiku is ~$0.001/call; budget cap enforced; monitor cost per job vs SmartApplyHandler baseline |
| **Latency regression** | Extra LLM call per iteration adds 500-1000ms | Haiku latency is 300-500ms; decision call runs in parallel with page load observation; overall latency should be comparable since SmartApplyHandler also makes LLM calls for form filling |

### 12.2 Medium Risk

| Risk | Impact | Mitigation |
|---|---|---|
| **v3 layers not production-ready** | DOMHand/StagehandHand/MagnitudeHand may have bugs | SmartApplyHandler's `fillFormOnPage()` already uses similar DOM + Magnitude fallback patterns; v3 layers were tested in isolation; gradual rollout catches issues early |
| **WorkflowState size bloat** | Action history grows large for complex applications | Cap at 50 entries; trim old entries; decision LLM only sees last 10 |
| **HITL resume breaks** | Decision loop state may be inconsistent after resume | Re-observe page on resume (browser state is ground truth); action history persists correctly in WorkflowState |

### 12.3 Low Risk

| Risk | Impact | Mitigation |
|---|---|---|
| **Desktop path regression** | `useDecisionEngine` flag off by default | No change to existing desktop behavior unless opted in |
| **Backward compatibility** | New WorkflowState fields | `decisionLoop` is optional in schema; existing `execute_handler` step ignores it |

---

## 13. Appendix: Sequence Diagrams

### 13.1 Page Decision Loop — Happy Path

```
JobExecutor                Mastra Workflow          PageDecisionLoop Step         DecisionEngine          ActionExecutor
    |                           |                           |                           |                      |
    |-- executeMastraWorkflow() |                           |                           |                      |
    |                           |                           |                           |                      |
    |                    [Step 1: check_blockers]           |                           |                      |
    |                           |--- no blocker ----------->|                           |                      |
    |                           |                           |                           |                      |
    |                    [Step 2: page_decision_loop]       |                           |                      |
    |                           |                           |                           |                      |
    |                           |                    [Iteration 1]                      |                      |
    |                           |                           |--- observe(page) -------->|                      |
    |                           |                           |<-- PageSnapshot ----------|                      |
    |                           |                           |                           |                      |
    |                           |                           |--- decide(context) ------>|                      |
    |                           |                           |<-- {fill_form, ...} ------|                      |
    |                           |                           |                           |                      |
    |                           |                           |--- execute(fill_form) ----|----> DOMHand.execute()
    |                           |                           |                           |  (fields filled via DOM)
    |                           |                           |<-- {success, 5 filled} ---|<---- result
    |                           |                           |                           |                      |
    |                           |                           |--- checkTermination() --->|                      |
    |                           |                           |<-- null (continue) -------|                      |
    |                           |                           |                           |                      |
    |                           |                    [Iteration 2]                      |                      |
    |                           |                           |--- observe(page) -------->|                      |
    |                           |                           |<-- PageSnapshot ----------|                      |
    |                           |                           |                           |                      |
    |                           |                           |--- decide(context) ------>|                      |
    |                           |                           |<-- {click_next, ...} -----|                      |
    |                           |                           |                           |                      |
    |                           |                           |--- execute(click_next) ---|----> tryDOMClick()
    |                           |                           |                           |  (Next button clicked)
    |                           |                           |<-- {success} -------------|<---- result
    |                           |                           |                           |                      |
    |                           |                    [... more iterations ...]          |                      |
    |                           |                           |                           |                      |
    |                           |                    [Iteration N]                      |                      |
    |                           |                           |--- decide(context) ------>|                      |
    |                           |                           |<-- {stop_for_review} -----|                      |
    |                           |                           |                           |                      |
    |                           |                           |--- checkTermination() --->|                      |
    |                           |                           |<-- {review_page} ---------|                      |
    |                           |                           |                           |                      |
    |                           |<-- state.status = 'awaiting_review' ----              |                      |
    |                           |                           |                           |                      |
    |<-- finalize result -------|                           |                           |                      |
```

### 13.2 Page Decision Loop — HITL Suspend/Resume

```
PageDecisionLoop Step         BlockerDetector          Mastra Engine              JobExecutor (HITL wait)
    |                              |                       |                           |
    |  [Iteration 3]              |                       |                           |
    |--- observe(page) ---------->|                       |                           |
    |<-- blockers: [captcha] -----|                       |                           |
    |                              |                       |                           |
    |  (update state, notify VALET)                       |                           |
    |--- suspend({captcha}) ----->|                       |                           |
    |                              |--- serialize state -->|                           |
    |                              |                       |--- result.status='suspended'
    |                              |                       |                           |
    |                              |                       |    [wait for human...]    |
    |                              |                       |    [LISTEN/NOTIFY]        |
    |                              |                       |    [human solves captcha] |
    |                              |                       |                           |
    |                              |                       |<-- resume(resolutionType) |
    |<-- resumeData={manual} -----|                       |                           |
    |                              |                       |                           |
    |  [Re-enter loop]            |                       |                           |
    |--- injectResolution() ----->|                       |                           |
    |--- re-observe(page) ------->|                       |                           |
    |<-- no blockers -------------|                       |                           |
    |                              |                       |                           |
    |  [Continue from iteration 3]|                       |                           |
    |--- decide(context) -------->|                       |                           |
    |                              |                       |                           |
```

### 13.3 Desktop Path — Decision Engine

```
Desktop App              runApplication()           DecisionLoopRunner          PageDecisionEngine
    |                         |                           |                           |
    |-- runApplication({      |                           |                           |
    |     useDecisionEngine:  |                           |                           |
    |     true, ...})         |                           |                           |
    |                         |                           |                           |
    |                  [Launch browser]                   |                           |
    |                         |                           |                           |
    |                  [Create DecisionLoopRunner]        |                           |
    |                         |--- run() --------------->|                           |
    |                         |                           |                           |
    |                         |                    [Same loop as hosted,             |
    |                         |                     but no Mastra, no Postgres,      |
    |                         |                     no HITL suspend]                 |
    |                         |                           |                           |
    |                         |                    [Iteration 1..N]                  |
    |                         |                           |--- decide() ------------>|
    |                         |                           |<-- action ---------------|
    |                         |                           |--- execute(action) ----->|
    |<-- onProgress events ---|<-- emit() ---------------|                           |
    |                         |                           |                           |
    |                         |<-- RunResult -------------|                           |
    |<-- result --------------|                           |                           |
```

### 13.4 Execution Cascade — Per Field

```
ActionExecutor          DOMHand              StagehandHand          MagnitudeHand
    |                      |                      |                      |
    |  [fill "email" field]|                      |                      |
    |--- execute() ------->|                      |                      |
    |                      |-- nativeInputValue() |                      |
    |                      |-- dispatchEvent()    |                      |
    |                      |-- verify readback()  |                      |
    |                      |                      |                      |
    |  (Case A: DOM succeeds)                     |                      |
    |<-- {success, layer:'dom', cost:$0} ---------|                      |
    |                      |                      |                      |
    |  (Case B: DOM fails — element not found)    |                      |
    |                      |--- escalate -------->|                      |
    |                      |                      |-- observe('email')   |
    |                      |                      |-- act('fill email')  |
    |                      |                      |-- verify readback()  |
    |                      |                      |                      |
    |  (Case B success)    |                      |                      |
    |<-- {success, layer:'stagehand', cost:$0.0005}                     |
    |                      |                      |                      |
    |  (Case C: Stagehand fails — custom widget)  |                      |
    |                      |                      |--- escalate -------->|
    |                      |                      |                      |-- act('Type email')
    |                      |                      |                      |-- screenshot verify
    |                      |                      |                      |
    |  (Case C success)    |                      |                      |
    |<-- {success, layer:'magnitude', cost:$0.005}|                      |
```

---

## Appendix: Constants

```typescript
// Decision loop limits
const MAX_ITERATIONS = 100;          // Absolute maximum loop iterations
const MAX_FORM_PAGES = 15;           // Maximum form pages (matches SmartApplyHandler)
const MAX_SAME_PAGE_COUNT = 6;       // Stuck detection threshold
const MAX_CONSECUTIVE_FAILURES = 3;  // Error accumulation threshold
const MAX_ACTION_HISTORY = 50;       // Action history cap in WorkflowState
const LLM_CONTEXT_HISTORY = 10;      // Actions sent to LLM for context

// Timeouts
const DOM_ACTION_TIMEOUT_MS = 5_000;
const STAGEHAND_ACTION_TIMEOUT_MS = 15_000;
const MAGNITUDE_ACTION_TIMEOUT_MS = 30_000;
const ITERATION_TIMEOUT_MS = 60_000;
const PAGE_LOAD_WAIT_MS = 3_000;

// Cost
const DECISION_CALL_COST_ESTIMATE = 0.001;  // Haiku decision call
const DOM_ACTION_COST = 0;
const STAGEHAND_ACTION_COST = 0.0005;
const MAGNITUDE_ACTION_COST = 0.005;
```
