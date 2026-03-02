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

3. **Dependencies installed** — Run `bun install` from the repo root.

All commands below assume you're in `packages/ghosthands/`.

---

## Runtime: bun vs npx tsx

The project uses **bun** as its primary runtime. All `package.json` scripts use bun.

| Platform | Worker (launches browser) | Job submission / API / scripts |
|----------|--------------------------|-------------------------------|
| **macOS / Linux** | `bun` | `bun` |
| **Windows** | `npx tsx` (see note below) | `bun` |

### Windows Note

**Bun on Windows cannot launch Chromium.** This is a [known bun bug](https://github.com/oven-sh/bun/issues/15679) — Playwright/Patchright's pipe-based IPC with the browser subprocess hangs indefinitely. The worker will start, pick up a job, and then freeze at "Creating adapter" with no browser appearing.

**The workaround:** Use `npx tsx` to run the worker process only. Everything else (job submission scripts, API server, utility scripts) works fine with bun on Windows because those don't launch a browser.

**Important:** Bun auto-loads `.env` files, but tsx/Node.js does not. When using `npx tsx`, you **must** pass `--env-file=.env` before the script path, otherwise environment variables like `SUPABASE_URL` won't be available.

> **tsx quirk:** tsx injects a `__name` helper into transformed code. When Playwright serializes `page.evaluate()` callbacks to run in the browser, `__name` doesn't exist there. The codebase already has polyfills for this in the key files (`formFiller.ts`, `smartApplyHandler.ts`, `GenericPlatformConfig.ts`), so it works. If you hit a `ReferenceError: __name is not defined` in a new location, add the one-liner polyfill:
> ```typescript
> await page.addInitScript('if(typeof globalThis.__name==="undefined"){globalThis.__name=function(f){return f}}');
> ```

---

## Quick Start

### 1. Start a Worker

**macOS / Linux (bun):**
```bash
bun run worker:named --worker-id=<your-name>
```

**Windows (npx tsx):**
```bash
npx tsx --env-file=.env src/workers/workerLauncher.ts -- --worker-id=<your-name>
```

The worker registers itself in the database and polls for pending jobs. Keep this terminal open.

### 2. Submit a Job

In a second terminal (works with bun on all platforms):

```bash
bun src/scripts/test-mastra.ts --url=<application-url> --user-id=<valet-user-uuid>
```

Or with npx tsx:

```bash
npx tsx --env-file=.env src/scripts/test-mastra.ts -- --url=<application-url> --user-id=<valet-user-uuid>
```

The worker picks up the job within ~5 seconds.

### 3. Start the API Server

```bash
bun run api
```

Works on all platforms (no browser involved).

---

## test-mastra.ts — Full Reference

```bash
bun src/scripts/test-mastra.ts --url=<url> --user-id=<uuid> [flags]
```

### Required Flags

| Flag | Description |
|------|-------------|
| `--url=<url>` | The job application URL (any website) |
| `--user-id=<uuid>` | VALET user ID — loads their parsed resume from Supabase |

### Optional Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--worker-id=<name>` | any worker | Target a specific worker by name |
| `--timeout=<seconds>` | 1800 | Job timeout in seconds (30 min default) |
| `--no-poll` | false | Just submit, don't poll for status |
| `--poll-interval=<ms>` | 5000 | Status poll interval in ms |
| `--direct` | false | Insert directly into DB instead of using the API |

### Examples

```bash
# Any application URL, targeted to a specific worker
bun src/scripts/test-mastra.ts \
  --url=https://boards.greenhouse.io/company/jobs/123 \
  --user-id=<uuid> \
  --worker-id=my-worker

# Let any available worker pick it up
bun src/scripts/test-mastra.ts \
  --url=https://company.wd5.myworkdayjobs.com/en-US/External/job/apply \
  --user-id=<uuid>

# Direct DB insert (no API server needed)
bun src/scripts/test-mastra.ts \
  --url=https://jobs.lever.co/company/abc \
  --user-id=<uuid> --direct

# Custom timeout (10 minutes)
bun src/scripts/test-mastra.ts \
  --url=<url> \
  --user-id=<uuid> \
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

## apply.ts — Legacy Job Submission

An older job submission script (pre-Mastra). Same idea as `test-mastra.ts` but submits in legacy mode.

```bash
bun src/scripts/apply.ts --user-id=<uuid> --url=<application-url>
```

| Flag | Default | Description |
|------|---------|-------------|
| `--user-id=<uuid>` | (required) | VALET user ID |
| `--url=<url>` | (required) | The job application URL |
| `--worker-id=<name>` | any worker | Target a specific worker |
| `--timeout=<seconds>` | 1800 | Job timeout in seconds |

---

## Two Ways to Run

There are two ways to fill a job application: **direct mode** (single process, no database) and **worker mode** (job queue + worker process). Both use the same form-filling logic under the hood.

### Direct Mode (`fill-form.ts`)

Runs everything in a single process — no database, no job queue, no worker. Useful for quick testing and debugging.

**macOS / Linux:**
```bash
# With a real user profile + a real application URL
bun toy-job-app/fill-form.ts --user-id=<uuid> --url=<application-url>

# With a real user profile (uses local toy form)
bun toy-job-app/fill-form.ts --user-id=<uuid>

# With built-in sample profile (no Supabase needed, uses local toy form)
bun toy-job-app/fill-form.ts
```

**Windows (launches a browser, so use npx tsx):**
```bash
npx tsx --env-file=.env toy-job-app/fill-form.ts --user-id=<uuid> --url=<application-url>
```

**What happens:** The script launches its own Magnitude browser agent, navigates to the URL, fills the form, and exits. Nothing is written to the database.

### Worker Mode (`test-mastra.ts` + `workerLauncher.ts`)

Production workflow. Two separate processes communicate via the database:

```
Terminal 1 (worker)                     Terminal 2 (submit job)
─────────────────────                   ─────────────────────
workerLauncher.ts starts, registers     test-mastra.ts inserts a job row
in DB, polls for pending jobs...        into gh_automation_jobs
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

All scripts are in `src/scripts/`. These are database/API-only (no browser), so `bun` works on all platforms.

### Job Management

```bash
# Kill all active jobs (sets status to 'failed')
bun src/scripts/kill-jobs.ts

# Check status of all jobs
bun src/scripts/check-jobs.ts

# Check a specific job by ID
bun src/scripts/check-job.ts --id=<job-uuid>

# Delete ALL jobs from the database (destructive!)
bun src/scripts/delete-all-jobs.ts

# Release stuck jobs (jobs that are 'running' but have no active worker)
bun src/scripts/release-stuck-jobs.ts
```

### Worker Management

```bash
# Kill all running worker processes (SIGTERM, then SIGKILL after 5s)
bun src/scripts/kill-workers.ts

# Remove stale worker entries from the registry
bun src/scripts/nuke-workers.ts
```

---

## Typical Workflow (Worker Mode)

**macOS / Linux:**
```
Terminal 1                              Terminal 2
──────────────────────                  ──────────────────────
Start worker:
  bun run worker:named \
    --worker-id=dev-1
                                        Submit job:
  Worker picks up job...                  bun src/scripts/test-mastra.ts \
  [SmartApply] Platform: greenhouse       --url=<url> \
  [SmartApply] Navigating to URL...       --user-id=<uuid> \
  [SmartApply] Detected: job_listing      --worker-id=dev-1
  [SmartApply] Clicking Apply...
  [formFiller] Found 15 visible fields
  [formFiller] LLM provided 15 answers
  [formFiller] DOM fill round 1: 13/15
  [formFiller] [MagnitudeHand] 2 unfilled
  [SmartApply] formFiller: 13 DOM + 2 Mag
  [SmartApply] Clicked Next via DOM.
  [SmartApply] Detected: review_page
  [SmartApply] Done — stopped at review.
                                        Check status:
                                          bun src/scripts/check-jobs.ts

                                        If something goes wrong:
                                          bun src/scripts/kill-jobs.ts
```

**Windows:**
```
Terminal 1                              Terminal 2
──────────────────────                  ──────────────────────
Start worker (must use npx tsx):
  npx tsx --env-file=.env \
    src/workers/workerLauncher.ts \
    -- --worker-id=dev-1
                                        Submit job (bun works fine):
  Worker picks up job...                  bun src/scripts/test-mastra.ts \
  [SmartApply] Platform: greenhouse       --url=<url> \
  [SmartApply] Navigating to URL...       --user-id=<uuid> \
  ...                                     --worker-id=dev-1

                                        Check status:
                                          bun src/scripts/check-jobs.ts
```

## Typical Workflow (Direct Mode)

**macOS / Linux:**
```bash
bun toy-job-app/fill-form.ts \
  --user-id=<uuid> \
  --url=https://boards.greenhouse.io/company/jobs/123
```

**Windows:**
```bash
npx tsx --env-file=.env toy-job-app/fill-form.ts \
  --user-id=<uuid> \
  --url=https://boards.greenhouse.io/company/jobs/123
```

Output:
```
[fill-form] Loading user profile...
[fill-form] Launching browser agent...
[fill-form] Navigating to URL...
[fill-form] Found 15 visible fields
[fill-form] LLM provided 15 answers
[fill-form] DOM fill round 1: 13/15
[fill-form] [MagnitudeHand] 2 unfilled fields — using visual agent
[fill-form] Done. 13 DOM + 2 Magnitude filled.
```
