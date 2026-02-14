# OSS Wrapping Patterns: Research & Recommendations for GHOST-HANDS

**Date:** 2026-02-14
**Author:** oss-researcher agent
**Status:** Complete

---

## 1. Executive Summary

GHOST-HANDS extends Magnitude (an open-source browser automation agent) with job-application-specific features: connectors, security, cost control, monitoring, and a worker/API layer. The core question is: **how should we structure our relationship with upstream Magnitude?**

**Recommendation:** Use Magnitude as an **npm dependency** (not a fork or submodule), with GHOST-HANDS code living in a **separate repository** that consumes `magnitude-core` as a published package. An **adapter/anti-corruption layer** should isolate GHOST-HANDS business logic from Magnitude internals.

---

## 2. Current State Analysis

### What exists today

```
magnitude-source/                  # Full clone of magnitudedev/browser-agent
  packages/
    magnitude-core/                # Upstream Magnitude (MODIFIED: +1,955 lines)
    magnitude-extract/             # Upstream
    magnitude-mcp/                 # Upstream
    magnitude-test/                # Upstream
    create-magnitude-app/          # Upstream
    ghosthands/                    # Our code, added as a workspace package
```

### Problems with current approach

| Problem | Impact |
|---------|--------|
| GhostHands connectors (manual, stagehand, gmail) were added **directly into** `magnitude-core/src/connectors/` | Cannot pull upstream without merge conflicts |
| Security modules added to `magnitude-core/src/security/` | Same -- pollutes upstream package |
| `browserAgent.ts` and `modelHarness.ts` modified in-place | Core files diverged from upstream |
| Entire Magnitude repo cloned into project | 38 top-level items, 232KB lockfile, all upstream packages included |
| `ghosthands` package depends on `magnitude-core: workspace:*` | Tied to this specific workspace layout |
| Git remote still points to `magnitudedev/browser-agent.git` | Confusing origin; no GHOST-HANDS remote |

---

## 3. Approaches Compared

### 3A. npm Dependency (Recommended)

Consume `magnitude-core` as a published npm package. GHOST-HANDS lives in its own repo.

```
ghost-hands/                       # Our repo
  packages/
    ghosthands-core/               # Our business logic
      src/
        adapters/                   # Anti-corruption layer over magnitude-core
        connectors/                 # Our connectors (manual, stagehand, gmail)
        security/
        workers/
        api/
      package.json                 # depends on "magnitude-core": "^0.3.x"
    ghosthands-client/             # Client SDK
  apps/
    worker/
    api/
```

| Pros | Cons |
|------|------|
| Clean separation: our code never touches upstream files | Cannot modify magnitude-core internals directly |
| `npm update` / Renovate / Dependabot tracks upstream releases | Must wait for upstream to publish new versions |
| No merge conflicts on upstream sync | Need adapter layer to insulate from API changes |
| Smaller repo; only our code in version control | Upstream bugs may block us until patched |
| Clear "what is ours" boundary | Initial migration effort required |
| Standard monorepo tooling (turborepo, bun workspaces) works naturally | |

**When upstream needs a fix:** Submit a PR upstream, or temporarily use `npm:` aliasing / patch-package for hotfixes.

### 3B. Git Submodule

Mount `magnitudedev/browser-agent` as a submodule inside our repo.

```
ghost-hands/
  vendor/magnitude/                # git submodule -> magnitudedev/browser-agent
  packages/
    ghosthands-core/
      package.json                 # depends on "../vendor/magnitude/packages/magnitude-core"
```

| Pros | Cons |
|------|------|
| Pin to exact upstream commit | Submodule UX is notoriously poor (clone --recurse, init, update) |
| Can read upstream source locally | PR reviews show only SHA changes for submodule updates |
| Possible to patch locally (but messy) | Workspace linking with submodule paths is fragile |
| | CI/CD complexity increases (submodule checkout) |
| | Diamond dependency risk if submodule has its own submodules |
| | New contributors consistently struggle with submodules |
| | pnpm/bun workspace `*` syntax breaks when submodule package.json uses non-workspace deps |

**Verdict:** Submodules are a poor fit. The complexity outweighs the benefit of pinning to a commit (which `package-lock.json` / `bun.lock` already provides).

### 3C. Hard Fork (Current Approach, Not Recommended Long-term)

Clone the entire upstream repo. Modify files in-place. Maintain as a single repo.

| Pros | Cons |
|------|------|
| Maximum flexibility -- change anything | Merge conflicts on every upstream sync |
| No abstraction overhead | "What did we change?" becomes archaeological excavation |
| Quick to start (which is why it was done initially) | Upstream improvements require manual cherry-picking |
| | Carries all upstream packages we don't need (create-magnitude-app, magnitude-test, etc.) |
| | Difficult to contribute fixes back upstream |
| | License compliance risk if modifications aren't tracked |

**Verdict:** Acceptable for prototyping (which was the Phase 1 goal), but must migrate away before adding more features.

### 3D. Soft Fork + npm Alias

Publish our own scoped fork of magnitude-core (`@ghosthands/magnitude-core`) that adds our extensions, aliased in package.json.

