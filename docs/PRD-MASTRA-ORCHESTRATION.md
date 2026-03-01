# PRD: Mastra.ai Orchestration Layer for GhostHands

**Author:** Spencer + Claude
**Date:** 2026-02-28
**Status:** Draft — Awaiting Review
**Branch:** `spencer-magnitude-hand`

---

## 1. Problem Statement

GhostHands has three execution tiers ("Hands") for filling job applications:

| Hand | Cost/Action | How It Works |
|------|-------------|--------------|
| **DOMHand** | $0.000 | Pure Playwright DOM injection, zero LLM |
| **StagehandHand** | ~$0.0005 | A11y tree + DOM fill, LLM fallback |
| **MagnitudeHand** | ~$0.005 | Full vision LLM agent (screenshots + reasoning) |

The current V3 engine (`SectionOrchestrator` + `V3ExecutionEngine`) orchestrates these hands with hand-rolled imperative logic: try DOM first, escalate to Stagehand on failure, escalate to Magnitude as last resort. This works, but:

1. **Orchestration logic is scattered** across `SectionOrchestrator.ts`, `V3ExecutionEngine.ts`, and individual `LayerHand` subclasses
2. **The multi-page flow** (observe → plan → execute → verify → navigate → repeat) is an imperative loop, not a declarative graph — harder to reason about, extend, and debug
3. **HITL suspend/resume** is custom Postgres LISTEN/NOTIFY plumbing — fragile and hard to test
4. **No unified observability** — cost tracking, tracing, and error classification are separate systems
5. **Model routing** is manual (hardcoded provider strings per tier)
6. **Adding a 4th hand** (e.g., ActionBook, Browserbase, a future tool) requires touching orchestration internals

**Goal:** Introduce Mastra.ai as the orchestration backbone to make hand coordination declarative, observable, and extensible — without rewriting the hands themselves.

---

## 2. Proposed Solution

### Core Idea

Use Mastra as the **full agentic framework** — not just for workflow orchestration, but for agents, tools, and memory management. The system maps onto Mastra's primitives naturally:

| GhostHands Concept | Mastra Primitive | Why |
|---------------------|-----------------|-----|
| SmartApplyHandler (page reasoning, navigation decisions) | **Agent** | Makes LLM-driven decisions about page types, navigation, error recovery |
| DOMHand, StagehandHand, MagnitudeHand | **Tools** | Discrete capabilities the agent invokes to fill fields |
| PageScanner, BlockerDetector, FieldMatcher | **Tools** | Observation and planning capabilities |
| Multi-page application flow | **Workflow** | Deterministic loop: observe → fill → verify → navigate → repeat |
| User profile, QA overrides, session state | **Memory / Context** | Persisted across pages, available to all agents and tools |
| Cookbook replay | **Workflow step** | Short-circuits the agent when a saved manual exists |

The key insight: **the Hands are tools, the Handlers are agents, the page loop is a workflow.**

```
┌─────────────────────────────────────────────────────────┐
│                   Mastra Workflow                        │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌─────────┐           │
│  │ Observe  │───▶│  Plan    │───▶│ Execute │──┐        │
│  │ (scan)   │    │ (match)  │    │ (fill)  │  │        │
│  └──────────┘    └──────────┘    └─────────┘  │        │
│       ▲                              │        │        │
│       │                         ┌────▼────┐   │        │
│       │                         │ Verify  │   │        │
│       │                         └────┬────┘   │        │
│       │                              │        │        │
│       │    ┌─────────┐          ┌────▼────┐   │        │
│       │    │ Record  │◀─────────│Navigate │   │        │
│       │    │(cookbook)│          │(next pg)│   │        │
│       │    └─────────┘          └────┬────┘   │        │
│       │                              │        │        │
│       └──────────────────────────────┘        │        │
│                                               │        │
│                                          ┌────▼────┐   │
│                                          │  HITL   │   │
│                                          │(suspend)│   │
│                                          └─────────┘   │
└─────────────────────────────────────────────────────────┘
```

### What Mastra Replaces vs. What It Doesn't

| Component | Current | With Mastra | Change Type |
|-----------|---------|-------------|-------------|
| SmartApplyHandler (4,471 lines) | Imperative handler class with hardcoded logic | **supervisorAgent** + sub-agents | Replace |
| formFiller.ts (~600 lines) | Imperative scan→answer→fill pipeline | **formFillerAgent** with fill tools | Replace |
| Page classification (4-tier cascade) | Hardcoded if/else in handler | **pageClassifierAgent** with classify tools | Replace |
| Platform-specific handlers | Separate handler classes per ATS | Same agents + platform-aware tools | Simplify |
| Multi-page loop | `SectionOrchestrator.run()` imperative loop | Mastra `dowhile` workflow | Replace |
| Escalation logic | `if (domFailed) tryStagehand()` | Agent tool selection OR `.branch()` workflow | Replace |
| HITL suspend/resume | Custom Postgres LISTEN/NOTIFY | Mastra `suspend()` / `resume()` + `requestHumanHelp` tool | Replace |
| Cross-page context | Instance variables on handler class | Mastra Memory (persisted, survives restarts) | Replace |
| Model routing | Hardcoded strings per tier | Mastra `"provider/model"` string routing | Replace |
| Observability/tracing | Custom logger + Prometheus | Mastra tracing → Langfuse/OTel | Augment |
| DOMHand logic | `layers/DOMHand.ts` | Unchanged (wrapped as `fillWithDOM` tool) | Wrap |
| StagehandHand logic | `layers/StagehandHand.ts` | Unchanged (wrapped as `fillWithStagehand` tool) | Wrap |
| MagnitudeHand logic | `layers/MagnitudeHand.ts` | Unchanged (wrapped as `fillWithMagnitude` tool) | Wrap |
| Cost tracking | `costControl.ts` | Unchanged (Mastra `onStepFinish` feeds into it) | Keep |
| Cookbook system | `CookbookExecutorV3` + `ManualStore` | Unchanged (wrapped as `lookupCookbook` + `recordToCookbook` tools) | Wrap |
| Job queue / worker | `JobPoller` + `JobExecutor` | Unchanged (Mastra runs inside executor) | Keep |
| API layer | Hono REST API | Unchanged | Keep |

**Key principle: Mastra orchestrates; Hands are tools; Handlers become agents.** The Hands remain unchanged internally. Mastra replaces the handler orchestration glue AND adds proper agent reasoning, tool composition, and memory management.

