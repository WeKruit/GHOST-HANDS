# Hybrid Execution Architecture — Cost & Speed Optimization

**Status:** Design approved, implementation pending
**Created:** 2026-02-26
**Target:** Reduce per-job cost from ~$0.50 to $0.05-0.10

---

## Versioning Strategy (Backward Compatibility)

New `engine_version` field on job submission. **v1 is always the default** — zero regression risk.

```
engine_version: 1  (default, omitted)  →  Current path: ExecutionEngine → cookbook or Magnitude
engine_version: 2                       →  New path: StepOrchestrator → observe→plan→act→verify→record
```

### Where the version flows

```
VALET → POST /valet/apply { engine_version: 2 }
  │
  ▼
API schema validates → stored in gh_automation_jobs.metadata.engine_version
  │
  ▼
JobExecutor.execute(job)
  │
  ├─ if engine_version === 1 (or absent):
  │    → Current ExecutionEngine (cookbook → Magnitude fallback)
  │    → Current task handlers (ApplyHandler, WorkdayApplyHandler, etc.)
  │    → ZERO changes to existing code paths
  │
  └─ if engine_version === 2:
       → StepOrchestrator (observe → plan → act → verify → record)
       → Tiered execution (Playwright → Stagehand → Magnitude)
       → Enhanced cookbook with page-level recording
```

### Schema changes

**`src/api/schemas/valet.ts`** — Add to both ValetApplySchema and ValetTaskSchema:
```typescript
engine_version: z.number().int().min(1).max(2).default(1)
  .describe('Execution engine version. 1=current (Magnitude), 2=hybrid (observe-first tiered)'),
```

**`src/workers/JobExecutor.ts`** — Branch point:
```typescript
const engineVersion = job.metadata?.engine_version ?? job.input_data?.engine_version ?? 1;

if (engineVersion === 2) {
  // New hybrid path
  return this.executeV2(job, adapter, ...);
} else {
  // Existing v1 path — UNTOUCHED
  return this.executeV1(job, adapter, ...);
}
```

### Rollout strategy
1. Deploy v2 code alongside v1 (v1 default, v2 opt-in)
2. Test v2 on staging with `engine_version: 2` from VALET test page
3. Compare cost + success rate between v1 and v2 for same job URLs
4. Once v2 is proven, flip VALET default to `engine_version: 2`
5. Eventually deprecate v1 (but keep it working for edge cases)

---

## 1. Stagehand act() vs Magnitude act() — The Core Difference

```
STAGEHAND act("Fill the email field with john@example.com")
  1. captureHybridSnapshot()          ← Zero LLM. CDP Accessibility.getFullAXTree
     Returns: text-only a11y tree     ← ~2K-8K text tokens
     "textbox 'Email Address' focused=false value=''"
  2. Send a11y tree + instruction → LLM (text-only, no vision needed)
     Returns: { elementId: 42, method: "fill", arguments: ["john@example.com"] }
  3. Resolve elementId → XPath via combinedXpathMap
  4. Playwright: page.locator(xpath).fill("john@example.com")  ← Deterministic

  Cost: ~3K input + ~200 output text tokens = ~$0.0005 with gemini-flash
  Strengths: Precise selectors, no coordinate errors, works with cheap text models
  Weakness: Fails on canvas, custom widgets, visual-only UI without a11y labels

MAGNITUDE act("Fill in the application form with the user's data")
  1. Take full-page screenshot                ← Image tokens (~3K-6K)
  2. Send screenshot + accumulated context + instruction → LLM (vision model)
     Returns: [
       { variant: "click", x: 245, y: 312 },   ← Multiple actions batched
       { variant: "type", content: "john@example.com" },
       { variant: "click", x: 245, y: 380 },
       { variant: "type", content: "John" },
     ]
  3. Execute each action sequentially via coordinate-based WebHarness
  4. Take new screenshot → repeat if more actions needed

  Cost: ~5K input + ~400 output (vision) = ~$0.005-0.01 with Haiku
  Strengths: Handles ANY visual UI, batches 3-5 actions per call, handles ambiguity
  Weakness: Expensive (image tokens), coordinate misses, needs vision model
```

**Key insight**: They're not competing — they're complementary. Stagehand is a scalpel (precise, cheap, one element at a time). Magnitude is a bulldozer (expensive, visual, handles anything). The orchestrator should use both.

---

## 2. Architecture: Observe-First with Pluggable Adapters

Every phase (observe/classify/act/verify/record) is adapter-agnostic. Either engine can provide capabilities at any phase. An orchestrating layer decides.

