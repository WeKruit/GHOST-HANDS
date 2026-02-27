# Observe-Then-Act: Hybrid Execution Architecture

**Date:** 2026-02-27
**Status:** Research complete, ready for implementation
**Cost impact:** $0.50/job → $0.002-0.05/job (10-100x reduction)

---

## Problem

Every job application costs ~$0.50 because Magnitude runs 50+ screenshot→vision LLM→action cycles. The vision LLM call is the expensive part (~$0.005-0.01 per cycle). We need to dramatically reduce per-job cost without sacrificing reliability or increasing bot detection risk.

## Solution

**Observe first, match against cookbooks per-section, LLM only for unknowns.**

1. Use Stagehand to read the page's accessibility tree (free) and interpret elements ($0.0005)
2. Decompose the page into logical sections (personal info, education, experience, etc.)
3. Match each section against our cookbook library — section-level, not site-level
4. **Matched sections:** Replay cookbook instructions via `exec()` — human-like, zero LLM cost
5. **Unmatched sections:** Fall back to Magnitude `act()` — GUI/screenshot + vision LLM
6. Re-observe after each section to verify state and detect the next section

The key insight: **the page tree is always the starting point**, and cookbook matching happens at section granularity. A single page can have some sections handled by cookbook replay ($0.00) and others by LLM ($0.01+). This maximizes cookbook coverage while gracefully handling novel form fields.

---

## Research Findings

### Magnitude's Low-Level APIs Are Public

Verified in `magnitude-core` v0.3.1 (our installed version):

| API | Public? | LLM Cost | How It Works |
|-----|---------|----------|-------------|
| `agent.act(instruction)` | Yes | **$0.005-0.01/cycle** | Screenshot → vision LLM → plan → execute → repeat |
| `agent.exec({ variant, x, y })` | **Yes** | **$0.00** | Direct action execution, no LLM |
| `agent.page` (Playwright) | Yes | $0.00 | Full Playwright API access |
| `WebHarness.click({ x, y })` | Yes | $0.00 | 20-step mouse interpolation + click |
| `WebHarness.type({ content })` | Yes | $0.00 | Character-by-character keyboard input |
| `WebHarness.executeAction(action)` | Yes | $0.00 | Generic action executor |

Source: `node_modules/magnitude-core/dist/agent/index.d.ts`, `dist/web/harness.d.ts`

### Bot Detection Comparison

| Signal | Stagehand `act()` | Magnitude `act()` | Our Hybrid (exec) |
|--------|-------------------|-------------------|--------------------|
| **Click method** | CDP `Input.dispatchMouseEvent` at computed centroid | `page.mouse.click(x,y)` with 20-step interpolation | Same as Magnitude — **20-step mouse trace** |
| **Text input** | `Input.insertText` — bulk inject, **zero key events** | `page.fill()` — bulk inject, **zero key events** | `keyboard:type` via harness — **character-by-character with real keydown/keyup** |
| **Mouse trajectory** | Single teleport to target point | 20-step move from current position | Same as Magnitude — 20-step interpolation |
| **Click target variance** | Always exact computed centroid | LLM-chosen point (slight variance) | We choose center of boundingBox (can add jitter) |
| `navigator.webdriver` | `true` (Playwright default) | `true` (Playwright default) | Same — needs separate stealth patching |

**Key insight:** Our hybrid approach is actually **more human-like** than either tool's default behavior because:
- Magnitude's `keyboard:type` action goes through `harness.type()` → `page.keyboard.type()` which fires real `keydown`/`keypress`/`keyup` events per character
- Both Stagehand and Magnitude use bulk text injection by default (`Input.insertText` / `page.fill()`) which fires zero keyboard events — easily detectable by ATS platforms like Workday (which use PerimeterX/HUMAN behavioral biometrics)

### Stagehand observe() Details