---

## 3. Technical Design

### 3.1 Agent Definitions

The current handlers contain genuine agentic logic — LLM-driven page classification, multi-step reasoning, error recovery, and navigation decisions. These map to Mastra Agents.

#### 3.1.1 ApplicationAgent (replaces SmartApplyHandler)

The top-level agent that reasons about multi-page job applications. This is the "brain" — it decides what page it's on, what to do, when to escalate, when to stop.

```typescript
// agents/applicationAgent.ts
import { Agent } from '@mastra/core/agent'
import { Memory } from '@mastra/memory'

export const applicationAgent = new Agent({
  id: 'application-agent',
  name: 'Job Application Agent',

  // Dynamic instructions based on platform + user context
  instructions: async ({ requestContext }) => {
    const platform = requestContext?.platform // 'workday' | 'greenhouse' | 'lever' | 'generic'
    const profile = requestContext?.userProfile
    return `
You are filling out a job application for ${profile.first_name} ${profile.last_name}.
Platform: ${platform}

## Your Tools
- scanPage: Scan the current page for form fields and buttons (FREE, always do this first)
- classifyPage: Determine what type of page you're on (listing, form, review, login, etc.)
- detectBlockers: Check for CAPTCHAs, login walls, bot detection
- fillWithDOM: Fill fields via direct DOM injection (FREE, try first)
- fillWithStagehand: Fill fields via a11y tree + LLM (CHEAP, use if DOM fails)
- fillWithMagnitude: Fill fields via vision LLM agent (EXPENSIVE, last resort)
- verifyFills: Check that fields were filled correctly via DOM readback
- clickNext: Navigate to the next page
- uploadResume: Attach resume file to file input
- generateAnswers: Generate answers for open-ended questions using user profile
- lookupCookbook: Check if we have a saved manual for this URL

## Decision Rules
1. ALWAYS scanPage before filling — know what you're working with
2. ALWAYS try fillWithDOM first ($0), then fillWithStagehand ($0.0005), then fillWithMagnitude ($0.005)
3. NEVER submit the application — stop at review/confirmation pages
4. If you see a CAPTCHA or login wall, use detectBlockers and request human help
5. Track your cost — stop if budget exceeded

## Context
${buildProfileBlock(profile)}
${buildQAOverridesBlock(requestContext?.qaOverrides)}
    `
  },

  // Model selection based on complexity
  model: async ({ requestContext }) => {
    switch (requestContext?.qualityPreset) {
      case 'speed':   return 'google/gemini-2.0-flash'
      case 'quality': return 'anthropic/claude-haiku-4-5'
      default:        return 'google/gemini-2.0-flash'
    }
  },

  tools: {
    scanPage, classifyPage, detectBlockers,
    fillWithDOM, fillWithStagehand, fillWithMagnitude,
    verifyFills, clickNext, uploadResume,
    generateAnswers, lookupCookbook,
  },

  maxSteps: 50, // safety cap — most applications are 5-15 steps

  // Memory for cross-page context
  memory: applicationMemory,

  // Cost tracking hook
  onStepFinish: async ({ step, usage }) => {
    costTracker.recordAgentStep(usage.inputTokens, usage.outputTokens, step.model)
  },

  onFinish: async ({ usage, result }) => {
    costTracker.recordTotal(usage)
    traceRecorder.save(result)
  },
})
```

#### 3.1.2 FormFillerAgent (replaces formFiller.ts logic)

A focused sub-agent for the specific task of filling a single page of form fields. The ApplicationAgent delegates to this when it encounters a form page.

```typescript
// agents/formFillerAgent.ts
export const formFillerAgent = new Agent({
  id: 'form-filler-agent',
  name: 'Form Filler',

  instructions: `
You fill form fields on a single page. You receive a list of fields and user data.

Strategy:
1. Use fillWithDOM for all fields first (free, batch operation)
2. Check which fields failed (DOM readback)
3. Use fillWithStagehand for failed fields (cheap, one at a time)
4. Use fillWithMagnitude ONLY for fields that both DOM and Stagehand failed on
5. Verify all fills at the end

For dropdowns and date pickers, try DOM-direct first. Only escalate if the
widget is a custom/non-standard implementation.

For open-ended questions, check qa_overrides first. If no override exists,
use generateAnswers to create an appropriate response from the user profile.
  `,

  model: 'google/gemini-2.0-flash', // cheap — this agent just coordinates tools

  tools: {
    fillWithDOM, fillWithStagehand, fillWithMagnitude,
    verifyFills, generateAnswers, fillDropdown, fillDatePicker,
  },

  maxSteps: 20,
})
```

#### 3.1.3 PageClassifierAgent (replaces 4-tier page detection)

A lightweight agent that determines page type. Currently this is a 4-tier cascade in SmartApplyHandler (URL → DOM → Platform DOM → LLM). As a Mastra agent, it can use tools to inspect the page and reason about what it sees.

```typescript
// agents/pageClassifierAgent.ts
export const pageClassifierAgent = new Agent({
  id: 'page-classifier',
  name: 'Page Classifier',

  instructions: `
Classify the current page into one of these types:
- job_listing: Job description with an Apply button
- login / google_signin: Authentication required
- account_creation: New account registration form
- application_form: Form fields to fill (personal info, experience, questions)
- review: Summary of entered data before submission
- confirmation: Application submitted successfully
- error: Something went wrong

Use classifyByUrl first (free). If inconclusive, use classifyByDOM (free).
Only use classifyByLLM as a last resort (costs money).

Safety overrides:
- If classified as "account_creation" but page has 5+ form fields → it's "application_form"
- If classified as "review" but page has editable fields → it's "application_form"
  `,

  model: 'google/gemini-2.0-flash',
  tools: { classifyByUrl, classifyByDOM, classifyByLLM, scanPage },
  maxSteps: 3, // should resolve in 1-2 tool calls
})
```

#### 3.1.4 Supervisor Agent (top-level coordinator)

Uses Mastra's supervisor pattern to delegate between the specialized agents:

```typescript
// agents/supervisor.ts
export const supervisorAgent = new Agent({
  id: 'ghosthands-supervisor',
  name: 'GhostHands Supervisor',

  instructions: `
You coordinate a job application. You have three specialist agents:
- pageClassifierAgent: Determines what type of page we're on
- formFillerAgent: Fills form fields on the current page
- applicationAgent: Handles navigation, error recovery, and multi-page flow