```
┌──────────────────────────────────────────────────────────────────┐
│                     StepOrchestrator                              │
│  Manages the full lifecycle: page scan → plan → execute → record │
│  Handles errors, HITL, tier escalation, budget gates             │
└──────────┬───────────┬───────────┬───────────┬──────────────────┘
           │           │           │           │
     ┌─────▼─────┐ ┌──▼───┐ ┌────▼────┐ ┌────▼─────┐
     │  OBSERVE   │ │CLASSIFY│ │  ACT    │ │ VERIFY   │
     │ (build     │ │(plan   │ │(execute │ │(confirm  │
     │  PageModel)│ │ steps) │ │ action) │ │ success) │
     └─────┬─────┘ └──┬───┘ └────┬────┘ └────┬─────┘
           │           │          │            │
     ┌─────▼───────────▼──────────▼────────────▼─────────────────┐
     │              Capability Providers                          │
     │                                                            │
     │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
     │  │  Playwright   │  │  Stagehand   │  │   Magnitude      │ │
     │  │  (DOM-direct) │  │  (a11y+LLM)  │  │   (vision+LLM)  │ │
     │  │              │  │              │  │                  │ │
     │  │ OBSERVE: ✓   │  │ OBSERVE: ✓   │  │ OBSERVE: ✓       │ │
     │  │ extractForms │  │ a11y tree    │  │ screenshot+LLM  │ │
     │  │ extractBtns  │  │ observe()    │  │ observe()       │ │
     │  │ scrollScan   │  │              │  │                  │ │
     │  │              │  │ ACT: ✓       │  │ ACT: ✓           │ │
     │  │ ACT: ✓       │  │ act() via    │  │ act() via        │ │
     │  │ fill/click   │  │ XPath+PW     │  │ screenshot+(x,y) │ │
     │  │ setInputFiles│  │              │  │                  │ │
     │  │              │  │ EXTRACT: ✓   │  │ EXTRACT: ✓       │ │
     │  │ VERIFY: ✓    │  │ extract()    │  │ extract()        │ │
     │  │ readback     │  │              │  │                  │ │
     │  │ URL check    │  │ VERIFY: ✓    │  │ VERIFY: ✓        │ │
     │  │ DOM diff     │  │ a11y diff    │  │ screenshot diff  │ │
     │  │              │  │              │  │                  │ │
     │  │ Cost: $0     │  │ Cost: ~$0.001│  │ Cost: ~$0.01     │ │
     │  └──────────────┘  └──────────────┘  └──────────────────┘ │
     └───────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │     RECORD         │
                    │  TraceRecorder     │
                    │  (saves PageModel  │
                    │   + actions as     │
                    │   cookbook entry)   │
                    └───────────────────┘
```

---

## 3. The Observe-First Page Scan

**Before ANY action on a new page**, build a complete `PageModel`:

```
NEW PAGE DETECTED (navigation, form submit, URL change)
  │
  ▼
┌─ PHASE 1: Full Page Scan ──────────────────────────────────────┐
│                                                                 │
│  1. Wait for page load (network idle + DOM stable)              │
│  2. Detect page type (form, login, confirmation, error, etc.)   │
│  3. Detect platform (workday, greenhouse, lever, etc.)          │
│  4. Check for blockers (CAPTCHA, login wall) → HITL if needed  │
│                                                                 │
│  5. SCROLL SCAN — build full-page inventory:                    │
│     ┌─────────────────────────────────────────────────────┐    │
│     │  scrollTo(top)                                       │    │
│     │  while (!atBottom) {                                 │    │
│     │    captureViewport() → extract forms/fields/buttons  │    │
│     │    scrollBy(65% viewport)                            │    │
│     │    merge new elements into PageModel                 │    │
│     │  }                                                   │    │
│     │  scrollTo(top) // reset for action phase             │    │
│     └─────────────────────────────────────────────────────┘    │
│                                                                 │
│  6. Build PageModel:                                            │
│     - All form fields (name, label, type, required, selector)   │
│     - All buttons (text, type, selector, position)              │
│     - File upload inputs (for resume)                           │
│     - Dropdown/select elements                                  │
│     - Date picker elements                                      │
│     - Page boundary (total scrollHeight, viewport count)        │
│     - Structure fingerprint (for cookbook matching)              │
│                                                                 │
│  7. Match against existing cookbook (ManualStore lookup)         │
│                                                                 │
│  Sources (cheapest first):                                      │
│     a. Playwright DOM extraction (FREE)                        │
│     b. Stagehand a11y tree snapshot (FREE, no LLM)             │
│     c. Stagehand observe() (CHEAP, 1 LLM call per viewport)   │
│     d. Magnitude screenshot (EXPENSIVE, only if needed)        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
  │
  ▼ PageModel ready
```

