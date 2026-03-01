# GhostHands Worker Usage Guide

How to run job applications through the worker pipeline.

---

## Prerequisites

1. **Environment variables** — Copy `.env.example` to `.env` and fill in:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `DATABASE_URL` (or `SUPABASE_DIRECT_URL`)
   - `ANTHROPIC_API_KEY`

2. **User resume in VALET** — The target user must have a resume uploaded and parsed in VALET (`resumes` table, `status = 'parsed'`). You'll need their VALET `user_id` (UUID).

3. **Dependencies installed** — Run `npm install` from `packages/ghosthands/`.

All commands below assume you're in `packages/ghosthands/`.

---

## Quick Start

### 1. Start a Worker

```bash
npx tsx --env-file=.env src/workers/main.ts -- --worker-id=<worker-name>
```

The worker registers itself in the database and polls for pending jobs. Keep this terminal open.

### 2. Submit a Job

In a second terminal:

```bash
npx tsx --env-file=.env src/scripts/apply.ts -- \
  --user-id=<valet-user-uuid> \
  --url=<application-url>
```

The worker picks up the job within ~5 seconds.

---

## apply.ts — Full Reference

```bash
npx tsx --env-file=.env src/scripts/apply.ts -- [flags]
```

### Required Flags

| Flag | Description |
|------|-------------|
| `--user-id=<uuid>` | VALET user ID — loads their parsed resume from Supabase |
| `--url=<url>` | The job application URL (any website) |

### Optional Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--worker-id=<name>` | any worker | Target a specific worker by name |
| `--timeout=<seconds>` | 1800 | Job timeout in seconds (30 min default) |

### Examples

```bash
# Any application URL, targeted to a specific worker
npx tsx --env-file=.env src/scripts/apply.ts -- \
  --user-id=<uuid> \
  --url=https://boards.greenhouse.io/company/jobs/123 \
  --worker-id=my-worker

# Let any available worker pick it up
npx tsx --env-file=.env src/scripts/apply.ts -- \
  --user-id=<uuid> \
  --url=https://company.wd5.myworkdayjobs.com/en-US/External/job/apply

# Custom timeout (10 minutes)
npx tsx --env-file=.env src/scripts/apply.ts -- \
  --user-id=<uuid> \
  --url=<url> \
  --timeout=600
```

### Platform Auto-Detection

The handler automatically detects the platform from the URL and adapts its strategy:

| URL Pattern | Detected Platform |
|---|---|
| `*.myworkdayjobs.com` | Workday |
| `*.greenhouse.io` | Greenhouse |
| `*.lever.co` | Lever |
| `*.linkedin.com` | LinkedIn |
| `*.amazon.jobs` | Amazon |
| `*.icims.com` | iCIMS |
| `*.smartrecruiters.com` | SmartRecruiters |
| anything else | Generic |

No need to specify the platform — it's detected from the URL.

---

## Two Ways to Run

There are two ways to fill a job application: **direct mode** (single process, no database) and **worker mode** (job queue + worker process). Both use the same form-filling logic under the hood.

### Direct Mode (`fill-form.ts`)

Runs everything in a single process — no database, no job queue, no worker. Useful for quick testing and debugging.

```bash
# With a real user profile + a real application URL
npx tsx toy-job-app/fill-form.ts --user-id=<uuid> --url=<application-url>

# With a real user profile (uses local toy form)
npx tsx toy-job-app/fill-form.ts --user-id=<uuid>

# With built-in sample profile (no Supabase needed, uses local toy form)
npx tsx toy-job-app/fill-form.ts
```

**What happens:** The script launches its own Magnitude browser agent, navigates to the URL, fills the form, and exits. Nothing is written to the database.

### Worker Mode (`apply.ts` + `main.ts`)

Production workflow. Two separate processes communicate via the database:

```
Terminal 1 (worker)                     Terminal 2 (submit job)
─────────────────────                   ─────────────────────
main.ts starts, registers in DB,        apply.ts inserts a job row
polls for pending jobs...               into gh_automation_jobs
                                        (status = 'pending')
Worker picks up job within ~5s
SmartApplyHandler.execute() runs
  → formFiller fills the form
  → clicks Next, detects review
  → updates job status in DB
```

**Why use this?** The worker mode is what runs in production. It supports job tracking, timeouts, retries, status reporting back to VALET, and can be scaled horizontally (multiple workers polling the same queue).

