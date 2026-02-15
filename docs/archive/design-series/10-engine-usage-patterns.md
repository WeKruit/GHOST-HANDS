# 10 - Engine Usage Patterns & SandboxController Implementation

> Practical patterns for using Stagehand v3 and Magnitude in Valet's multi-tier architecture.
> Covers SandboxController implementation, engine switching, form analysis,
> end-to-end platform examples, error recovery, HITL flows, and cost optimization.

---

## Table of Contents

1. [SandboxController Implementation](#1-sandboxcontroller-implementation)
2. [Engine Initialization Patterns](#2-engine-initialization-patterns)
3. [Form Analysis Pipeline](#3-form-analysis-pipeline)
4. [End-to-End Platform Examples](#4-end-to-end-platform-examples)
5. [Engine Switching Implementation](#5-engine-switching-implementation)
6. [Error Recovery Patterns](#6-error-recovery-patterns)
7. [Human-in-the-Loop Flows](#7-human-in-the-loop-flows)
8. [Cost Optimization](#8-cost-optimization)
9. [Testing & Validation](#9-testing--validation)

---

## 1. SandboxController Implementation

The `SandboxController` is the central orchestrator that manages engine lifecycle, switching, and session state within a single browser automation session.

### 1.1 Core Class Structure

```typescript
// apps/worker/src/sandbox/sandbox-controller.ts

import { Mutex, withTimeout } from "async-mutex";
import type {
  EngineType,
  SandboxTier,
  FailureSignalType,
  ApplicationPhase,
  SandboxSession,
  EngineState,
} from "@valet/shared/types/sandbox.js";

export class SandboxController {
  private currentEngine: EngineType = "none";
  private stagehand: Stagehand | null = null;
  private magnitudeAgent: MagnitudeAgent | null = null;
  private session: SandboxSession;
  private failureCount: Map<EngineType, number> = new Map();
  private phase: ApplicationPhase = "provisioning";

  // CDP mutex prevents concurrent connect/disconnect operations
  private readonly cdpMutex = withTimeout(
    new Mutex(),
    30_000,
    new Error("CDP mutex timeout: lock held >30s"),
  );

  constructor(
    private readonly tier: SandboxTier,
    private readonly provider: ISandboxProvider,
    private readonly onPhaseChange: (phase: ApplicationPhase) => void,
  ) {}

  /** Provision sandbox and connect initial engine */
  async initialize(config: SandboxConfig): Promise<void> {
    this.setPhase("provisioning");
    this.session = await this.provider.provision(config);

    // Connect primary engine based on tier
    const primaryEngine = this.getPrimaryEngine();
    await this.connectEngine(primaryEngine);
  }

  /** Execute an automation action with fallback cascade */
  async execute(action: AutomationAction): Promise<ActionResult> {
    const maxCascadeAttempts = this.tier >= 3 ? 4 : 2; // Premium gets full cascade

    for (let attempt = 0; attempt < maxCascadeAttempts; attempt++) {
      try {
        return await this.executeWithCurrentEngine(action);
      } catch (error) {
        const signal = this.classifyFailure(error);

        if (this.shouldSwitch(signal)) {
          const nextEngine = this.getNextEngine(signal);
          if (nextEngine) {
            await this.switchEngine(nextEngine);
            continue;
          }
        }

        if (this.shouldEscalateToHuman(signal)) {
          return { status: "waiting_human", signal };
        }

        throw error; // Unrecoverable
      }
    }

    return { status: "waiting_human", signal: "engine_exhausted" };
  }

  /** Graceful teardown */
  async destroy(): Promise<void> {
    await this.cdpMutex.runExclusive(async () => {
      if (this.stagehand) {
        await this.stagehand.close().catch(() => {});
        this.stagehand = null;
      }
      if (this.magnitudeAgent) {
        await this.magnitudeAgent.close().catch(() => {});
        this.magnitudeAgent = null;
      }
    });
    await this.provider.terminate(this.session.id);
  }

  private setPhase(phase: ApplicationPhase): void {
    this.phase = phase;
    this.onPhaseChange(phase);
  }

  private getPrimaryEngine(): EngineType {
    switch (this.tier) {
      case 1: return "none";           // Free tier: extension handles it
      case 2: return "stagehand";      // Starter: Stagehand DOM
      case 2.5: return "stagehand";    // Local: Stagehand DOM (Magnitude as fallback)
      case 3: return "stagehand";      // Pro: Stagehand DOM
      case 4: return "stagehand";      // Premium: Stagehand DOM (Magnitude as fallback)
      default: return "stagehand";
    }
  }

  private getNextEngine(signal: FailureSignalType): EngineType | null {
    const cascade = this.getFallbackCascade();
    const currentIndex = cascade.indexOf(this.currentEngine);
    return cascade[currentIndex + 1] ?? null;
  }

  private getFallbackCascade(): EngineType[] {
    if (this.tier <= 2) return ["stagehand"];           // Starter: no fallback
    if (this.tier === 2.5) return ["stagehand", "magnitude"];  // Local: full cascade (runs on user's machine)
    if (this.tier === 3) return ["stagehand"];           // Pro: retry only
    return ["stagehand", "magnitude"];                   // Premium: full cascade
  }
}
```

### 1.2 Phase Progression

```
provisioning → navigating → analyzing → filling → uploading → reviewing → submitting → verifying → completed
                                 ↕                                              ↕
                          waiting_human                                   waiting_human
```

Each phase transition emits a WebSocket event for real-time UI updates:

```typescript
// Phase change triggers WebSocket broadcast
this.onPhaseChange = (phase: ApplicationPhase) => {
  context.broadcast("task:progress", {
    taskId: this.taskId,
    phase,
    engine: this.currentEngine,
    timestamp: Date.now(),
  });
};
```

---

## 2. Engine Initialization Patterns

### 2.1 Stagehand v3 with Browserbase (Starter/Pro)

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

async function createBrowserbaseStagehand(
  sessionId: string,
): Promise<Stagehand> {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: sessionId,

    // Model configuration — 3-tier routing
    model: "anthropic/claude-sonnet-4-5",  // Primary: best accuracy
    systemPrompt: `You are a job application assistant. Fill forms accurately.
      Use exact values provided. Never fabricate information.
      If a field is ambiguous, describe what you see.`,

    // Performance tuning
    enableCaching: true,  // Cache DOM observations for repeated elements
    domSettleTimeoutMs: 3000,
    selfHeal: true,       // Auto-retry failed selectors

    // Logging
    verbose: process.env.NODE_ENV !== "production" ? 2 : 0,
    logger: (msg) => logger.debug({ engine: "stagehand" }, msg.message),
  });

  await stagehand.init();
  return stagehand;
}
```

### 2.2 Stagehand v3 with Local CDP (Premium/AdsPower)

```typescript
async function createLocalStagehand(cdpUrl: string): Promise<Stagehand> {
  const stagehand = new Stagehand({
    env: "LOCAL",
    localCdpUrl: cdpUrl,  // ws://localhost:9222 or AdsPower debug port

    model: "anthropic/claude-sonnet-4-5",
    systemPrompt: "...",

    enableCaching: true,
    domSettleTimeoutMs: 3000,
    selfHeal: true,
  });

  await stagehand.init();
  return stagehand;
}
```

### 2.3 Stagehand v3 with Local Chrome (Local Tier via Companion App)

```typescript
async function createLocalCompanionStagehand(
  cdpPort: number = 9222,
): Promise<Stagehand> {
  const stagehand = new Stagehand({
    env: "LOCAL",
    localCdpUrl: `ws://127.0.0.1:${cdpPort}`,  // Companion launches Chrome on localhost

    model: "anthropic/claude-sonnet-4-5",
    systemPrompt: "...",

    enableCaching: true,
    domSettleTimeoutMs: 3000,
    selfHeal: true,

    // Companion app routes LLM calls through Valet API for usage tracking
    // API key injected by companion app
  });

  await stagehand.init();
  return stagehand;
}
```

**Local tier flow:**
```
Extension → Native Messaging → Companion App
    → Companion launches Chrome with --remote-debugging-port=9222
    → Companion initializes Stagehand(env: "LOCAL", cdpUrl: "ws://127.0.0.1:9222")
    → Stagehand connects to local Chrome
    → Companion reports progress back to Extension via Native Messaging
    → Extension shows live overlay on user's browser tab
```

### 2.4 Magnitude Agent Initialization

```typescript
import { startBrowserAgent } from "magnitude-core";

async function createMagnitudeAgent(
  cdpUrl: string,
  instructions: string,
): Promise<MagnitudeAgent> {
  const agent = await startBrowserAgent({
    task: instructions,
    browser: {
      cdpUrl,   // Connect to existing AdsPower browser
    },
    agent: {
      modelProvider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    // Vision-first: uses screenshots, not DOM
    maxScreenshots: 5,
    minScreenshots: 2,
  });

  return agent;
}
```

### 2.5 Engine Selection by Platform

```typescript
function selectEngine(platformUrl: string, tier: SandboxTier): {
  primary: EngineType;
  mode?: "dom" | "cua" | "hybrid";
} {
  const hostname = new URL(platformUrl).hostname;

  // Workday: vision-first (shadow DOM, custom components)
  if (hostname.includes("workday") || hostname.includes("myworkdayjobs")) {
    return tier >= 4
      ? { primary: "magnitude" }
      : { primary: "stagehand", mode: "cua" };
  }

  // Standard ATS platforms: DOM-first
  if (
    hostname.includes("greenhouse") ||
    hostname.includes("lever") ||
    hostname.includes("linkedin") ||
    hostname.includes("indeed")
  ) {
    return { primary: "stagehand", mode: "dom" };
  }

  // Unknown: start with DOM, let fallback cascade handle it
  return { primary: "stagehand", mode: "dom" };
}
```

---

## 3. Form Analysis Pipeline

### 3.1 IFormAnalyzer Implementation

```typescript
// apps/worker/src/automation/form-analyzer.ts

export class StagehandFormAnalyzer implements IFormAnalyzer {
  constructor(private readonly stagehand: Stagehand) {}

  /** Detect all form fields on the current page */
  async analyzeForm(): Promise<FormField[]> {
    const observation = await this.stagehand.observe({
      instruction: `Identify ALL form fields on this page. For each field, describe:
        - The label text (exactly as shown)
        - The field type (text, select, radio, checkbox, file, textarea)
        - Whether it is required (look for asterisk or "required" text)
        - Any placeholder text
        - Current value if pre-filled
        - Any dropdown options visible`,
      returnAction: true,
    });

    return this.parseObservation(observation);
  }

  /** Map user profile data to form fields */
  async mapFieldsToProfile(
    fields: FormField[],
    profile: UserProfile,
  ): Promise<FieldMapping[]> {
    const mappings: FieldMapping[] = [];

    for (const field of fields) {
      const mapping = this.matchField(field, profile);
      mappings.push({
        field,
        value: mapping.value,
        confidence: mapping.confidence,
        source: mapping.source,  // "profile" | "resume" | "qa_bank" | "llm_generated"
      });
    }

    return mappings;
  }

  /** Check for multi-page forms */
  async detectPagination(): Promise<{
    isMultiPage: boolean;
    currentPage: number;
    totalPages: number | null;
    nextAction: string | null;
  }> {
    const observation = await this.stagehand.observe({
      instruction: `Look for pagination indicators on this form:
        - Step indicators (e.g., "Step 2 of 5")
        - Progress bars with numbered steps
        - "Next" / "Continue" / "Save & Continue" buttons
        - Tab navigation for form sections
        Report the current step number, total steps if visible,
        and the text of the next/continue button if present.`,
    });

    return this.parsePagination(observation);
  }

  private matchField(
    field: FormField,
    profile: UserProfile,
  ): { value: string; confidence: number; source: string } {
    const label = field.label.toLowerCase();

    // Direct matches (high confidence)
    const directMappings: Record<string, { value: string; source: string }> = {
      "first name": { value: profile.firstName, source: "profile" },
      "last name": { value: profile.lastName, source: "profile" },
      "email": { value: profile.email, source: "profile" },
      "phone": { value: profile.phone, source: "profile" },
      "linkedin": { value: profile.linkedinUrl, source: "profile" },
      "location": { value: profile.location, source: "profile" },
      "city": { value: profile.city, source: "profile" },
    };

    for (const [key, mapping] of Object.entries(directMappings)) {
      if (label.includes(key) && mapping.value) {
        return { ...mapping, confidence: 0.95 };
      }
    }

    // Fuzzy matches (medium confidence) — use LLM
    return { value: "", confidence: 0, source: "unknown" };
  }
}
```

### 3.2 Magnitude Form Analysis (Vision-First)

```typescript
export class MagnitudeFormAnalyzer implements IFormAnalyzer {
  constructor(private readonly agent: MagnitudeAgent) {}

  async analyzeForm(): Promise<FormField[]> {
    // Magnitude sees the rendered page as pixels
    const result = await this.agent.extract(
      `Look at this form page. List every input field you can see.
       For each field, provide:
       - label: the text label next to the field
       - type: text/select/radio/checkbox/file/textarea
       - required: true if there's an asterisk or "required" indicator
       - options: for dropdowns/radios, list the available choices
       Return as a JSON array.`,
    );

    return JSON.parse(result);
  }
}
```

### 3.3 QA Bank Integration

For open-ended questions (e.g., "Why do you want to work here?"):

```typescript
// Check QA bank first, then generate with LLM
async function getAnswer(
  question: string,
  qaBank: IQABank,
  profile: UserProfile,
  jobDescription: string,
): Promise<{ answer: string; source: "qa_bank" | "llm_generated" }> {
  // 1. Check QA bank for exact or semantic match
  const bankMatch = await qaBank.findMatch(question);
  if (bankMatch && bankMatch.confidence > 0.85) {
    return { answer: bankMatch.answer, source: "qa_bank" };
  }

  // 2. Generate with LLM
  const generated = await llm.generate({
    model: "gpt-4.1-mini",  // Cost-effective for text generation
    system: `Generate a professional, concise answer for a job application.
      Use the candidate's profile and the job description for context.
      Keep under 200 words unless the question asks for more.`,
    user: `Question: ${question}
      Candidate profile: ${JSON.stringify(profile)}
      Job description: ${jobDescription}`,
  });

  // 3. Save to QA bank for future use
  await qaBank.save(question, generated, { jobUrl: jobDescription });

  return { answer: generated, source: "llm_generated" };
}
```

---

## 4. End-to-End Platform Examples

### 4.1 Greenhouse (Standard ATS — Stagehand DOM)

```typescript
async function applyGreenhouse(
  controller: SandboxController,
  stagehand: Stagehand,
  task: ApplicationTask,
): Promise<void> {
  // Phase: navigating
  controller.setPhase("navigating");
  await stagehand.goto(task.jobUrl);
  await stagehand.waitForSettledDom();

  // Phase: analyzing
  controller.setPhase("analyzing");
  const analyzer = new StagehandFormAnalyzer(stagehand);
  const fields = await analyzer.analyzeForm();
  const pagination = await analyzer.detectPagination();
  const mappings = await analyzer.mapFieldsToProfile(fields, task.profile);

  // Phase: filling
  controller.setPhase("filling");
  for (const mapping of mappings) {
    if (mapping.confidence < 0.5) {
      // Low confidence — mark for human review
      controller.flagForReview(mapping.field, mapping.value);
      continue;
    }

    switch (mapping.field.type) {
      case "text":
      case "textarea":
        await stagehand.act(
          `Type "${mapping.value}" into the "${mapping.field.label}" field`,
        );
        break;

      case "select":
        await stagehand.act(
          `Select "${mapping.value}" from the "${mapping.field.label}" dropdown`,
        );
        break;

      case "radio":
        await stagehand.act(
          `Click the "${mapping.value}" option for "${mapping.field.label}"`,
        );
        break;

      case "checkbox":
        if (mapping.value === "true") {
          await stagehand.act(
            `Check the "${mapping.field.label}" checkbox`,
          );
        }
        break;
    }
  }

  // Phase: uploading (resume)
  controller.setPhase("uploading");
  if (task.resumeUrl) {
    await stagehand.act('Click the "Upload Resume" or "Attach Resume" button');
    // File upload handled via CDP file chooser interception
    await handleFileUpload(stagehand, task.resumeUrl);
  }

  // Handle multi-page form
  while (pagination.isMultiPage && pagination.nextAction) {
    await stagehand.act(`Click "${pagination.nextAction}"`);
    await stagehand.waitForSettledDom();

    const nextFields = await analyzer.analyzeForm();
    const nextMappings = await analyzer.mapFieldsToProfile(nextFields, task.profile);
    // ... fill next page
    pagination = await analyzer.detectPagination();
  }

  // Phase: reviewing
  controller.setPhase("reviewing");
  if (task.tier === "pro" || task.tier === "premium") {
    // Wait for user confirmation before submitting
    await controller.waitForHumanApproval("review_before_submit");
  }

  // Phase: submitting
  controller.setPhase("submitting");
  await stagehand.act('Click the "Submit Application" or "Apply" button');

  // Phase: verifying
  controller.setPhase("verifying");
  const confirmation = await stagehand.extract({
    instruction: "Find the confirmation message or ID after submission",
    schema: z.object({
      confirmationText: z.string(),
      confirmationId: z.string().optional(),
    }),
  });

  // Take confirmation screenshot
  const screenshot = await stagehand.page.screenshot();
  await uploadScreenshot(screenshot, task.id);

  controller.setPhase("completed");
}
```

### 4.2 Workday (Complex ATS — Magnitude Primary)

```typescript
async function applyWorkday(
  controller: SandboxController,
  cdpUrl: string,
  task: ApplicationTask,
): Promise<void> {
  // Workday uses Shadow DOM + custom web components
  // Magnitude (vision-first) is the primary engine here

  controller.setPhase("navigating");
  const agent = await createMagnitudeAgent(cdpUrl, `
    Navigate to ${task.jobUrl} and apply for this position.
    You are filling out a Workday application form.
    Workday forms have multiple sections — complete each one.
  `);

  controller.setPhase("analyzing");
  // Magnitude sees the rendered page, not the DOM
  const formFields = await agent.extract(`
    What form fields are visible on this page?
    List each field with its label and type.
  `);

  controller.setPhase("filling");
  // Magnitude fills by describing visual actions
  await agent.act(`Fill in the "First Name" field with "${task.profile.firstName}"`);
  await agent.act(`Fill in the "Last Name" field with "${task.profile.lastName}"`);
  await agent.act(`Fill in the "Email" field with "${task.profile.email}"`);

  // Workday's location field uses a custom autocomplete
  await agent.act(`Click the "Location" field and type "${task.profile.city}"`);
  await agent.act(`Wait for the dropdown suggestions and click the matching option`);

  // Handle Workday's custom file upload
  controller.setPhase("uploading");
  await agent.act(`Click the "Upload Resume" section`);
  await agent.act(`Click "Select Files" or the upload button`);
  // File upload via CDP file chooser

  // Workday multi-section navigation
  await agent.act(`Click "Next" or "Save & Continue" to go to the next section`);
  // ... continue through sections

  controller.setPhase("submitting");
  await agent.act(`Click "Submit" to submit the application`);

  controller.setPhase("verifying");
  const confirmation = await agent.extract(
    "What confirmation message is shown? Include any application ID.",
  );

  controller.setPhase("completed");
}
```

### 4.3 LinkedIn Easy Apply (Stagehand DOM + Multi-Step)

```typescript
async function applyLinkedIn(
  stagehand: Stagehand,
  task: ApplicationTask,
): Promise<void> {
  await stagehand.goto(task.jobUrl);

  // Click "Easy Apply" button
  await stagehand.act('Click the "Easy Apply" button');
  await stagehand.waitForSettledDom();

  // LinkedIn Easy Apply is a multi-step modal
  let isLastStep = false;
  while (!isLastStep) {
    // Analyze current step
    const stepInfo = await stagehand.extract({
      instruction: `Analyze the current Easy Apply step:
        - What fields are shown?
        - Is there a "Next", "Review", or "Submit" button?`,
      schema: z.object({
        fields: z.array(z.object({
          label: z.string(),
          type: z.string(),
          required: z.boolean(),
        })),
        nextButton: z.string(),  // "Next" | "Review" | "Submit application"
      }),
    });

    // Fill fields
    for (const field of stepInfo.fields) {
      // ... map and fill
    }

    isLastStep = stepInfo.nextButton.toLowerCase().includes("submit");

    if (!isLastStep) {
      await stagehand.act(`Click "${stepInfo.nextButton}"`);
      await stagehand.waitForSettledDom();
    }
  }

  // Submit
  await stagehand.act('Click "Submit application"');
}
```

---

## 5. Engine Switching Implementation

### 5.1 Switch Protocol

```typescript
// SandboxController method
async switchEngine(target: EngineType): Promise<void> {
  await this.cdpMutex.runExclusive(async () => {
    // Step 1: Capture current state
    const state = await this.captureState();

    // Step 2: Disconnect current engine (CDP client only, NOT the browser)
    await this.disconnectCurrentEngine();

    // Step 3: Verify browser is still alive
    const browserOk = await this.verifyBrowser();
    if (!browserOk) {
      throw new Error("Browser process died during engine switch");
    }

    // Step 4: Connect new engine
    await this.connectEngine(target);

    // Step 5: Verify new engine works
    const engineOk = await this.verifyEngine();
    if (!engineOk) {
      throw new Error(`Failed to initialize ${target} engine`);
    }

    // Step 6: Restore state if needed
    if (state.url !== await this.getCurrentUrl()) {
      await this.navigate(state.url);
    }
  });
}

private async captureState(): Promise<BrowserState> {
  if (this.stagehand) {
    const page = this.stagehand.page;
    return {
      url: page.url(),
      title: await page.title(),
      scrollY: await page.evaluate(() => window.scrollY),
    };
  }
  // CDP direct query as fallback
  return { url: "", title: "", scrollY: 0 };
}

private async disconnectCurrentEngine(): Promise<void> {
  if (this.currentEngine === "stagehand" && this.stagehand) {
    await this.stagehand.close().catch(() => {});
    this.stagehand = null;
  }
  if (this.currentEngine === "magnitude" && this.magnitudeAgent) {
    await this.magnitudeAgent.close().catch(() => {});
    this.magnitudeAgent = null;
  }
  this.currentEngine = "none";
}

private async verifyBrowser(): Promise<boolean> {
  try {
    const resp = await fetch(`http://${this.session.host}:${this.session.debugPort}/json/version`);
    return resp.ok;
  } catch {
    return false;
  }
}
```

### 5.2 What Survives an Engine Switch

The browser process continues running. All browser-side state survives:

| State | Survives | Reason |
|-------|:--------:|--------|
| Cookies | Yes | Browser process |
| localStorage / sessionStorage | Yes | Browser process |
| Current URL + DOM | Yes | Page stays loaded |
| Form field values | Yes | DOM nodes persist |
| Auth sessions | Yes | Cookie/token-based |
| Scroll position | Yes | Browser maintains |

What does NOT survive and must be re-created:

| State | Mitigation |
|-------|------------|
| Engine element cache | Re-observe after switch |
| Stagehand action history | Store in workflow context |
| Magnitude agent memory | Re-initialize with instructions |
| Page event listeners | Re-attach post-connect |
| Retry counters | Track in SandboxController |

### 5.3 Failure Classification

```typescript
function classifyFailure(error: Error): FailureSignalType {
  const msg = error.message.toLowerCase();

  if (msg.includes("element not found") || msg.includes("selector"))
    return "selector_not_found";
  if (msg.includes("ambiguous") || msg.includes("multiple matches"))
    return "selector_ambiguous";
  if (msg.includes("no effect") || msg.includes("unchanged"))
    return "action_no_effect";
  if (msg.includes("shadow") || msg.includes("shadow-root"))
    return "shadow_dom_blocked";
  if (msg.includes("iframe") || msg.includes("frame"))
    return "iframe_unreachable";
  if (msg.includes("canvas"))
    return "canvas_element";
  if (msg.includes("captcha") || msg.includes("challenge"))
    return "captcha_detected";
  if (msg.includes("bot") || msg.includes("blocked") || msg.includes("denied"))
    return "anti_bot_detected";
  if (msg.includes("timeout"))
    return "timeout";
  if (msg.includes("websocket") || msg.includes("disconnected"))
    return "cdp_disconnect";
  if (msg.includes("rate") || msg.includes("429"))
    return "rate_limited";

  return "unknown";
}
```

### 5.4 Fallback Cascade

```
Stagehand DOM   → retry 2x    → 15s timeout per attempt
    │ (on selector_not_found, shadow_dom_blocked, action_no_effect)
    ▼
Stagehand CUA   → retry 1x    → 30s timeout per attempt
    │ (on same failures as DOM)
    ▼
Magnitude       → retry 2x    → 30s timeout per attempt  [Premium only]
    │ (on all failures except budget_exceeded)
    ▼
Human (VNC)     → wait 120s   → then fail
```

Total cascade timeout: 5 minutes.

Platform-specific overrides:

| Platform | Primary | Fallback Order |
|----------|---------|---------------|
| LinkedIn | Stagehand DOM | CUA → Magnitude → Human |
| Greenhouse | Stagehand DOM | CUA → Magnitude → Human |
| Lever | Stagehand DOM | CUA → Magnitude → Human |
| Workday | Magnitude | Stagehand CUA → Human |
| Unknown | Stagehand DOM | CUA → Magnitude → Human |

---

## 6. Error Recovery Patterns

### 6.1 CDP Connection Recovery

```typescript
async function withCdpRecovery<T>(
  createEngine: () => Promise<Stagehand>,
  operation: (stagehand: Stagehand) => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let stagehand = await createEngine();

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
      stagehand = await createEngine();
    }
  }
  throw new Error("CDP recovery exhausted");
}
```

### 6.2 LLM Fallback (Cost-Tiered)

```typescript
async function actWithFallback(
  stagehand: Stagehand,
  instruction: string,
): Promise<ActResult> {
  // Tier 1: Primary model
  try {
    return await stagehand.act(instruction, {
      timeout: 15_000,
      model: { modelName: "anthropic/claude-sonnet-4-5" },
    });
  } catch {}

  // Tier 2: Cheaper fallback
  try {
    return await stagehand.act(instruction, {
      timeout: 15_000,
      model: { modelName: "openai/gpt-4.1-mini" },
    });
  } catch {}

  // Tier 3: Most permissive prompt
  return await stagehand.act(instruction, {
    timeout: 30_000,
    model: { modelName: "anthropic/claude-sonnet-4-5" },
    // More verbose instruction for difficult elements
  });
}
```

### 6.3 Stagehand-Specific Error Handling

| Error Class | Recovery Strategy |
|-------------|-------------------|
| `StagehandElementNotFoundError` | Re-observe page, try broader instruction, switch to CUA mode |
| `StagehandClickError` | Wait 1s for DOM settle, scroll into view, retry |
| `StagehandIframeError` | Check same-origin, try `deepLocator` option |
| `XPathResolutionError` | Re-observe to get fresh selector |
| `AgentAbortError` | Save progress, clean up, mark for retry |

### 6.4 Magnitude Error Handling

| Error Pattern | Recovery Strategy |
|---------------|-------------------|
| Coordinate miss | Wait 1s for page stabilize, retry with more specific prompt |
| Rate limit (429) | Exponential backoff: `2^attempt * 1000ms` |
| Context overflow | Reduce `maxScreenshots`, clear agent context |
| Navigation failure | Retry once, verify URL |

---

## 7. Human-in-the-Loop Flows

### 7.1 Hatchet DurableTask Pattern

```typescript
// In the Hatchet workflow definition
const fillForm = workflow.durableTask({
  name: "fill-form",
  executionTimeout: "10m",
  fn: async (context: DurableContext<TaskInput>) => {
    const controller = new SandboxController(/* ... */);

    try {
      await controller.execute(/* ... */);
    } catch (error) {
      if (classifyFailure(error) === "captcha_detected") {
        // Pause workflow, notify user
        context.log("CAPTCHA detected, requesting human intervention");

        // Update task status to waiting_human
        await updateTaskStatus(context.input.taskId, "waiting_human");

        // Wait for human resolution (up to 5 minutes)
        const resolution = await context.waitFor<HumanResolution>(
          "human:resolved",
          { timeout: "5m" },
        );

        if (resolution.action === "completed") {
          // Human solved it, continue workflow
          await updateTaskStatus(context.input.taskId, "in_progress");
          return await controller.execute(/* continue from where we left off */);
        }

        if (resolution.action === "cancelled") {
          await updateTaskStatus(context.input.taskId, "cancelled");
          return { status: "cancelled" };
        }
      }

      throw error;
    }
  },
});
```

### 7.2 VNC Session Handoff

```typescript
// API endpoint to create VNC session for human takeover
async function createVncSession(
  taskId: string,
  userId: string,
): Promise<{ vncUrl: string; token: string }> {
  // 1. Get sandbox connection info
  const sandbox = await getSandboxForTask(taskId);

  // 2. Generate per-session JWT
  const token = jwt.sign(
    { taskId, userId, sandboxId: sandbox.id },
    process.env.VNC_JWT_SECRET,
    { expiresIn: "10m" },
  );

  // 3. Return VNC WebSocket URL
  return {
    vncUrl: `wss://${sandbox.host}:6080/websockify?token=${token}`,
    token,
  };
}
```

### 7.3 Human Resolution Event

```typescript
// Frontend sends resolution event
async function resolveHumanIntervention(
  taskId: string,
  action: "completed" | "cancelled" | "skip_field",
): Promise<void> {
  // Push event to Hatchet to wake the waiting durableTask
  await hatchet.events.push("human:resolved", {
    taskId,
    action,
    resolvedAt: new Date().toISOString(),
  });
}
```

### 7.4 Browserbase Live View (Alternative to VNC)

For Starter/Pro tiers, Browserbase provides built-in Live View:

```typescript
// No VNC stack needed — use Browserbase's debug URL
const session = await bb.sessions.retrieve(sessionId);
const liveViewUrl = session.debuggerFullscreenUrl;
// Embed this URL in an iframe on the frontend
```

---

## 8. Cost Optimization

### 8.1 LLM Cost per Application

| Engine + Model | Tokens/App | Cost/App | Use Case |
|---------------|-----------|----------|----------|
| Stagehand DOM + GPT-4.1 mini | ~2K tokens | ~$0.003 | Simple forms |
| Stagehand DOM + Sonnet | ~5K tokens | ~$0.02 | Complex forms |
| Stagehand CUA + Sonnet | ~10K tokens | ~$0.05 | Shadow DOM |
| Magnitude + Sonnet | ~20K tokens (incl. images) | ~$0.08-0.15 | Vision-heavy |

### 8.2 3-Tier LLM Routing Strategy

```typescript
function selectModel(
  task: "observe" | "act" | "extract" | "generate_answer",
  complexity: "low" | "medium" | "high",
): string {
  // Tier 1: Observation and simple actions — cheapest model
  if (task === "observe" || (task === "act" && complexity === "low")) {
    return "openai/gpt-4.1-mini";  // ~$0.001/1K tokens
  }

  // Tier 2: Complex form filling — balanced model
  if (task === "act" || task === "extract") {
    return "anthropic/claude-sonnet-4-5";  // ~$0.003/1K tokens
  }

  // Tier 3: Open-ended answers — most capable
  return "anthropic/claude-sonnet-4-5";  // Best quality for user-facing text
}
```

### 8.3 Caching Strategy

```typescript
// Stagehand DOM observation caching
const stagehand = new Stagehand({
  enableCaching: true,  // Caches DOM observations across actions
});

// QA Bank caching (avoid regenerating same answers)
const cachedAnswer = await qaBank.findMatch(question);
if (cachedAnswer?.confidence > 0.85) {
  return cachedAnswer;  // Skip LLM call entirely
}

// Platform template caching
// After analyzing a Greenhouse form once, cache the field structure
// to skip observation step for same employer's forms
const templateKey = `form:${new URL(jobUrl).hostname}:${formFingerprint}`;
const cached = await redis.get(templateKey);
```

### 8.4 Budget Guards

```typescript
// Per-application cost tracking
interface CostTracker {
  taskId: string;
  budget: number;           // Max cost in dollars (e.g., $0.50)
  spent: number;            // Running total
  llmCalls: number;
  screenshots: number;
}

function checkBudget(tracker: CostTracker, estimatedCost: number): void {
  if (tracker.spent + estimatedCost > tracker.budget) {
    throw new BudgetExceededError(
      `Budget exceeded: spent $${tracker.spent.toFixed(3)}, ` +
      `budget $${tracker.budget}, requested $${estimatedCost.toFixed(3)}`,
    );
  }
}
```

---

## 9. Testing & Validation

### 9.1 Unit Testing Engine Wrappers

```typescript
// Mock Stagehand for unit tests
const mockStagehand = {
  act: vi.fn().mockResolvedValue({ success: true }),
  observe: vi.fn().mockResolvedValue([{ description: "Name field", selector: "#name" }]),
  extract: vi.fn().mockResolvedValue({ text: "Application submitted" }),
  page: {
    url: vi.fn().mockReturnValue("https://example.com/apply"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
  },
  close: vi.fn(),
};

describe("SandboxController", () => {
  it("should fall back to Magnitude on shadow DOM failure", async () => {
    mockStagehand.act.mockRejectedValueOnce(
      new Error("shadow-root blocked access"),
    );

    const controller = new SandboxController(4, mockProvider, vi.fn());
    await controller.initialize(config);

    const result = await controller.execute(action);
    expect(controller.currentEngine).toBe("magnitude");
  });
});
```

### 9.2 Integration Testing Against Real ATS

```typescript
// E2E test against Greenhouse test instance
describe("Greenhouse Integration", () => {
  it("should fill and submit a test application", async () => {
    const stagehand = await createBrowserbaseStagehand(testSessionId);

    try {
      await stagehand.goto(GREENHOUSE_TEST_JOB_URL);
      await stagehand.act('Fill "First Name" with "Test"');
      await stagehand.act('Fill "Last Name" with "Automation"');
      await stagehand.act('Fill "Email" with "test@example.com"');

      const fields = await stagehand.observe({
        instruction: "List all visible form fields",
      });

      expect(fields.length).toBeGreaterThan(0);
    } finally {
      await stagehand.close();
    }
  });
});
```

### 9.3 Platform Compatibility Matrix

| Platform | Engine | Test Coverage | Notes |
|----------|--------|--------------|-------|
| Greenhouse | Stagehand DOM | Full E2E | Test sandbox available |
| Lever | Stagehand DOM | Full E2E | Test sandbox available |
| LinkedIn Easy Apply | Stagehand DOM | Manual only | Requires real account |
| Workday | Magnitude | Manual only | Shadow DOM, no test sandbox |
| Indeed | Stagehand DOM | Partial E2E | Rate limits on testing |
| Custom ATS | Stagehand DOM → CUA | Per-site | Unknown structure |