### PageModel Type

```typescript
interface PageModel {
  url: string;
  platform: string;                    // workday, greenhouse, lever, etc.
  pageType: string;                    // form, login, confirmation, multi-step, etc.
  fingerprint: string;                 // deterministic hash for cookbook matching
  scrollBoundary: { totalHeight: number; viewportHeight: number; viewportCount: number };

  fields: FieldModel[];                // ALL form fields on the page
  buttons: ButtonModel[];              // ALL buttons
  fileInputs: FileInputModel[];        // Upload elements (resume, cover letter)
  selects: SelectModel[];              // Dropdowns with their options
  datePickers: DatePickerModel[];      // Date inputs

  blockers: ObservationBlocker[];      // CAPTCHAs, login walls detected
  cookbookMatch?: ActionManual;        // Matching cookbook if found

  observationSource: 'dom' | 'a11y' | 'stagehand' | 'magnitude';
}

interface FieldModel {
  selector: string;                    // CSS selector
  xpath?: string;                      // XPath (from Stagehand a11y)
  label?: string;                      // Associated label text
  name?: string;                       // HTML name attribute
  type: string;                        // text, email, tel, password, etc.
  placeholder?: string;
  required: boolean;
  currentValue: string;                // Already filled or empty
  matchedUserDataKey?: string;         // Auto-matched to user_data key (or null)
  matchConfidence: number;             // 0-1 how confident the match is
  viewportIndex: number;               // Which scroll viewport contains this
}

interface FileInputModel {
  selector: string;
  acceptTypes: string;                 // ".pdf,.docx" etc.
  label?: string;                      // "Upload Resume", "Attach Cover Letter"
  purpose: 'resume' | 'cover_letter' | 'other';
  alreadyUploaded: boolean;
}
```

---

## 4. The Step Execution Loop

After the page scan builds a PageModel, the orchestrator plans and executes:

```
PageModel ready
  │
  ▼
┌─ PHASE 2: Plan Actions ───────────────────────────────────────┐
│                                                                │
│  ActionPlanner receives PageModel + userData + task type        │
│                                                                │
│  Output: ordered ActionPlan[]                                  │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ 1. Upload resume (if fileInput.purpose='resume')       │   │
│  │ 2. Fill field "First Name" → userData.first_name       │   │
│  │ 3. Fill field "Last Name" → userData.last_name         │   │
│  │ 4. Fill field "Email" → userData.email                 │   │
│  │ 5. Select dropdown "Country" → userData.country        │   │
│  │ 6. Fill field "Phone" → userData.phone                 │   │
│  │ 7. Answer question "Why do you..." → LLM generate     │   │
│  │ 8. Click "Next" / "Submit" / "Continue"                │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  Each action gets a recommended tier:                          │
│  - High-confidence field match → Tier 0 (Playwright direct)   │
│  - File upload → Tier 0 (setInputFiles, always DOM)           │
│  - Medium-confidence match → Tier 1 (Stagehand act)           │
│  - Open-ended question → Tier 2 (Stagehand extract + fill)    │
│  - No match / complex UI → Tier 3 (Magnitude act)             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ PHASE 3: Execute + Verify (per action) ──────────────────────┐
│                                                                │
│  for each action in plan:                                      │
│    1. captureState(page) → before snapshot                     │
│    2. scrollToElement(action.selector) if not in viewport      │
│    3. Execute at recommended tier                              │
│       ├─ Tier 0: Playwright  page.locator(sel).fill(value)    │
│       ├─ Tier 1: Stagehand   stagehand.act(instruction)       │
│       ├─ Tier 2: Stagehand   stagehand.extract() then fill    │
│       └─ Tier 3: Magnitude   adapter.act(instruction)         │
│    4. captureState(page) → after snapshot                      │
│    5. Verify: compare before/after                             │
│       ├─ Field readback: page.$eval(sel, el => el.value)      │
│       ├─ URL changed? (form submission detected)               │
│       ├─ Error appeared? (validation banner)                   │
│       └─ DOM structure changed? (new section revealed)         │
│    6. On FAILURE:                                              │
│       ├─ Escalate to next tier (Tier 0→1→2→3)                 │
│       ├─ If Tier 3 fails → mark action as needs_hitl           │
│       └─ If validation error → error recovery loop             │
│    7. On SUCCESS:                                              │
│       └─ Record to TraceRecorder with tier + locator quality   │
│                                                                │
│  After all actions:                                            │
│    - Re-scan for new elements (some forms reveal fields)       │
│    - Click navigation button (Next/Submit/Continue)            │
│    - Detect page transition → loop back to Phase 1             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 5. Dedicated Page Operations

First-class operations with dedicated handling, not afterthoughts delegated to LLM:

### Resume Upload (Tier 0 always — never use LLM for file upload)
```
1. PageModel.fileInputs finds input[type="file"] elements
2. Classify by label: "resume" | "cover_letter" | "other"
3. Check alreadyUploaded (look for filename text, delete buttons)
4. If not uploaded: page.locator(selector).setInputFiles(resumePath)
5. Verify: wait for upload confirmation text or filename appears
6. Fallback: register filechooser listener, click the upload button
```

### Dropdown Selection (Tier 0/1 — DOM first, Stagehand if custom)
```
1. PageModel.selects lists all <select> elements + their <option> values
2. Match userData value to option text (fuzzy match)
3. Standard HTML select: page.locator(sel).selectOption(value) — Tier 0
4. Custom dropdown (React Select, Workday dropdown):
   - Stagehand act("Select {value} from {label} dropdown") — Tier 1
   - Magnitude act() — Tier 3 only if Stagehand fails
