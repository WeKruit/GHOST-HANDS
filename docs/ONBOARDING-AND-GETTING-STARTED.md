# GhostHands – Onboarding & Getting Started

This guide walks through everything needed to run GhostHands locally: env setup, keys, worker, jobs, and common issues.

---

## 1. Prerequisites

-   **Bun** (recommended) or Node 18+
-   **Supabase project** (shared with VALET or standalone)
-   **Vision-capable LLM API key** (Magnitude needs to “see” the page via screenshots)

```bash
# Clone and install
git clone https://github.com/WeKruit/GHOST-HANDS.git
cd GHOST-HANDS
bun install
```

---

## 2. Environment Setup

All runtime config lives in `packages/ghosthands/.env`. Copy from example and fill in:

```bash
cd packages/ghosthands
cp .env.example .env
# Edit .env with your values
```

### 2.1 Database (required)

Use **direct Postgres URLs** for the worker (LISTEN/NOTIFY and job pickup need a real session):

| Variable                                       | Description                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`                                 | Pooled URL (e.g. Supabase pooler port 6543)                 |
| `DATABASE_DIRECT_URL` or `SUPABASE_DIRECT_URL` | Direct Postgres URL (port 5432), used by worker and scripts |

### 2.2 Supabase REST API (required for worker)

The worker uses the **Supabase JS client** to update job status, log events, and upload screenshots. You need valid REST keys from your Supabase project:

| Variable               | Description                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`         | Project URL, e.g. `https://xxxx.supabase.co`                                                                                     |
| `SUPABASE_ANON_KEY`    | Publishable key (dashboard: Project Settings → API → anon public)                                                                |
| `SUPABASE_SERVICE_KEY` | Secret key (dashboard: Project Settings → API → service_role). **Required** – worker needs it to bypass RLS and manage all jobs. |

If you see `Invalid API key` when the worker runs, the JWT keys are wrong or rotated. Create new keys in the Supabase dashboard and update `.env`. Newer projects may use key formats like `sb_publishable_...` and `sb_secret_...` – use the **secret** one for `SUPABASE_SERVICE_KEY`.

### 2.3 Model selection (required)

Magnitude is **vision-based**: it sends screenshots to the LLM. You must use a **vision-capable** model.

| Variable   | Example        | Notes                                    |
| ---------- | -------------- | ---------------------------------------- |
| `GH_MODEL` | `qwen-72b`     | Default in config; needs SiliconFlow key |
|            | `qwen-7b`      | Cheaper/faster, same provider            |
|            | `claude-haiku` | If you use Anthropic                     |

**Do not use** `deepseek-chat` – it is text-only and will return `image_url` / 400 errors.

### 2.4 LLM API keys (at least one vision provider)

Set the key for the provider of your chosen model:

| Provider    | Env key               | Used by models              |
| ----------- | --------------------- | --------------------------- |
| SiliconFlow | `SILICONFLOW_API_KEY` | qwen-7b, qwen-72b, qwen3-\* |
| Anthropic   | `ANTHROPIC_API_KEY`   | claude-sonnet, claude-haiku |
| OpenAI      | `OPENAI_API_KEY`      | gpt-4o, gpt-4o-mini         |

Get SiliconFlow keys at: https://cloud.siliconflow.cn/account/ak

If the worker logs `401 Unauthorized. "Api key is invalid"`, the key for the selected model is wrong or expired – fix it and restart the worker.

---

## 3. Database migration

Create GhostHands tables (all use the `gh_` prefix):

```bash
cd packages/ghosthands
bun src/scripts/run-migration.ts
bun src/scripts/verify-setup.ts
```

---

## 4. Run the system

Use **two terminals** (or run the API in the background).

**Terminal 1 – API (optional for script-based testing):**

```bash
cd packages/ghosthands
bun run api
# or: bun run api:dev
```

**Terminal 2 – Worker (required to process jobs):**

```bash
cd packages/ghosthands
bun run worker
```

You should see:

-   `[Worker] Starting worker-local-...`
-   `[Worker] Postgres connection established`
-   `[Worker] Listening for jobs on gh_job_created channel`

Only **one** worker process should be running per machine when sharing the same DB. Multiple processes will compete for the same jobs.

---

## 5. Submitting a test job

### Option A: Script (direct DB insert)

Ensures the worker picks up a job without needing the API:

```bash
cd packages/ghosthands
bun run submit-test-job
```

This inserts one job: Google search for “GhostHands browser automation”. The worker must be running in another terminal; it will pick the job up within a few seconds (or on the next 5s poll).

### Option B: API

If the API is running, create a job via `POST /api/jobs` with the correct body and `X-Service-Key` header (see API docs).

### Required input for `apply` jobs

For `job_type: "apply"`, the handler validates `input_data.user_data`:

-   `first_name` (required)
-   `last_name` (required)
-   `email` (required)