Workflow:
1. Ask pageClassifierAgent what page we're on
2. Based on result:
   - job_listing → applicationAgent to click Apply
   - application_form → formFillerAgent to fill fields
   - login → suspend for human intervention
   - review → stop (never submit)
   - confirmation → done
3. After filling, ask applicationAgent to navigate to next page
4. Repeat until done or budget exhausted
  `,

  model: 'google/gemini-2.0-flash',
  agents: { pageClassifierAgent, formFillerAgent, applicationAgent },
  memory: applicationMemory, // shared memory across all sub-agents
})
```

---

### 3.2 Tool Catalog

Every discrete capability becomes a Mastra tool. These are the building blocks that agents invoke.

#### 3.2.1 Observation Tools (Free / Cheap)

```typescript
// tools/observation.ts
import { createTool } from '@mastra/core/tools'

export const scanPage = createTool({
  id: 'scan-page',
  description: 'Scroll the page and extract all form fields, buttons, file inputs, dropdowns, and date pickers. Returns a structured PageModel. Cost: $0 (pure DOM).',
  inputSchema: z.object({}),
  outputSchema: PageModelSchema,
  execute: async ({ context }) => {
    const scanner = new PageScanner(context.page)
    return await scanner.scan()
  },
})

export const classifyByUrl = createTool({
  id: 'classify-by-url',
  description: 'Classify page type from URL patterns alone. Instant, zero cost. Returns null if URL is not recognizable.',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: z.object({ pageType: PageTypeSchema.nullable() }),
  execute: async ({ context }) => {
    return { pageType: detectPageByUrl(context.url) }
  },
})

export const classifyByDOM = createTool({
  id: 'classify-by-dom',
  description: 'Classify page type by scanning DOM for patterns (password fields, apply buttons, review indicators). Cost: $0, ~50ms.',
  inputSchema: z.object({}),
  outputSchema: z.object({ pageType: PageTypeSchema.nullable(), confidence: z.number() }),
  execute: async ({ context }) => {
    return await detectPageByDOM(context.page)
  },
})

export const classifyByLLM = createTool({
  id: 'classify-by-llm',
  description: 'Classify page type using LLM vision (screenshot + URL). EXPENSIVE — only use if URL and DOM classification were inconclusive. Cost: ~$0.001.',
  inputSchema: z.object({ urlHint: z.string().optional() }),
  outputSchema: z.object({ pageType: PageTypeSchema, confidence: z.number() }),
  execute: async ({ context }) => {
    return await context.adapter.extract(
      'Classify this page type',
      z.object({ page_type: PageTypeSchema, page_title: z.string() })
    )
  },
})

export const detectBlockers = createTool({
  id: 'detect-blockers',
  description: 'Check for CAPTCHAs, login walls, bot detection, rate limiting. Uses 3-level detection: URL → DOM → LLM observe. Returns blocker type and confidence.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    blocked: z.boolean(),
    blockerType: z.enum(['captcha', 'login', '2fa', 'bot_check', 'rate_limited']).optional(),
    confidence: z.number(),
  }),
  execute: async ({ context }) => {
    const detector = new BlockerDetector(context.adapter)
    return await detector.detect()
  },
})
```

#### 3.2.2 Form Filling Tools (Tiered Cost)

```typescript
// tools/filling.ts

export const fillWithDOM = createTool({
  id: 'fill-with-dom',
  description: 'Fill form fields using direct DOM injection (nativeInputValueSetter + dispatchEvent). Handles text inputs, selects, checkboxes, radio buttons. Cost: $0. Use this FIRST for all fields.',
  inputSchema: z.object({
    fields: z.array(FieldFillSchema), // [{ selector, value, type }]
  }),
  outputSchema: z.object({
    filled: z.array(z.string()),     // selectors that succeeded
    failed: z.array(FieldFillSchema), // fields that couldn't be filled
  }),
  execute: async ({ context }) => {
    const executor = new DOMActionExecutor(context.page)
    return await executor.fillBatch(context.fields)
  },
})

export const fillWithStagehand = createTool({
  id: 'fill-with-stagehand',
  description: 'Fill a single form field using Stagehand a11y tree observation + act(). Use when DOM fill failed (custom widgets, React controlled inputs). Cost: ~$0.0005 per field.',
  inputSchema: z.object({
    field: FieldFillSchema,
    instruction: z.string(), // natural language: "Select 'Male' from the Gender dropdown"
  }),
  outputSchema: z.object({ success: z.boolean(), cost: z.number() }),
  execute: async ({ context }) => {
    const hand = new StagehandHand(context.page)
    return await hand.fillSingle(context.field, context.instruction)
  },
})

export const fillWithMagnitude = createTool({
  id: 'fill-with-magnitude',
  description: 'Fill a form field using full vision LLM agent (screenshot + reasoning + action). LAST RESORT — only use when both DOM and Stagehand failed. Cost: ~$0.005 per field.',
  inputSchema: z.object({
    instruction: z.string(), // "Type \'John\' into the First Name field"
  }),
  outputSchema: z.object({ success: z.boolean(), cost: z.number(), message: z.string() }),
  execute: async ({ context }) => {
    return await context.adapter.act(context.instruction)
  },
})

export const fillDropdown = createTool({
  id: 'fill-dropdown',
  description: 'Fill a dropdown/select field. Tries DOM-direct for native <select> elements. For custom dropdowns (Workday, React Select), uses 8-level label discovery + programmatic selection. Cost: $0 for native, ~$0.0005 for custom.',
  inputSchema: z.object({
    selector: z.string(),
    value: z.string(),
    isCustom: z.boolean().default(false),
  }),
  outputSchema: z.object({ success: z.boolean(), cost: z.number() }),
  execute: async ({ context }) => {
    if (!context.isCustom) {
      return await domSelectOption(context.page, context.selector, context.value)
    }
    return await customDropdownFill(context.page, context.selector, context.value)
  },
})

export const fillDatePicker = createTool({
  id: 'fill-date-picker',
  description: 'Fill a date picker field. Uses native HTML date input when possible ($0). Falls back to Stagehand for custom calendar widgets (~$0.0005).',
  inputSchema: z.object({ selector: z.string(), date: z.string() }),
  outputSchema: z.object({ success: z.boolean(), cost: z.number() }),
  execute: async ({ context }) => {
    return await dateFill(context.page, context.selector, context.date)
  },
})
```