```

### Date Pickers (Tier 0/1)
```
1. Detect date inputs: input[type="date"], [data-automation-id*="date"], .datepicker
2. Standard HTML date: page.locator(sel).fill("2024-01-15") — Tier 0
3. Custom date picker: Stagehand act("Set date to January 15, 2024") — Tier 1
```

### Open-Ended Questions (Tier 2 — needs LLM for answer generation)
```
1. Detect question fields: textarea, input with question-like labels
2. Check qa_overrides first (user-provided answers) — Tier 0
3. Generate answer: Stagehand extract("What is the question asking?") →
   cheap LLM generates answer → fill — Tier 2
4. Fallback: Magnitude act("Answer the question: {question}") — Tier 3
```

### Multi-Page Navigation (orchestrator-level)
```
1. After filling current page: click Next/Continue/Submit DOM-direct
2. Wait for page load (network idle + DOM stable)
3. Detect if same page (validation error) or new page (URL/DOM changed)
4. If new page → loop back to Phase 1 (full page scan)
5. If validation error → error recovery (scroll to error, fix field, retry)
6. If confirmation page → extract result, done
```

---

## 6. Enhanced Cookbook System

### Page-Level Recording (not just action-level)

Current cookbook records individual actions. New system records **full page models + action plans**:

```typescript
interface CookbookPageEntry {
  pageFingerprint: string;
  urlPattern: string;
  platform: string;
  pageType: string;

  // What we observed (enables re-scan verification)
  expectedFields: { label?: string; name?: string; type: string; selector: string }[];
  expectedButtons: { text: string; selector: string }[];
  expectedFileInputs: { selector: string; purpose: string }[];
  scrollBoundary: { totalHeight: number; viewportCount: number };

  // What we did (enables replay)
  actions: CookbookAction[];

  // Health tracking
  healthScore: number;
  perStepHealth: Map<number, number>;
}
```

### Partial Cookbook Replay

Current: one step fails → entire cookbook abandoned → full Magnitude.
New: **per-step fallback within a cookbook page**:

```
Replay cookbook page entry:
  1. Re-scan page → build fresh PageModel
  2. Compare fresh PageModel vs cookbook's expectedFields
     - Fields still match? → replay the action (Tier 0: Playwright locator)
     - Field moved/renamed? → try DOM-direct with heuristic match (Tier 0)
     - Field gone? → skip, mark step unhealthy
     - New field appeared? → plan new action for it (Tier 1-3)
  3. Per-step health: success → +2, failure → -5
  4. Steps below health 0.5 → pre-classified for Stagehand/Magnitude on next run
