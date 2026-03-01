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

## Direct Testing (No Worker)

For quick local testing without the worker pipeline, use `fill-form.ts`:

```bash
# With a real user profile from Supabase
npx tsx toy-job-app/fill-form.ts --user-id=<uuid>

# With a real user profile + a real application URL
npx tsx toy-job-app/fill-form.ts --user-id=<uuid> --url=<application-url>

# With built-in sample profile (no Supabase needed, uses local toy form)
npx tsx toy-job-app/fill-form.ts
```

This launches a browser directly, fills the form with the DOM filler, then uses the Magnitude visual agent (blue cursor) for any remaining tricky fields.

---

## What the Worker Does

When a job is picked up, the worker runs `SmartApplyHandler`:

1. **Navigates** to the application URL
2. **Detects** the platform and loads platform-specific config
3. **Clicks Apply** (if on a job listing page)
4. **formFiller** takes over for each form page:
   - Injects browser-side helpers and extracts all form fields via `data-ff-id` tagging
   - Discovers dropdown options by briefly opening custom dropdowns
   - Asks **Claude Haiku 4.5** for answers (single LLM call for all fields — requires `ANTHROPIC_API_KEY`)
   - Iteratively fills fields via Playwright DOM manipulation (fast, near-$0)
   - Re-extracts after each round to catch conditional fields that appeared
   - **MagnitudeHand fallback** — for tricky fields the DOM filler can't handle (typeaheads, cascading dropdowns, custom widgets), micro-scoped `adapter.act()` calls use the real Magnitude visual agent (blue cursor)
5. **Clicks Next** / advances to the next page (handled by `genericConfig.clickNextButton`)
6. **Stops** at the review/summary page (does NOT submit)

> **Note:** The form-filling approach is the same proven logic used by `toy-job-app/fill-form.ts`, adapted as a production module (`src/workers/taskHandlers/formFiller.ts`).

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

## Typical Workflow

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
  [formFiller] Found 15 visible fields    --user-id=<uuid> \
  [formFiller] LLM provided 15 answers    --url=<url> \
  [formFiller] DOM fill done: 13/15       --worker-id=dev-1
  [formFiller] [MagnitudeHand] 2 unfilled
  [SmartApply] formFiller: 13 DOM + 2 Mag
  [SmartApply] Clicked Next via DOM.
                                        If something goes wrong:
                                          npx tsx --env-file=.env \
                                            src/scripts/kill-jobs.ts
```