- Reads Chrome's accessibility tree (free DOM operation)
- Sends text-only representation to LLM for interpretation
- Cost: ~$0.0005 per call (text tokens only, no vision/images)
- Returns: element selectors (XPath) + human-readable descriptions + suggested interaction methods
- Already wired in our codebase: `StagehandObserver` in `engine/StagehandObserver.ts`

---

## Architecture

The core loop: **Observe → Decompose → Match → Execute → Verify**

```
┌─────────────────────────────────────────────────────────────┐
│  1. OBSERVE (cheap — ~$0.0005)                              │
│                                                             │
│  StagehandObserver.observe()                                │
│  → Reads accessibility tree (free)                          │
│  → LLM interprets elements (text-only, cheap)               │
│  → Returns: [{ selector, description, action }]             │
│                                                             │
│  This is ALWAYS the first step, every page, every time.     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  2. DECOMPOSE INTO SECTIONS (free — $0.00)                  │
│                                                             │
│  Group observed elements into logical sections:             │
│    Section: "Personal Information"                          │
│      → [First Name, Last Name, Email, Phone]                │
│    Section: "Education"                                     │
│      → [School, Degree, GPA, Graduation Date]               │
│    Section: "Work Experience"                                │
│      → [Company, Title, Start Date, End Date, Description]  │
│    Section: "Resume Upload"                                 │
│      → [File input]                                         │
│                                                             │
│  Uses heading elements, fieldset/legend, proximity,         │
│  and label semantics from the accessibility tree.           │
│                                                             │
│  → Returns: [{ sectionName, elements[], signature }]        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  3. MATCH SECTIONS AGAINST COOKBOOK (free — $0.00)           │
│                                                             │
│  For EACH section, compare its signature against the        │
│  cookbook library (ManualStore):                             │
│                                                             │
│  Section signature = normalized set of:                     │
│    - Field labels, types, order                             │
│    - e.g. ["text:first_name", "text:last_name",             │
│            "text:email", "tel:phone"]                       │
│                                                             │
│  ManualStore.lookupSection(signature, platform)             │
│    → Fuzzy match against stored section manuals             │
│    → Health score > 0.3 required                            │
│                                                             │
│  Result for each section:                                   │
│    ✓ MATCHED   → has cookbook steps to replay                │
│    ✗ UNMATCHED → needs LLM fallback                         │
│                                                             │
│  → Returns: { matched: [...], unmatched: [...] }            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  4a. EXECUTE MATCHED SECTIONS (free — $0.00, human-like)    │
│                                                             │
│  For each matched section, replay cookbook steps:            │
│                                                             │
│  Locate elements:                                           │
│    page.$(selector) → boundingBox() → {x, y} coordinates   │
│                                                             │
│  Execute via Magnitude exec() (no LLM):                    │
│    agent.exec({ variant: 'mouse:click', x, y })            │
│      → 20-step mouse interpolation to target                │
│    agent.exec({ variant: 'keyboard:type', content })        │
│      → Character-by-character, real keydown/keyup events    │
│                                                             │
│  Template substitution:                                     │
│    step.value = "{{firstName}}" → userData.firstName         │
│                                                             │
│  For selects/dropdowns:                                     │
│    Click to open → locate matching option → click           │
│  For file uploads:                                          │
│    page.on('filechooser') → setFiles()                      │
│                                                             │
│  Cost: $0.00 per section — pure Playwright + exec()         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  4b. EXECUTE UNMATCHED SECTIONS (expensive — LLM fallback)  │
│                                                             │
│  For each unmatched section, use Magnitude act():           │
│                                                             │
│    adapter.act("Fill in the Work Experience section...")     │
│      → Screenshot of current viewport                       │
│      → Vision LLM identifies elements + plans actions       │
│      → Executes actions with human-like input               │
│      → Repeats until section complete                        │
│                                                             │
│  TraceRecorder captures these actions for future cookbooks: │
│    recorder.start() → listens to adapter 'actionDone'       │
│    → Extracts DOM locators via elementFromPoint              │
│    → Templatizes values ({{email}}, {{phone}}, etc.)         │
│    → Stores as ManualStep[] for this section signature       │
│                                                             │
│  Cost: ~$0.01-0.05 per section (vision LLM cycles)          │
│  But: NEXT TIME this section is seen, it's $0.00 (cookbook)  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  5. VERIFY & LOOP (cheap — ~$0.0005)                        │
│                                                             │
│  Re-observe page state via StagehandObserver:               │
│    - Did fields get filled correctly?                       │
│    - Did a new page/section load?                           │
│    - Any error messages?                                    │
│    - Any HITL blockers (captcha, login)?                    │
│                                                             │
│  If new page/section: → Go back to step 1 (OBSERVE)        │
│  If error on a field: → Retry that field or escalate        │
│  If HITL blocker: → Pause for human intervention            │
│  If all good + submit button visible: → Click submit        │
│  If stuck after retries: → Fail job                         │
└─────────────────────────────────────────────────────────────┘
```