---

## How Form Filling Works

Both direct mode and worker mode use the same form-filling approach (via `formFiller.ts`):

1. **Injects browser-side helpers** — tags every interactive element with a `data-ff-id` attribute
2. **Extracts all form fields** — discovers labels, types, current values, dropdown options
3. **Discovers dropdown options** — briefly opens custom dropdowns/comboboxes to read their choices
4. **Generates answers via LLM** — single Claude Haiku 4.5 call for ALL fields at once (requires `ANTHROPIC_API_KEY`)
5. **Iterative DOM fill** — fills fields via Playwright DOM manipulation (fast, near-$0). Re-extracts after each round to catch conditional fields that appeared. Repeats up to 10 rounds.
6. **MagnitudeHand fallback** — for tricky fields the DOM filler can't handle (typeaheads, cascading dropdowns, custom widgets), micro-scoped `adapter.act()` calls use the Magnitude visual agent (blue cursor) one field at a time

### Worker Mode Additionally Handles:

- **Page navigation** — detects page type (job listing, form, review, login)
- **Clicks Apply** — if starting from a job listing page
- **SPA guard** — for sites like Greenhouse where the URL doesn't change after clicking Apply
- **Clicks Next** — advances through multi-page forms (via `genericConfig.clickNextButton`)
- **Review detection** — stops at the review/summary page (does NOT submit)
- **Cookie/popup dismissal** — handles consent banners and overlays

---

## Operational Scripts

All scripts are in `src/scripts/` and use `--env-file=.env` for database credentials.

### Job Management

```bash
# Kill all active jobs (sets status to 'failed')
npx tsx --env-file=.env src/scripts/kill-jobs.ts

# Check status of all jobs
npx tsx --env-file=.env src/scripts/check-jobs.ts

# Check a specific job by ID
npx tsx --env-file=.env src/scripts/check-job.ts -- --id=<job-uuid>

# Delete ALL jobs from the database (destructive!)
npx tsx --env-file=.env src/scripts/delete-all-jobs.ts

# Release stuck jobs (jobs that are 'running' but have no active worker)
npx tsx --env-file=.env src/scripts/release-stuck-jobs.ts
```

### Worker Management

```bash
# Kill all running worker processes (SIGTERM, then SIGKILL after 5s)
npx tsx --env-file=.env src/scripts/kill-workers.ts

# Remove stale worker entries from the registry
npx tsx --env-file=.env src/scripts/nuke-workers.ts
```

---

## Typical Workflow (Worker Mode)

```
Terminal 1                              Terminal 2
──────────────────────                  ──────────────────────
Start worker:
  npx tsx --env-file=.env \
    src/workers/main.ts \
    -- --worker-id=dev-1
                                        Submit job:
  Worker picks up job...                  npx tsx --env-file=.env \
  [SmartApply] Platform: greenhouse       src/scripts/apply.ts -- \
  [SmartApply] Navigating to URL...       --user-id=<uuid> \
  [SmartApply] Detected: job_listing      --url=<url> \
  [SmartApply] Clicking Apply...          --worker-id=dev-1
  [formFiller] Found 15 visible fields
  [formFiller] LLM provided 15 answers
  [formFiller] DOM fill round 1: 13/15
  [formFiller] [MagnitudeHand] 2 unfilled
  [SmartApply] formFiller: 13 DOM + 2 Mag
  [SmartApply] Clicked Next via DOM.
  [SmartApply] Detected: review_page
  [SmartApply] Done — stopped at review.
                                        Check status:
                                          npx tsx --env-file=.env \
                                            src/scripts/check-jobs.ts

                                        If something goes wrong:
                                          npx tsx --env-file=.env \
                                            src/scripts/kill-jobs.ts
```

## Typical Workflow (Direct Mode)

```bash
npx tsx toy-job-app/fill-form.ts \
  --user-id=<uuid> \
  --url=https://boards.greenhouse.io/company/jobs/123

# Output:
# [fill-form] Loading user profile...
# [fill-form] Launching browser agent...
# [fill-form] Navigating to URL...
# [fill-form] Found 15 visible fields
# [fill-form] LLM provided 15 answers
# [fill-form] DOM fill round 1: 13/15
# [fill-form] [MagnitudeHand] 2 unfilled fields — using visual agent
# [fill-form] Done. 13 DOM + 2 Magnitude filled.
```
