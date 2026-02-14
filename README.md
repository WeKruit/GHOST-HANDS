# GHOST-HANDS

Browser automation system for job applications, built as an extension to [Magnitude](https://github.com/magnitudedev/browser-agent).

## 🏗️ Architecture

GHOST-HANDS is a **hybrid system** combining multiple open-source browser automation tools:
- **Magnitude** - Base browser automation framework (upstream dependency)
- **Stagehand** - Visual understanding (planned integration)
- **GhostHands** - Our custom glue layer (API, worker, VALET integration)

### Repository Contents
- `docs/` - Architecture, security, and integration documentation
- `examples/` - React components and usage examples  
- `*.sql` - Supabase migration files for VALET integration
- `magnitude-source/` - **Not tracked** - Clone separately from upstream

## 🚀 Quick Start

### 1. Clone GHOST-HANDS
\`\`\`bash
git clone https://github.com/WeKruit/GHOST-HANDS.git
cd GHOST-HANDS
\`\`\`

### 2. Clone Magnitude (upstream)
\`\`\`bash
# Clone the upstream Magnitude browser-agent
git clone https://github.com/magnitudedev/browser-agent.git magnitude-source
cd magnitude-source

# Install dependencies
bun install --ignore-scripts
\`\`\`

### 3. Add GhostHands Package
The GhostHands code lives in \`magnitude-source/packages/ghosthands/\` (not tracked in this repo).

To set it up from scratch:
\`\`\`bash
cd magnitude-source/packages/ghosthands

# Run database migration
bun src/scripts/run-migration.ts

# Verify setup
bun src/scripts/verify-setup.ts
\`\`\`

### 4. Start the System
\`\`\`bash
# Terminal 1: API Server
bun run api:dev

# Terminal 2: Job Worker  
bun run worker:dev

# Terminal 3: Run tests
bun run test:e2e
\`\`\`

## 🔄 Updating Magnitude

Pull the latest from upstream:
\`\`\`bash
cd magnitude-source
git pull origin main
\`\`\`

Your GhostHands package (\`packages/ghosthands/\`) is separate and won't be affected.

## 🛠️ What's in GhostHands?

The \`packages/ghosthands/\` package (local, not pushed to this repo) includes:

- **REST API** (Hono) - Job management endpoints with auth
- **Job Worker** - Postgres LISTEN/NOTIFY + browser automation
- **VALET Client** - Dual-mode (API + DB) integration library
- **Monitoring** - Structured logging, metrics, health checks
- **Security** - Rate limiting, cost control, encryption, RLS
- **Testing** - 102 E2E tests covering all workflows

## 📚 Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security & Architecture Report](docs/SECURITY-AND-ARCHITECTURE-REPORT.md)
- [VALET Integration](docs/12-valet-ghosthands-integration.md)
- [Integration Architecture Decision](docs/13-integration-architecture-decision.md)
- [Deployment Strategy](docs/14-deployment-strategy.md)

## 📋 Requirements

- Bun 1.3+
- Postgres 14+ (Supabase)
- Node.js 18+ (for some dependencies)

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

### Current (v0.1)
- ✅ Magnitude-based browser automation
- ✅ Job queue with Postgres LISTEN/NOTIFY
- ✅ REST API + worker architecture
- ✅ VALET integration

### Planned (v0.2+)
- 🔄 Stagehand integration for visual understanding
- 🔄 Multi-provider automation (Magnitude + Stagehand + custom)
- 🔄 Smarter form detection and filling
- 🔄 Enhanced progress tracking with screenshots

## 📝 Why Not Track magnitude-source?

We keep \`magnitude-source/\` in \`.gitignore\` because:
1. It's an **upstream dependency** we pull from regularly
2. Our custom code (\`packages/ghosthands/\`) is modular and separate
3. Easier to test upstream updates without merge conflicts
4. Allows switching to alternative tools (Stagehand) in the future

For development, the GhostHands package is self-contained and can be extracted or migrated to a standalone package when needed.

---

Built with ❤️ by WeKruit