### Why Section-Level Matching?

The old approach matched cookbooks at the **whole-site level** (URL pattern). This has problems:

1. **All-or-nothing:** If a site adds one new field, the entire cookbook fails and we fall back to full LLM for everything
2. **Low reuse:** A "Personal Information" section on Workday looks the same as on Greenhouse, but site-level matching can't share them
3. **Slow learning:** Need a full successful run per site before any cookbook exists

Section-level matching fixes all of these:

1. **Graceful degradation:** If 4 out of 5 sections match, only 1 section uses LLM
2. **Cross-platform reuse:** A "Personal Info" section cookbook works across all ATS platforms
3. **Fast learning:** Each LLM-handled section is immediately recorded as a new cookbook entry. After a few runs across different sites, the cookbook covers most section types.

### Self-Learning Loop

```
First run on a new site:
  Observe → 0/5 sections matched → all 5 use LLM ($0.05)
  TraceRecorder saves 5 new section cookbooks

Second run on same site:
  Observe → 5/5 sections matched → all 5 use cookbook ($0.00)

First run on DIFFERENT site (same ATS platform):
  Observe → 3/5 sections matched → 2 use LLM ($0.02)
  TraceRecorder saves 2 new section cookbooks

Eventually:
  Most sections across all platforms are covered
  Only genuinely novel fields trigger LLM
  Steady-state cost: $0.002-0.005/job
```

---

## Section Signature Design

A section signature is a normalized fingerprint that enables matching across sites.

### Structure

```typescript
interface SectionSignature {
  fields: FieldFingerprint[];  // Sorted, normalized field descriptors
  hash: string;                // SHA-256 of normalized fields for fast lookup
}

interface FieldFingerprint {
  type: 'text' | 'email' | 'tel' | 'select' | 'checkbox' | 'radio' | 'file' | 'textarea' | 'date' | 'number';
  label: string;               // Normalized: lowercase, trimmed, common synonyms collapsed
  required: boolean;
}
```

### Normalization Rules

Labels are normalized to enable cross-platform matching:

```
"First Name" / "Given Name" / "first_name" / "fname"  → "first_name"
"Last Name"  / "Family Name" / "Surname"               → "last_name"
"Email Address" / "E-mail" / "email"                    → "email"
"Phone Number" / "Mobile" / "Cell" / "Telephone"        → "phone"
"Street Address" / "Address Line 1"                     → "street_address"
"Resume" / "CV" / "Upload Resume"                       → "resume_file"
"Cover Letter"                                          → "cover_letter_file"
```

### Matching Algorithm

```
1. Compute section signature hash
2. Exact hash match in ManualStore → use directly (fastest)
3. No exact match → fuzzy match:
   a. Find cookbook sections with ≥80% field overlap
   b. Rank by health score
   c. Best match above threshold → use, with gap-fill for missing fields
4. No fuzzy match → section is UNMATCHED → LLM fallback
```

