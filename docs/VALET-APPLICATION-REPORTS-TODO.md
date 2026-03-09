# VALET Integration: Application Reports — TODO

**For:** VALET repo Claude agent
**Date:** 2026-03-08
**GH Branch:** `feature/application-reports` (merged into staging)
**Context:** GhostHands now stores a structured report of every field the worker filled during a job application. This document describes the new API endpoints, data schema, and exactly where/how to integrate in VALET.

---

## What GhostHands Now Provides

After every job completes (or fails / goes to awaiting_review), GhostHands writes a row to `gh_application_reports` containing:
- Company name, job URL, platform (workday, greenhouse, etc.)
- Resume reference used
- **A flat JSON array of every field the worker filled** — field label, value submitted, field type, source (DOM/LLM/Magnitude), confidence score, required/optional, fill state
- Summary counts (total fields, filled, failed, unresolved)
- Submission status, cost, screenshots, timestamps

---

## Where to Add Code in VALET

The GhostHands integration layer lives in:

```
apps/api/src/modules/ghosthands/
├── ghosthands.client.ts    ← Add new methods here (getApplicationReport, listUserReports)
├── ghosthands.types.ts     ← Add new types here (GHApplicationReport, GHSubmittedField, etc.)
└── ghosthands.webhook.ts   ← No changes needed (callbacks unchanged)
```

### Auth & Request Pattern

All requests use the existing pattern in `ghosthands.client.ts`:
- **Base URL:** `GHOSTHANDS_API_URL` env var (already configured, default `http://localhost:3100`)
- **Auth header:** `X-GH-Service-Key: {GH_SERVICE_SECRET}` (already used by all other methods)
- **Full path prefix:** `{GHOSTHANDS_API_URL}/api/v1/gh/valet/reports/...`

Follow the exact same `fetch()` pattern used by existing methods like `getJobStatus(jobId)`.

---

## New API Endpoints

Base URL: `{GHOSTHANDS_API_URL}/api/v1/gh/valet`

### 1. Get Report for a Single Job

```
GET /valet/reports/:jobId
```

**Response (200):**
```json
{
  "report": {
    "id": "uuid",
    "job_id": "uuid",
    "user_id": "uuid",
    "valet_task_id": "vt-789",
    "job_url": "https://mycompany.wd5.myworkdayjobs.com/en-US/External/job/apply",
    "company_name": "mycompany",
    "job_title": null,
    "platform": "workday",
    "resume_ref": "resumes/resume-abc.pdf",
    "fields_submitted": [
      {
        "prompt_text": "First Name",
        "value": "John",
        "question_type": "text",
        "source": "dom",
        "answer_mode": "profile_backed",
        "confidence": 0.95,
        "required": true,
        "section_label": "Personal Information",
        "state": "verified"
      },
      {
        "prompt_text": "Years of Experience",
        "value": "5",
        "question_type": "select",
        "source": "llm",
        "answer_mode": "best_effort_guess",
        "confidence": 0.7,
        "required": true,
        "section_label": null,
        "state": "filled"
      }
    ],
    "total_fields": 15,
    "fields_filled": 13,
    "fields_failed": 1,
    "fields_unresolved": 1,
    "status": "completed",
    "submitted": true,
    "result_summary": "Application submitted successfully",
    "llm_cost_cents": 5,
    "action_count": 10,
    "total_tokens": 1500,
    "screenshot_urls": ["https://s3.amazonaws.com/..."],
    "started_at": "2026-03-08T10:00:00Z",
    "completed_at": "2026-03-08T10:02:30Z",
    "created_at": "2026-03-08T10:02:30Z",
    "updated_at": "2026-03-08T10:02:30Z"
  }
}
```

**Response (404):**
```json
{ "error": "not_found", "message": "Report not found" }
```

### 2. List All Reports for a User

```
GET /valet/reports/user/:userId?limit=50&offset=0
```

**Query params:**
- `limit` — 1–100, default 50
- `offset` — default 0

**Response (200):**
```json
{
  "reports": [ /* array of report objects, same shape as above */ ],
  "count": 42
}
```

> **Note:** `count` is the **total** number of reports for the user (not the page size). Use it with `limit`/`offset` to build pagination controls (e.g., "Page 1 of 3").

---

## TypeScript Types to Add

Add these to `ghosthands.types.ts`:

```typescript
export interface GHSubmittedField {
  prompt_text: string;
  value: string;
  question_type: 'text' | 'textarea' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'file' | 'select' | 'radio' | 'checkbox' | 'unknown';
  source: 'dom' | 'llm' | 'magnitude' | 'manual';
  answer_mode?: 'profile_backed' | 'best_effort_guess' | 'default_decline' | 'system_attachment' | null;
  confidence: number;
  required: boolean;
  section_label?: string | null;
  state: 'verified' | 'filled' | 'failed' | 'uncertain' | 'planned' | 'attempted';
}

export interface GHApplicationReport {
  id: string;
  job_id: string;
  user_id: string;
  valet_task_id: string | null;
  job_url: string;
  company_name: string | null;
  job_title: string | null;
  platform: string | null;
  resume_ref: string | null;
  fields_submitted: GHSubmittedField[];
  total_fields: number;
  fields_filled: number;
  fields_failed: number;
  fields_unresolved: number;
  status: 'completed' | 'failed' | 'awaiting_review';
  submitted: boolean;
  result_summary: string | null;
  llm_cost_cents: number | null;
  action_count: number | null;
  total_tokens: number | null;
  screenshot_urls: string[];
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GHGetReportResponse {
  report: GHApplicationReport;
}

export interface GHListReportsResponse {
  reports: GHApplicationReport[];
  count: number; // total count for the user (not page size)
}
```