#### 3.2.3 Verification & Recording Tools

```typescript
// tools/verification.ts

export const verifyFills = createTool({
  id: 'verify-fills',
  description: 'Verify that form fields were filled correctly by reading back DOM values. Cost: $0 (pure DOM readback).',
  inputSchema: z.object({
    expectedFills: z.array(z.object({ selector: z.string(), expectedValue: z.string() })),
  }),
  outputSchema: z.object({
    verified: z.array(z.string()),
    mismatches: z.array(z.object({ selector: z.string(), expected: z.string(), actual: z.string() })),
  }),
  execute: async ({ context }) => {
    const verifier = new VerificationEngine(context.page)
    return await verifier.verify(context.expectedFills)
  },
})

export const recordToCookbook = createTool({
  id: 'record-to-cookbook',
  description: 'Save successful fill actions to the cookbook (ManualStore) for replay on future applications to the same URL pattern.',
  inputSchema: z.object({
    urlPattern: z.string(),
    actions: z.array(CookbookActionSchema),
    pageFingerprint: z.string(),
  }),
  outputSchema: z.object({ manualId: z.string(), healthScore: z.number() }),
  execute: async ({ context }) => {
    return await manualStore.save(context.urlPattern, context.actions)
  },
})

export const lookupCookbook = createTool({
  id: 'lookup-cookbook',
  description: 'Check if a saved manual exists for this URL pattern + task type. Returns the manual with health score if found. Manuals with health < 0.3 should be skipped.',
  inputSchema: z.object({ url: z.string(), taskType: z.string() }),
  outputSchema: z.object({
    found: z.boolean(),
    manual: CookbookManualSchema.optional(),
    healthScore: z.number().optional(),
  }),
  execute: async ({ context }) => {
    const manual = await manualStore.lookup(context.url, context.taskType)
    return { found: !!manual, manual, healthScore: manual?.health_score }
  },
})
```

#### 3.2.4 Navigation & Interaction Tools

```typescript
// tools/navigation.ts

export const clickNext = createTool({
  id: 'click-next',
  description: 'Click the Next/Continue/Submit button to advance to the next page. Uses DOM-direct click (no LLM). Returns whether a review page was detected.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    result: z.enum(['clicked', 'review_detected', 'not_found']),
  }),
  execute: async ({ context }) => {
    const config = getPlatformConfig(context.platform)
    return { result: await config.clickNextButton(context.adapter) }
  },
})

export const uploadResume = createTool({
  id: 'upload-resume',
  description: 'Attach a resume file to a file input. Tries direct setInputFiles first ($0), falls back to CDP file chooser interception.',
  inputSchema: z.object({ filePath: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ context }) => {
    return await uploadResumeFile(context.page, context.filePath)
  },
})

export const generateAnswers = createTool({
  id: 'generate-answers',
  description: 'Generate answers for form fields using user profile data + QA overrides. Makes a single LLM call (Claude Haiku) with all field labels + user context. Cost: ~$0.001 for batch.',
  inputSchema: z.object({
    fields: z.array(z.object({ label: z.string(), type: z.string(), options: z.array(z.string()).optional() })),
    userProfile: UserDataSchema,
    qaOverrides: z.record(z.string()).optional(),
  }),
  outputSchema: z.object({
    answers: z.record(z.string()), // label → answer
  }),
  execute: async ({ context }) => {
    // Check QA overrides first (free)
    const answers: Record<string, string> = {}
    for (const field of context.fields) {
      const override = findQAOverride(field.label, context.qaOverrides)
      if (override) {
        answers[field.label] = override
      }
    }
    // Generate remaining via LLM
    const unanswered = context.fields.filter(f => !answers[f.label])
    if (unanswered.length > 0) {
      const generated = await generateFieldAnswers(unanswered, context.userProfile)
      Object.assign(answers, generated)
    }
    return { answers }
  },
})

export const detectValidationErrors = createTool({
  id: 'detect-validation-errors',
  description: 'Check if the page shows validation errors after clicking Next (red text, error banners, required field highlights). Cost: $0 (DOM scan).',
  inputSchema: z.object({}),
  outputSchema: z.object({
    hasErrors: z.boolean(),
    errorMessages: z.array(z.string()),
    errorFields: z.array(z.string()), // selectors of fields with errors
  }),
  execute: async ({ context }) => {
    return await scanForValidationErrors(context.page)
  },
})
```

#### 3.2.5 HITL Tools (Suspend Workflow)

```typescript
// tools/hitl.ts

export const requestHumanHelp = createTool({
  id: 'request-human-help',
  description: 'Suspend the workflow and request human intervention. Used for CAPTCHAs, login walls, 2FA codes. The workflow pauses until VALET resumes it with resolution data.',
  inputSchema: z.object({
    reason: z.enum(['captcha', 'login_required', '2fa', 'bot_check', 'manual_review']),
    message: z.string(),
  }),
  outputSchema: z.object({
    resolution: z.object({
      type: z.enum(['code_entry', 'credentials', 'manual', 'skip']),
      data: z.record(z.string()).optional(),
    }),
  }),
  // This tool suspends the workflow — Mastra handles state persistence
  requireApproval: true,
  execute: async ({ context, suspend }) => {
    const screenshot = await context.page.screenshot()
    const resolution = await suspend({
      reason: context.reason,
      message: context.message,
      screenshot: screenshot.toString('base64'),
      jobId: context.jobId,
    })
    return { resolution }
  },
})
```

---

### 3.3 Memory & Context Management

The current system passes context through function arguments and instance variables. Mastra's memory system gives us structured, persistent context that all agents and tools can access.

#### 3.3.1 Application Context (Cross-Page State)

```typescript
// memory/applicationMemory.ts
import { Memory } from '@mastra/memory'
import { LibSQLStore } from '@mastra/libsql'

export const applicationMemory = new Memory({
  storage: new LibSQLStore({ url: process.env.DATABASE_URL }),
})

// Context structure maintained across pages
interface ApplicationContext {
  // User data (immutable for the session)
  userProfile: UserProfile
  qaOverrides: Record<string, string>
  resumePath: string

  // Platform detection (set once, used throughout)
  platform: 'workday' | 'greenhouse' | 'lever' | 'linkedin' | 'amazon' | 'generic'
  platformConfig: PlatformConfig

  // Page navigation state (updated each page)
  currentPage: number
  currentUrl: string
  pageHistory: Array<{ url: string, pageType: string, fieldsCount: number }>

  // Safety guards (prevent infinite loops)
  lastPageSignature: string    // hash of URL + visible content
  stuckCount: number           // consecutive times same signature seen
  applyClicked: boolean        // prevents re-classifying as job_listing
  loginAttempted: boolean      // prevents create-account loop

  // Cost tracking
  totalCost: number
  costBreakdown: { dom: number, stagehand: number, magnitude: number, agent: number }
  budget: number

  // Filled fields log (for verification and cookbook)
  filledFields: Array<{
    page: number
    selector: string
    value: string
    hand: 'dom' | 'stagehand' | 'magnitude'
    verified: boolean
  }>
}
```