```json
{
  "dependencies": {
    "magnitude-core": "npm:@ghosthands/magnitude-core@^0.3.1"
  }
}
```

| Pros | Cons |
|------|------|
| Can modify magnitude-core internals | Must actively merge upstream changes into our fork |
| Downstream code uses same import paths | Publishing overhead (CI, npm org, versioning) |
| Drop-in replacement | Still a fork -- same merge conflict problems |
| | Two packages to version and release |

**Verdict:** Only justified if we need to modify magnitude-core internals permanently and upstream won't accept our changes. Currently we don't -- the `AgentConnector` interface covers our extension needs.

---

## 4. Real-World Examples

### Stagehand (Browserbase)

Stagehand originally wrapped Playwright as an npm dependency. In v3, they introduced a **modular driver system** that abstracts the browser automation backend entirely. Their architecture:
- `@browserbasehq/stagehand` is the published npm package
- It consumes `playwright-core` (or Puppeteer) as a dependency
- A `BrowserDriver` adapter interface allows swapping backends
- No fork of Playwright required

**Lesson for GHOST-HANDS:** The adapter pattern works. Stagehand proves you can build a significant product on top of Playwright/browser automation without forking the dependency.

### Patchright (Playwright fork)

Patchright takes the opposite approach: a hard fork of Playwright that patches specific behaviors. They publish `patchright` as a drop-in npm replacement.
- Constant merge effort to stay current with upstream Playwright
- Justified because their changes require modifying Playwright internals

**Lesson for GHOST-HANDS:** We should only fork magnitude-core if the `AgentConnector` interface is insufficient. Currently, it is sufficient.

### WebdriverIO

WebdriverIO wraps Selenium WebDriver + DevTools Protocol as an npm package (`webdriverio`). It consumes `selenium-webdriver` as a dependency and exposes a higher-level API.
- Clean separation between WebdriverIO's API and the underlying protocol
- Adapter pattern for swapping between WebDriver and DevTools backends

**Lesson for GHOST-HANDS:** Higher-level wrappers around browser automation tools consistently use the npm dependency + adapter pattern.

### NestJS Monorepo Pattern

The `nestjs-monorepo` boilerplate on GitHub demonstrates anti-corruption layer, adapter, and dependency inversion patterns in a TypeScript monorepo. Structure:
```
packages/
  core/           # Business logic
  adapters/       # External service adapters
  libs/           # Shared utilities
```

**Lesson for GHOST-HANDS:** Well-known monorepo patterns exist for exactly our use case.

---

## 5. `vendor/` vs `packages/` Directory

| Aspect | `vendor/` | `packages/` |
|--------|-----------|-------------|
| **Convention** | Implies third-party vendored code (Go, PHP, Ruby) | Standard for monorepo internal packages (JS/TS) |
| **Semantics** | "Code we copied from elsewhere" | "Code we own and maintain" |
| **Tooling** | Not recognized by workspace configs by default | Native support in bun/pnpm/npm workspaces |
| **Upstream tracking** | Implies manual vendoring / copy-paste | Implies managed internal packages |

**Recommendation:** Use `packages/` for our code. If we ever need to vendor a dependency (e.g., a patched version of magnitude-core), place it in `vendor/` with a clear README explaining why. But the primary goal should be to **not vendor** -- consume via npm instead.

---

## 6. Handling Upstream Breaking Changes

### Strategy: Adapter + Semver + CI

1. **Adapter Layer (Anti-Corruption Layer)**
   - All imports from `magnitude-core` flow through `ghosthands-core/src/adapters/`
   - Adapters re-export only the types and functions we use
   - When upstream changes an API, only the adapter file changes -- not our business logic

   ```typescript
   // adapters/magnitude.ts
   import { Agent, AgentConnector } from 'magnitude-core';
   import type { ActionDefinition } from 'magnitude-core';

   // Re-export with our naming conventions
   export type { Agent, AgentConnector, ActionDefinition };

   // Wrap if API changes
   export function createAgent(config: GhostHandsConfig): Agent {
     return new Agent({
       // Map our config to magnitude's expected format
       ...config,
       connectors: config.connectors ?? [],
     });
   }
   ```

2. **Semver Pinning**
   - Use caret ranges `^0.3.x` in package.json to accept patches
   - Major version bumps require explicit review and adapter updates
   - `bun.lock` / `package-lock.json` provides deterministic builds

3. **CI Upstream Check**
   - Weekly CI job runs tests against `magnitude-core@latest`
   - Alerts if upstream update breaks our adapter layer
   - Gives early warning before we bump in production

4. **Escape Hatch: patch-package**
   - If upstream has a bug blocking us, use `patch-package` to apply a local patch
   - Patch is tracked in `patches/magnitude-core+0.3.1.patch`
   - Removed once upstream publishes a fix
   - Far better than maintaining a full fork

---

## 7. Recommendations for GHOST-HANDS

### Decision Matrix

