# GhostHands System Analysis Report

**Date:** 2026-03-01
**Scope:** Complete technical analysis of the job application automation pipeline post PRD-MASTRA-ORCHESTRATION-V5.2

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Job Lifecycle: End to End](#3-job-lifecycle-end-to-end)
4. [Execution Modes](#4-execution-modes)
5. [Form Discovery & Field Extraction](#5-form-discovery--field-extraction)
6. [Field Matching: How Fields Map to User Data](#6-field-matching-how-fields-map-to-user-data)
7. [Form Filling Strategies (Three-Layer Stack)](#7-form-filling-strategies-three-layer-stack)
8. [Page Classification & Section-Specific Handling](#8-page-classification--section-specific-handling)
9. [Multi-Page Navigation & Stuck Detection](#9-multi-page-navigation--stuck-detection)
10. [Cookbook System: Self-Learning Replay](#10-cookbook-system-self-learning-replay)
11. [Blocker Detection & Human-in-the-Loop](#11-blocker-detection--human-in-the-loop)
12. [Mastra Workflow Orchestration (V5.2)](#12-mastra-workflow-orchestration-v52)
13. [Cost Control & Budget Enforcement](#13-cost-control--budget-enforcement)
14. [Session Persistence & Credential Management](#14-session-persistence--credential-management)
15. [Security Architecture](#15-security-architecture)
16. [Worker Fleet & Job Dispatch](#16-worker-fleet--job-dispatch)
17. [API Surface & VALET Integration](#17-api-surface--valet-integration)
18. [Platform-Specific Configurations](#18-platform-specific-configurations)
19. [Adapter Abstraction Layer](#19-adapter-abstraction-layer)

---

## 1. Executive Summary

GhostHands is a browser automation system that fills out job applications on behalf of users. It operates through a multi-layered architecture designed to minimize cost while maximizing reliability:

- **Three execution engines** (V1 cookbook-first, V3 section-orchestrated, Mastra workflow-driven) coexist and are selected per-job via `execution_mode`
- **Three automation layers** (DOMHand at $0/action, StagehandHand at ~$0.0005/action, MagnitudeHand at ~$0.005/action) escalate from cheapest to most capable
- **Self-learning cookbooks** record successful runs and replay them deterministically on future applications to the same site (~95% cost reduction)
- **Human-in-the-Loop (HITL)** pauses execution on blockers (CAPTCHAs, login walls, 2FA) and resumes when a human resolves them
- **Mastra durable workflows** (new in V5.2) provide crash-safe suspend/resume for the HITL flow with PostgreSQL-backed state snapshots

A typical job application costs $0.003-0.05 depending on form complexity and whether a cookbook exists.

---

## 2. Architecture Overview

```
VALET (frontend)
  │
  ├─── POST /api/v1/gh/valet/apply ──► GhostHands API (Hono, port 3100)
  │                                         │
  │                                    gh_automation_jobs (Postgres)
  │                                         │
  │                                    LISTEN/NOTIFY or pg-boss
  │                                         │
  ├─── Webhook callback ◄────────── Worker (port 3101)
  │                                    │
  │                                    ├─ JobExecutor
  │                                    │   ├─ Adapter (Magnitude/Stagehand/Mock)
  │                                    │   ├─ ExecutionEngine (V1) or V3ExecutionEngine or Mastra workflow
  │                                    │   ├─ TaskHandler (SmartApply/AgentApply/FillForm/...)
  │                                    │   ├─ CostTracker
  │                                    │   ├─ ProgressTracker
  │                                    │   └─ BlockerDetector
  │                                    │
  │                                    └─ gh_action_manuals (cookbook storage)
  │                                       gh_browser_sessions (encrypted sessions)
  │                                       gh_job_events (audit trail)
  │                                       gh_worker_registry (fleet)
```

**Key design principles:**
- Single-task-per-worker (horizontal scaling only)
- Adapter pattern isolates browser engine (Magnitude/Stagehand/Mock)
- All GhostHands tables use `gh_` prefix (shared Supabase DB with VALET)
- AES-256-GCM encryption for all stored credentials and sessions

---

## 3. Job Lifecycle: End to End

```
1. VALET submits job ──► API validates + inserts gh_automation_jobs (status: pending)
2. Worker picks up job ── FOR UPDATE SKIP LOCKED (status: queued)
3. Pre-flight checks ─── Budget validation, input validation
4. Browser launches ───── Magnitude or Stagehand adapter starts
5. Session injection ──── Load stored cookies/localStorage from gh_browser_sessions
6. Initial blocker check  Detect CAPTCHA/login before form filling
7. Execution mode fork:
   ├─ V1: Cookbook attempt → Magnitude fallback
   ├─ V3: Cookbook attempt → SectionOrchestrator (3-layer escalation)
   └─ Mastra: Durable workflow (checkBlockers → cookbook → handler)
8. Page loop (max 15 pages):
   ├─ Detect page type (URL → DOM → platform config → LLM)
   ├─ Handle page (login/fill/upload/navigate)
   ├─ Discover conditional fields (re-scan after fills)
   └─ Click Next/Continue → repeat
9. Review page reached → STOP (browser kept open for manual review)
10. Finalization:
    ├─ Screenshot capture + upload
    ├─ Session save (encrypted cookies)
    ├─ Cost recording (gh_user_usage)
    ├─ Cookbook creation (if successful, new manual saved)
    └─ VALET callback (status, cost, screenshots)
```

**State transitions:**
```
pending → queued → running → completed
                           → failed (retryable → pending with backoff)
                           → paused (HITL) → running (on resume)
                           → awaiting_user_review
                           → cancelled
                           → expired
```

---

## 4. Execution Modes

The `execution_mode` field on each job determines which engine processes it:

| Mode | Engine | Behavior |
|------|--------|----------|
| `auto` (default) | V3ExecutionEngine | Cookbook first, then SectionOrchestrator with 3-layer escalation |
| `cookbook_only` | V3ExecutionEngine | Cookbook only; fail if no manual or cookbook fails |
| `ai_only` / `hybrid` | V3ExecutionEngine | Skip cookbook, go straight to SectionOrchestrator |
| `smart_apply` | SmartApplyHandler | Multi-page state machine with platform-specific configs |
| `agent_apply` | AgentApplyHandler | Autonomous Stagehand LLM agent |
| `mastra` | Mastra workflow | Durable 3-step workflow with HITL suspend/resume |
| `v1` (legacy) | ExecutionEngine | V1 cookbook → Magnitude fallback |

**Selection heuristic:** VALET typically sends `auto` or `smart_apply`. The `mastra` mode is opt-in for jobs that need robust HITL (Workday, complex multi-step forms).

---

## 5. Form Discovery & Field Extraction

When the automation reaches a form page, field discovery happens in phases:

### Phase 1: Helper Injection

A `window.__ff` object is injected into the page with utilities for accessible name resolution, visibility checking, and element tagging. Each interactive element gets a unique `data-ff-id` attribute.

### Phase 2: Field Extraction

The system scans for all interactive elements: `input`, `select`, `textarea`, `[role="combobox"]`, `[role="radio"]`, `[role="listbox"]`, etc.

For each field, it extracts:
- **Label** via a 7-level cascade: `aria-labelledby` → `aria-label` → `<label for>` → parent `.form-group` label → section heading → `placeholder`/`title` → empty
- **Type** mapped from HTML: text, email, tel, select, radio, checkbox, date, file, textarea, combobox
- **Required** status: `required` attr, `aria-required`, `data-required`
- **Visibility**: display/visibility/aria-hidden checks
- **Options**: for selects/radios/custom dropdowns
- **Section**: nearest heading for grouping context

Radio buttons and checkboxes with the same `name` attribute are grouped into `radio-group` or `checkbox-group` fields with a `choices` array.

### Phase 3: Dropdown Option Discovery

Custom dropdowns (ARIA combobox, Workday selectinput) require special handling:

1. Click the combobox trigger to open
2. For **hierarchical dropdowns** (e.g., Workday "How did you hear?"): detect chevrons → drill into each category → collect sub-options as `"Category > SubOption"`
3. For **flat dropdowns**: extract visible option texts
4. Handle virtualized/lazy-loaded lists by scrolling to load more
5. Dismiss dropdown before proceeding to next field

### Phase 4: V3 PageScanner (Alternative Path)

The V3 engine uses `PageScanner.scan()` which performs a full-page scroll+extract, capturing:
- All form fields with DOM depth and parent container info
- Button inventory (text, type, position)
- Page fingerprint for change detection
- Field grouping by Y-coordinate ranges into sections

---

## 6. Field Matching: How Fields Map to User Data

The system uses a **7-strategy cascade** to match discovered form fields to user profile data. Each strategy returns a confidence score; the first match above threshold wins.

### Strategy 1: Automation ID (confidence: 0.95)

Platform-specific handlers provide direct mappings from `data-automation-id` attributes to user data keys. Example for Workday:
```
legalNameSection_firstName → first_name
addressSection_city → city
educationSection_school → school
```
Most reliable strategy — zero ambiguity.

### Strategy 2: HTML Name Attribute (confidence: 0.95)

Normalizes the `name` attribute and looks up in a static map:
```
firstname → first_name
email → email
addressline1 → street
postalcode → zip
```

### Strategy 3: Label Exact Match (confidence: 0.90)

Normalizes field label by stripping `*`, "Required", "(optional)", whitespace. Compares to normalized user data keys.

### Strategy 4: Fuzzy Q&A Match (confidence: 0.85)

Applies a **5-pass fuzzy algorithm** against the user's `qa_overrides` (pre-configured answers to screening questions):

| Pass | Method | Guard |
|------|--------|-------|
| 1 | Exact (case-insensitive, stripped) | — |
| 2 | Label contains key | Key must be ≥60% of label length |
| 3 | Key contains label | Label must be ≥50% of key length, >3 chars |
| 4 | Significant word overlap | ALL distinguishing words must match, ≥2 overlap. Generic words ("name", "number", "date") excluded |
| 5 | Stem-based overlap | Strip suffixes (-ing, -tion, -ed, etc.), ≥2 stem matches |

**Anti-false-positive example:** "Middle Name" won't match "First Name" because pass 4 requires all distinguishing words to match — "middle" ≠ "first".

### Strategy 5: Fuzzy UserData Match (confidence: 0.75)

Same 5-pass fuzzy algorithm but against user profile data keys (first_name, email, phone, etc.).

### Strategy 6: Placeholder Match (confidence: 0.70)

Matches `placeholder` attribute text against user data keys using exact then fuzzy matching.

### Strategy 7: Default Value (confidence: 0.60)

For Q&A answers that didn't match any field — uses `ariaLabel` or platform metadata hints as a last resort.

---

## 7. Form Filling Strategies (Three-Layer Stack)

The V3 engine routes each field action through three layers, cheapest first:

### Layer 1: DOMHand ($0 per action)

Pure DOM injection with zero LLM involvement:

- **Text fields**: Uses `nativeInputValueSetter` to bypass React/Vue controlled components, then dispatches `input`, `change`, and `blur` events
- **Selects**: `element.selectOption(value)` via Playwright
- **Checkboxes/Radios**: Direct click on input element
- **Custom dropdowns**: Click trigger → type to search → click matching option
- **Verification**: DOM readback (`el.value`, `el.textContent`, combobox role checks)

Success rate: ~50-70% depending on form framework complexity.

### Layer 2: StagehandHand (~$0.0005 per action)

Stagehand's accessibility tree enrichment + DOM fallback:

- **Observe**: Stagehand `observe()` returns rich a11y tree with bounding boxes
- **Process**: Merges Stagehand descriptions with DOM field matching
- **Execute**: Tries DOM injection first (free); escalates to Stagehand `act()` on failure
- **Review**: DOM readback + Stagehand verification

Success rate: ~85-90%.

### Layer 3: MagnitudeHand (~$0.005 per action)

Full vision LLM automation:

- **Observe**: Screenshot → vision LLM analysis
- **Process**: LLM identifies fields by visual inspection
- **Execute**: Two sub-strategies:
  - `exec()` for known fields (click at coordinates + type) — cheaper, no screenshot cycle
  - `act()` for complex interactions (full LLM reasoning per action) — most expensive
- **Review**: LLM visual verification

Success rate: ~95%+.

### Escalation Policy

The SectionOrchestrator assigns layers based on field match confidence:
- Confidence ≥ 0.8 → DOMHand
- Confidence ≥ 0.6 → StagehandHand
- Confidence < 0.6 → MagnitudeHand

On failure at assigned layer: escalate to next layer (max 2 attempts per layer).

### Conditional Field Discovery

After filling visible fields, the orchestrator re-scans the page up to 3 times to discover dynamically revealed fields (e.g., selecting "Yes" to "Do you need visa sponsorship?" reveals a follow-up text field). Newly discovered fields go through the same match → plan → execute cycle.

---

## 8. Page Classification & Section-Specific Handling

### 4-Tier Page Classification

When the automation lands on a new page, it classifies the page type through escalating checks:

**Tier 1: URL-Based ($0, instant)**
- Google SSO URLs → `google_signin`
- Workday sign-in URLs → `login`
- Platform-specific patterns

**Tier 2: Minimal DOM Checks ($0, instant)**
- Cookie banners, error pages, confirmation pages
- Visible text/button scanning for signals

**Tier 2.5: Platform-Specific DOM ($0, instant)**
- Form field count (5+ fields = application form, not login)
- Button text analysis ("Apply", "Submit", "Review")
- Password fields + email fields → login
- Review/confirmation signals

**Tier 3: LLM Classification ($0.001-0.005)**
- Screenshot sent to Claude Haiku with `pageStateSchema`
- Safety overrides prevent misclassification (e.g., 5+ form fields can't be "account_creation")

### Page Types and How They're Handled

| Page Type | Detection Signal | Handling |
|-----------|-----------------|----------|
| `job_listing` | "Apply" button, job description text | Click the Apply/Start button |
| `login` | Password field + "Sign in" text | Inject stored credentials, type email/password |
| `google_signin` | Google SSO URL pattern | Type Google email, handle OAuth redirect |
| `account_creation` | "Create account" + registration fields | Fill registration form (after login attempt fails) |
| `verification_code` | "Verification code" text, OTP input | **HITL pause** — human enters code |
| `phone_2fa` | "Authenticator"/"SMS code" text | **HITL pause** — human enters 2FA code |
| `personal_info` | Name/email/phone fields, <5 fields | Fill via formFiller (DOM injection + LLM answers) |
| `experience` | Work history section, "Add Experience" | Platform-specific handler or generic fill |
| `resume_upload` | File input, "Upload Resume" | Intercept file chooser → attach resume file |
| `questions` | 5+ form fields, screening question labels | LLM generates answers → fill via DOM/adapter |
| `voluntary_disclosure` | "Voluntary Self-Identification" heading | Fill demographics from profile or "Decline to identify" |
| `self_identify` | "Do you have a disability?" | Select from qaAnswers or "Prefer not to answer" |
| `review` | "Review your application" text, Submit button | **STOP** — keep browser open for manual review |
| `confirmation` | "Thank you"/"Application submitted" text | **STOP** — record success |
| `error` | "404"/"Page not found" text | Log error, fail job |

### Section-Specific Fill Logic

#### Personal Information
- **Fields:** first name, last name, email, phone, address (street, city, state, zip, country), LinkedIn URL, portfolio URL
- **Matching:** Primarily via name attributes and label exact match (strategies 2-3)
- **Special handling:** Address fields often auto-complete; country dropdowns may need search-type interaction

#### Work History
- **Fields:** company name, job title, start/end dates, description, current job indicator
- **Matching:** Platform-specific automation IDs (Workday) or Q&A fuzzy match
- **Special handling:** Multi-entry sections (add another experience), date pickers with segmented month/day/year inputs (Workday)

#### Education
- **Fields:** school name, degree, field of study, graduation date, GPA
- **Matching:** Q&A fuzzy match or platform automation IDs
- **Special handling:** School name may be a searchable combobox with autocomplete

#### Skills
- **Fields:** Multi-select checkboxes or searchable multi-combobox
- **Matching:** LLM generates relevant skill list from profile, matched against available options
- **Special handling:** Multi-select dropdowns need individual option clicks

#### Screening Questions
- **Fields:** Yes/No radios, single-select dropdowns, free-text textareas
- **Matching:** 5-pass fuzzy match against user's `qa_overrides` map
- **LLM fallback:** For questions without pre-configured answers, the LLM generates contextual responses:
  - Yes/No questions: infers from profile (e.g., work authorization from citizenship)
  - Free text: writes 2-4 sentence responses referencing the role and profile
  - Salary expectations: generates reasonable range based on role/location
  - "How did you hear about us?": defaults to "LinkedIn" or "Company Website"

#### File Uploads (Resume/Cover Letter)
- **Detection:** `<input type="file">` elements
- **Mechanism A (CDP):** `Page.setInterceptFileChooserDialog` → intercepts native dialog → attaches file
- **Mechanism B (Direct):** `setInputFiles()` on the input element
- **Resume download:** If `resume_ref` contains a URL or storage path, downloaded to temp directory before job starts

#### Demographics / EEO (Voluntary Disclosure)
- **Fields:** Gender, race/ethnicity, veteran status, disability status
- **Matching:** Uses profile demographics data or qaAnswers
- **Default behavior:** If no data available, selects "Decline to self-identify" / "Prefer not to answer"
- **Platform-specific:** Workday has dedicated `voluntary_disclosure` and `self_identify` page handlers

---

## 9. Multi-Page Navigation & Stuck Detection

### Navigation Flow

After filling all fields on a page:

1. **Last page detection**: No "Next/Continue" button + has "Submit" button → this is the review/submit page
2. **Navigate**: Find "Next"/"Continue"/"Save and Continue" button → click
3. **Wait**: Poll for page change (URL change or field turnover detected by fingerprint)
4. **SPA detection**: Same URL but different fields → treat as new page

### Stuck Detection

Prevents infinite loops via page signature tracking:
- **Signature** = URL + content fingerprint (headings + field count + sidebar state)
- If same signature seen **3 consecutive times** → abort, open browser for manual intervention
- **SPA mutation detection**: Same URL but different field fingerprint → recognized as valid navigation

### V3 SectionOrchestrator Limits
- Maximum **15 pages** per application
- Maximum **3 stuck retries** before abort
- Track URL + fingerprint history for cycle detection

---

## 10. Cookbook System: Self-Learning Replay

### How Cookbooks Work

When a job application succeeds, the system records the exact steps taken and saves them as a "manual" (cookbook) for future replay on the same site.

### Recording (TraceRecorder)

During live execution, the TraceRecorder subscribes to adapter events:
- `mouse:click` → recorded as `click` step with locator
- `keyboard:type` → recorded as `fill` step with **templatized** value
- `keyboard:enter/tab` → recorded as `press` step
- `browser:nav` → recorded as `navigate` step

**Templatization:** If the typed value matches a user data field (e.g., typed "john@example.com" equals `userData.email`), the step stores `{{email}}` instead of the literal value. This makes cookbooks reusable across different users.

**Element extraction:** For each action, captures the element's testId, role, name, ariaLabel, id, text, CSS selector, and XPath — providing 8 locator strategies for replay.

### Storage (ManualStore)

Cookbooks are stored in `gh_action_manuals` with:
- **URL pattern**: Concrete URL converted to glob (e.g., `*.myworkdayjobs.com/*/careers/job/*/apply`)
- **Task pattern**: Job type (apply, fill_form, etc.)
- **Platform**: Detected ATS platform
- **Steps**: Ordered list of actions with locators and template values
- **Health score**: 0-100, starts at 100 (recorded) or 80 (imported ActionBook)

### Lookup

When a new job starts:
1. Query by task_pattern + health > 0 (ordered by health DESC)
2. Test URL against stored glob patterns
3. Return highest-health matching manual

### Replay (CookbookExecutor)

For each recorded step:
1. **Resolve element** via LocatorResolver (8-strategy cascade: testId → role+name → ariaLabel → name → id → text → CSS → XPath)
2. **Perform action**: click, fill (with template resolution `{{email}}` → actual email), select, check, press, scroll, navigate, wait
3. **Wait** after each step (recorded waitAfter duration)
4. **Stop on first failure**

### V3 CookbookExecutorV3 (Dual Strategy)

Each action tries two strategies:
1. **DOM-first (free)**: nativeInputValueSetter for fills, selector clicks, DOM readback verification
2. **GUI fallback (cheap)**: Magnitude `exec()` for coordinate-based automation

Per-action health tracking: skip if action health < 0.3, abort after 3 consecutive failures.

### Health Scoring

| Event | Score Change |
|-------|-------------|
| Cookbook recorded from successful run | Start at 100 |
| Imported from ActionBook | Start at 80 |
| Successful replay | +2 (cap 100) |
| Failed replay | -5 (or -15 after 5+ cumulative failures) |
| Health reaches 0 | Manual effectively disabled |

---

## 11. Blocker Detection & Human-in-the-Loop

### Detection Architecture

A **dual-pass detector** identifies blockers during form filling:

**Pass 1: Fast DOM Detection ($0)**
- URL pattern matching (e.g., `google.com/sorry` → CAPTCHA at 0.95 confidence)
- CSS selector matching: `iframe[src*="recaptcha"]` (0.95), `iframe[src*="hcaptcha"]` (0.95), `#challenge-running` (0.95)
- Text pattern matching against `document.body.innerText`: "verify you are human", "sign in to continue", "two-factor authentication"

**Pass 2: Vision-Based Detection (~$0.001)**
- Only runs if DOM detection confidence < 0.8
- Uses adapter `observe()` for rich element analysis
- Results combined with DOM results (same type → boosted confidence)

### Blocker Categories

| Category | Detection Signals | Confidence Range |
|----------|-------------------|-----------------|
| `captcha` | reCAPTCHA/hCaptcha/Turnstile iframes, "I'm not a robot" text | 0.60-0.95 |
| `login` | Password fields, login forms, "sign in to continue" text | 0.60-0.85 |
| `2fa` | "Verification code"/"authenticator app" text, OTP inputs | 0.70-0.85 |
| `bot_check` | Cloudflare challenge, DataDome, "checking your browser" text | 0.50-0.95 |
| `rate_limited` | "Too many requests"/"try again later" text | 0.50-0.90 |
| `verification` | Slider/puzzle CAPTCHAs, "select all images" text | 0.75-0.90 |

**Visibility matters:** Hidden elements get 50% confidence reduction. Combined detection boost: `min(1.0, domConfidence + observeConfidence * 0.3)`.

### Detection Timing

1. **After initial navigation** (before form filling starts)
2. **Every 30 seconds** (periodic timer during execution)
3. **After 3 consecutive action failures** (adapter can't interact)
4. **After HITL resume** (verify blocker was actually resolved, up to 3 re-checks)

### HITL Flow

When a blocker is detected with confidence ≥ 0.6:

```
1. Screenshot captured + uploaded to cloud storage
2. Job status → 'paused'
3. interaction_data stored: { type, confidence, selector, screenshot_url, page_url }
4. Adapter paused (promise-based gate blocks further actions)
5. VALET callback: status='needs_human', blocker details included
6. Wait for resume signal (default timeout: 5 minutes)
   └─ VALET sends POST /valet/resume/:jobId with resolution data
7. Worker reads resolution from DB, immediately clears sensitive fields
8. adapter.resume(resolutionContext) — inject credentials/OTP in-memory
9. Post-resume verification: re-check up to 3 times
   ├─ Still blocked → re-pause, wait again
   └─ Clear → continue execution
```

---

## 12. Mastra Workflow Orchestration (V5.2)

### What Changed

The Mastra integration adds **durable, crash-safe workflows** for the HITL flow. Previously, if a worker crashed while a job was paused, the HITL state was lost. Now, workflow state is persisted in PostgreSQL and can be resumed by any worker.

### Workflow Structure

The `gh_apply` workflow has three steps:

```
check_blockers_checkpoint
  │
  ├─ Blocker detected → suspend workflow → HITL pause
  │   └─ On resume: read resolution, inject, verify, continue
  │
  └─ No blocker → continue
         │
    cookbook_attempt
         │
         ├─ Cookbook success → workflow complete (skip handler)
         │
         └─ Cookbook fail → continue
                │
           execute_handler
                │
                ├─ Handler success → workflow complete
                ├─ Awaiting review → workflow complete (keepBrowserOpen)
                └─ Handler fail → workflow failed
```

### Key Design Decisions (AD-1 through AD-7)

- **AD-1**: Steps capture non-serializable objects (adapter, supabase, costTracker) via closure injection, never in workflow state. Keeps snapshots JSON-serializable and secret-safe.
- **AD-2**: `mastra_run_id` persisted once on first execution, never rotated.
- **AD-3**: Atomic resume claim via CAS query prevents double-resume.
- **AD-4**: Sensitive resolution data (passwords, 2FA codes) read then immediately cleared from DB.
- **AD-5**: Finalization extracted into shared functions so both legacy and Mastra paths produce identical results.
- **AD-6**: Workflow snapshots verified to contain zero passwords/credentials (secret audit test).
- **AD-7**: Overhead benchmark target: < 500ms, snapshot size < 10KB.

### Resume Coordinator

Handles the worker-side resume flow:

1. **Discriminator**: Checks if job has `resume_requested=true` in metadata
2. **Atomic claim**: CAS UPDATE that only succeeds for one worker
3. **Resolution read + clear**: Fetches `interaction_data.resolution_data`, immediately nullifies in DB
4. **Dispatch**: Injects resolution into adapter, resumes Mastra workflow run

### Database Support

- Migration `018_execution_mode_add_mastra.sql`: Adds `'mastra'` to execution_mode CHECK constraint
- Migration `020_mastra_rls_and_retention.sql`: RLS policies, 7-day retention cleanup, indexes for `mastra_run_id` lookups

---

## 13. Cost Control & Budget Enforcement

### Per-Task Budget

| Quality Preset | Budget |
|---------------|--------|
| `speed` | $0.05 |
| `balanced` | $0.50 |
| `quality` | $1.00 |
| Workday/SmartApply override | $2.00 |

**Action limits:** 50 for apply/fill, 30 for scrape, 10000 for workday_apply/smart_apply.

The `CostTracker` enforces hard limits — throws `BudgetExceededError` if exceeded.

### Per-User Monthly Budget

| Tier | Monthly Budget |
|------|---------------|
| free | $0.50 |
| starter | $2.00 |
| pro | $10.00 |
| premium | $25.00 |
| enterprise | $100.00 |

Pre-flight check blocks job start if monthly budget exhausted. Cost recorded atomically via `gh_increment_user_usage()` RPC.

### Cost by Layer

| Layer | Cost Per Action | Typical Form Cost |
|-------|----------------|-------------------|
| Cookbook replay | $0.00 | $0.00 |
| DOMHand | $0.00 | $0.00 |
| StagehandHand | ~$0.0005 | $0.005-0.01 |
| MagnitudeHand (exec) | ~$0.002 | $0.01-0.03 |
| MagnitudeHand (act) | ~$0.005-0.02 | $0.03-0.10 |
| LLM page classification | ~$0.001-0.005 | $0.005-0.02 |
| LLM answer generation | ~$0.003-0.015 | $0.003-0.015 |

---

## 14. Session Persistence & Credential Management

### Browser Sessions

Stored in `gh_browser_sessions`, keyed by `(user_id, domain)`:
- Contains Playwright `storageState` (cookies + localStorage)
- Encrypted with AES-256-GCM before storage
- Loaded before each job to avoid re-authentication
- Saved after successful completion for future reuse
- TTL-based expiration with periodic cleanup

### Credential Encryption

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: 256-bit from `GH_CREDENTIAL_KEY` (64 hex chars)
- **IV**: 12 bytes, unique per encryption
- **Envelope format**: `[version:1][keyId:2][iv:12][authTag:16][ciphertext:*]`
- **Key rotation**: Supports multiple keys simultaneously; new encryptions use active key, old ciphertexts decrypted with their original key

### Session Injection Strategy

Before form filling:
1. Load target domain session (cookies from previous successful run)
2. Load intermediate sessions for SSO flows (e.g., Google session for "Sign in with Google")
3. Inject via Playwright context `storageState`
4. After success: save updated session back to DB

---

## 15. Security Architecture

### Domain Lockdown

Prevents prompt injection attacks where malicious job listings trick the LLM into navigating to attacker URLs:

- Route interception on all Playwright requests
- Three allowlist layers: job URL domain + ATS platform domains + resource CDN allowlist
- Safe resource types (images, fonts, stylesheets) allowed cross-origin
- Blocked requests logged with statistics tracking

### Input Sanitization

- **XSS prevention**: 13 payload patterns detected, HTML tags stripped, entities encoded
- **SQL injection detection**: 11 pattern checks (defense-in-depth; primary protection is ORM parameterization)
- **URL validation**: Only `http://` and `https://` protocols allowed

### Rate Limiting

**Per-user tier limits:**
| Tier | Hourly | Daily |
|------|--------|-------|
| free | 3 | 5 |
| starter | 10 | 25 |
| pro | 15 | 50 |
| premium | 20 | 100 |
| enterprise | unlimited | unlimited |

**Per-platform limits** (to avoid ATS detection):
| Platform | Hourly | Daily |
|----------|--------|-------|
| LinkedIn | 5 | 20 |
| Workday/Amazon/Taleo | 20 | 100 |
| Greenhouse/Lever | 30 | 150 |
| Other | 50 | 250 |

Sliding window implementation with dual-check (user tier checked first, then platform limit).

### RLS & Auth

- All `gh_` tables have Row-Level Security enabled
- Service-to-service auth via `X-GH-Service-Key` header
- User auth via Supabase JWT (`Authorization: Bearer`)
- Structured logger auto-redacts sensitive keys (passwords, tokens, JWTs, SSNs)

---

## 16. Worker Fleet & Job Dispatch

### Worker Identity Resolution

Priority order:
1. CLI arg `--worker-id=VALUE`
2. Environment `GH_WORKER_ID`
3. EC2 IMDS instance ID discovery
4. Generated ID: `worker-{region}-{timestamp}`

### Job Dispatch Modes

**Legacy (default):** PostgreSQL `FOR UPDATE SKIP LOCKED` polling every 5 seconds. Compatible with pgbouncer transaction mode.

**Queue mode:** pg-boss message queue with dedicated worker-specific queues. Requires session-mode Postgres.

### Worker Affinity

Jobs can specify `target_worker_id` with affinity modes:
- `any`: any worker can claim
- `preferred`: target worker gets priority, others can claim after timeout
- `strict`: only target worker can claim

### Heartbeat & Monitoring

- 30-second heartbeat updates `gh_worker_registry`
- Stale workers (no heartbeat for 5+ minutes) auto-marked offline
- HTTP status endpoint on port 3101: health check, drain control
- Crash recovery: re-queue stuck jobs, detect browser crashes (up to 2 recovery attempts)

---

## 17. API Surface & VALET Integration

### Core Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/gh/jobs` | Create single job |
| POST | `/api/v1/gh/jobs/batch` | Create 1-50 jobs in transaction |
| GET | `/api/v1/gh/jobs` | List jobs with filters |
| GET | `/api/v1/gh/jobs/:id` | Full job record |
| GET | `/api/v1/gh/jobs/:id/status` | Lightweight status |
| POST | `/api/v1/gh/jobs/:id/cancel` | Cancel job |
| POST | `/api/v1/gh/jobs/:id/retry` | Retry failed job |
| GET | `/api/v1/gh/jobs/:id/events` | Event timeline |

### VALET-Specific Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/gh/valet/apply` | Rich application request (profile + resume + QA) |
| POST | `/api/v1/gh/valet/task` | Generic task request (any execution mode) |
| POST | `/api/v1/gh/valet/resume/:jobId` | Resume paused HITL job |
| GET | `/api/v1/gh/valet/status/:jobId` | Rich status with cost breakdown, manual info |
| POST | `/api/v1/gh/valet/workers/deregister` | Deregister worker, cancel its jobs |
| GET | `/api/v1/gh/valet/sessions/:userId` | List stored browser sessions |
| DELETE | `/api/v1/gh/valet/sessions/:userId/:domain` | Clear specific session |

### Callback Notifications

GhostHands → VALET webhook payload:
```json
{
  "job_id": "uuid",
  "valet_task_id": "string",
  "status": "completed|failed|needs_human|resumed",
  "result_data": { "confirmation_id": "...", "submitted": true },
  "screenshot_urls": ["..."],
  "error_code": "captcha_blocked",
  "cost": { "total_cost_usd": 0.023, "action_count": 12, "total_tokens": 4500 },
  "execution_mode": "smart_apply",
  "final_mode": "magnitude"
}
```

Callbacks retry 3 times with exponential backoff [1s, 3s, 10s]. Failures never fail the job.

### Client SDK

`GhostHandsClient` provides a typed SDK for VALET with:
- API mode (HTTP REST) and DB mode (direct Supabase)
- Realtime subscriptions via Supabase channels (job status, progress, events)
- `waitForCompletion()` with WebSocket or polling fallback
- Custom error classes: `JobNotFoundError`, `DuplicateIdempotencyKeyError`, `JobNotCancellableError`

---

## 18. Platform-Specific Configurations

### GenericPlatformConfig (default)

Works for any ATS. Provides:
- 4-tier page classification
- Base form-filling rules prompt (top-to-bottom, skip filled fields, never click Submit)
- Profile → data prompt conversion
- Q&A answer mapping

### WorkdayPlatformConfig

Specialized handling for Workday's complex UI:
- Additional page types: `voluntary_disclosure`, `self_identify`
- Workday-specific automation ID mappings
- Hierarchical dropdown drilling (categories with chevrons)
- Segmented date components (separate month/day/year inputs)
- Custom experience page handler
- Heading-based page classification ("Application Questions", "My Experience", "Voluntary Disclosures")

### Other Platforms

The adapter pattern supports pluggable platform configs. Current implementations include handlers for Amazon, Greenhouse, and other ATS platforms, each with platform-specific selectors and page detection logic.

---

## 19. Adapter Abstraction Layer

### Interface

`BrowserAutomationAdapter` provides:
- `act(instruction, context)` — Natural language action (LLM-driven)
- `exec(action)` — Direct low-level action (bypass LLM, cheaper)
- `extract(instruction, schema)` — Structured data extraction with Zod validation
- `observe(instruction)` — Discover interactive elements without executing
- `navigate(url)`, `screenshot()`, `getCurrentUrl()`, `page` — Navigation and state
- `registerCredentials(creds)` — Redact sensitive values from LLM
- `pause()` / `resume(context)` / `isPaused()` — HITL gate
- Event system: `actionStarted`, `actionDone`, `tokensUsed`, `thought`, `error`, `progress`

### Implementations

| Adapter | Cost | Use Case |
|---------|------|----------|
| MagnitudeAdapter | $0.005-0.02/action | Production form filling (vision LLM) |
| StagehandAdapter | $0.005-0.015/action | Alternative engine (a11y tree + LLM) |
| MockAdapter | $0 | Unit testing (no browser) |

### Concurrency Control (ActMutex)

Prevents concurrent `act()` calls when timeouts occur. Magnitude/Stagehand don't expose abort APIs, so timed-out calls keep running in the background. The mutex:
1. Tracks `actInFlight` state
2. On timeout: marks as `poisoned`, stores pending promise
3. Next `act()` call: polls 500ms to see if old promise settled
4. If still running: returns error, orchestrator escalates to different layer

### Stagehand Compatibility Layer

Bridges Stagehand v3's Page/Locator classes with Playwright's API:
- `StagehandPageCompat`: Playwright-like page interface
- `StagehandLocatorCompat`: Chainable locator with click/fill/select/check/type methods
- `StagehandContextCompat`: Session persistence (cookies, localStorage) via CDP

---

*Generated 2026-03-01 by comprehensive codebase analysis.*
