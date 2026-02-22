# GHOST-HANDS

Browser automation system for job applications. Uses an **adapter-based architecture** to wrap Magnitude (and future engines) behind a clean interface, with a Hono REST API, Postgres-backed job queue, and Docker deployment on EC2.

## Architecture

```
GHOST-HANDS/
  packages/ghosthands/
    src/
      adapters/          # BrowserAutomationAdapter interface + Magnitude/Mock
      api/               # Hono REST API (routes, middleware, schemas)
      workers/           # JobPoller (LISTEN/NOTIFY) + JobExecutor
      engine/            # ExecutionEngine, CookbookExecutor, ManualStore
      client/            # VALET integration SDK
      security/          # Rate limiting, domain lockdown, input sanitization
      monitoring/        # Structured logging, metrics, health checks, alerts
      sessions/          # Encrypted browser session persistence
      db/                # Supabase client, AES-256-GCM credential encryption
      config/            # Model catalog, rate limits, environment
    __tests__/           # Unit, integration, and E2E tests
  docs/                  # Technical documentation
  scripts/               # deploy.sh (EC2 deployment)
  supabase-migration*.sql
```

## Quick Start

```bash
# 1. Install
git clone https://github.com/WeKruit/GHOST-HANDS.git
cd GHOST-HANDS
bun install

# 2. Configure
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL, GH_SERVICE_SECRET

# 3. Run migrations
cd packages/ghosthands
bun src/scripts/run-migration.ts
bun src/scripts/verify-setup.ts

# 4. Start
bun run dev:api      # API on port 3100
bun run dev:worker   # Worker on port 3101 (separate terminal)
```

Or with Docker:

```bash
docker compose up
```

## Key Components

- **Adapter Layer** -- `BrowserAutomationAdapter` abstraction over Magnitude/Stagehand/Actionbook
- **REST API** -- Hono-based, versioned at `/api/v1/gh/`, with auth, rate limiting, and CSP
- **Job Worker** -- Postgres LISTEN/NOTIFY for instant pickup, `FOR UPDATE SKIP LOCKED` for safe concurrency
- **Execution Engine** -- Tries cookbook replay from manuals first, falls back to Magnitude LLM agent
- **Cost Control** -- Per-task budgets ($0.02-$0.30), per-user monthly limits, tiered rate limiting
- **VALET Integration** -- Dedicated `/valet/` routes, callback notifications, shared Supabase DB

## Common Commands (Windows)

All commands run from `packages/ghosthands/`.

```bash
# Start a worker
npx tsx --env-file=.env src/workers/main.ts --worker-id=workday-test

# Submit a Workday application job (pulls user profile from VALET's parsed resumes)
npx tsx --env-file=.env src/scripts/apply-workday.ts -- --user-id=<uuid> --worker-id=workday-test
# Optional flags:
#   --url=<workday-url>    — override the default Workday listing URL
#   --worker-id=<id>       — target a specific worker (required if multiple workers running)

# Kill all jobs
npx tsx --env-file=.env src/scripts/kill-jobs.ts

# Kill zombie workers
npx tsx --env-file=.env src/scripts/kill-zombies.ts

# Fix tier lock
npx tsx --env-file=.env src/scripts/fix-tier.ts

# Clear old session cookies from Supabase
npx tsx --env-file=.env src/scripts/clear-old-sessions.ts

# Run session persistence test (from packages/ghosthands/)
npx vitest run __tests__/integration/sessions/sessionPersistence.test.ts
```

### Workday Profile Defaults

When loading a user's parsed resume from VALET, some Workday-specific fields
(gender, veteran status, disability, etc.) are not in the resume. These use
defaults defined in:

```
packages/ghosthands/src/db/resumeProfileLoader.ts → WORKDAY_PROFILE_DEFAULTS
```

Edit that object to change the default answers for self-identification questions.

## Requirements

- Bun 1.2+
- Postgres 14+ (Supabase)
- Node.js 18+ (for some dependencies)

## Documentation

See **[docs/CURRENT-STATE.md](docs/CURRENT-STATE.md)** for the full technical reference.

| Doc | Description |
|-----|-------------|
| [CURRENT-STATE.md](docs/CURRENT-STATE.md) | Architecture, DB schema, API, workers, deployment |
| [ONBOARDING-AND-GETTING-STARTED.md](docs/ONBOARDING-AND-GETTING-STARTED.md) | Setup, env vars, troubleshooting |
| [VALET-INTEGRATION-CONTRACT.md](docs/VALET-INTEGRATION-CONTRACT.md) | API contract with VALET |
| [CLAUDE.md](CLAUDE.md) | Development conventions and standards |

Archived design docs and research are in [docs/archive/](docs/archive/).

---

Built by WeKruit
