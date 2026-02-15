# GHOST-HANDS

Browser automation system for job applications with **adapter-based architecture** supporting multiple browser automation engines.

## 🏗️ Architecture

GHOST-HANDS uses a **clean adapter pattern** to integrate multiple browser automation tools:

-   **Magnitude** - Current implementation (npm dependency)
-   **Stagehand** - Visual understanding (adapter ready, awaiting integration)
-   **Actionbook** - Pre-computed action manuals (adapter ready, awaiting integration)

### Repository Structure

```
GHOST-HANDS/
├── packages/ghosthands/
│   ├── src/adapters/          # Browser automation abstraction
│   │   ├── types.ts           # BrowserAutomationAdapter interface
│   │   ├── magnitude.ts       # Magnitude wrapper (current)
│   │   ├── mock.ts            # Mock for testing
│   │   └── index.ts           # Factory + exports
│   ├── src/api/               # REST API (Hono)
│   ├── src/workers/           # Job queue + executor
│   ├── src/client/            # VALET integration SDK
│   ├── src/monitoring/        # Logging, metrics, alerts
│   ├── src/security/          # Rate limiting, encryption
│   └── __tests__/e2e/         # 102 E2E tests
├── docs/                      # Architecture, research, migration docs
├── magnitude-source/          # Backup (not tracked, for reference)
└── ...
```

## 🚀 Quick Start

**New to the project?** See **[docs/ONBOARDING-AND-GETTING-STARTED.md](docs/ONBOARDING-AND-GETTING-STARTED.md)** for full onboarding: env vars, Supabase keys, vision model setup, worker, test jobs, and troubleshooting (browser closed, 401s, stuck jobs).

### 1. Clone and Install

\`\`\`bash
git clone https://github.com/WeKruit/GHOST-HANDS.git
cd GHOST-HANDS

# Install dependencies (includes magnitude-core@0.3.1 via npm)

bun install

# Build

bun run build
\`\`\`

### 2. Set Up Environment

\`\`\`bash

# Copy example env file

cp .env.example packages/ghosthands/.env

# Edit with your credentials

nano packages/ghosthands/.env
\`\`\`

### 3. Run Database Migration

\`\`\`bash
cd packages/ghosthands
bun src/scripts/run-migration.ts
bun src/scripts/verify-setup.ts
\`\`\`

### 4. Start the System

\`\`\`bash

# Terminal 1: API Server (port 3000)

bun run api:dev

# Terminal 2: Job Worker

bun run worker:dev

# Terminal 3: Run tests

bun run test:e2e
\`\`\`

## 🔄 Updating Dependencies

Pull latest Magnitude updates:
\`\`\`bash

# Check for updates

bun outdated

# Update Magnitude

bun update magnitude-core magnitude-extract

# Rebuild

bun run build
\`\`\`

## 🛠️ What's Inside?

### Core Components

-   **Adapter Layer** (`src/adapters/`) - Abstraction for Magnitude/Stagehand/Actionbook
-   **REST API** (`src/api/`) - Hono-based job management with auth
-   **Job Worker** (`src/workers/`) - Postgres LISTEN/NOTIFY + browser automation
-   **VALET Client** (`src/client/`) - Dual-mode (API + DB) integration SDK
-   **Monitoring** (`src/monitoring/`) - Structured logging, metrics, health checks
-   **Security** (`src/security/`) - Rate limiting, cost control, encryption, RLS
-   **Testing** (`__tests__/e2e/`) - 102 E2E tests covering all workflows

### Features

✅ Browser automation via adapter pattern
✅ Multiple engine support (Magnitude, Stagehand-ready, Actionbook-ready)
✅ Job queue with instant pickup (LISTEN/NOTIFY)
✅ Progress tracking (11-step lifecycle)
✅ Cost tracking and budget enforcement
✅ Rate limiting by tier and platform
✅ Security: AES-256-GCM encryption, RLS policies, CSP headers
✅ Deployment: Docker, Fly.io configs, CI/CD pipeline

## 📚 Documentation

See **[docs/README.md](docs/README.md)** for the full index. Main entries:

-   [Onboarding & getting started](docs/ONBOARDING-AND-GETTING-STARTED.md) – env, keys, worker, troubleshooting
-   [VALET setup](docs/VALET-SETUP-GUIDE.md) – VALET integration
-   [API integration](docs/API-INTEGRATION.md) – API usage
-   [Architecture](docs/ARCHITECTURE.md) · [Security report](docs/SECURITY-AND-ARCHITECTURE-REPORT.md)
-   [Adapter validation](docs/adapter-validation.md) · [Dependency map](docs/dependency-map.md)
-   Older design/migration docs are in [docs/archive/](docs/archive/)

## 📋 Requirements

-   Bun 1.3+
-   Postgres 14+ (Supabase)
-   Node.js 18+ (for some dependencies)

## 🔑 Environment Variables

Create \`.env\` in \`magnitude-source/\`:

\`\`\`bash

# Supabase (shared with VALET)

DATABASE_URL=postgresql://...
DATABASE_DIRECT_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_KEY=eyJ...

# LLM Provider (choose one)

DEEPSEEK_API_KEY=sk-...
SILICONFLOW_API_KEY=sk-...
GOOGLE_API_KEY=...
\`\`\`

## 🔮 Roadmap

### v0.1 - Foundation (Current) ✅

-   ✅ Clean adapter-based architecture
-   ✅ Magnitude integration via npm dependency
-   ✅ Job queue with Postgres LISTEN/NOTIFY
-   ✅ REST API + worker system
-   ✅ VALET integration SDK
-   ✅ Production-ready deployment configs

### v0.2 - Multi-Engine Support (Next)

-   🔄 Stagehand adapter implementation (validated, ready to build)
-   🔄 Actionbook adapter implementation (validated, ready to build)
-   🔄 HybridAdapter (smart routing between engines)
-   🔄 Engine selection by task complexity
-   🔄 Visual understanding via Stagehand

### v0.3 - Intelligence Layer

-   🔄 Smarter form detection and filling
-   🔄 Enhanced progress tracking with screenshots
-   🔄 Self-healing selectors
-   🔄 Action replay and debugging tools

## 🎯 Why This Architecture?

### Adapter Pattern Benefits

1. **Easy engine updates** - `bun update magnitude-core` pulls latest without conflicts
2. **Swappable backends** - Switch between Magnitude/Stagehand/Actionbook via config
3. **Clean separation** - Our code (`packages/ghosthands`) never touches upstream
4. **Testing** - MockAdapter enables unit tests without browsers
5. **Future-proof** - Add new engines without refactoring core logic

### npm vs Git Submodule

We chose **npm dependencies** over git submodules because:

-   ✅ Standard tooling (bun/npm) - no git submodule complexity
-   ✅ Version pinning via package.json + bun.lock
-   ✅ Simpler CI/CD (no submodule init/update)
-   ✅ Better developer experience
-   ✅ Emergency hotfixes via `patch-package`

See [docs/research/oss-wrapping-patterns.md](docs/research/oss-wrapping-patterns.md) for full analysis.

---

Built with ❤️ by WeKruit