#### 3.3.2 How Context Flows Through the System

```
JobExecutor creates initial context
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Mastra Memory (persisted in LibSQL/Supabase)    │
│                                                 │
│  userProfile ──────────────────────────────────▶ All agents read this
│  qaOverrides ──────────────────────────────────▶ generateAnswers tool checks first
│  platform ─────────────────────────────────────▶ Platform-specific tool behavior
│  pageHistory ──────────────────────────────────▶ Stuck detection, SPA guards
│  costBreakdown ────────────────────────────────▶ Budget enforcement, hand selection
│  filledFields ─────────────────────────────────▶ Cookbook recording at end
│                                                 │
│  Updated by: agents after each step             │
│  Read by: tools at execution time               │
│  Persisted: survives HITL suspend/resume        │
└─────────────────────────────────────────────────┘
```

#### 3.3.3 Context vs. Current System

| Context Type | Current Implementation | With Mastra |
|---|---|---|
| User profile | `input_data.user_data` passed via function args | `memory.userProfile` — accessible to all agents/tools |
| QA overrides | `input_data.qa_overrides` threaded through calls | `memory.qaOverrides` — checked by `generateAnswers` tool |
| Page state | Instance variables on SmartApplyHandler (`this.lastPageSignature`, `this.applyClicked`) | `memory.pageHistory`, `memory.stuckCount` — persisted across HITL suspends |
| Cost tracking | `CostTracker` object passed around | `memory.costBreakdown` + Mastra `onStepFinish` hooks feed it |
| Filled fields log | TraceRecorder collects during execution | `memory.filledFields` — agents append, cookbook step reads at end |
| Browser session | `SessionManager` encrypts/saves cookies | **Unchanged** — browser state stays in SessionManager (not Mastra memory) |

Key advantage: **context survives HITL suspend/resume**. Currently, if a job suspends for a CAPTCHA and resumes 10 minutes later, the SmartApplyHandler instance variables are lost (process may have restarted). With Mastra memory, all context is persisted and restored automatically.

#### 3.3.4 Browser State Boundary

Mastra memory handles **logical state** (user data, page history, cost). Browser state (cookies, localStorage, CDP session) stays in `SessionManager` — it's not serializable into Mastra's storage and doesn't need to be. The Playwright `Page` object is injected into tool execution context at runtime, never serialized.

```typescript
// Runtime context injection — Page object is NOT in Mastra memory
const run = await applyWorkflow.createRun({
  runtimeContext: {
    page: adapter.page,           // Playwright Page — runtime only
    adapter: adapter,             // BrowserAutomationAdapter — runtime only
    sessionManager: sessionMgr,   // For cookie persistence — runtime only
  },
})
```

---

### 3.4 Handler → Agent Mapping

The current handler registry dispatches to imperative handler classes. With Mastra, each handler becomes an agent or workflow composition:

| Current Handler | Lines | What It Does | Mastra Mapping |
|---|---|---|---|
| **SmartApplyHandler** | 4,471 | Multi-page orchestration, page classification, platform detection, form filling, navigation, error recovery | **supervisorAgent** (delegates to pageClassifier, formFiller, applicationAgent) |
| **AgentApplyHandler** | 694 | Single `agent.execute()` call with Stagehand — fully autonomous | **applicationAgent** with Stagehand-only tools (no DOM/Magnitude) |
| **WorkdayApplyHandler** | ~800 | Workday-specific page types, ARIA widget handling, 8-level label discovery | **applicationAgent** with `platform: 'workday'` context → loads Workday-specific tool variants |
| **formFiller.ts** | ~600 | Single-page: scan → LLM answers → DOM fill → Magnitude fallback | **formFillerAgent** |
| **ApplyHandler** | ~200 | Legacy: single `adapter.act()` call | Deprecated — replaced by applicationAgent |
| **FillFormHandler** | ~150 | Generic form fill without navigation | **formFillerAgent** (no navigation tools) |

#### Platform-Specific Tool Variants

Instead of separate handlers per platform, Mastra uses **the same agents with platform-aware tools**:

```typescript
// The tool adapts its behavior based on platform context
export const fillDropdown = createTool({
  id: 'fill-dropdown',
  description: 'Fill a dropdown. Behavior adapts to platform (Workday uses ARIA widgets, generic uses native select).',
  execute: async ({ context }) => {
    const platform = context.memory?.platform || 'generic'
    switch (platform) {
      case 'workday':
        // 8-level hierarchical label discovery + ARIA button interaction
        return await workdayDropdownFill(context.page, context.selector, context.value)
      case 'greenhouse':
        // React Select with typeahead
        return await greenhouseDropdownFill(context.page, context.selector, context.value)
      default:
        // Native <select> or basic custom dropdown
        return await genericDropdownFill(context.page, context.selector, context.value)
    }
  },
})
```

#### Safety Logic as Agent Instructions (not hardcoded)

The current SmartApplyHandler has safety overrides hardcoded in imperative logic (e.g., "if LLM says account_creation but 5+ fields, override to application_form"). In Mastra, these become **agent instructions** — the LLM reasons about them naturally:

```typescript
instructions: `
...
Safety overrides you MUST apply:
- If page classified as "account_creation" but has 5+ form fields → reclassify as "application_form"
- If page classified as "review" but has editable input fields → reclassify as "application_form"
- If same page detected 3+ consecutive times (stuck) → stop and request human help
- If Apply button already clicked but page type is still "job_listing" → treat as "application_form" (SPA)
- NEVER submit the application — stop at review/confirmation pages
...
`
```

---

### 3.5 Mastra Step Definitions (Workflow-Level)

Each Hand also works as a Mastra workflow step for the deterministic escalation path. This gives you two modes: **agent-driven** (LLM picks the tool) or **workflow-driven** (deterministic escalation chain).

