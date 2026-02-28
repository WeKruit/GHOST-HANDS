# V3 Engine Research Analysis

**Date:** 2026-02-27
**Author:** Research Agent
**Purpose:** Extract portable code patterns from CheaperAttempt and alex-generic-stagehands branches + open source analysis for the v3 LayerHand engine.

---

## Table of Contents

1. [CheaperAttempt Branch — v2 Engine](#1-cheaperattempt-branch--v2-engine)
2. [alex-generic-stagehands Branch — SmartApplyHandler](#2-alex-generic-stagehands-branch--smartapplyhandler)
3. [FieldMatcher Strategy Comparison](#3-fieldmatcher-strategy-comparison)
4. [LLM Context Optimization Analysis](#4-llm-context-optimization-analysis)
5. [Open Source Analysis](#5-open-source-analysis)
6. [Recommendations for v3 LayerHand](#6-recommendations-for-v3-layerhand)

---

## 1. CheaperAttempt Branch — v2 Engine

### Source Files Extracted

| File | Lines | Purpose |
|------|-------|---------|
| `engine/v2/types.ts` | ~180 | Core type definitions: FieldModel, PageModel, ActionPlan, etc. |
| `engine/v2/PageScanner.ts` | ~860 | Full-page DOM scanner with scroll-and-extract loop |
| `engine/v2/FieldMatcher.ts` | ~290 | 7-strategy cascading field-to-data matcher |
| `engine/v2/ActionPlanner.ts` | ~140 | Tier assignment (0=DOM, 3=LLM) + action ordering |
| `engine/v2/DOMActionExecutor.ts` | ~470 | Tier 0 direct DOM fills + Tier 3 LLM fallback |
| `engine/v2/VerificationEngine.ts` | ~280 | Post-fill DOM readback verification |
| `engine/v2/platforms/workday.ts` | ~210 | Workday automation-id map + label map + platform detection |

### Key Architecture Patterns

#### 1.1 PageScanner — Scroll-and-Extract DOM Scanner

The PageScanner runs entirely inside `page.evaluate()` (string-based to avoid esbuild `__name` injection). Core algorithm:

```
1. Clear stale data-gh-scan-idx attributes
2. Scroll to top
3. For each viewport position (max 15 rounds, 70% overlap):
   a. Extract all visible interactive elements
   b. Deduplicate by CSS selector
   c. Scroll to next position
4. Scroll back to top
5. Sort fields by absoluteY, assign stable IDs (field-0, field-1, ...)
```

**Label Extraction — 9 strategies in priority order:**
1. `el.labels` (HTMLInputElement.labels)
2. `aria-label` on element or closest ancestor
3. `aria-labelledby` ID references
4. `placeholder` attribute
5. `label[for="id"]` lookup
6. Parent container label (`.field`, `fieldset`, `form-group`, `data-automation-id`)
7. Preceding sibling element (label, span, div, p)
8. Walk up DOM to find ancestor with exactly 1 input (subtract input text from ancestor text)
9. Name/id attribute fallback (camelCase/snake_case split)

**Field Type Detection:**
- Covers: text, email, phone, number, date, textarea, select, custom_dropdown, radio, aria_radio, checkbox, file, contenteditable, password, unknown
- Workday-specific: "Select One" buttons -> custom_dropdown
- ARIA detection: role="combobox" -> custom_dropdown, role="radiogroup" -> aria_radio

**Selector Generation Priority:**
1. `#id`
2. `[data-testid="..."]`
3. `[data-automation-id="..."]`
4. `[data-gh-scan-idx="N"]` (assigned if no stable ID exists)

**What to port to v3 DOMHand.scanPage():**
- The entire `extractVisibleElements()` evaluate function (field extraction, label extraction, selector generation)
- The scroll-and-dedup loop
- The `data-gh-scan-idx` tagging pattern for elements without stable selectors

#### 1.2 FieldMatcher — 7-Strategy Cascade

Strategies in priority order with confidence scores:

| # | Strategy | Confidence | Source |
|---|----------|------------|--------|
| 1 | `automation_id` — platform handler maps `data-automation-id` -> userData key | 0.95 | Platform-specific |
| 2 | `name_attr` — HTML name attribute via static NAME_TO_KEY map | 0.95 | Universal |
| 3 | `label_exact` — normalized label exact-matches a userData/qaAnswers key | 0.90 | Universal |
| 4 | `qa_match` — fuzzy 5-pass match of label against qaAnswers | 0.85 | Universal |
| 5 | `label_fuzzy` — fuzzy 5-pass match of label against userData | 0.75 | Universal |
| 6 | `placeholder` — placeholder text matches userData keys | 0.70 | Universal |
| 7 | `default_value` — ariaLabel or platformMeta against qaAnswers | 0.60 | Universal |

**Fuzzy Lookup Algorithm (5-pass):**
1. Exact match (case-insensitive, stripped)
2. Label contains key (key >= 60% of label length)
3. Key contains label (label >= 50% of key, label > 3 chars)
4. Significant word overlap (all distinguishing words must match, >= 2 overlap)
5. Stem-based overlap (strip suffixes: -ating, -ting, -ing, -tion, etc., >= 2 stem overlap)

**Helper functions to port:**
- `normalizeLabel()` — strips `*`, `Required`, `(optional)`, collapses whitespace
- `stem()` — strips common English suffixes
- `fuzzyLookup()` — the 5-pass matching engine
- `NAME_TO_KEY` static map

#### 1.3 ActionPlanner — Tier Assignment

Tier assignment rules:
- **Tier 0 (DOM-direct, $0):** confidence >= 0.6 on known field types (text, email, phone, number, textarea, select, custom_dropdown, radio, aria_radio, checkbox, date, file)
- **Tier 3 (LLM, ~$0.01):** password fields, unknown types, confidence < 0.6, or unmatched fields
- Special: typeahead always tries Tier 0 first

Actions sorted top-to-bottom by `absoluteY` for natural form-filling order.

**What to port to v3:** The tier assignment logic maps directly to the LayerHand escalation model. Tier 0 -> DOMHand, Tier 3 -> StagehandHand or MagnitudeHand.

#### 1.4 DOMActionExecutor — nativeInputValueSetter Pattern

The core pattern for React-compatible text fills:

```typescript
const proto = el.tagName === 'TEXTAREA'
  ? HTMLTextAreaElement.prototype
  : HTMLInputElement.prototype;
const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
if (nativeSetter) {
  nativeSetter.call(el, val);
} else {
  el.value = val;
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
```

**Field type handlers:**
- `fillText()` — nativeInputValueSetter + input/change/blur events
- `fillSelect()` — best-match option finding (exact > starts-with > contains > reverse-contains) + nativeInputValueSetter on select
- `fillCustomDropdown()` — click to open, optional search/filter input, click matching option, fallback to progressively shorter prefixes
- `fillRadio()` — find group by name, match value to labels (exact > starts-with > contains)
- `fillAriaRadio()` — find role="radio" children, match text (exact > starts-with > contains)
- `checkCheckbox()` — handles native + ARIA role="checkbox"
- `fillDate()` — click, type digits (Workday auto-advances MM/DD/YYYY), Tab to commit

**What to port to v3 DOMHand:** All field-type-specific fill methods. The `scrollFieldIntoView()` helper. The `fillWithLLM()` escalation pattern.

#### 1.5 VerificationEngine — DOM Readback

Post-fill verification reads back field values from DOM and compares:

```
1. Read current value (type-specific: .value, selectedIndex.text, textContent, aria-checked)
2. Normalize both expected and actual (trim, lowercase, collapse spaces)
3. Type-specific normalization (phone: digits only, date: digits only)
4. Fuzzy matching:
   - Exact after normalization
   - Checkbox: truthy values
   - Phone: last 7 digits
   - Date: digit-only comparison
   - Select/dropdown: contains or starts-with
   - Radio: contains
   - General: contains (either direction)
```

**What to port to v3:** The entire `readFieldValue()` and `fuzzyMatch()` methods for the DOMHand verification step.

#### 1.6 WorkdayPlatformHandler

**automation-id map (37 entries):**
- Legal name: `legalNameSection_firstName`, `_lastName`, `_middleName`, `_preferredFirstName`
- Address: `addressSection_addressLine1`, `_city`, `_countryRegion`, `_postalCode`, `_stateProvince`
- Phone: `phone_number`, `phone-device-type`, `countryPhoneCode`
- Email: `email`, `emailAddress`
- Links: `linkedInQuestion`, `websiteQuestion`
- Self-id: `genderDropdown`, `ethnicityDropdown`, `veteranStatusDropdown`, `disabilityStatusDropdown`
- Education: `education-school`, `-degree`, `-fieldOfStudy`, `-gpa`, `-startDate`, `-endDate`
- Work: `workExperience-jobTitle`, `-company`, `-startDate`, `-endDate`, `-description`
- Resume: `file-upload-input-ref`

**label map (50+ entries):** Maps common Workday label text to canonical data keys.

**Field type overrides:**
- `button` with text "Select One" -> custom_dropdown
- `button` with `aria-haspopup="listbox"` -> custom_dropdown
- `automationId` containing `dateSectionMonth/Day/Year` -> date
- `role="combobox"` with `aria-haspopup="listbox"` -> typeahead
- `automationId` containing `fieldOfStudy/skills/school/degree` -> typeahead

---

## 2. alex-generic-stagehands Branch — SmartApplyHandler

### Source Files Extracted

| File | Lines | Purpose |
|------|-------|---------|
| `taskHandlers/smartApplyHandler.ts` | ~2,400 | Multi-page form-filling orchestrator |
| `taskHandlers/platforms/types.ts` | ~200 | PlatformConfig interface + ScannedField type |
| `taskHandlers/platforms/genericConfig.ts` | ~2,800 | Generic platform: page detection, field scanning, filling |
| `taskHandlers/platforms/workdayConfig.ts` | ~2,300 | Workday-specific config extending generic |
| `adapters/stagehand.ts` | ~450 | StagehandAdapter (HitlCapableAdapter) |
| `adapters/stagehandCompat.ts` | ~600 | Playwright API compatibility layer for Stagehand |

### Key Architecture Patterns

#### 2.1 SmartApplyHandler — 4-Tier Page Detection

The multi-page loop detects page type using 4 tiers:

```
1. URL-based detection (free, instant)
   - Google SSO: accounts.google.com
   - Platform-specific URL patterns

2. DOM-based detection (free, fast)
   - Scan clickable elements for Apply/Submit/Next buttons
   - Check for password fields, form inputs, review signals
   - Count native + ARIA form controls

3. LLM classification (paid, slow)
   - Platform-specific classification prompt
   - Zod schema for structured extraction

4. DOM fallback classification (free, last resort)
   - Text analysis of body content and headings
```

Page types: `job_listing`, `login`, `google_signin`, `verification_code`, `phone_2fa`, `account_creation`, `personal_info`, `experience`, `resume_upload`, `questions`, `review`, `confirmation`, `error`, `unknown`

Workday adds: `voluntary_disclosure`, `self_identify`

#### 2.2 SmartApplyHandler — 3-Phase Fill Per Page

```
Phase 1: Scan-first field discovery (scanPageFields)
  - Scroll through page collecting all fields
  - Build field metadata (kind, selector, label, currentValue, options)
  - Sort by absoluteY

Phase 2: Programmatic fill (fillScannedField per field)
  - Match each field label to QA map using findBestAnswer
  - Fill using type-appropriate DOM strategy
  - No LLM cost for matched fields

Phase 3: LLM cleanup (adapter.act with rules prompt)
  - Only for fields that programmatic fill missed
  - Constrained with base rules preventing navigation
```

#### 2.3 PlatformConfig Interface

The `PlatformConfig` interface is comprehensive (~200 LOC). Key methods:

```typescript
interface PlatformConfig {
  // Page detection (4 tiers)
  detectPageByUrl(url: string): PageState | null;
  detectPageByDOM(adapter): Promise<PageState | null>;
  buildClassificationPrompt(urlHints): string;
  classifyByDOMFallback(adapter): Promise<PageType>;

  // Form filling (scan-first)
  scanPageFields(adapter): Promise<ScanResult>;
  fillScannedField(adapter, field, answer): Promise<boolean>;

  // Legacy DOM helpers
  fillDropdownsProgrammatically(adapter, qaMap): Promise<number>;
  fillCustomDropdownsProgrammatically(adapter, qaMap): Promise<number>;
  fillTextFieldsProgrammatically(adapter, qaMap): Promise<number>;
  fillRadioButtonsProgrammatically(adapter, qaMap): Promise<number>;
  fillDateFieldsProgrammatically(adapter, qaMap): Promise<number>;
  checkRequiredCheckboxes(adapter): Promise<number>;

  // Navigation
  clickNextButton(adapter): Promise<'clicked'|'review_detected'|'not_found'>;
  detectValidationErrors(adapter): Promise<boolean>;

  // Platform-specific
  handleCustomPageType?(...): Promise<boolean>;
  handleExperiencePage?(...): Promise<void>;
  handleLogin?(...): Promise<void>;
}
```

#### 2.4 ScannedField Type (alex branch)

```typescript
interface ScannedField {
  id: string;              // "field-0", "field-1"
  kind: FieldKind;         // text, select, custom_dropdown, radio, etc.
  fillStrategy: FillStrategy;
  selector: string;        // CSS selector
  label: string;
  currentValue: string;
  options?: string[];
  groupKey?: string;
  absoluteY: number;
  isRequired: boolean;
  matchedAnswer?: string;
  filled: boolean;
  platformMeta?: Record<string, string>;
}
```

This is structurally identical to CheaperAttempt's `FieldModel` — the types were already aligned.

#### 2.5 StagehandAdapter

Full `HitlCapableAdapter` implementation using Stagehand v3 SDK:
- `act(instruction)` — with timeout, token tracking, new-tab detection
- `extract(instruction, schema)` — Zod schema extraction
- `observe(instruction)` — returns `ObservedElement[]` with selector/description/method
- `observeWithBlockerDetection()` — HITL blocker classification via regex on observation results
- HITL pause/resume via promise gate pattern
- `StagehandPageCompat` — Playwright API compatibility layer (locator, keyboard, context, evaluate)

#### 2.6 StagehandCompat — Playwright Shim

Key components:
- `StagehandPageCompat` — wraps Stagehand Page with Playwright API (`locator()`, `keyboard`, `context()`, `waitForTimeout()`, `on('filechooser')`)
- `StagehandLocatorCompat` — `.nth()`, `.first()`, `.click()`, `.fill()`, `.type()`, `.getAttribute()`, `.scrollIntoViewIfNeeded()`
- `StagehandContextCompat` — `storageState()`, `addCookies()`, `newPage()`
- `FileChooserCompat` — CDP `DOM.setFileInputFiles` for file uploads

---

## 3. FieldMatcher Strategy Comparison

### CheaperAttempt: 7-Strategy Cascade

| # | Strategy | What it does | Confidence |
|---|----------|-------------|------------|
| 1 | automation_id | Platform handler maps automation-id to data key | 0.95 |
| 2 | name_attr | Static NAME_TO_KEY map (firstname -> first_name) | 0.95 |
| 3 | label_exact | Normalized label == normalized userData/qaAnswers key | 0.90 |
| 4 | qa_match | 5-pass fuzzy against qaAnswers | 0.85 |
| 5 | label_fuzzy | 5-pass fuzzy against userData | 0.75 |
| 6 | placeholder | Placeholder text against userData (exact + fuzzy) | 0.70 |
| 7 | default_value | ariaLabel / platformMeta against qaAnswers | 0.60 |

**Fuzzy engine: 5-pass** (exact -> label-contains-key -> key-contains-label -> word-overlap -> stem-overlap)

### alex Branch: findBestAnswer — 4-Pass

| # | Pass | What it does | Guard |
|---|------|-------------|-------|
| 1 | Exact | Normalized label == normalized key | None |
| 2 | Contains | Label contains key | Key >= 60% of label length |
| 3 | Reverse | Key contains label | Label >= 50% of key, label >= 3 chars |
| 4 | Word overlap | All distinguishing words overlap | Generic word filter, >= 2 overlap |

**Key differences:**
- alex has no `automation_id` or `name_attr` strategies (relies on platform config for those)
- alex has no `placeholder` strategy
- alex has no `stem-based overlap` (pass 5 in CheaperAttempt)
- alex has a `GENERIC_WORDS` filter set (`name`, `number`, `address`, `date`, etc.) that CheaperAttempt lacks
- CheaperAttempt has confidence scores; alex returns first match (no scoring)

### Recommendation: Merge

The v3 FieldMatcher should combine both:

```
Cascade order:
1. automation_id (from platform handler) — confidence 0.95
2. name_attr (static map) — confidence 0.95
3. label_exact (exact normalized match) — confidence 0.90
4. qa_match (5-pass fuzzy on qaAnswers + GENERIC_WORDS filter) — confidence 0.85
5. label_fuzzy (5-pass fuzzy on userData + GENERIC_WORDS filter) — confidence 0.75
6. placeholder (exact + fuzzy on userData) — confidence 0.70
7. default_value (ariaLabel / platformMeta) — confidence 0.60
```

The 5-pass fuzzy engine should adopt alex's `GENERIC_WORDS` filter for pass 4 (word overlap) to prevent false matches like "Middle Name" matching "First Name" via the shared word "Name". Keep CheaperAttempt's stem-based pass 5 as a final fallback.

---

## 4. LLM Context Optimization Analysis

### What Stagehand observe() Returns

Each observation returns `Action[]`:
```typescript
interface Action {
  selector: string;     // CSS selector
  description: string;  // Natural language description
  method: string;       // click, fill, select, etc.
  arguments: string[];  // Method arguments
}
```

### Token Usage by Operation

| Operation | Approx Token Cost | When Used |
|-----------|-------------------|-----------|
| observe() | ~2,000-5,000 tokens | Page scanning (a11y tree -> LLM) |
| act() | ~3,000-8,000 tokens | Single action execution |
| extract() | ~2,000-6,000 tokens | Structured data extraction |

### Optimization Strategies

#### 4.1 DOM-First Scanning Eliminates observe() for Known Fields

The CheaperAttempt PageScanner runs entirely in `page.evaluate()` — zero LLM cost. It captures:
- All standard inputs, selects, textareas
- ARIA comboboxes, radiogroups
- Workday "Select One" buttons
- Contenteditable elements
- Buttons (navigation, submit, add)

**For v3:** DOMHand.scanPage() replaces observe() for field discovery. observe() is only needed when DOMHand fails to find fields (e.g., shadow DOM, canvas-based UIs).

#### 4.2 Prune observation Results Before Sending to LLM

When StagehandHand does need to observe, strip irrelevant fields:

**Keep:**
- `selector` (needed for action execution)
- `description` (if under 100 chars)
- `method` (action type)

**Strip:**
- Full DOM snapshot (Stagehand sends the a11y tree internally)
- Element styling information
- aria-* attributes not relevant to filling
- Duplicate selectors for the same logical element

#### 4.3 Minimum Context for Magnitude act()

Current approach sends: `"Fill the entire job application form at ${url}. Here is the applicant data: ..."`

This forces Magnitude to do ~50 screenshot->LLM->action cycles internally.

**Optimized approach for v3:**
```
Per-field: "Fill ONLY the '${label}' field with '${value}'. Click the field,
type/select the value, then click whitespace to deselect. Do NOT interact
with any other fields. Do NOT scroll. Do NOT navigate."
```

This constrains Magnitude to 1-3 cycles per field instead of discovering fields itself.

#### 4.4 Page Snapshot Token Budget

The LLM classification prompt (alex branch) structures context efficiently:

```
URL hints: [platform domain, path segments]
Classification rules: ~300 tokens (structured numbered list)
DOM signals: ~100 tokens (pre-extracted booleans)
Total: ~400-500 tokens per classification
```

vs. sending the full page content (~5,000-20,000 tokens).

**Recommendation:** Always pre-extract DOM signals via `page.evaluate()` and send structured data to LLM, never raw HTML.

---

## 5. Open Source Analysis

### 5.1 berellevy/job_app_filler

**Architecture:** Chrome extension with content script + injected script model.

**Key Patterns:**

1. **fieldFillerQueue (Singleton AsyncQueue)**
   ```typescript
   class AsyncQueue<T> {
     private queue: [() => Promise<T>, resolve][];
     private running: boolean;

     enqueue(task: () => Promise<T>): Promise<void> {
       // Add to queue, resolve when done
       this.queue.push([task, taskComplete]);
       this.runNext();
     }

     private async runNext() {
       if (this.running || this.queue.length === 0) return;
       this.running = true;
       const [task, resolve] = this.queue.shift();
       await task();
       resolve();
       this.running = false;
       this.runNext(); // Process next
     }
   }
   ```

   **Why it matters for v3:** Prevents concurrent field fills from racing each other. When filling dropdowns (which open popups), a subsequent fill could click the wrong element. The queue ensures serial execution.

2. **DropdownSearchable Fill Pattern**
   ```
   1. Enqueue fill operation in fieldFillerQueue
   2. scrollBack() — save scroll position, fill, restore
   3. Get answer from stored data
   4. Call React's onKeyDown({ key: 'Tab', target: { value: answer } })
   5. Wait for selectedItemElement to appear with matching text
   6. If no match, click first promptOption in dropdown
   7. Close dropdown by removing popup element from DOM
   ```

   **Key insight:** Workday's searchable dropdowns can be filled by calling React's `onKeyDown` with `key: 'Tab'` and `target.value` set to the search term. This triggers Workday's internal search-and-select without needing to interact with the dropdown UI.

3. **XPath-Based Field Discovery**
   Uses precise XPaths to identify Workday field types:
   ```
   TEXT_INPUT:   formField-* containing input[type=text] without aria-haspopup
   SIMPLE_DROPDOWN:  formField-* containing button[aria-haspopup=listbox]
   SEARCHABLE_DROPDOWN: specific formField IDs (sourcePrompt, country-phone-code, field-of-study, schoolItem) containing multiSelectContainer
   BOOLEAN_RADIO: formField-* containing exactly 2 radio inputs
   MONTH_DAY_YEAR: formField-* containing Month+Day+Year aria-label inputs
   MONTH_YEAR: formField-* containing Month+Year but not Day
   YEAR: formField-* containing Year but not Month
   ```

   **What to port:** The XPath patterns for Workday field type detection are more precise than what either branch has. The `formField-` prefix pattern is especially reliable.

4. **Section Detection via Ancestor Traversal**
   ```
   ancestor::fieldset/parent::div[contains this field]//h4
   OR
   ancestor::div[@role="group"][contains this field]//h4[@id]
   ```

   **What to port:** This section-detection pattern is crucial for the SectionGrouper in v3 — it identifies which section (Personal Info, Experience, etc.) a field belongs to.

### 5.2 ubangura/Workday-Application-Automator

**Architecture:** Puppeteer script with hardcoded page flow.

**Key Patterns:**

1. **Complete data-automation-id Map for Workday**
   ```
   Navigation:
   - bottom-navigation-next-button (Next/Save and Continue)
   - utilityButtonSignIn (Sign In)
   - signInSubmitButton, createAccountLink, createAccountSubmitButton
   - adventureButton (Apply), applyManually

   Pages:
   - contactInformationPage, myExperiencePage
   - voluntaryDisclosuresPage, selfIdentificationPage

   Fields:
   - legalNameSection_firstName, legalNameSection_lastName
   - addressSection_addressLine1, addressSection_city
   - addressSection_countryRegion, addressSection_postalCode
   - phone-device-type, phone-number
   - email, password, verifyPassword
   - jobTitle, company, location, description
   - degree, gpa, linkedinQuestion
   - gender, hispanicOrLatino, ethnicityDropdown, veteranStatus
   - agreementCheckbox, name (self-identify signature)
   - file-upload-input-ref
   - dateSectionMonth-input, dateSectionYear-input

   Section management:
   - workExperience-N (numbered sections)
   - educationSection + Add button
   - websiteSection + websitePanelSet-N
   ```

2. **Workday Custom Dropdown Fill Pattern**
   ```typescript
   // Click button to open, type to filter, Enter to select
   await button.click();
   await page.keyboard.type(value, { delay: 100 });
   await page.keyboard.press('Enter');
   ```
   This is simpler than CheaperAttempt's approach but works for most cases. The `delay: 100` is critical for Workday's search filtering.

3. **Date Field Pattern (Segmented)**
   ```typescript
   // Focus the specific segment input, then type digits
   await el.waitHandle().focus();
   await page.keyboard.type(monthValue, { delay: 100 });
   ```
   Workday date fields are segmented (separate Month, Day, Year inputs), each identified by:
   - `dateSectionMonth-input`
   - `dateSectionDay-input` (when present)
   - `dateSectionYear-input`

4. **Work Experience "Add" Pattern**
   ```
   First section: button[data-automation-id*="add"] (lowercase)
   Additional: button[data-automation-id*="Add"] (uppercase A)
   Section container: div[data-automation-id="workExperience-N"]
   ```
   The casing difference between first and subsequent "Add" buttons is a Workday quirk that both branches should handle.

---

## 6. Recommendations for v3 LayerHand

### 6.1 Portable Code to Merge Into v3

| Component | Source | Target in v3 | Priority |
|-----------|--------|-------------|----------|
| PageScanner evaluate function | CheaperAttempt | DOMHand.scanPage() | P0 |
| nativeInputValueSetter pattern | CheaperAttempt | DOMHand.fillText() | P0 |
| FieldMatcher 7-strategy cascade | CheaperAttempt | DOMHand.matchFields() | P0 |
| fuzzyLookup 5-pass + GENERIC_WORDS | Both branches | Shared utility | P0 |
| VerificationEngine readback | CheaperAttempt | DOMHand.verify() | P0 |
| ActionPlanner tier assignment | CheaperAttempt | SectionOrchestrator | P1 |
| PlatformConfig interface | alex branch | Platform abstraction | P1 |
| Page detection 4-tier cascade | alex branch | SectionOrchestrator | P1 |
| StagehandAdapter | alex branch | StagehandHand | P1 |
| StagehandCompat layer | alex branch | StagehandHand internals | P1 |
| fieldFillerQueue | berellevy | DOMHand fill serialization | P2 |
| Section detection via ancestors | berellevy | SectionGrouper | P2 |
| Workday XPath field type patterns | berellevy | WorkdayPlatformHandler | P2 |
| automation-id map (ubangura) | ubangura | WorkdayPlatformHandler | P2 |

### 6.2 Type Alignment

Both branches use nearly identical types. The v3 types should be:

```typescript
// FieldModel (from CheaperAttempt) = ScannedField (from alex) + extras
interface ScannedField {
  id: string;
  kind: FieldKind;        // alex naming
  fieldType: FieldType;   // CheaperAttempt naming (alias)
  fillStrategy: FillStrategy;
  selector: string;
  label: string;
  currentValue: string;
  isEmpty: boolean;
  isRequired: boolean;
  isVisible: boolean;
  isDisabled: boolean;
  options?: string[];
  groupKey?: string;
  absoluteY: number;
  boundingBox: BoundingBox;
  automationId?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  platformMeta?: Record<string, string>;
}
```

### 6.3 LLM Context Budget

Target token budgets per operation:

| Operation | Budget | Strategy |
|-----------|--------|----------|
| Page classification | 500 tokens | Pre-extract DOM signals, send structured data |
| Field-to-data matching | 0 tokens | Fully deterministic (FieldMatcher) |
| DOM fill | 0 tokens | page.evaluate() only |
| Stagehand act (per field) | 2,000 tokens | Constrained single-field instructions |
| Magnitude act (per field) | 5,000 tokens | Screenshot + single-field instruction |
| Full page Magnitude | 50,000 tokens | AVOID — use per-field instead |

### 6.4 Key Design Decisions

1. **Serial field filling** — Use a queue (inspired by fieldFillerQueue) to prevent dropdown/popup interference between concurrent fills
2. **Verification after every fill** — CheaperAttempt's VerificationEngine catches ~15% of DOM fills that silently fail
3. **Escalation on failure, not on uncertainty** — Try DOM first for ALL matched fields (even low confidence), only escalate to LLM when verification fails
4. **Platform handler as optional enrichment** — The generic path (label matching) should work for 80% of fields; platform handlers add automation-id shortcuts for the rest
5. **Scan once per page, not per viewport** — PageScanner's scroll-and-collect approach captures all fields upfront, avoiding repeated scans as sections expand

---

*End of research analysis.*