---

## Cost Comparison

### Per-Job Cost Breakdown (Happy Path — All Sections Matched)

| Step | # Calls | Cost/Call | Total |
|------|---------|-----------|-------|
| Stagehand observe (page tree) | 1 | $0.0005 | $0.0005 |
| Decompose into sections | 1 | $0.00 | $0.00 |
| Match against cookbook | 1 | $0.00 | $0.00 |
| Playwright boundingBox (locate) | ~20 | $0.00 | $0.00 |
| Magnitude exec (click/type) | ~20 | $0.00 | $0.00 |
| Re-observe (per page/section) | ~3 | $0.0005 | $0.0015 |
| **Happy path total** | | | **$0.002** |

### Per-Job Cost Breakdown (Partial Match — Some Sections Need LLM)

| Step | # Calls | Cost/Call | Total |
|------|---------|-----------|-------|
| Happy path base | — | — | $0.002 |
| Magnitude act() per unmatched section | 1-3 | $0.01-0.02 | $0.01-0.05 |
| **Partial match total** | | | **$0.01 - $0.05** |

### Per-Job Cost Breakdown (First Run — No Cookbook)

| Step | # Calls | Cost/Call | Total |
|------|---------|-----------|-------|
| Stagehand observe (page tree) | 1 | $0.0005 | $0.0005 |
| Decompose into sections | 1 | $0.00 | $0.00 |
| Match against cookbook (all miss) | 1 | $0.00 | $0.00 |
| Magnitude act() for all sections | 3-5 | $0.01-0.02 | $0.03-0.10 |
| Re-observe (verify) | ~3 | $0.0005 | $0.0015 |
| **First run total** | | | **$0.03 - $0.10** |
| *But*: all sections recorded as cookbooks for next time | | | |

### vs Current Architecture

| Metric | Current (Magnitude only) | Hybrid (Observe-then-Act) |
|--------|-------------------------|---------------------------|
| Cost per job (steady state) | ~$0.50 | $0.002 - $0.01 |
| Cost per job (first run) | ~$0.50 | $0.03 - $0.10 |
| LLM calls per job | ~50 vision calls | 1-5 text + 0-5 vision fallback |
| Vision model usage | Every action | Only unmatched sections |
| Cookbook granularity | Whole-site | Per-section |
| Cross-platform reuse | None | Sections reused across sites |
| Mouse simulation | 20-step interpolation | Same (via exec) |
| Keyboard simulation | Bulk inject (fill) | **Character-by-character (type)** |
| Bot detection risk | Medium | **Lower** (better keyboard events) |

### Monthly Cost at Scale (Steady State)

| Jobs/month | Current | Hybrid | Savings |
|------------|---------|--------|---------|
| 100 | $50 | $0.20 - $1 | 98-99% |
| 1,000 | $500 | $2 - $10 | 98-99% |
| 10,000 | $5,000 | $20 - $100 | 98-99% |

---

## Implementation Plan

### Phase 1: Expose `exec()` on MagnitudeAdapter

**Files:**
- `packages/ghosthands/src/adapters/magnitude.ts` — add `exec()` passthrough
- `packages/ghosthands/src/adapters/types.ts` — add optional `exec()` to interface

```typescript
// magnitude.ts — add method
async exec(action: { variant: string; [key: string]: any }): Promise<void> {
  this.emitter.emit('actionStarted', action);
  await this.requireAgent().exec(action);
  this.emitter.emit('actionDone', action);
}
```

**Effort:** ~30 minutes. Zero risk — additive only.

### Phase 2: Section Decomposer

**New file:** `packages/ghosthands/src/engine/SectionDecomposer.ts`