Each Hand becomes a Mastra step with typed input/output schemas:

```typescript
// steps/domHandStep.ts
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { DOMHand } from '../engine/v3/layers/DOMHand'

export const domHandStep = createStep({
  id: 'dom-hand',
  inputSchema: z.object({
    fields: z.array(FieldSchema),
    userData: UserDataSchema,
    page: z.any(), // Playwright Page (runtime injection)
  }),
  outputSchema: z.object({
    filledFields: z.array(z.string()),
    failedFields: z.array(FieldSchema),
    cost: z.number(),
  }),
  execute: async ({ inputData }) => {
    const hand = new DOMHand(inputData.page)
    const results = await hand.fillFields(inputData.fields, inputData.userData)
    return {
      filledFields: results.successes,
      failedFields: results.failures,
      cost: 0, // DOMHand is always free
    }
  },
})
```

```typescript
// steps/stagehandStep.ts
export const stagehandHandStep = createStep({
  id: 'stagehand-hand',
  inputSchema: z.object({
    fields: z.array(FieldSchema),  // only the fields DOM failed on
    userData: UserDataSchema,
    page: z.any(),
  }),
  outputSchema: z.object({
    filledFields: z.array(z.string()),
    failedFields: z.array(FieldSchema),
    cost: z.number(),
  }),
  execute: async ({ inputData }) => {
    const hand = new StagehandHand(inputData.page)
    const results = await hand.fillFields(inputData.fields, inputData.userData)
    return {
      filledFields: results.successes,
      failedFields: results.failures,
      cost: results.totalCost,
    }
  },
})
```

```typescript
// steps/magnitudeHandStep.ts
export const magnitudeHandStep = createStep({
  id: 'magnitude-hand',
  inputSchema: z.object({
    fields: z.array(FieldSchema),  // only the fields Stagehand failed on
    userData: UserDataSchema,
    adapter: z.any(),
  }),
  outputSchema: z.object({
    filledFields: z.array(z.string()),
    failedFields: z.array(FieldSchema),
    cost: z.number(),
  }),
  execute: async ({ inputData }) => {
    const hand = new MagnitudeHand(inputData.adapter)
    const results = await hand.fillFields(inputData.fields, inputData.userData)
    return {
      filledFields: results.successes,
      failedFields: results.failures,
      cost: results.totalCost,
    }
  },
})
```

### 3.2 Escalation Workflow (Per Page)

```typescript
// workflows/fillPageWorkflow.ts
import { createWorkflow, createStep } from '@mastra/core/workflows'

const observeStep = createStep({
  id: 'observe-page',
  inputSchema: PageContextSchema,
  outputSchema: PageModelSchema,
  execute: async ({ inputData }) => {
    // PageScanner: scroll, extract fields, detect blockers
    const scanner = new PageScanner(inputData.page)
    return await scanner.scan()
  },
})

const planStep = createStep({
  id: 'plan-actions',
  inputSchema: PageModelSchema,
  outputSchema: ActionPlanSchema,
  execute: async ({ inputData }) => {
    // FieldMatcher: map fields to user data, assign confidence
    const matcher = new FieldMatcher()
    return matcher.plan(inputData.fields, inputData.userData)
  },
})

const verifyStep = createStep({
  id: 'verify-fills',
  inputSchema: FillResultSchema,
  outputSchema: VerificationResultSchema,
  execute: async ({ inputData }) => {
    // DOM readback to confirm fields were filled correctly
    const verifier = new VerificationEngine(inputData.page)
    return await verifier.verify(inputData.filledFields)
  },
})

const recordStep = createStep({
  id: 'record-cookbook',
  inputSchema: VerificationResultSchema,
  outputSchema: z.object({ recorded: z.boolean() }),
  execute: async ({ inputData }) => {
    // Save successful actions to ManualStore for replay
    if (inputData.allVerified) {
      await manualStore.save(inputData.actions)
    }
    return { recorded: inputData.allVerified }
  },
})

// The escalation chain
export const fillPageWorkflow = createWorkflow({
  id: 'fill-page',
  inputSchema: PageContextSchema,
  outputSchema: FillResultSchema,
})
  .then(observeStep)
  .then(planStep)
  .then(domHandStep)                              // Try DOM first ($0)
  .branch([
    // If all fields filled, go straight to verify
    [async ({ inputData }) => inputData.failedFields.length === 0, verifyStep],
    // If some fields failed, escalate to Stagehand
    [async ({ inputData }) => inputData.failedFields.length > 0, stagehandHandStep],
  ])
  .branch([
    // After Stagehand: if all done, verify
    [async ({ inputData }) => inputData.failedFields?.length === 0, verifyStep],
    // Still failures? Escalate to Magnitude
    [async ({ inputData }) => inputData.failedFields?.length > 0, magnitudeHandStep],
  ])
  .then(verifyStep)
  .then(recordStep)
  .commit()
```

### 3.3 Multi-Page Application Workflow

```typescript
// workflows/applyWorkflow.ts
export const applyWorkflow = createWorkflow({
  id: 'apply-to-job',
  inputSchema: JobContextSchema,
  outputSchema: ApplicationResultSchema,
})
  .then(cookbookLookupStep)       // Check ManualStore first
  .branch([
    // Cookbook found with good health → replay
    [async ({ inputData }) => inputData.cookbook?.healthScore > 0.3, cookbookReplayStep],
    // No cookbook or unhealthy → full orchestration
    [async () => true, fillPageWorkflow],
  ])
  .dowhile(
    navigateAndFillStep,          // Click "Next", then run fillPageWorkflow
    async ({ inputData }) => {
      // Continue until: terminal page, max pages, or budget exceeded
      return !inputData.isTerminalPage
        && inputData.pageCount < 15
        && inputData.totalCost < inputData.budget
    }
  )
  .then(submitStep)               // Optional: click submit on review page
  .then(finalRecordStep)          // Save full cookbook for this URL
  .commit()
```

### 3.4 HITL via Mastra Suspend/Resume

