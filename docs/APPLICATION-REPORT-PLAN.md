# Application Report Feature — Implementation Plan

**Author:** Claude (with Spencer)
**Date:** 2026-03-08
**Status:** Planning
**Branch:** TBD (suggest `feature/application-reports`)

---

## 1. Problem Statement

After GhostHands completes a job application, users have no structured way to see **what the worker actually submitted** — which fields were filled, with what values, which resume was used, and whether any answers were low-confidence guesses.

Currently, the data exists scattered across:
- `gh_job_page_contexts.page_context` (deeply nested JSONB, designed for debugging)
- `gh_automation_jobs.result_data.context_report` (only surfaces problematic fields)
- `gh_job_events` (action-level audit trail, not field-centric)

None of these are queryable in a VALET-friendly way.

**Goal:** Create a clean, flat `gh_application_reports` table that stores a per-job report of every field the worker filled, accessible via a new API endpoint for VALET UI to display.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage approach | New `gh_application_reports` table | Clean API surface for VALET, indexed, RLS-ready |
| Field visibility | No redaction of user's own data (phone, address) | User needs to verify what was submitted |
| Sensitive fields | Redact passwords, SSNs, tokens only | Use existing `SENSITIVE_FIELD_RE` pattern from `finalization.ts` |
| Scope | All job types (generic) | Future-proof, not just `smart_apply` |
| Granularity | Flat list of field→value pairs | Per-page breakdown not needed per Spencer |
| Backfill | Fresh start only | No public users yet, old data inconsistent |
| Resume info | Filename/ref only | VALET can resolve the display name from resume ID |
| Data source | PageContextSession (primary) + FillResult (fallback) | PageContext has richest data; FillResult covers non-PageContext handlers |

---

## 3. Data Sources Available at Finalization

### 3.1 PageContextSession (Primary — Smart Apply with PageContext)

At finalization time, `session.pages[*].questions[*]` contains every `QuestionRecord`:

```typescript
interface QuestionRecord {
  questionKey: string;
  promptText: string;           // "What is your first name?"
  currentValue?: string;        // DOM value after fill
  lastAnswer?: string;          // Answer that was submitted
  questionType: QuestionType;   // 'text' | 'select' | 'email' | ...
  source: QuestionSource;       // 'dom' | 'llm' | 'magnitude' | 'manual'
  answerMode?: AnswerMode;      // 'profile_backed' | 'best_effort_guess' | ...
  state: QuestionState;         // 'filled' | 'verified' | 'failed' | ...
  required: boolean;
  resolutionConfidence: number;
  sectionLabel?: string;
}
```

**Key insight:** `buildContextReport()` iterates ALL questions but only surfaces problems. Successfully filled/verified fields are accessible but not reported. We extract them ourselves.

### 3.2 FillResult (Fallback — handlers without PageContext)

`fillFormOnPage()` returns:
```typescript
interface FillResult {
  questionOutcomes?: QuestionOutcome[];  // { questionKey, state, currentValue, source, confidence }
  questionSnapshots?: QuestionSnapshot[]; // { questionKey, promptText, questionType, ... }
  answerDecisions?: AnswerDecision[];     // { questionKey, answer, confidence, source, answerMode }
}
```

Can be joined: `questionSnapshots` (field labels) + `answerDecisions` (planned values) + `questionOutcomes` (final status).

### 3.3 Job Record

- `job.target_url` → application URL
- `job.input_data.user_data` → user profile sent
- `job.resume_ref` → resume reference (filename/path)
- `job.valet_task_id` → links to VALET task
- `job.metadata` → platform detection, etc.

### 3.4 Cost Snapshot

- `finalCost.totalCost`, `finalCost.actionCount`, `finalCost.inputTokens`, `finalCost.outputTokens`

---

## 4. Database Schema

### 4.1 Migration: `026_gh_application_reports.sql`