If any are missing, the job fails with `validation_error` before the browser is started. The test script uses these by default.

---

## 6. Where to see what

-   **Worker terminal**: All job lifecycle and Magnitude logs:
    -   `[JobPoller] Picked up job <id>` – job claimed
    -   `[BAML INFO]` – LLM requests (model, tokens, replies)
    -   `[JobExecutor] Job ... failed` or completion
    -   `[JobPoller] Job ... finished` – slot free again
-   **Browser window**: Launched by the worker; you see the agent navigate, type, click. Don’t close it manually during a run.
-   **Database**: Tables `gh_automation_jobs`, `gh_job_events` for status and history.

---

## 7. Useful scripts (packages/ghosthands)

| Script                                           | Purpose                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `bun run worker`                                 | Start the job worker                                          |
| `bun run api`                                    | Start the API server                                          |
| `bun run submit-test-job`                        | Insert one Google-search test job                             |
| `bun run release-stuck-jobs`                     | Re-queue jobs stuck >2 min (no heartbeat)                     |
| `bun run delete-jobs`                            | Delete all jobs (with 3s confirmation)                        |
| `bun run delete-jobs -- --status=failed,pending` | Delete only jobs with given statuses                          |
| `bun run test-shutdown`                          | List jobs currently claimed by workers and show heartbeat age |

All of these read from `packages/ghosthands/.env` (Bun loads it when you run from that directory).

---

## 8. Troubleshooting

### Worker picks up jobs but they “finish” immediately with no browser

-   **Cause**: Supabase client can’t authenticate (e.g. invalid or rotated `SUPABASE_SERVICE_KEY`).
-   **Fix**: Update `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_KEY` in `.env` from the Supabase dashboard, then restart the worker.

### Jobs are picked up by a different worker / I never see “Picked up job”

-   **Cause**: Another process is running `bun run worker` (same machine or another dev) and claims jobs first.
-   **Fix**: Run only one worker per DB, or use separate queues. On your machine, stop extra workers (e.g. `pkill -f "bun src/workers/main"` or close the other terminal), then restart your worker.

### “Api key is invalid” (401) in worker logs

-   **Cause**: The API key for the **LLM** (e.g. SiliconFlow) is wrong or expired.
-   **Fix**: Set or refresh `SILICONFLOW_API_KEY` (or the key for the model in `GH_MODEL`) in `.env` and restart the worker.

### “unknown variant `image_url`, expected `text`” (400)

-   **Cause**: The model in `GH_MODEL` does not support images (e.g. `deepseek-chat`).
-   **Fix**: Set `GH_MODEL` to a vision model, e.g. `qwen-72b` or `qwen-7b`, and ensure the corresponding API key is set.

### “Input validation failed: user_data.first_name is required”

-   **Cause**: Job has `job_type: "apply"` but `input_data.user_data` is missing required fields.
-   **Fix**: Send `first_name`, `last_name`, and `email` in `input_data.user_data` for apply jobs. The `submit-test-job` script does this.

### “browser_crashed: page, context or browser is closed”

-   **Cause**: The browser was closed (manually, by the OS, or because the previous run/retry already called `adapter.stop()`). On retry, the same job runs again but the browser instance is gone.
-   **Mitigation**: Avoid closing the browser window while a job is running. If you see this on retries, it’s a known limitation (browser lifecycle is per run). For a single successful run, the agent can complete the task; retries may need a fresh browser session (e.g. a new job).

### Stuck jobs (worker crashed or killed)

-   **Cause**: Jobs left in `running`/`queued` with an old `worker_id` and no recent heartbeat.
-   **Fix**: Run `bun run release-stuck-jobs` to re-queue them, or use `bun run delete-jobs` to clear. On graceful worker shutdown, the worker tries to release its claimed jobs so they can be picked up again.

---

## 9. Checklist before first run

-   [ ] `packages/ghosthands/.env` created from `.env.example`
-   [ ] `DATABASE_URL` / `SUPABASE_DIRECT_URL` (or `DATABASE_DIRECT_URL`) set and valid
-   [ ] `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` set and valid (no “Invalid API key”)
-   [ ] `GH_MODEL` set to a **vision** model (e.g. `qwen-72b`)
-   [ ] API key for that model set (e.g. `SILICONFLOW_API_KEY`)
-   [ ] Migrations run: `bun src/scripts/run-migration.ts` and verify
-   [ ] Only one worker running: `bun run worker` in a single terminal
-   [ ] Test job: `bun run submit-test-job` and watch worker + browser

---

## 10. Next steps

-   Run a real **apply** job to a job board URL (with valid `user_data`).
-   Integrate with VALET (see `docs/VALET-SETUP-GUIDE.md` and `docs/API-INTEGRATION.md`).
-   Tune cost/quality via `GH_MODEL` and presets in `src/config/models.config.json`.

For architecture and conventions, see the root `README.md` and `CLAUDE.md`.