---

## Client Methods to Add

Add these to `ghosthands.client.ts`, following the same pattern as `getJobStatus()`:

```typescript
async getApplicationReport(jobId: string): Promise<GHGetReportResponse | null> {
  // GET /api/v1/gh/valet/reports/:jobId
  // Returns null on 404 (report not found)
}

async listUserReports(userId: string, limit = 50, offset = 0): Promise<GHListReportsResponse> {
  // GET /api/v1/gh/valet/reports/user/:userId?limit=X&offset=Y
}
```

---

## `fields_submitted` Schema Reference

Each element in the `fields_submitted` JSONB array:

| Field | Type | Description |
|-------|------|-------------|
| `prompt_text` | string | The field label shown to the worker (e.g., "First Name", "Do you require sponsorship?") |
| `value` | string | What was submitted. Passwords/SSNs are `[REDACTED]`. Phone/address kept visible. |
| `question_type` | string | One of: `text`, `textarea`, `email`, `tel`, `url`, `number`, `date`, `file`, `select`, `radio`, `checkbox`, `unknown` |
| `source` | string | How the field was filled: `dom` (direct JS), `llm` (AI planned), `magnitude` (GUI agent), `manual` (human) |
| `answer_mode` | string? | Strategy used: `profile_backed` (from user profile), `best_effort_guess` (AI guessed), `default_decline` (declined optional), `system_attachment` (file upload) |
| `confidence` | number | 0-1 confidence score. 0.95+ = high confidence, 0.7-0.95 = moderate, <0.7 = low |
| `required` | boolean | Whether the field was marked required by the ATS |
| `section_label` | string? | Form section name if detected (e.g., "Personal Information", "Work History") |
| `state` | string | Final state: `verified` (confirmed correct), `filled` (filled but unverified), `failed` (attempted but failed), `uncertain`, `planned`, `attempted` |

---

## Resume Reference Resolution

The `resume_ref` field contains the storage path (e.g., `resumes/resume-abc.pdf`). This is NOT the user-facing filename. VALET should:
1. Parse the resume ID from the path (the UUID portion after `resumes/`)
2. Look up the resume record in the VALET `resumes` table to get the display name
3. Show the display name in the UI (e.g., "Software Engineer Resume.pdf")

---

## VALET Implementation Checklist

### Backend (`apps/api/src/modules/ghosthands/`)
- [ ] Add `GHSubmittedField`, `GHApplicationReport`, `GHGetReportResponse`, `GHListReportsResponse` types to `ghosthands.types.ts`
- [ ] Add `getApplicationReport(jobId)` method to `ghosthands.client.ts`
- [ ] Add `listUserReports(userId, limit?, offset?)` method to `ghosthands.client.ts`
- [ ] Resolve `resume_ref` to user-facing resume name via VALET's `resumes` table
- [ ] Cache report data if needed (reports are immutable once status is `completed` — but may update from `awaiting_review` → `completed`)

### Frontend (Application Tracker UI)
- [ ] Create Application Tracker page/component
- [ ] **List view:** display applications with: company, status, date, field count, pagination
- [ ] **Detail view:** show all `fields_submitted` as a table with columns:
  - Field Name (`prompt_text`)
  - Value Submitted (`value`)
  - Type (`question_type`)
  - Confidence badge (green >=0.9, yellow 0.7-0.9, red <0.7)
  - Required indicator
  - State badge
- [ ] Show summary stats: total fields, filled, failed, unresolved
- [ ] Show cost info: `llm_cost_cents`, `action_count`
- [ ] Show screenshots (clickable thumbnails)
- [ ] Show resume used (resolved display name)
- [ ] Filter/sort applications by: date, company, platform, status
- [ ] Pagination controls using `count` (total) with `limit`/`offset`

### Visual Indicators
- **State badges:**
  - `verified` → green checkmark
  - `filled` → blue filled circle
  - `failed` → red X
  - `uncertain` / other → yellow warning
- **Confidence:**
  - >= 0.9 → green
  - 0.7 - 0.9 → yellow/orange
  - < 0.7 → red
- **Answer mode:**
  - `profile_backed` → "From profile" label
  - `best_effort_guess` → "AI guess" warning label
  - `default_decline` → "Declined" label

---

## Notes

- Reports are written best-effort — if the DB write fails, the job still completes normally. A small percentage of jobs may not have reports.
- The `status` field on the report mirrors the job status: `completed`, `failed`, or `awaiting_review`.
- When a job transitions from `awaiting_review` → `completed`, the report is updated via upsert (same `job_id`).
- Sensitive fields (passwords, SSNs, tokens) are automatically redacted to `[REDACTED]`. User PII like phone numbers and addresses are NOT redacted since the user needs to verify them.
- The `company_name` is best-effort extracted from the URL (works well for Workday, Greenhouse, Lever — may be null for unknown ATS platforms).
- Both endpoints are rate-limited (same middleware as other valet routes).