```sql
-- Migration 026: Application reports — structured record of what the worker submitted
--
-- Stores a per-job flat report of every field filled during an application,
-- queryable by VALET UI for the Application Tracker feature.
-- Data is populated during job finalization from PageContextSession.

CREATE TABLE IF NOT EXISTS gh_application_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES gh_automation_jobs(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL,
  valet_task_id TEXT,

  -- Application metadata
  job_url       TEXT NOT NULL,
  company_name  TEXT,
  job_title     TEXT,
  platform      TEXT,

  -- Resume used
  resume_ref    TEXT,

  -- What the worker submitted (core payload)
  -- Array of { prompt_text, value, question_type, source, answer_mode, confidence, required }
  fields_submitted JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Summary counts
  total_fields       INTEGER NOT NULL DEFAULT 0,
  fields_filled      INTEGER NOT NULL DEFAULT 0,
  fields_failed      INTEGER NOT NULL DEFAULT 0,
  fields_unresolved  INTEGER NOT NULL DEFAULT 0,

  -- Submission outcome
  status         TEXT NOT NULL DEFAULT 'completed',
  submitted      BOOLEAN NOT NULL DEFAULT false,
  result_summary TEXT,

  -- Cost
  llm_cost_cents INTEGER,
  action_count   INTEGER,
  total_tokens   INTEGER,

  -- Screenshots
  screenshot_urls JSONB DEFAULT '[]'::jsonb,

  -- Timestamps
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_app_reports_job
  ON gh_application_reports(job_id);

CREATE INDEX IF NOT EXISTS idx_gh_app_reports_user
  ON gh_application_reports(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gh_app_reports_valet_task
  ON gh_application_reports(valet_task_id)
  WHERE valet_task_id IS NOT NULL;

-- RLS
ALTER TABLE gh_application_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on gh_application_reports"
  ON gh_application_reports FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- DOWN (rollback — commented)
-- DROP TABLE IF EXISTS gh_application_reports;
```

### 4.2 `fields_submitted` JSONB Shape

Each element in the array:

```typescript
interface SubmittedField {
  prompt_text: string;       // "First Name", "Years of Experience"
  value: string;             // "John", "5"
  question_type: string;     // "text", "select", "email", etc.
  source: string;            // "dom", "magnitude", "llm", "manual"
  answer_mode?: string;      // "profile_backed", "best_effort_guess", etc.
  confidence: number;        // 0-1
  required: boolean;
  section_label?: string;    // "Personal Information", "Work History"
  state: string;             // "verified", "filled"
}
```

---

## 5. Implementation Steps

### Step 1: Migration File

**File:** `packages/ghosthands/src/db/migrations/026_gh_application_reports.sql`

Create the table as specified in Section 4.1 above.

### Step 2: Report Builder Utility

**New file:** `packages/ghosthands/src/workers/reportBuilder.ts`

This module extracts filled field data from the PageContextSession and builds the report payload.

```typescript
// Key exports:
export interface ApplicationReportData {
  job_id: string;
  user_id: string;
  valet_task_id?: string;
  job_url: string;
  company_name?: string;
  job_title?: string;
  platform?: string;
  resume_ref?: string;
  fields_submitted: SubmittedField[];
  total_fields: number;
  fields_filled: number;
  fields_failed: number;
  fields_unresolved: number;
  status: string;
  submitted: boolean;
  result_summary?: string;
  llm_cost_cents?: number;
  action_count?: number;
  total_tokens?: number;
  screenshot_urls?: string[];
  started_at?: string;
  completed_at?: string;
}

export interface SubmittedField {
  prompt_text: string;
  value: string;
  question_type: string;
  source: string;
  answer_mode?: string;
  confidence: number;
  required: boolean;
  section_label?: string;
  state: string;
}

// Main function — extracts from PageContextSession
export function buildApplicationReport(
  job: AutomationJob,
  session: PageContextSession | null,
  costSnapshot: CostSnapshot,
  taskResult: TaskResult,
  screenshotUrls: string[],
): ApplicationReportData;

// Fallback — extracts from FillResult when no PageContext
export function buildReportFromFillResult(
  job: AutomationJob,
  fillResult: FillResult,
  costSnapshot: CostSnapshot,
  taskResult: TaskResult,
  screenshotUrls: string[],
): ApplicationReportData;
```

**Logic for `buildApplicationReport()`:**

1. Iterate `session.pages[*].questions[*]`
2. For each question where `state === 'filled' || state === 'verified'`:
   - Extract `promptText`, `lastAnswer || currentValue`, `questionType`, `source`, `answerMode`, `resolutionConfidence`, `required`, `sectionLabel`
   - Apply sensitive field redaction using `SENSITIVE_FIELD_RE`
3. Also include `state === 'failed'` fields (with empty value) so user sees what failed
4. Count totals: `total_fields`, `fields_filled` (verified+filled), `fields_failed`, `fields_unresolved`
5. Extract `company_name` and `job_title` from job URL or `input_data` if available
6. Return `ApplicationReportData`

### Step 3: Integrate into Finalization

**File:** `packages/ghosthands/src/workers/finalization.ts`