```typescript
// steps/blockerDetectionStep.ts
const blockerCheckStep = createStep({
  id: 'check-blockers',
  inputSchema: PageModelSchema,
  outputSchema: z.object({ blocked: z.boolean(), type: z.string().optional() }),
  execute: async ({ inputData, suspend }) => {
    const blockers = inputData.blockers
    if (blockers.length > 0) {
      const blocker = blockers[0]
      // Suspend workflow — Mastra persists state, VALET can resume later
      const resolution = await suspend({
        blockerType: blocker.type,  // 'captcha' | 'login_required' | '2fa'
        jobId: inputData.jobId,
        screenshot: await inputData.page.screenshot(),
      })
      // When resumed, resolution contains human-provided data
      return { blocked: false, resolution }
    }
    return { blocked: false }
  },
})
```

This replaces the current custom Postgres LISTEN/NOTIFY plumbing with Mastra's built-in suspend/resume, which handles state serialization automatically.

### 3.5 Model Routing

```typescript
// For MagnitudeHand's LLM calls (when used as a Mastra agent)
const magnitudeAgent = new Agent({
  id: 'magnitude-agent',
  instructions: 'You are a browser automation agent. Fill form fields accurately.',
  model: async ({ requestContext }) => {
    // Tiered model selection based on field complexity
    switch (requestContext?.tier) {
      case 'easy':   return 'google/gemini-2.0-flash'       // $0.15/M
      case 'medium': return 'qwen/qwen3-vl-30b'             // $1.26/M
      case 'hard':   return 'anthropic/claude-haiku-4-5'     // $0.80/M
      default:       return 'google/gemini-2.0-flash'
    }
  },
  tools: { fillFieldTool, clickTool, scrollTool, screenshotTool },
  maxSteps: 10,
  onFinish: async ({ usage }) => {
    // Feed token counts into CostTracker
    costTracker.record(usage.inputTokens, usage.outputTokens, model)
  },
})
```

### 3.6 Integration Point: JobExecutor

The Mastra workflow plugs into the existing `JobExecutor` with minimal changes:

```typescript
// workers/JobExecutor.ts (modified)
import { applyWorkflow } from '../workflows/applyWorkflow'

async execute(job: Job) {
  // ... existing preflight, adapter creation, session loading ...

  if (job.metadata?.engine_version === 4) {
    // V4: Mastra-orchestrated
    const run = await applyWorkflow.createRun()
    const result = await run.start({
      inputData: {
        jobId: job.id,
        targetUrl: job.target_url,
        userData: job.input_data.user_data,
        qaOverrides: job.input_data.qa_overrides,
        adapter: this.adapter,
        page: this.adapter.page,
        budget: this.costTracker.remaining,
      }
    })

    if (result.status === 'suspended') {
      // HITL: save run state, notify VALET
      await this.saveRunState(job.id, run)
      await this.notifyBlocker(job, result.suspended)
      return
    }

    return this.processResult(job, result)
  }

  // V1/V3: existing engines (unchanged)
  // ...
}
```

---

## 4. Migration Strategy

### Phase 1: Foundation — Tools + Memory (1 week)
- Add `@mastra/core`, `@mastra/memory`, `@mastra/libsql` dependencies
- Define all Mastra tools (Section 3.2): wrap DOMHand, StagehandHand, MagnitudeHand, PageScanner, BlockerDetector, FieldMatcher, CookbookExecutor as `createTool()` definitions
- Set up Mastra Memory with LibSQL/Supabase backend (Section 3.3)
- Define ApplicationContext schema
- Test tools individually against mock adapter
- **No production impact** — all behind `engine_version: 4` gate

### Phase 2: Agents — FormFiller + PageClassifier (1 week)
- Build `formFillerAgent` (Section 3.1.2) — single-page form filling with tool escalation
- Build `pageClassifierAgent` (Section 3.1.3) — 3-tool classification cascade
- Test against real pages: agent correctly classifies page type and fills fields
- Validate cost: agent reasoning overhead vs. current hardcoded handler logic

### Phase 3: Orchestration — Application Workflow + Supervisor (1 week)
- Build `applicationAgent` (Section 3.1.1) — multi-page navigation + error recovery
- Build `supervisorAgent` (Section 3.1.4) — top-level coordinator
- Build `applyWorkflow` with `dowhile` page loop (Section 3.6)
- Wire HITL suspend/resume via `requestHumanHelp` tool
- Wire cookbook lookup/replay as workflow short-circuit
- Test against staging URLs (Greenhouse, Lever, Workday)

### Phase 4: Observability + Model Routing (3 days)
- Configure Mastra tracing → existing logger / Langfuse
- Set up model routing with per-tier providers and dynamic selection
- Feed Mastra `onStepFinish` token usage into `CostTracker`
- Validate memory persistence across HITL suspend/resume cycles

### Phase 5: Production Rollout (1 week)
- Deploy alongside V1/V3 (V4 opt-in via `engine_version: 4`)
- A/B test: same URLs, compare cost + success rate + agent reasoning overhead
- Monitor agent tool selection patterns — is it respecting cheapest-first?
- Flip default once V4 matches or beats V3

### Phase 6: Cleanup (ongoing)
- Deprecate `SmartApplyHandler` (4,471 lines) once supervisorAgent is default
- Deprecate `SectionOrchestrator` once workflow is default
- Remove V1 `ExecutionEngine` (already legacy)
- Consolidate HITL plumbing (remove Postgres LISTEN/NOTIFY path)
- Migrate platform-specific handlers to platform-aware tool variants

---

## 5. Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Mastra adds latency** to workflow setup/teardown | Medium | Benchmark. Steps are thin wrappers — actual work is in Hands |
| **Playwright Page object** can't be serialized by Mastra's state persistence | High | Pass page handle via runtime context injection, not workflow state. Don't persist browser state in Mastra — keep that in SessionManager |
| **Mastra suspend/resume** requires storage backend (not file-based in prod) | Medium | Use Supabase/LibSQL as Mastra storage backend — we already have Supabase |
| **DOMHand is not an LLM step** — Mastra's strength is LLM orchestration | Low | Use Mastra steps (not agents) for non-LLM tiers. Steps are just typed functions — Mastra still orchestrates control flow |
| **Adding a framework dependency** for something the SectionOrchestrator already does | Medium | Gate behind engine_version=4. If Mastra doesn't prove its value in Phase 4 A/B test, revert without production impact |
| **Mastra API evolution** — framework is young, APIs may shift between minor versions | Low | Pin exact version. Mastra 1.0+ is stable with backward compat guarantees. Team (ex-Gatsby, YC W25) has strong track record |
| **Cost tracking gap** — Mastra gives token counts, not dollars | Low | Keep existing CostTracker. Feed Mastra's `onFinish` usage into it |

