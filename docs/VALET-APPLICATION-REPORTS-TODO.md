# VALET Integration: Application Reports — TODO

**For:** VALET repo Claude agent
**Date:** 2026-03-08
**GH Branch:** `feature/application-reports` (merged into staging)
**Context:** GhostHands now stores a structured report of every field the worker filled during a job application. This document describes the new API endpoints and data schema so VALET can integrate the Application Tracker UI.

---

## What GhostHands Now Provides

After every job completes (or fails / goes to awaiting_review), GhostHands writes a row to `gh_application_reports` containing:
- Company name, job URL, platform (workday, greenhouse, etc.)
- Resume reference used
- **A flat JSON array of every field the worker filled** — field label, value submitted, field type, source (DOM/LLM/Magnitude), confidence score, required/optional, fill state
- Summary counts (total fields, filled, failed, unresolved)
- Submission status, cost, screenshots, timestamps

---

## New API Endpoints

Base URL: `{GH_API_URL}/api/v1/gh/valet`

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
- `limit` — max 100, default 50
- `offset` — default 0

**Response (200):**
```json
{
  "reports": [ /* array of report objects, same shape as above */ ],
  "count": 12
}
```

---

## `fields_submitted` Schema

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
1. Parse the resume ID from the path
2. Look up the resume record in the VALET `resumes` table to get the display name
3. Show the display name in the UI (e.g., "Software Engineer Resume.pdf")

---

## VALET Implementation Checklist

### Backend
- [ ] Add a service/helper to call `GET /valet/reports/:jobId` from GH API
- [ ] Add a service/helper to call `GET /valet/reports/user/:userId` from GH API
- [ ] Cache report data if needed (reports are immutable after creation)
- [ ] Resolve `resume_ref` to user-facing resume name

### Frontend (Application Tracker UI)
- [ ] Create Application Tracker page/component (similar to Tsenta screenshot)
- [ ] Display list of applications with: company, status, date, field count
- [ ] Detail view: show all `fields_submitted` as a table with columns:
  - Field Name (`prompt_text`)
  - Value Submitted (`value`)
  - Type (`question_type`)
  - Confidence badge (green >=0.9, yellow 0.7-0.9, red <0.7)
  - Required indicator
- [ ] Show summary stats: total fields, filled, failed, unresolved
- [ ] Show cost info: `llm_cost_cents`, `action_count`
- [ ] Show screenshots (clickable thumbnails)
- [ ] Show resume used (resolved display name)
- [ ] Filter/sort applications by: date, company, platform, status

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