| Question | Answer | Rationale |
|----------|--------|-----------|
| **npm dep or git submodule?** | npm dependency | Submodules add complexity without benefit; npm provides version management, lockfile pinning, and standard tooling |
| **How to structure our extensions?** | Separate `packages/ghosthands-core` with adapter layer | All magnitude-core imports go through adapters; connectors, security, workers are our packages |
| **`vendor/` or `packages/`?** | `packages/` for our code; no `vendor/` needed initially | Standard JS/TS monorepo convention; vendor only if forced to patch upstream |
| **How to handle breaking changes?** | Adapter layer + semver + CI checks + patch-package escape hatch | Insulates business logic from upstream churn |

### Concrete Next Steps

1. **Create a new GHOST-HANDS repository** (or repurpose the existing one without the magnitude-source clone)
2. **Move ghosthands code out of magnitude-source** into `packages/ghosthands-core/`
3. **Move connectors out of magnitude-core** (manual, stagehand, gmail) into `ghosthands-core/src/connectors/`
4. **Remove security modules from magnitude-core** into `ghosthands-core/src/security/`
5. **Add `magnitude-core: ^0.3.1`** as a normal npm dependency
6. **Create adapter layer** in `ghosthands-core/src/adapters/magnitude.ts`
7. **Revert modifications to magnitude-core** (browserAgent.ts, modelHarness.ts) and implement equivalent behavior through the adapter/connector pattern
8. **Delete magnitude-source/** once migration is validated
9. **Set up CI** to test against latest upstream periodically

### What Needs Upstream Contribution

Two modifications currently in `magnitude-core` may need to be contributed back or handled differently:

| Modification | Location | Strategy |
|--------------|----------|----------|
| Cost map additions in modelHarness.ts | `magnitude-core/src/ai/modelHarness.ts` | PR upstream to make cost map configurable/extensible |
| ConnectorRegistry access in browserAgent.ts | `magnitude-core/src/agent/browserAgent.ts` | Already works via `AgentConnector` interface -- verify and remove direct modifications |

---

## 8. Architectural Diagram

```
                    GHOST-HANDS Repository
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  packages/                                       │
  │  ├── ghosthands-core/                            │
  │  │   ├── src/                                    │
  │  │   │   ├── adapters/                           │
  │  │   │   │   └── magnitude.ts  ← ACL layer      │
  │  │   │   ├── connectors/                         │
  │  │   │   │   ├── manualConnector.ts              │
  │  │   │   │   ├── stagehandConnector.ts           │
  │  │   │   │   └── gmailConnector.ts               │
  │  │   │   ├── security/                           │
  │  │   │   ├── workers/                            │
  │  │   │   ├── api/                                │
  │  │   │   └── db/                                 │
  │  │   └── package.json                            │
  │  │       dependencies:                           │
  │  │         "magnitude-core": "^0.3.x"  ← npm    │
  │  │                                               │
  │  └── ghosthands-client/                          │
  │      └── package.json                            │
  │                                                  │
  │  apps/                                           │
  │  ├── api/                                        │
  │  └── worker/                                     │
  │                                                  │
  └──────────────────────────────────────────────────┘
              │
              │  npm install
              ▼
  ┌──────────────────────┐
  │  magnitude-core      │  ← Published npm package
  │  (upstream, unmodified) │     from magnitudedev
  │                      │
  │  Exports:            │
  │  - Agent             │
  │  - AgentConnector    │
  │  - ActionDefinition  │
  │  - ModelHarness      │
  └──────────────────────┘
```

---

## 9. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Upstream removes AgentConnector interface | Low | High | Pin version; adapter layer gives time to respond |
| Upstream publishes breaking v1.0 | Medium | Medium | Semver pinning; adapter layer absorbs changes |
| We need a magnitude-core internal change | Medium | Medium | PR upstream first; patch-package as interim |
| Upstream goes unmaintained | Low | High | Fork at that point (not before) |
| Migration introduces regressions | Medium | Medium | Comprehensive test suite before migration |

---

## 10. References

- [Stagehand: Moving Beyond Playwright](https://www.browserbase.com/blog/stagehand-playwright-evolution-browser-automation) -- How Browserbase built an adapter layer over Playwright
- [Patchright (Playwright fork)](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) -- Example of when/why to fork vs. wrap
- [Anti-Corruption Layer Pattern](https://deviq.com/domain-driven-design/anti-corruption-layer/) -- DDD pattern for isolating external dependencies
- [Reasons to Avoid Git Submodules](https://blog.timhutt.co.uk/against-submodules/) -- Comprehensive argument against submodules
- [Turborepo: Managing Dependencies](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) -- Workspace dependency management best practices
- [NestJS Monorepo with ACL Pattern](https://github.com/mikemajesty/nestjs-monorepo) -- TypeScript monorepo using adapter + anti-corruption layer
- [Kilo Health: Why Git Submodules Didn't Work](https://kilo.health/engineering-blog/how-we-tried-using-git-submodules-and-why-it-did-not-work-for-us/) -- Real-world submodule failure story
- [Dependency Cutout Pattern](https://blog.glyph.im/2025/11/dependency-cutout-workflow-pattern.html) -- Managing vendored dependency visibility