Takes the flat list of `ObservedElement[]` from StagehandObserver and groups them into logical sections using:
- Heading elements (`<h1>`-`<h6>`, `<legend>`, `aria-label` on `<fieldset>`)
- Proximity grouping (elements between headings)
- Semantic clustering (all name/email/phone fields likely = "Personal Info")

Returns `PageSection[]` where each section has a name, element list, and computed signature.

**Effort:** ~1 day.

### Phase 3: Section-Level ManualStore

**File:** `packages/ghosthands/src/engine/ManualStore.ts` — extend with section methods

Add section-level storage and lookup alongside existing site-level methods (backward compatible):

- `lookupSection(signature, platform?)` — find matching cookbook for a section signature
- `saveSectionFromTrace(steps, sectionSignature, metadata)` — save a section cookbook from recorded trace
- New DB table: `gh_section_manuals` (section signatures + steps + health scores)
- Fuzzy matching: field-overlap scoring for signatures that don't match exactly

**Effort:** ~1 day.

### Phase 4: Create ObserveAndActEngine (Orchestrator)

**New file:** `packages/ghosthands/src/engine/ObserveAndActEngine.ts`

Core orchestrator implementing the full loop:

```
observe → decompose → match sections → execute matched → LLM unmatched → verify → loop
```

Key methods:
- `fillPage(userData, adapter, observer)` — main entry point
- `observeAndDecompose(observer)` — steps 1-2
- `matchSections(sections, platform)` — step 3
- `executeMatchedSection(section, manual, adapter)` — step 4a (exec-based replay)
- `executeUnmatchedSection(section, adapter, recorder)` — step 4b (Magnitude act + record)
- `verifyAndLoop(observer)` — step 5

**Effort:** ~1-2 days.

### Phase 5: Enhance StagehandObserver

**File:** `packages/ghosthands/src/engine/StagehandObserver.ts`

Currently returns basic `{ selector, description, action }`. Enhance to also return:
- Field type (text, email, tel, select, checkbox, radio, file, button)
- Current value (if pre-filled)
- Label text
- Required flag
- Placeholder text
- Containing section hint (heading/fieldset context)

This enables better section decomposition and signature computation without additional LLM calls.

**Effort:** ~0.5 days.

### Phase 6: Wire into Execution Flow

**File:** `packages/ghosthands/src/workers/JobExecutor.ts`

Replace the current `ExecutionEngine` call with the new hybrid flow:

```
1. StagehandObserver.observe() → page tree
2. SectionDecomposer.decompose() → sections
3. For each section:
   a. ManualStore.lookupSection() → cookbook match?
   b. YES: CookbookExecutor with exec() → $0.00
   c. NO:  Magnitude act() + TraceRecorder → save section cookbook
4. Verify, loop for next page
```

Gate via `execution_mode` field (already exists in DB, currently unwired):
- `auto` → observe-then-act with section matching (new default)
- `ai_only` → Magnitude only (current behavior, for debugging)
- `cookbook_only` → only execute matched sections, skip unmatched

**Effort:** ~0.5 days.

**Total estimated effort: 4-5 days**

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Section decomposition misgroups fields | Wrong fields matched to wrong cookbook | Verify after each section fill; re-decompose if field errors detected |
| Section signature too strict (no fuzzy match) | Low cookbook hit rate | Fuzzy matching with ≥80% field overlap threshold; synonym normalization |
| Section signature too loose (false matches) | Wrong cookbook applied, bad fills | Health score system degrades bad matches; verify after fill |
| Stagehand observe() returns stale selectors | Field click misses target | Re-observe after every section; verify element exists before clicking |
| boundingBox() returns null (off-screen element) | Can't get coordinates | Scroll into view first (`element.scrollIntoViewIfNeeded()`) |
| exec() mouse traces detected as bot | Application rejected | Magnitude's 20-step interpolation is industry standard; add jitter later |
| Multi-page forms with dynamic loading | Observe sees incomplete page | Wait for network idle before observing; re-observe after page transitions |
| CAPTCHA/login wall appears mid-form | Execution blocked | Existing HITL blocker detection handles this (already wired) |