**Injection point:** After `resultData` is assembled (after current line ~405), before the flush-failure check.

Add a new helper function:

```typescript
async function writeApplicationReport(
  supabase: SupabaseClient,
  job: AutomationJob,
  pageContext: PageContextService | undefined,
  costSnapshot: CostSnapshot,
  taskResult: TaskResult,
  screenshotUrls: string[],
  status: 'completed' | 'failed' | 'awaiting_review',
  resultSummary?: string,
): Promise<void> {
  try {
    // Get the session from pageContext if available
    // Build report using buildApplicationReport() or buildReportFromFillResult()
    // Insert into gh_application_reports
    await supabase.from('gh_application_reports').upsert([reportData], {
      onConflict: 'job_id',
    });
  } catch (err) {
    // Best-effort — never fail the job over reporting
    logger.warn('Failed to write application report', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

**Call sites in `finalizeHandlerResult()`:**

1. **Awaiting review path** (after line ~378): Write report with `status: 'awaiting_review'`
2. **Failure path** (after line ~445): Write report with `status: 'failed'`
3. **Success path** (after line ~497): Write report with `status: 'completed'`

### Step 4: Pass Session to Report Builder

**Problem:** `finalizeHandlerResult()` currently calls `flushPageContext()` which returns a `ContextReport` (summary only), not the full session.

**Solution:** Modify the `flushPageContext` helper to also return the session data we need, OR access the PageContextSession before flushing.

Two approaches:

**Approach A (Preferred):** Extract filled fields BEFORE flushing, by reading from the PageContextService. Add a new method to `PageContextService`:

```typescript
// In PageContextService interface:
getAllFilledFields(): Promise<SubmittedField[]>;
```

This iterates `this.session.pages[*].questions[*]` and returns the flat list.

**Approach B:** Modify `flushPageContext()` to return the full session alongside the report. Less clean.

### Step 5: API Endpoint

**File:** `packages/ghosthands/src/api/routes/valet.ts`

Add a new route:

```typescript
// GET /valet/reports/:jobId — Fetch application report for a job
valet.get('/reports/:jobId', rateLimitMiddleware(), async (c) => {
  const jobId = c.req.param('jobId');

  const { data, error } = await supabase
    .from('gh_application_reports')
    .select('*')
    .eq('job_id', jobId)
    .single();

  if (error || !data) {
    return c.json({ error: 'Report not found' }, 404);
  }

  return c.json({ report: data });
});

// GET /valet/reports/user/:userId — List all reports for a user
valet.get('/reports/user/:userId', rateLimitMiddleware(), async (c) => {
  const userId = c.req.param('userId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const { data, error } = await supabase
    .from('gh_application_reports')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return c.json({ error: 'Failed to fetch reports' }, 500);
  }

  return c.json({ reports: data, count: data?.length || 0 });
});
```

**Note:** The `pool` (pg.Pool) is already available in the route factory. We may use either raw SQL via `pool.query()` or the Supabase client — follow whichever pattern the existing status endpoint uses.

### Step 6: Include Report URL in Callback

**File:** `packages/ghosthands/src/workers/finalization.ts`

After writing the report, include a `report_available: true` flag in the callback payload's `result_data` so VALET knows to fetch it:

```typescript
resultData.report_available = true;
```

VALET can then call `GET /valet/reports/:jobId` to fetch the full report.

---

## 6. Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/db/migrations/026_gh_application_reports.sql` | **CREATE** | New migration for the table |
| `src/workers/reportBuilder.ts` | **CREATE** | Report builder utility (extract fields, build payload) |
| `src/workers/finalization.ts` | **MODIFY** | Add `writeApplicationReport()` call in all 3 finalization paths |
| `src/context/PageContextService.ts` | **MODIFY** | Add `getAllFilledFields()` method to interface + implementation |
| `src/context/NoopPageContextService.ts` | **MODIFY** | Add noop `getAllFilledFields()` |
| `src/api/routes/valet.ts` | **MODIFY** | Add `GET /reports/:jobId` and `GET /reports/user/:userId` |
| `src/events/JobEventTypes.ts` | **MODIFY** | Add `REPORT_GENERATED: 'report_generated'` event type |
| `__tests__/unit/reportBuilder.test.ts` | **CREATE** | Unit tests for report builder |
| `__tests__/integration/applicationReport.test.ts` | **CREATE** | Integration test for the full flow |
| `docs/VALET-INTEGRATION-CONTRACT.md` | **MODIFY** | Document new endpoints and report schema |

---

## 7. Testing Strategy