---

## 6. What We're NOT Changing

- **The Hands themselves** — DOMHand, StagehandHand, MagnitudeHand internal logic stays identical (they become Mastra tools)
- **The worker system** — JobPoller, JobExecutor, Postgres queue, LISTEN/NOTIFY for job dispatch
- **The API layer** — Hono REST routes, Zod schemas
- **Cost control** — Per-task and per-user budgets remain in `costControl.ts` (Mastra feeds into it)
- **The cookbook system** — ManualStore, health scoring, replay logic (wrapped as tools)
- **The adapter layer** — BrowserAutomationAdapter interface and implementations
- **VALET integration** — Callback webhooks, shared DB, API contract
- **Browser session management** — SessionManager handles cookies/localStorage (not Mastra memory)

---

## 7. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Cost parity** | V4 ≤ V3 cost per job | A/B test same URLs |
| **Success rate parity** | V4 ≥ V3 success rate | A/B test same URLs |
| **Code reduction** | Remove ≥200 lines of orchestration glue | Diff SectionOrchestrator before/after |
| **Extensibility** | Add a 4th hand in <50 lines | Implement one as proof |
| **HITL reliability** | Suspend/resume works without Postgres | Integration test with mock blocker |
| **Observability** | Full trace for every job (steps, costs, model, duration) | Mastra tracing dashboard |

---

## 8. Open Questions

1. **Mastra storage backend** — Should we use Supabase (already in stack) or add LibSQL? Supabase avoids a new dependency but Mastra's native LibSQL support may be more battle-tested. See [Mastra v1 migration guide](https://mastra.ai/guides/migrations/upgrade-to-v1/overview) for storage backend options.

2. **Agent-driven vs. workflow-driven escalation?** Two modes are possible:
   - **Agent mode**: The formFillerAgent LLM reasons about which tool to call (fillWithDOM → fillWithStagehand → fillWithMagnitude). More flexible but LLM might make suboptimal cost decisions.
   - **Workflow mode**: Deterministic `.branch()` chain forces cheapest-first. Predictable costs but less adaptable.
   - **Hybrid**: Agent for page-level decisions, workflow for field-level escalation. Probably the sweet spot.

3. **Supervisor depth** — Should the supervisorAgent delegate to sub-agents (pageClassifier, formFiller), or should the applicationAgent handle everything with tools directly? Deeper delegation = more LLM calls = more cost. Shallower = one smart agent with many tools.

4. **Memory scope** — Mastra memory per-job (fresh each application) or per-user (remembers patterns across applications)? Per-user memory could learn user preferences over time but adds complexity.

5. **Cookbook as tool vs. workflow short-circuit** — If `lookupCookbook` finds a healthy manual, should the agent decide to replay it (tool), or should the workflow short-circuit before the agent even runs (step)? Short-circuit is cheaper (no agent reasoning needed).

6. **Version numbering** — The hybrid engine was planned as V2 (in docs) but implemented as V3 (in code). Should Mastra-orchestrated be V4 or V2?

7. **Platform tool variants vs. platform agents** — Should Workday/Greenhouse/Lever each have their own agent with specialized instructions, or should all platforms share one agent with platform-aware tools? Shared agent is simpler; per-platform agents allow tighter instruction tuning.

---

## 9. Alternatives Considered

### A. Keep Current Architecture (SectionOrchestrator)
**Pros:** Already works, no new dependency, team knows the code
**Cons:** Imperative orchestration is harder to extend, no built-in observability, HITL is fragile
**Verdict:** Viable but limits extensibility

### B. Build Custom Workflow Engine
**Pros:** Tailored to our exact needs, no external dependency
**Cons:** Reinventing the wheel, maintenance burden, no community/ecosystem
**Verdict:** Not worth the investment when Mastra exists

### C. LangGraph (Python)
**Pros:** More mature, larger community
**Cons:** Python — entire codebase is TypeScript, would require a language bridge
**Verdict:** Non-starter for a TypeScript project

### D. Vercel AI SDK (without Mastra)
**Pros:** Lighter weight, just the LLM abstraction
**Cons:** No workflow engine, no multi-agent, no HITL — we'd still need orchestration glue
**Verdict:** Mastra is built on AI SDK, so we get this for free

---

## 10. Appendix: Mastra Quick Reference

**Install:** `npm install @mastra/core @mastra/memory @mastra/libsql`

**Requirement:** Node.js 22.13.0+

**Key APIs (v1 stable):**

*Agents:*
- `new Agent({ id, model, tools, instructions, agents, memory, maxSteps })` — autonomous LLM agent
- `agent.generate(prompt, { requestContext })` — full response
- `agent.stream(prompt, { requestContext })` — token streaming
- `agent.network(prompt)` — supervisor delegates to sub-agents
- `onStepFinish`, `onFinish` — lifecycle hooks with token usage

*Tools:*
- `createTool({ id, description, inputSchema, outputSchema, execute })` — typed tool
- Tool signature: `execute: async ({ context, suspend })` (v1 format)
- `requireApproval: true` — HITL gating on tool execution
- MCP server support for cross-agent tool sharing

*Workflows:*
- `createStep({ id, inputSchema, outputSchema, execute })` — typed workflow step
- `createWorkflow({ id, inputSchema, outputSchema })` — workflow definition
- `.then(step)` — sequential | `.branch([[condition, step], ...])` — conditional routing
- `.parallel([steps])` — concurrent | `.dowhile(step, condition)` — loop
- `.foreach(step, { concurrency })` — iterate arrays | `.map(fn)` — transform data
- `suspend(payload)` / `workflow.resume(runId, data)` — HITL

*Memory:*
- `new Memory({ storage })` — persistent memory for agents
- Storage backends: LibSQL, Supabase, ClickHouse
- Required for multi-agent `.network()` calls

*Model Routing:*
- `"provider/model"` string routing — 87+ providers, 2,594 models
- Dynamic model: `model: async ({ requestContext }) => 'provider/model'`
- Fallback chains: `modelRouter({ primary, fallbacks })`

**Project stats:** 21.5k GitHub stars, YC W25, ex-Gatsby team, TypeScript-native, stable 1.0+ release (v1.0 Jan 2026, latest: v1.7.0 Feb 2026)

**Docs:** https://mastra.ai/docs
**Migration guide:** https://mastra.ai/guides/migrations/upgrade-to-v1/overview