---

## What We Already Have vs What We Need

### Already Built (reuse as-is)
- `StagehandObserver` — observation layer (`engine/StagehandObserver.ts`)
- `MagnitudeAdapter` — execution layer with `page` access (`adapters/magnitude.ts`)
- `CookbookExecutor` — deterministic step replay (`engine/CookbookExecutor.ts`)
- `ManualStore` — cookbook CRUD + health scores (`engine/ManualStore.ts`)
- `TraceRecorder` — action recording for future cookbooks (`engine/TraceRecorder.ts`)
- `BlockerDetector` — HITL detection (`detection/BlockerDetector.ts`)
- `CostControl` — budget tracking (`workers/CostControl.ts`)
- `execution_mode` DB field — already in schema, just needs wiring
- HITL pause/resume flow — fully implemented

### Need to Build
- `exec()` passthrough on MagnitudeAdapter (~30 min)
- `SectionDecomposer` — page tree → sections (~1 day)
- Section-level ManualStore methods + `gh_section_manuals` table (~1 day)
- `ObserveAndActEngine` — orchestrator (~1-2 days)
- Enhanced observation metadata on StagehandObserver (~0.5 days)
- Wiring in JobExecutor (~0.5 days)

**Total estimated effort: 4-5 days**

---

## Database Changes

### New Table: `gh_section_manuals`

```sql
CREATE TABLE gh_section_manuals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_hash TEXT NOT NULL,           -- SHA-256 of normalized section signature
  signature JSONB NOT NULL,               -- Full section signature (fields, types, labels)
  section_name TEXT,                       -- Human-readable name ("Personal Information")
  platform TEXT,                           -- ATS platform ("workday", "greenhouse", null=generic)
  steps JSONB NOT NULL,                   -- ManualStep[] for this section
  health_score INTEGER DEFAULT 100,       -- 0-100, same system as gh_action_manuals
  source TEXT DEFAULT 'recorded',         -- 'recorded' | 'template'
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_used TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup by signature hash
CREATE INDEX idx_section_manuals_hash ON gh_section_manuals(signature_hash);
-- Platform-scoped lookups
CREATE INDEX idx_section_manuals_platform ON gh_section_manuals(platform, health_score DESC);

-- RLS
ALTER TABLE gh_section_manuals ENABLE ROW LEVEL SECURITY;
```

The existing `gh_action_manuals` table remains for backward compatibility. Over time, section-level manuals will replace site-level ones as the primary cookbook source.

---

## Appendix: Available Magnitude exec() Actions

From `magnitude-core` v0.3.1 `webActions.ts`:

| Action Variant | Inputs | Description |
|---------------|--------|-------------|
| `mouse:click` | `{ x: number, y: number }` | Click at coordinates (20-step mouse move) |
| `mouse:double_click` | `{ x: number, y: number }` | Double-click at coordinates |
| `mouse:right_click` | `{ x: number, y: number }` | Right-click at coordinates |
| `mouse:drag` | `{ from: {x,y}, to: {x,y} }` | Drag from point to point |
| `mouse:scroll` | `{ x, y, deltaX, deltaY }` | Scroll at coordinates |
| `keyboard:type` | `{ content: string }` | Type text character-by-character |
| `keyboard:enter` | `{}` | Press Enter key |
| `keyboard:tab` | `{}` | Press Tab key |
| `keyboard:backspace` | `{}` | Press Backspace key |
| `keyboard:select_all` | `{}` | Select all text (Ctrl+A) |
| `browser:nav` | `{ url: string }` | Navigate to URL |
| `browser:nav:back` | `{}` | Go back |
| `browser:tab:switch` | `{ index: number }` | Switch browser tab |
| `browser:tab:new` | `{}` | Open new tab |
| `wait` | `{ seconds: number }` | Wait for specified duration |