### 7.1 Unit Tests (`reportBuilder.test.ts`)

1. **Build report from PageContextSession** — mock session with various question states, verify flat field extraction
2. **Sensitive field redaction** — verify passwords/SSNs redacted, phone/address preserved
3. **Empty session** — no pages → empty fields_submitted, zero counts
4. **Mixed states** — verified + filled + failed + skipped → correct counts and filtering
5. **Fallback from FillResult** — when no PageContext, verify report built from questionOutcomes + snapshots

### 7.2 Integration Tests (`applicationReport.test.ts`)

1. **Full finalization flow** — mock job + taskResult + pageContext → verify row written to `gh_application_reports`
2. **API endpoint** — insert mock report → GET /valet/reports/:jobId → verify response shape
3. **User listing** — insert multiple reports → GET /valet/reports/user/:userId → verify pagination
4. **Best-effort resilience** — simulate DB write failure → verify job finalization still succeeds
5. **Upsert idempotency** — call finalization twice for same job → verify single row (upsert)

### 7.3 Manual Smoke Test

1. Run migration: `bun src/scripts/run-migration.ts 026`
2. Trigger a test job application
3. Verify `gh_application_reports` row exists with populated `fields_submitted`
4. Call `GET /api/v1/gh/valet/reports/:jobId` and verify response

---

## 8. Edge Cases & Considerations

| Edge Case | Handling |
|-----------|----------|
| Job has no PageContext (old handlers) | Fall back to FillResult data if available; otherwise write report with empty fields_submitted |
| Job fails before any fields are filled | Write report with status='failed', empty fields, zero counts |
| Job is awaiting_review then later completes | Upsert (onConflict: job_id) updates the existing row |
| fields_submitted JSONB is very large (100+ fields) | Unlikely for job applications; no size concern |
| Report write fails | Best-effort — logged and swallowed, job status unaffected |
| Multiple finalization paths (handler vs side-effects) | Only `finalizeHandlerResult()` writes reports, not `finalizeHandlerSideEffects()` |
| AgentApplyHandler (no formFiller) | Will have empty fields_submitted until agent mode captures field data |

---

## 9. Sequence Diagram

```
JobExecutor
  │
  ├── handler.execute() → TaskResult
  │
  ├── finalizeHandlerResult()
  │     │
  │     ├── captureAndUpload() → screenshotUrls
  │     ├── saveBrowserSession()
  │     ├── costTracker.getSnapshot() → finalCost
  │     ├── saveFreshSessionCookies()
  │     ├── persist final_mode + cost metadata
  │     │
  │     ├── flushPageContext() → contextReport
  │     ├── build resultData (taskResult.data + cost + context_report)
  │     │
  │     ├── ★ NEW: writeApplicationReport()          ◄── INJECTION POINT
  │     │     ├── pageContext.getAllFilledFields()
  │     │     ├── buildApplicationReport()
  │     │     └── supabase.upsert('gh_application_reports')
  │     │
  │     ├── update gh_automation_jobs (status, result_data)
  │     ├── logEvent('job_completed')
  │     ├── recordCostBestEffort()
  │     └── fireCallbackBestEffort() → VALET
  │
  └── cleanup
```

---

## 10. VALET Integration Notes

After this feature ships on the GH side, VALET needs to:

1. **Query the new endpoint** — `GET /api/v1/gh/valet/reports/:jobId`
2. **List user reports** — `GET /api/v1/gh/valet/reports/user/:userId`
3. **Display in Application Tracker UI** — render `fields_submitted` as a table/list
4. **Resolve resume name** — use `resume_ref` to look up the user's resume display name

A separate VALET TODO document will be created after implementation (see Section 12).

---

## 11. Implementation Order

1. **Migration** — create table (can be done first, no code dependency)
2. **Report builder** — pure utility, fully unit-testable in isolation
3. **PageContextService.getAllFilledFields()** — small interface addition
4. **Finalization integration** — wire report builder into finalization flow
5. **API endpoints** — expose data to VALET
6. **Tests** — unit + integration
7. **Contract doc update** — update VALET-INTEGRATION-CONTRACT.md
8. **VALET TODO doc** — handoff document for VALET agent

---

## 12. VALET Handoff TODO (Created After Implementation)

A `docs/VALET-APPLICATION-REPORTS-TODO.md` will be created containing:
- New API endpoints with request/response examples
- `fields_submitted` JSONB schema
- Resume ref resolution guidance
- UI rendering suggestions (table columns, status badges)
- Example queries for the Application Tracker feature
