# GhostHands Development Guide

**For:** Claude AI, Developers, Contributors
**Purpose:** Standards and conventions for the GhostHands project
**Last Updated:** 2026-02-14

---

## 🎯 Project Overview

GhostHands is a fork of Magnitude Browser Agent that adds:
1. **Stagehand-powered semantic observation** (CSS selectors, not screenshots)
2. **Self-learning manual system** (ActionBook-inspired)
3. **MCP connector support** (starting with Gmail)

**Core Innovation:** After the first successful run, manuals enable ~95% cost reduction by replaying actions with near-zero LLM calls.

---

## 📊 Architecture Principles

### 1. **DO NOT Modify Magnitude Core**

GhostHands extends Magnitude via the `AgentConnector` interface. **Never modify:**
- `Agent._act()` loop
- `ModelHarness` logic (except cost map additions)
- Core action definitions

**Why:** Keeps us compatible with upstream Magnitude updates.

### 2. **All Extensions via Connectors**

New capabilities must be implemented as `AgentConnector` implementations:

```typescript
export class MyConnector implements AgentConnector {
    id = "my-feature";

    getActionSpace(): ActionDefinition<any>[] {
        return [/* your actions */];
    }

    async getInstructions(): Promise<string> {
        return "Instructions that shape LLM behavior";
    }
}
```

### 3. **Test-Driven Development (TDD)**

**ALWAYS write tests before implementation:**

1. Write failing tests
2. Implement minimal code to pass
3. Refactor
4. Repeat

**No PRs accepted without tests.**

---

## 🗄️ Database Naming Conventions

### **Critical Rule: Table Prefixes**

GhostHands shares the **same Supabase database** as VALET to:
- Reduce costs (single instance)
- Enable future integration
- Share authentication

**To avoid conflicts, ALL GhostHands tables MUST use the `gh_` prefix:**

| System | Table Prefix | Example Tables |
|--------|--------------|----------------|
| **VALET** | None | `users`, `tasks`, `resumes`, `browser_profiles` |
| **GhostHands** | `gh_` | `gh_action_manuals`, `gh_sessions` (future) |

### Examples

✅ **CORRECT:**
```sql
CREATE TABLE gh_action_manuals (
    id UUID PRIMARY KEY,
    url_pattern TEXT,
    -- ...
);

CREATE INDEX idx_gh_manuals_url_pattern
    ON gh_action_manuals(url_pattern);
```

❌ **WRONG:**
```sql
CREATE TABLE action_manuals (  -- Missing gh_ prefix!
    id UUID PRIMARY KEY,
    -- ...
);
```

### Enforcement

- **Migration files:** Must include `gh_` prefix check
- **Code:** ManualConnector uses `gh_action_manuals` table name
- **Tests:** Verify correct table names
- **CI:** Will fail if unprefixed tables detected

---

## 🔧 Code Style

### TypeScript

- Use TypeScript strict mode
- Prefer `async/await` over promises
- Use Zod for schema validation
- Export types alongside implementations

### File Organization

```
packages/magnitude-core/src/
├── connectors/
│   ├── stagehandConnector.ts    # One file per connector
│   ├── manualConnector.ts
│   └── index.ts                 # Export all connectors
├── actions/
│   └── [existing Magnitude actions]
└── ai/
    └── modelHarness.ts          # Only modify knownCostMap
```

### Naming Conventions

- **Connectors:** `*Connector.ts` (PascalCase)
- **Actions:** `namespace:action` (lowercase with colon)
- **Tests:** `*.test.ts` (same name as implementation)
- **Interfaces:** `I*` prefix (e.g., `IManualStorage`)

---

## 🧪 Testing Standards

### Test Structure

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