```

---

## 7. Model Tiering Strategy

| Phase | Provider | Model | Cost/M (in/out) | Notes |
|-------|----------|-------|-----------------|-------|
| Page scan (DOM) | Playwright | N/A | $0 | extractForms, extractButtons |
| Page scan (a11y) | Stagehand | N/A | $0 | captureHybridSnapshot, no LLM |
| Stagehand observe() | Stagehand | gemini-2.0-flash | $0.15/$0.60 | Element discovery |
| Stagehand act() | Stagehand | gemini-2.0-flash | $0.15/$0.60 | Single-element actions |
| Answer generation | LLM | qwen-7b | $0.21/$0.21 | Open-ended questions |
| Magnitude act() | Magnitude | qwen3-vl-30b | $1.26/$1.26 | Complex visual UI |
| Magnitude act() (hard) | Magnitude | qwen-72b | $4.13/$4.13 | Last resort |
| Verification | Playwright | N/A | $0 | DOM readback |

### Escalation Chain
```
gemini-2.0-flash ($0.15) → qwen3-vl-30b ($1.26) → qwen-72b ($4.13) → claude-haiku ($0.80/$4.00)
```

---

## 8. Error Handling & HITL in the Orchestrator

```
StepOrchestrator error handling:

  ACTION FAILED (field fill, button click):
    → Escalate tier (0→1→2→3)
    → If all tiers fail → mark as needs_hitl, continue other fields
    → After all fields done, pause for human on needs_hitl fields

  VALIDATION ERROR (after clicking Next):
    → Scroll to error banner (DOM detection)
    → Re-scan visible fields for empty/invalid ones
    → Re-plan actions for those fields
    → Retry (max 3 attempts)

  PAGE DIDN'T CHANGE (after clicking Next):
    → Check if button click actually happened (verify)
    → Try alternative button selectors
    → Escalate to Magnitude act("Click the submit button")

  BLOCKER DETECTED (any phase):
    → Pause immediately
    → Send HITL notification to VALET
    → Wait for human resolution (timeout: 5 min)
    → Resume with resolution_data
    → Re-scan page (blocker may have changed page state)

  BROWSER CRASH:
    → Existing crash recovery (restart adapter, reload session)
    → Re-scan page from scratch
    → Continue from last successful action

  BUDGET EXCEEDED:
    → Stop execution
    → Save partial results + partial cookbook
    → Report to VALET with cost breakdown
```

---

## 9. Implementation Plan

### Phase 1: PageScanner + PageModel (foundation)

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/PageScanner.ts` | Create | Full-page scroll scan → PageModel |
| `src/engine/types.ts` | Modify | Add PageModel, FieldModel, ActionPlan types |
| `src/engine/PageObserver.ts` | Modify | Add file input, select, date picker extraction |

### Phase 2: DOMActionExecutor + FieldMatcher (zero-LLM path)

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/DOMActionExecutor.ts` | Create | Zero-LLM form filling (fill, select, upload, date) |
| `src/engine/FieldMatcher.ts` | Create | Heuristic field → userData matching |
| `src/engine/VerificationEngine.ts` | Create | DOM-based action verification |

### Phase 3: StagehandAdapter (full adapter, not just observer)

| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/stagehand.ts` | Create | Full Stagehand v3 adapter (act/observe/extract) |
| `src/adapters/index.ts` | Modify | Wire stagehand adapter in createAdapter() |

### Phase 4: ActionPlanner + StepOrchestrator

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/ActionPlanner.ts` | Create | PageModel → ordered ActionPlan with tiers |
| `src/engine/StepOrchestrator.ts` | Create | Main execution loop (observe→plan→act→verify→record) |

### Phase 5: Enhanced CookbookExecutor + Recording

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/CookbookExecutor.ts` | Modify | Partial replay with per-step fallback |
| `src/engine/TraceRecorder.ts` | Modify | Record PageModel + locator quality scores |
| `src/engine/CookbookPageMatcher.ts` | Create | Compare fresh PageModel vs cookbook expectations |

### Phase 6: Version gate + Integration

| File | Action | Purpose |
|------|--------|---------|
| `src/api/schemas/valet.ts` | Modify | Add engine_version field |
| `src/workers/JobExecutor.ts` | Modify | Branch v1/v2, wire StepOrchestrator for v2 |
| `src/config/ModelSelector.ts` | Create | Per-tier model selection |
| `src/config/models.config.json` | Modify | Add tier_models config |
| `src/workers/costControl.ts` | Modify | Updated budgets + tier breakdown |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| DOM-direct fills wrong field | Readback verification; escalate to Stagehand |
| React controlled inputs ignore fill() | `page.evaluate()` to dispatch synthetic events |
| Stagehand + Magnitude CDP conflict | Already proven (StagehandObserver shares CDP today) |
| Page scan too slow | Parallelize extraction per viewport; skip Stagehand if DOM sufficient |
| Cookbook page model mismatch | CookbookPageMatcher detects changes, plans new actions |
| Cheap models produce bad answers | Tier escalation; quality preset allows expensive models |
| Breaking existing v1 path | engine_version gate — v1 code path completely untouched |