describe('FeatureConnector', () => {
    describe('interface compliance', () => {
        test('has correct id', () => { /* ... */ });
        test('implements AgentConnector', () => { /* ... */ });
    });

    describe('action: feature:action', () => {
        test('succeeds with valid input', () => { /* ... */ });
        test('throws on invalid input', () => { /* ... */ });
    });
});
```

### Test Coverage Goals

- **Unit tests:** >80% line coverage
- **Integration tests:** Cover all critical paths
- **E2E tests:** At least 1 per connector

### Mocking

- Mock external services (Supabase, MCP, Stagehand)
- Use dependency injection for testability
- Never make live API calls in unit tests

---

## 💰 Cost Optimization

### Provider Selection

**Default hierarchy (cheapest to most expensive):**

1. Qwen VL 7B (SiliconFlow) - $0.05/$0.15 per million tokens
2. DeepSeek Chat - $0.27/$1.10 per million tokens
3. Gemini 2.5 Flash - $0.075/$0.30 per million tokens
4. Gemini 2.5 Pro - $1.25/$5.00 per million tokens
5. Claude Sonnet 3.7 - $3.00/$15.00 per million tokens (baseline)

### Cost Map Updates

When adding new providers, update `knownCostMap` in `modelHarness.ts`:

```typescript
'new-model-name': {
    inputTokens: 0.XX,   // USD per million input tokens
    outputTokens: 0.YY   // USD per million output tokens
}
```

**Source costs from:** Official provider pricing pages (as of 2026-02)

---

## 🔐 Security & Secrets

### Environment Variables

**Never commit:**
- API keys
- Database passwords
- Supabase credentials
- MCP server URLs with tokens

**Use `.env` files (gitignored):**
```bash
# .env (never committed)
SUPABASE_URL=...
SUPABASE_KEY=...
DEEPSEEK_API_KEY=...
```

**For tests:**
```typescript
// Use env vars with fallbacks for CI
const apiKey = process.env.DEEPSEEK_API_KEY ?? 'test-key-for-mocking';
```

### Database Security

- **Enable RLS** (Row Level Security) on all tables
- **Use anon key** for client-side access
- **Use service role key** only in server code
- **Never log** database credentials

---

## 📝 Documentation Standards

### Code Comments

**When to comment:**
- Complex algorithms
- Non-obvious design decisions
- Workarounds for bugs

**When NOT to comment:**
- Obvious code
- Self-explanatory functions

```typescript
// ❌ BAD: Obvious
// Increment counter
count++;

// ✅ GOOD: Explains why
// Health score degrades faster after 5 failures to prevent stale manuals
const degradationFactor = failureCount > 5 ? 2.0 : 1.0;
```

### README Requirements

Every new feature needs:
1. **What:** Brief description
2. **Why:** Problem it solves
3. **How:** Usage example
4. **Tests:** How to verify it works

---

## 🚀 Release Process

### Version Bumping

Use semantic versioning:
- **Major:** Breaking changes to public API
- **Minor:** New features (backward-compatible)
- **Patch:** Bug fixes

### Changelog

Update `CHANGELOG.md` with:
- New features
- Bug fixes
- Breaking changes
- Migration guides (if needed)

---

## 🤝 Contribution Workflow

### Before Starting Work

1. Check existing issues/PRs
2. Create an issue describing the change
3. Get approval from maintainers
4. Fork and create a branch

### Development Cycle

1. Write tests (TDD!)
2. Implement feature
3. Ensure all tests pass
4. Update documentation
5. Submit PR

### PR Requirements

- [ ] All tests pass
- [ ] No TypeScript errors
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Follows naming conventions
- [ ] Uses `gh_` prefix for any new tables

---

## 📊 Performance Guidelines

### LLM Call Optimization

**Golden rule:** Minimize LLM calls via manuals.

**First run (no manual):**
- ~10 LLM calls expected
- ~$0.02 cost (with cheap providers)
- ~8s duration

**Second run (with manual):**
- ~1 LLM call (manual:lookup only)
- ~$0.0005 cost
- ~0.4s duration

**Target:** 95% reduction in calls/cost/time after first run.

### Database Query Optimization

- Use indexes on frequently queried columns
- Limit query results (don't fetch all rows)
- Use `.select('*')` sparingly (select only needed columns)

---

## 🐛 Debugging

### Enable Verbose Logging

```typescript
import logger from '@/logger';

logger.level = 'debug';  // or 'trace' for even more detail
```

### Common Issues

**Issue:** Tests fail with "Supabase not connected"
**Fix:** Check `SUPABASE_URL` and `SUPABASE_KEY` env vars

**Issue:** Manual not found after saving
**Fix:** Verify table name is `gh_action_manuals` (with prefix!)

**Issue:** BAML errors
**Fix:** Run `npx baml-cli generate --from packages/magnitude-core/baml_src`

---

## 📚 References

### Key Files

- `packages/magnitude-core/src/connectors/index.ts` - Connector interface
- `packages/magnitude-core/src/actions/index.ts` - Action creation
- `test/connectors/manual.test.ts` - Reference test structure
- `supabase-migration.sql` - Database schema

### External Docs

- [Magnitude Docs](https://docs.magnitude.run)
- [Stagehand Docs](https://github.com/browserbasehq/stagehand)
- [MCP Specification](https://modelcontextprotocol.io)
- [Supabase Docs](https://supabase.com/docs)

---

## ✅ Pre-commit Checklist

Before committing:

- [ ] All tests pass (`bun test`)
- [ ] TypeScript compiles (`bun run check`)
- [ ] No console.log statements (use logger)
- [ ] Tables use `gh_` prefix
- [ ] Environment variables in `.env` (not hardcoded)
- [ ] Documentation updated
- [ ] CHANGELOG.md updated (if user-facing change)

---

**Questions?** Check existing tests for examples or ask in issues!

**Want to contribute?** Read this guide first, then submit a PR!

---

*This guide is a living document. Update it as the project evolves!*
