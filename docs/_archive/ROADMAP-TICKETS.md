# GhostHands Roadmap: Phase 2-3 Ticket Breakdown (v2)

**Date:** 2026-02-16
**Revised:** 2026-02-16 — Stagehand/ActionBook as deps, session persistence & HITL to P0
**Status:** Planning (ready for implementation)
**Scope:** Phase 2a-2d (Hybrid Engine + HITL) and Phase 3a-3d (Browser Operator)

---

## Key Decisions (v2 changes)

1. **Session Persistence is P0** — moved from Phase 2c to Sprint 1. Every new task currently creates a fresh browser; this is the #1 pain point.
2. **HITL Pause/Resume is P0** — moved from Phase 2b to Sprint 1. Blockers (CAPTCHA, 2FA) are unrecoverable without human intervention.
3. **Stagehand (`@browserbasehq/stagehand`) is a dependency** — we use its `observe()` for page understanding instead of building our own CDP Accessibility Tree parser. PageObserver wraps Stagehand, not replaces it.
4. **ActionBook (`@actionbookdev/sdk`) is a dependency** — we use its pre-built action manuals as cookbook seed data instead of hand-coding platform templates. ActionBookConnector queries ActionBook's API for existing manuals before running expensive AI exploration.
5. **Don't reinvent the wheel** — Stagehand handles page observation + DOM analysis; ActionBook handles pre-built ATS manuals; we handle the orchestration, recording, self-healing, and session persistence layers.

---

## Part 1: Epic Overview

| # | Epic | Phase | Status | Description |
|---|------|-------|--------|-------------|
| E1 | **Session Persistence** | 2a | **Complete** | storageState export/import/encrypt for cross-job browser session reuse |
| E2 | **HITL Pause/Resume** | 2a | **Complete** | Blocker detection, agent pause/resume, VALET notification, resume endpoint |
| E3 | **Stagehand Integration** | 2a | Not started | Install Stagehand, share browser via CDP, use `observe()` for page understanding |
| E4 | **ActionBook Integration** | 2a | Not started | Install ActionBook SDK, query pre-built manuals, seed cookbooks from ActionBook |
| E5 | **Resilient Cookbooks** | 2a-2c | Not started | Multi-strategy locators, cookbook storage, replay, trace recording, self-healing |
| E6 | **Execution Engine** | 2b | Not started | Orchestrator: observe, decide (fast path vs agent), execute, learn |
| E7 | **File Upload** | 2b | Not started | Filechooser interception, buffer uploads, drag-drop; resume passed at job submission |
| E8 | **Metrics & Polish** | 2d | Not started | Cost savings dashboard, cookbook hit rates, healing event telemetry |
| E9 | **Browser Operator** | 3a-3d | Not started | Chrome extension, CDP bridge, BrowserOperatorAdapter, mode switching |
| E10 | **DB Migrations** | 2a | Not started | Migration 009 (interaction columns), 010 (gh_browser_sessions) |
| E11 | **Test Infrastructure** | 2a-2d | Not started | Unit, integration, E2E tests for all new components |

---

## Part 2: Detailed Tickets

---

### Epic E1: Session Persistence (P0 — Sprint 1)

---

#### GH-001: DB migration 010 — create gh_browser_sessions table

- **Epic:** E1 - Session Persistence
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [db]
- **Description:** Create `gh_browser_sessions` table for session persistence. Stores encrypted browser state (cookies + localStorage as JSON) per user per domain, enabling cross-job session reuse. Includes encryption fields, TTL, and domain index.
- **Acceptance Criteria:**
  - Table: `gh_browser_sessions` with columns: id (UUID PK), user_id (TEXT), domain (TEXT), encrypted_state (BYTEA), encryption_iv (BYTEA), created_at, updated_at, expires_at, last_used
  - Index on (user_id, domain) for fast lookup
  - RLS policy: users can only access their own sessions
  - Table uses `gh_` prefix
  - Migration is idempotent
  - Migration file: `010_create_browser_sessions.sql`
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/db/migrations/010_create_browser_sessions.sql` (NEW)
- **Estimated Effort:** S

---

#### GH-002: Implement SessionManager (storageState export/import/encrypt)

- **Epic:** E1 - Session Persistence
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [backend] [worker]
- **Description:** After a successful job, export the browser's storageState (cookies + localStorage) using Playwright's `context.storageState()`. Encrypt it using AES-256-GCM with a per-user encryption key derived from GH_ENCRYPTION_KEY. Store in `gh_browser_sessions` table keyed by (user_id, domain). On next job for same user+domain, inject the stored state via `browser.newContext({ storageState })`. Includes TTL management and session invalidation.
- **Acceptance Criteria:**
  - `SessionManager.save(userId, domain, context)` exports and encrypts storageState
  - `SessionManager.load(userId, domain)` decrypts and returns storageState or null
  - `SessionManager.invalidate(userId, domain)` deletes stored session
  - Encryption: AES-256-GCM with per-user key derived from GH_ENCRYPTION_KEY + userId
  - Stored in `gh_browser_sessions` table (from GH-001)
  - TTL: sessions expire after 7 days (configurable)
  - Inject into Playwright: `browser.newContext({ storageState: loaded })`
  - Session loaded before browser navigates to target URL
  - Handles expired/corrupted sessions gracefully (delete and start fresh)
- **Dependencies:** GH-001
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/SessionManager.ts` (NEW)
- **Estimated Effort:** L

---

#### GH-003: Wire SessionManager into JobExecutor

- **Epic:** E1 - Session Persistence
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [backend] [worker]
- **Description:** Modify JobExecutor to load stored sessions before creating the browser context, and save sessions after successful jobs. Add `storageState` support to `AdapterStartOptions` so the adapter can inject it during `browser.newContext()`. Update `MagnitudeAdapter.start()` to pass storageState to Playwright/Patchright.
- **Acceptance Criteria:**
  - `AdapterStartOptions` gains optional `storageState?: object` field
  - `MagnitudeAdapter.start()` passes `storageState` to `browser.newContext({ storageState })`
  - `JobExecutor` loads session via `SessionManager.load(userId, domain)` before `adapter.start()`
  - On successful job completion: `SessionManager.save(userId, domain, adapter.page.context())`
  - On failed job: no session save (avoid persisting bad state)
  - Domain extracted from `target_url` (e.g., `new URL(target_url).hostname`)
  - `userId` from `job.valet_user_id` or `job.user_id`
  - Falls back gracefully if no session exists (fresh context)
- **Dependencies:** GH-002
- **Files to Create/Modify:**
  - `packages/ghosthands/src/adapters/types.ts` (MODIFY — add storageState to AdapterStartOptions)
  - `packages/ghosthands/src/adapters/magnitude.ts` (MODIFY — pass storageState)
  - `packages/ghosthands/src/workers/JobExecutor.ts` (MODIFY — load/save sessions)
- **Estimated Effort:** M

---

#### GH-004: Session persistence tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [test]
- **Description:** Unit and integration tests for the full session persistence flow.
- **Acceptance Criteria:**
  - Unit test: SessionManager.save() encrypts and stores
  - Unit test: SessionManager.load() decrypts and returns
  - Unit test: SessionManager.load() returns null for expired sessions
  - Unit test: SessionManager.invalidate() deletes session
  - Integration test: save session -> load on next job -> browser starts with cookies
  - Mock Supabase client, mock crypto for unit tests
  - Mock Playwright context for storageState export
- **Dependencies:** GH-002, GH-003
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/engine/sessionManager.test.ts` (NEW)
  - `packages/ghosthands/__tests__/integration/session/sessionPersistence.test.ts` (NEW)
- **Estimated Effort:** M

---

### Epic E2: HITL Pause/Resume (P0 — Sprint 1)

---

#### GH-005: DB migration 009 — add interaction columns to gh_automation_jobs

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [db]
- **Description:** Add columns to `gh_automation_jobs` for HITL interaction tracking: `interaction_type` (captcha, 2fa, login, bot_check), `interaction_data` (JSONB with screenshot, description, etc.), and `paused_at` (timestamp). These columns support the pause/resume HITL flow.
- **Acceptance Criteria:**
  - Migration adds `interaction_type TEXT DEFAULT NULL`
  - Migration adds `interaction_data JSONB DEFAULT NULL`
  - Migration adds `paused_at TIMESTAMPTZ DEFAULT NULL`
  - Migration is idempotent (uses `ADD COLUMN IF NOT EXISTS`)
  - Table name uses `gh_` prefix
  - Migration file: `009_add_interaction_columns.sql`
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/db/migrations/009_add_interaction_columns.sql` (NEW)
- **Estimated Effort:** S

---

#### GH-006: Expose pause/resume on BrowserAutomationAdapter

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [adapter]
- **Description:** Add optional `pause()`, `resume()`, and `paused` to the BrowserAutomationAdapter interface. Implement in MagnitudeAdapter by forwarding to the underlying Magnitude Agent's native `pause()`/`resume()` methods (which are cooperative: finish current action, block before next). MockAdapter should implement with simple flag toggling. This is a 3-line change per adapter — Magnitude-core 0.3.1 already has native pause/resume.
- **Acceptance Criteria:**
  - `BrowserAutomationAdapter` interface gains: `pause?(): Promise<void>`, `resume?(): Promise<void>`, `paused?: boolean`
  - `MagnitudeAdapter.pause()` calls `this.agent.pause()`
  - `MagnitudeAdapter.resume()` calls `this.agent.resume()`
  - `MagnitudeAdapter.paused` returns `this.agent.paused`
  - `MockAdapter` implements with boolean flag
  - Existing code continues working (methods are optional)
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/adapters/types.ts` (MODIFY)
  - `packages/ghosthands/src/adapters/magnitude.ts` (MODIFY)
  - `packages/ghosthands/src/adapters/mock.ts` (MODIFY)
- **Estimated Effort:** S

---

#### GH-007: Extend CallbackNotifier for needs_human status

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [worker] [api]
- **Description:** Extend the existing CallbackNotifier to support a `needs_human` status in addition to `completed` and `failed`. Add a `notifyInteraction()` method that sends the HITL callback payload including interaction reason, screenshot URL, current URL, paused_at, expires_at, and timeout_seconds.
- **Acceptance Criteria:**
  - `CallbackPayload.status` type expanded to `'completed' | 'failed' | 'needs_human'`
  - New `HumanInteractionPayload` type with interaction details
  - `CallbackNotifier.notifyInteraction(callbackUrl, payload)` sends HITL notification
  - Payload matches the contract in VALET-INTEGRATION-CONTRACT-007.md
  - Retry logic (3 attempts) applies to interaction notifications too
  - Callback failures logged but never crash the worker
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/workers/callbackNotifier.ts` (MODIFY)
- **Estimated Effort:** S

---

#### GH-008: Add resume API endpoint (POST /valet/resume/:jobId)

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [api]
- **Description:** Add a new endpoint `POST /api/v1/gh/valet/resume/:jobId` that VALET calls after a human resolves a blocker. Accepts `action: "resume" | "cancel"`, optional `resolution` and `notes`. Verifies job is actually paused (409 if not). On resume: sends Postgres NOTIFY on `gh_job_resume` channel. On cancel: updates job to cancelled. Logs interaction event.
- **Acceptance Criteria:**
  - Endpoint: `POST /api/v1/gh/valet/resume/:jobId`
  - Request body: `{ action: "resume" | "cancel", resolution?: string, notes?: string }`
  - Returns 200 with `{ job_id, status: "running" | "cancelled", resumed_at? }`
  - Returns 404 if job not found
  - Returns 409 if job is not in 'paused' status
  - On resume: executes `NOTIFY gh_job_resume, '<jobId>'`
  - On cancel: updates job status to 'cancelled' with completed_at
  - Logs `human_resumed` or `human_cancelled` event to `gh_job_events`
  - Protected by same auth middleware as other VALET routes
- **Dependencies:** GH-005
- **Files to Create/Modify:**
  - `packages/ghosthands/src/api/routes/valet.ts` (MODIFY)
  - `packages/ghosthands/src/api/schemas/valet.ts` (MODIFY — add resume schema)
- **Estimated Effort:** M

---

#### GH-009: Implement blocker detection (DOM patterns + error classification)

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [backend]
- **Description:** Implement blocker detection at two levels: (1) DOM pattern matching for CAPTCHA iframes, 2FA inputs, bot check divs, login forms; (2) Thought pattern matching from agent events for phrases like "I see a CAPTCHA". Returns a `BlockerDetection` object with type, confidence, description. Integrates with existing `ERROR_CLASSIFICATIONS` in JobExecutor.
- **Acceptance Criteria:**
  - `BlockerDetector.detect(page)` returns `BlockerDetection[]`
  - DOM patterns: `iframe[src*="recaptcha"]`, `.h-captcha`, `#captcha`, `input[name*="otp"]`, `form[action*="login"]`, `.cf-browser-verification`, etc.
  - Thought patterns: regex matching on agent thought events for CAPTCHA, 2FA, login, bot check keywords
  - Confidence scoring: exact match = 0.9, partial match = 0.6
  - Blocker types: captcha, 2fa, login, bot_check, screening_question
  - Integrates with existing ERROR_CLASSIFICATIONS patterns in JobExecutor
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/blockerDetector.ts` (NEW)
- **Estimated Effort:** M

---

#### GH-010: Wire requestHumanIntervention in JobExecutor + Postgres LISTEN

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [worker]
- **Description:** Implement the `requestHumanIntervention()` method in JobExecutor that: (1) pauses the agent via adapter.pause(), (2) takes a screenshot, (3) updates job status to 'paused' with interaction columns, (4) sends needs_human callback to VALET, (5) waits for resume signal via Postgres LISTEN on `gh_job_resume` channel (or timeout after 5 minutes), (6) on resume: calls adapter.resume(), on cancel/timeout: fails/cancels job. Also implement Postgres LISTEN mechanism with a dedicated pg connection. Modify error handling to route captcha_blocked, login_required, and 2fa_required errors to HITL instead of retry.
- **Acceptance Criteria:**
  - `requestHumanIntervention(job, adapter, blocker, progress)` returns `'resumed' | 'cancelled' | 'timeout'`
  - Calls `adapter.pause()` (keeps browser alive, stops action loop)
  - Takes screenshot via `adapter.screenshot()` and uploads to Supabase storage
  - Updates `gh_automation_jobs`: status='paused', interaction_type, interaction_data, paused_at
  - Sends `needs_human` callback via CallbackNotifier.notifyInteraction()
  - Worker creates a dedicated pg connection for LISTEN (separate from pool)
  - Subscribes to `gh_job_resume` channel, listens for this job's ID
  - Timeout: 5 minutes (configurable), resolves as 'timeout'
  - On 'resumed': calls `adapter.resume()`, updates status back to 'running'
  - On 'timeout': fails job with error_code 'human_timeout'
  - On 'cancelled': cancels job with error_code 'human_cancelled'
  - Error classification updated: captcha_blocked and login_required route to HITL instead of retry queue
- **Dependencies:** GH-005, GH-006, GH-007, GH-008, GH-009
- **Files to Create/Modify:**
  - `packages/ghosthands/src/workers/JobExecutor.ts` (MODIFY)
  - `packages/ghosthands/src/db/pgListener.ts` (NEW — reusable LISTEN helper)
- **Estimated Effort:** XL

---

#### GH-011: Update VALET status endpoint with interaction info

- **Epic:** E2 - HITL Pause/Resume
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [api]
- **Description:** Update the `GET /api/v1/gh/valet/status/:jobId` endpoint to include interaction details when a job is in 'paused' status.
- **Acceptance Criteria:**
  - Status response includes `interaction` object when `status === 'paused'`
  - Interaction object contains: reason, description, screenshot_url, current_url, paused_at, expires_at, timeout_seconds
  - Response matches the contract in VALET-INTEGRATION-CONTRACT-007.md
  - No changes to response format when status is not 'paused'
- **Dependencies:** GH-005, GH-010
- **Files to Create/Modify:**
  - `packages/ghosthands/src/api/routes/valet.ts` (MODIFY)
- **Estimated Effort:** S

---

#### GH-012: HITL unit and integration tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [test]
- **Description:** Tests for the full HITL flow: blocker detection, pause, callback, resume endpoint, and worker resume handling.
- **Acceptance Criteria:**
  - Unit test: blocker detection DOM patterns (CAPTCHA, 2FA, login, bot check)
  - Unit test: blocker detection thought patterns
  - Unit test: CallbackNotifier.notifyInteraction() payload construction
  - Unit test: resume endpoint validation (404, 409, success)
  - Integration test: full pause -> notify -> resume flow with MockAdapter
  - Integration test: pause -> timeout -> fail flow
  - Integration test: pause -> cancel flow
  - Mock Postgres LISTEN/NOTIFY for worker-side tests
- **Dependencies:** GH-005 through GH-011
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/engine/blockerDetector.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/workers/callbackNotifier.test.ts` (NEW)
  - `packages/ghosthands/__tests__/integration/hitl/pauseResume.test.ts` (NEW)
- **Estimated Effort:** L

---

### Epic E3: Stagehand Integration (P0 — Sprint 2)

---

#### GH-013: Install and configure Stagehand as a dependency

- **Epic:** E3 - Stagehand Integration
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend] [setup]
- **Description:** Install `@browserbasehq/stagehand` as a dependency. Configure it to share the browser with Magnitude via CDP. Stagehand v3 uses CDP directly and can attach to an existing browser via `cdpUrl`. The recommended pattern: Magnitude owns the browser (via Patchright), we extract the CDP WebSocket URL, and Stagehand attaches for observation only.
- **Key Decision:** Magnitude owns the browser, Stagehand attaches via CDP for `observe()` calls only. This avoids two libraries fighting over browser lifecycle.
- **Acceptance Criteria:**
  - `@browserbasehq/stagehand` added to `packages/ghosthands/package.json`
  - `StagehandObserver` class created: wraps Stagehand instance lifecycle
  - Constructor accepts `cdpUrl` and LLM config (uses cheapest provider — Qwen VL or DeepSeek)
  - `init()` creates Stagehand instance with `{ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl } }`
  - `observe(instruction)` calls `stagehand.observe(instruction)` and returns `ObservedElement[]`
  - `stop()` tears down Stagehand instance (does NOT close the browser — Magnitude owns it)
  - Maps Stagehand's `Action[]` return type to our existing `ObservedElement` interface
  - Handles Stagehand issue #1392 gracefully (if external CDP page resolution fails, fall back to basic DOM analysis)
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/package.json` (MODIFY — add @browserbasehq/stagehand)
  - `packages/ghosthands/src/engine/StagehandObserver.ts` (NEW)
- **Estimated Effort:** L

---

#### GH-014: Build PageObserver using Stagehand observe()

- **Epic:** E3 - Stagehand Integration
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend] [connector]
- **Description:** Implement PageObserver that uses StagehandObserver for element discovery and enriches it with lightweight DOM analysis for platform detection and URL pattern generation. Does NOT rebuild the full Accessibility Tree parser — delegates that to Stagehand. Adds platform detection (Workday, Greenhouse, Lever, etc.) via URL and DOM heuristics, page type detection (login, form, confirmation), and structural fingerprinting for cookbook matching.
- **Acceptance Criteria:**
  - `PageObserver.observe(page, stagehandObserver?)` returns a `PageObservation` object
  - Uses `StagehandObserver.observe("find all interactive elements")` for element discovery when available
  - Falls back to basic DOM analysis (`page.$$eval`) when Stagehand is not available (e.g., in tests)
  - Platform detection for: workday, greenhouse, lever, icims, taleo, smartrecruiters, linkedin, other (via URL patterns and DOM markers)
  - Page type detection: login, form, multi-step, confirmation, error, unknown
  - URL pattern generation: `"*.myworkdayjobs.com/*/apply/*"` from specific URLs
  - Structure fingerprint: deterministic hash of DOM structure for cookbook matching
  - Includes blocker detection (delegates to BlockerDetector from GH-009)
  - Zero LLM calls from PageObserver itself (Stagehand makes its own LLM calls internally)
- **Dependencies:** GH-013, GH-009
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/PageObserver.ts` (NEW)
- **Estimated Effort:** L

---

#### GH-015: Implement MagnitudeAdapter.observe() via Stagehand

- **Epic:** E3 - Stagehand Integration
- **Priority:** P1 (high)
- **Labels:** [sprint-2] [adapter]
- **Description:** Implement the optional `observe()` method on MagnitudeAdapter that delegates to StagehandObserver. The adapter interface already defines `observe?()` returning `ObservedElement[]`. When StagehandObserver is configured, MagnitudeAdapter.observe() passes the instruction through to Stagehand.
- **Acceptance Criteria:**
  - `MagnitudeAdapter` gains a `setObserver(observer: StagehandObserver)` method
  - `MagnitudeAdapter.observe(instruction)` delegates to `stagehandObserver.observe(instruction)`
  - Returns `ObservedElement[]` matching the existing interface
  - Returns `undefined` if no StagehandObserver configured (graceful degradation)
  - `MockAdapter.observe()` continues returning mock data (already implemented)
- **Dependencies:** GH-013
- **Files to Create/Modify:**
  - `packages/ghosthands/src/adapters/magnitude.ts` (MODIFY — add observe())
- **Estimated Effort:** S

---

#### GH-016: Stagehand integration tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [test]
- **Description:** Tests for Stagehand integration: observer initialization, observe() calls, mapping to ObservedElement, fallback behavior.
- **Acceptance Criteria:**
  - Unit test: StagehandObserver initialization with cdpUrl
  - Unit test: observe() maps Stagehand Action[] to ObservedElement[]
  - Unit test: graceful fallback when Stagehand connection fails
  - Unit test: PageObserver works without Stagehand (DOM-only fallback)
  - Integration test: StagehandObserver with mock CDP endpoint
- **Dependencies:** GH-013, GH-014
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/engine/stagehandObserver.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/pageObserver.test.ts` (NEW)
- **Estimated Effort:** M

---

### Epic E4: ActionBook Integration (P0 — Sprint 2)

---

#### GH-017: Install ActionBook SDK and build ActionBookConnector

- **Epic:** E4 - ActionBook Integration
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend] [connector]
- **Description:** Install `@actionbookdev/sdk` and create an `ActionBookConnector` that implements `AgentConnector`. On task start, queries ActionBook's API for existing manuals for the current URL/domain. If found, converts ActionBook's `ParsedElements` format to GhostHands cookbook format and seeds `gh_action_manuals`. The connector provides `actionbook:lookup` and `actionbook:get-manual` actions to the Magnitude agent.
- **Key Mapping:** ActionBook `css_selector` → our `LocatorDescriptor.css`, `allow_methods` → `action`, `description` → step description, `depends_on` → step ordering.
- **Acceptance Criteria:**
  - `@actionbookdev/sdk` added to `packages/ghosthands/package.json`
  - `ActionBookConnector` implements `AgentConnector` with `id = 'actionbook'`
  - `getActionSpace()` provides: `actionbook:lookup`, `actionbook:get-manual`
  - `actionbook:lookup` calls `client.searchActions({ query, url, domain })` to find manuals
  - `actionbook:get-manual` calls `client.getActionByAreaId(areaId)` to get full details
  - `convertToManual(actionDetail)` maps ActionBook format to GhostHands `ActionManual`
  - `getInstructions()` tells agent to check ActionBook before exploring
  - Reads API key from `ACTIONBOOK_API_KEY` env var (optional — open beta works without)
  - Falls back gracefully when ActionBook has no manual for a URL (returns empty)
  - Uses legacy JSON API (`searchActionsLegacy`) for structured data, not text API
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/package.json` (MODIFY — add @actionbookdev/sdk)
  - `packages/ghosthands/src/connectors/actionbookConnector.ts` (NEW)
  - `packages/ghosthands/src/connectors/index.ts` (NEW or MODIFY)
- **Estimated Effort:** L

---

#### GH-018: Seed cookbooks from ActionBook on first encounter

- **Epic:** E4 - ActionBook Integration
- **Priority:** P1 (high)
- **Labels:** [sprint-2] [backend]
- **Description:** When ExecutionEngine encounters a URL with no existing cookbook in `gh_action_manuals`, query ActionBook before falling through to expensive AI exploration. If ActionBook has a manual, convert it and seed `gh_action_manuals` with health_score=80 (not 100 — pre-built manuals may not match exact site version). This provides a "cold start" solution.
- **Acceptance Criteria:**
  - ExecutionEngine checks ActionBook before AI fallback (observe → lookup local cookbook → lookup ActionBook → AI agent)
  - ActionBook manual converted to GhostHands format with health_score=80
  - Seeded manual stored in `gh_action_manuals` with source='actionbook'
  - `ActionManual` type gains optional `source` field: 'recorded' | 'actionbook' | 'template'
  - On subsequent runs, local cookbook is used (ActionBook not re-queried)
  - If ActionBook lookup fails (network, no results), silently falls through to AI
- **Dependencies:** GH-017, GH-025 (ManualStore)
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/ExecutionEngine.ts` (MODIFY — add ActionBook lookup step)
  - `packages/ghosthands/src/engine/types.ts` (MODIFY — add source field)
- **Estimated Effort:** M

---

#### GH-019: ActionBook integration tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P1 (high)
- **Labels:** [sprint-2] [test]
- **Description:** Tests for ActionBook connector and cookbook seeding.
- **Acceptance Criteria:**
  - Unit test: ActionBookConnector.searchActions() with mocked SDK
  - Unit test: convertToManual() format mapping
  - Unit test: fallback when ActionBook returns no results
  - Unit test: API key configuration (with and without)
  - Integration test: seed cookbook from ActionBook -> replay via CookbookExecutor
- **Dependencies:** GH-017, GH-018
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/connectors/actionbookConnector.test.ts` (NEW)
  - `packages/ghosthands/__tests__/integration/engine/actionbookSeed.test.ts` (NEW)
- **Estimated Effort:** M

---

### Epic E5: Resilient Cookbooks (P0 — Sprint 2)

---

#### GH-020: Define LocatorDescriptor types and interfaces

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend]
- **Description:** Define the core TypeScript types for multi-strategy element identification. A `LocatorDescriptor` stores multiple ways to find a single element (testId, ARIA role+name, ariaLabel, name, id, text, CSS, XPath) so that if one strategy breaks, others provide fallback. Also define `ManualStep`, `ActionManual`, `PageObservation`, and related interfaces.
- **Acceptance Criteria:**
  - `LocatorDescriptor` type with fields: testId, role+name, ariaLabel, name, id, text, css, xpath, each optional
  - `ManualStep` type with: order, locator (LocatorDescriptor), action, value, description, waitAfter, verification, healthScore
  - `ActionManual` type matching the `gh_action_manuals` schema (id, url_pattern, task_pattern, platform, steps, health_score, source)
  - `PageObservation` type with: url, platform, pageType, fingerprint, forms, buttons, navigation, urlPattern, structureHash
  - `FormObservation`, `FieldObservation`, `ButtonObservation`, `NavObservation` subtypes
  - `BlockerDetection` type with: type, confidence, screenshot, description, selectors
  - All types exported from `src/engine/types.ts`
  - Types use Zod schemas for runtime validation where needed
- **Dependencies:** None
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/types.ts` (NEW)
  - `packages/ghosthands/src/engine/index.ts` (NEW)
- **Estimated Effort:** S

---

#### GH-021: Build LocatorResolver (multi-strategy element finder)

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend]
- **Description:** Implement a LocatorResolver that takes a `LocatorDescriptor` and resolves it to a Playwright `Locator` by trying strategies in priority order: testId > ARIA role+name > ariaLabel > name > id > text > CSS > XPath. If the primary strategy fails, it tries the next. Tracks which strategy succeeded for health scoring.
- **Acceptance Criteria:**
  - `LocatorResolver.resolve(page, descriptor)` returns `{ locator: Locator | null, strategy: string, attempts: number }`
  - Tries strategies in defined priority order
  - Falls back to Playwright semantic locators if attribute-based strategies fail
  - Returns metadata about which strategy worked (for health score updates)
  - Handles stale elements gracefully (retry once on StaleElementReference)
  - Timeout per resolution attempt (default 3s)
- **Dependencies:** GH-020
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/LocatorResolver.ts` (NEW)
- **Estimated Effort:** M

---

#### GH-022: Build TraceRecorder (action event to locator recording)

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend]
- **Description:** Implement a TraceRecorder that hooks into Magnitude's adapter events (`actionStarted`, `actionDone`, `thought`) and records each action as a `ManualStep` with a full `LocatorDescriptor`. Since Magnitude uses pixel coordinates (x,y), TraceRecorder must use `document.elementFromPoint(x,y)` reverse lookup to find the actual DOM element, then extract all possible locator strategies for it.
- **Acceptance Criteria:**
  - `TraceRecorder` subscribes to adapter events
  - On `actionDone`, performs `elementFromPoint(x,y)` to find the target element
  - Extracts all locator strategies from the found element into a `LocatorDescriptor`
  - Records action type, value, description from Magnitude's event data
  - Template detection: if typed value matches a known user_data field value, stores `{{field_name}}` instead
  - `getTrace()` returns an ordered list of `ManualStep`s
  - Handles page navigation between steps (records navigation steps)
- **Dependencies:** GH-020
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/TraceRecorder.ts` (NEW)
- **Estimated Effort:** L

---

#### GH-023: Build ManualStore (Supabase CRUD for cookbooks)

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend] [db]
- **Description:** Implement ManualStore with CRUD operations against the existing `gh_action_manuals` table. Supports lookup by URL pattern + task type + optional platform, saving new manuals from traces, recording success/failure (health score adjustments), and retrieval by ID.
- **Acceptance Criteria:**
  - `ManualStore.lookup(url, taskType, platform?)` returns best-matching manual or null
  - URL matching uses pattern comparison
  - `saveFromTrace(trace, metadata)` converts a TraceRecorder trace into an ActionManual and inserts it
  - `saveFromActionBook(actionDetail, metadata)` converts ActionBook result and inserts with source='actionbook'
  - `recordSuccess(manualId)` increments success_count, recalculates health_score, updates last_used
  - `recordFailure(manualId)` increments failure_count, degrades health_score
  - Health score formula: starts at 100 (recorded) or 80 (actionbook), -5 per failure (-15 after 5+ failures), +2 per success (capped at 100)
  - All queries use the `gh_action_manuals` table name
  - Uses Supabase client passed via constructor (dependency injection for testability)
- **Dependencies:** GH-020
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/ManualStore.ts` (NEW)
- **Estimated Effort:** M

---

#### GH-024: Build CookbookExecutor (deterministic step replay)

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [backend]
- **Description:** Implement CookbookExecutor that replays a cookbook's steps using LocatorResolver for element finding and direct Playwright actions for execution. Supports template substitution (`{{first_name}}` -> actual value from user data), step verification, and per-step error reporting. No LLM calls.
- **Acceptance Criteria:**
  - `CookbookExecutor.executeAll(page, manual, userData)` replays all steps, returns `{ success, failedStepIndex?, error? }`
  - `CookbookExecutor.executeStep(page, step, userData)` replays a single step
  - Template substitution: `{{key}}` in step values replaced with `userData[key]`
  - Uses LocatorResolver for element finding (multi-strategy)
  - Supported actions: click, type, select, wait, navigate, scroll
  - Step verification: checks verification condition after each step
  - Returns detailed failure info (step index, error message, attempted selectors)
  - Zero LLM calls
- **Dependencies:** GH-020, GH-021
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/CookbookExecutor.ts` (NEW)
  - `packages/ghosthands/src/engine/templateResolver.ts` (NEW)
- **Estimated Effort:** L

---

#### GH-025: Unit tests for Cookbook Foundation components

- **Epic:** E11 - Test Infrastructure
- **Priority:** P0 (critical)
- **Labels:** [sprint-2] [test]
- **Description:** Write comprehensive unit tests for all cookbook components following TDD.
- **Acceptance Criteria:**
  - Tests for LocatorDescriptor type validation
  - Tests for LocatorResolver: strategy priority, fallback behavior, timeout handling, stale element retry
  - Tests for TraceRecorder: event subscription, elementFromPoint recording, template detection, trace output
  - Tests for ManualStore: lookup matching, save, success/failure recording, health score calculation
  - Tests for CookbookExecutor: step replay, template substitution, verification, failure reporting
  - Tests for templateResolver: variable substitution, missing variables, nested values
  - >80% line coverage for all engine/ files
  - All tests use `bun:test` framework
  - Mock Supabase client for ManualStore tests
  - Mock Playwright Page for resolver/executor tests
- **Dependencies:** GH-020 through GH-024
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/engine/types.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/locatorResolver.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/traceRecorder.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/manualStore.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/cookbookExecutor.test.ts` (NEW)
  - `packages/ghosthands/__tests__/unit/engine/templateResolver.test.ts` (NEW)
- **Estimated Effort:** L

---

### Epic E6: Execution Engine (P0 — Sprint 3)

---

#### GH-026: Build CookbookConnector (AgentConnector implementation)

- **Epic:** E6 - Execution Engine
- **Priority:** P0 (critical)
- **Labels:** [sprint-3] [backend] [connector]
- **Description:** Implement CookbookConnector that implements Magnitude's `AgentConnector` interface. When the Magnitude agent IS running (agent path), CookbookConnector injects cookbook awareness into the agent's context. `collectObservations()` returns current page state and cookbook availability. `getActionSpace()` provides `cookbook:try-step`, `cookbook:skip-step`, and `file:upload`.
- **Acceptance Criteria:**
  - `CookbookConnector` implements `AgentConnector` with `id = 'cookbook'`
  - `collectObservations()` returns page observation + cookbook step info
  - `getActionSpace()` returns: `cookbook:try-step`, `cookbook:skip-step`, `file:upload`
  - `cookbook:try-step` resolver calls CookbookExecutor.executeStep and advances step index
  - `file:upload` resolver calls FileUploadHelper
  - `getInstructions()` returns contextual prompt guiding the agent to prefer cookbook steps
  - Constructor accepts: ManualStore, CookbookExecutor, PageObserver, ActionBookConnector, current manual (nullable), user data
- **Dependencies:** GH-014, GH-023, GH-024, GH-028
- **Files to Create/Modify:**
  - `packages/ghosthands/src/connectors/cookbookConnector.ts` (NEW)
  - `packages/ghosthands/src/connectors/index.ts` (MODIFY)
- **Estimated Effort:** L

---

#### GH-027: Build ExecutionEngine (observe, decide, execute, learn)

- **Epic:** E6 - Execution Engine
- **Priority:** P0 (critical)
- **Labels:** [sprint-3] [backend] [worker]
- **Description:** Implement ExecutionEngine that orchestrates the full hybrid execution flow: (1) Observe page via PageObserver, (2) Lookup cookbook via ManualStore, (2b) If no local cookbook, check ActionBook, (3a) Fast path if healthy cookbook exists (CookbookExecutor replays without LLM), (3b) Agent path if no cookbook or cookbook fails (Magnitude with CookbookConnector), (4) Learn from successful AI traces (save as new cookbook).
- **Acceptance Criteria:**
  - `ExecutionEngine.execute(ctx: TaskContext)` returns `TaskResult`
  - Lookup order: local manual → ActionBook → AI agent
  - Respects `execution_mode`: `"auto"` (default hybrid), `"ai_only"` (skip cookbook), `"cookbook_only"` (no AI fallback)
  - Fast path: healthy cookbook (health_score >= 70) replays all steps without LLM
  - Agent path: invokes adapter.act() with CookbookConnector + ActionBookConnector attached
  - On fast path success: records success on manual
  - On fast path failure: records failure, falls through to agent path
  - On agent path success with trace: saves trace as new/updated cookbook
  - Returns result with `mode` field (cookbook/ai/hybrid/actionbook) and cost data
  - Does NOT use LLM for mode selection (pure programmatic decision)
- **Dependencies:** GH-014, GH-017, GH-022, GH-023, GH-024, GH-026
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/ExecutionEngine.ts` (NEW)
- **Estimated Effort:** XL

---

#### GH-028: Build FileUploadHelper (filechooser + setInputFiles)

- **Epic:** E7 - File Upload
- **Priority:** P1 (high)
- **Labels:** [sprint-3] [backend] [worker]
- **Description:** Implement FileUploadHelper that handles OS-level file picker dialogs using Playwright's `page.on('filechooser')` event interception. Supports three upload patterns: direct `<input type="file">` via `setInputFiles`, custom button triggers via filechooser interception, and drag-and-drop zones. The resume file should be downloaded/prepared BEFORE the browser encounters the upload field.
- **Acceptance Criteria:**
  - `FileUploadHelper.uploadFile(page, selector, filePath)` handles `<input type="file">` and button-triggered pickers
  - `FileUploadHelper.uploadBuffer(page, selector, buffer, filename)` handles cloud-stored files
  - `FileUploadHelper.uploadViaDragDrop(page, dropZoneSelector, filePath)` handles drag-drop zones
  - Filechooser dialog is intercepted at CDP level (never opens OS dialog)
  - Supports PDF, DOCX, DOC file types
  - Integrates with existing `ResumeDownloader`
  - File size validation (max 10MB)
- **Dependencies:** GH-020
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/FileUploadHelper.ts` (NEW)
- **Estimated Effort:** M

---

#### GH-029: Wire ExecutionEngine into TaskHandlers

- **Epic:** E6 - Execution Engine
- **Priority:** P0 (critical)
- **Labels:** [sprint-3] [backend] [worker]
- **Description:** Modify ApplyHandler, ScrapeHandler, and FillFormHandler to use ExecutionEngine instead of calling adapter.act() directly. Update JobExecutor to instantiate engine components (including SessionManager, StagehandObserver, ActionBookConnector) and pass them via context.
- **Acceptance Criteria:**
  - `TaskContext` gains optional `engine?: ExecutionEngine` field
  - `ApplyHandler.execute()` uses `ctx.engine.execute(ctx)` when engine is available
  - `ScrapeHandler` and `FillFormHandler` similarly use engine
  - `CustomHandler` continues using `adapter.act()` directly (no change)
  - `JobExecutor` creates SessionManager, StagehandObserver, ActionBookConnector, PageObserver, ManualStore, CookbookExecutor, TraceRecorder, ExecutionEngine and passes via context
  - Engine is opt-in: handlers fall back to adapter.act() if no engine in context
- **Dependencies:** GH-027
- **Files to Create/Modify:**
  - `packages/ghosthands/src/workers/taskHandlers/types.ts` (MODIFY)
  - `packages/ghosthands/src/workers/taskHandlers/applyHandler.ts` (MODIFY)
  - `packages/ghosthands/src/workers/taskHandlers/scrapeHandler.ts` (MODIFY)
  - `packages/ghosthands/src/workers/taskHandlers/fillFormHandler.ts` (MODIFY)
  - `packages/ghosthands/src/workers/JobExecutor.ts` (MODIFY)
- **Estimated Effort:** L

---

#### GH-030: Integration tests for ExecutionEngine

- **Epic:** E11 - Test Infrastructure
- **Priority:** P0 (critical)
- **Labels:** [sprint-3] [test]
- **Description:** Integration tests verifying the full engine flow including ActionBook integration.
- **Acceptance Criteria:**
  - Test: fast path success (healthy cookbook, all steps pass, no LLM)
  - Test: fast path failure -> agent path fallback
  - Test: ActionBook seed -> cookbook replay (cold start scenario)
  - Test: agent path with no cookbook (pure AI, trace recorded)
  - Test: agent path success -> trace saved as new cookbook
  - Test: `execution_mode: "ai_only"` bypasses cookbook
  - Test: `execution_mode: "cookbook_only"` no AI fallback on failure
  - Test: unhealthy cookbook (health < 70) goes to agent path
  - Uses MockAdapter with scripted responses
  - Uses in-memory ManualStore mock
  - Uses mocked ActionBook SDK
- **Dependencies:** GH-027, GH-029
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/integration/engine/executionEngine.test.ts` (NEW)
  - `packages/ghosthands/__tests__/integration/engine/cookbookConnector.test.ts` (NEW)
- **Estimated Effort:** L

---

### Sprint 4: Optimization & Polish

---

#### GH-031: Implement health scores with per-step granularity

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [backend]
- **Description:** Enhance the health scoring system to track health per step (not just per cookbook). Steps that consistently fail get flagged for re-exploration.
- **Acceptance Criteria:**
  - `ManualStep` gains `health_score: number` field (default 100)
  - `CookbookExecutor` reports per-step success/failure
  - Overall cookbook health_score = min of all step health_scores
  - Steps with health < 30 are flagged as "needs re-exploration"
- **Dependencies:** GH-023, GH-024
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/ManualStore.ts` (MODIFY)
  - `packages/ghosthands/src/engine/CookbookExecutor.ts` (MODIFY)
  - `packages/ghosthands/src/engine/types.ts` (MODIFY)
- **Estimated Effort:** M

---

#### GH-032: Implement self-healing selectors (auto-promote fallbacks)

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [backend]
- **Description:** When a primary locator strategy fails but a fallback succeeds, automatically promote the fallback to primary position. Track strategy success rates over time.
- **Acceptance Criteria:**
  - LocatorResolver tracks which strategy succeeded for each resolution
  - On fallback success: reorder strategies in the LocatorDescriptor (promote working one)
  - ManualStore persists updated strategy order
  - Auto-healing happens transparently during cookbook replay
  - Healing events logged to `gh_job_events` for telemetry
- **Dependencies:** GH-021, GH-024, GH-031
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/LocatorResolver.ts` (MODIFY)
  - `packages/ghosthands/src/engine/ManualStore.ts` (MODIFY)
- **Estimated Effort:** M

---

#### GH-033: Template detection and variable extraction

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [backend]
- **Description:** Build intelligent template detection that auto-detects which values in a recorded trace should become `{{template_variables}}`.
- **Acceptance Criteria:**
  - Direct match: typed value exactly matches a user_data field -> `{{field_name}}`
  - Pattern match: email -> `{{email}}`, phone -> `{{phone}}`, LinkedIn URL -> `{{linkedin_url}}`
  - Multi-word fields: "John Smith" matches `{{first_name}} {{last_name}}`
  - Template variables are validated on substitution
- **Dependencies:** GH-022
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/TraceRecorder.ts` (MODIFY)
  - `packages/ghosthands/src/engine/templateResolver.ts` (MODIFY)
- **Estimated Effort:** M

---

#### GH-034: Multi-step form navigation

- **Epic:** E5 - Resilient Cookbooks
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [backend]
- **Description:** Enhance CookbookExecutor to handle multi-page application forms (Workday has 3-5 pages). Steps can include `navigate` actions that click "Next" buttons, wait for page transitions, and continue.
- **Acceptance Criteria:**
  - ManualStep supports `pageIndex` field for multi-page tracking
  - CookbookExecutor handles page navigation between step groups
  - Waits for page transition (URL change or DOM change) after navigation steps
  - Cookbook replay resumes from correct page after failure/retry
- **Dependencies:** GH-024, GH-022
- **Files to Create/Modify:**
  - `packages/ghosthands/src/engine/CookbookExecutor.ts` (MODIFY)
  - `packages/ghosthands/src/engine/TraceRecorder.ts` (MODIFY)
  - `packages/ghosthands/src/engine/types.ts` (MODIFY)
- **Estimated Effort:** L

---

#### GH-035: Performance benchmarks (cost, speed, LLM calls)

- **Epic:** E8 - Metrics & Polish
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [test]
- **Description:** Benchmark tests measuring cost, speed, and LLM call count for each execution mode.
- **Acceptance Criteria:**
  - Benchmark: first run (AI only) measures cost, LLM calls, duration
  - Benchmark: second run (cookbook) measures same metrics
  - Benchmark: ActionBook-seeded cookbook measures same metrics
  - Asserts 95%+ cost reduction between first and second run
  - Asserts 0 LLM calls for healthy cookbook replay
- **Dependencies:** GH-027, GH-029
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/benchmarks/executionEngine.bench.ts` (NEW)
- **Estimated Effort:** M

---

#### GH-036: FileUploadHelper tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P1 (high)
- **Labels:** [sprint-4] [test]
- **Description:** Unit tests for FileUploadHelper covering all upload patterns and error cases.
- **Acceptance Criteria:**
  - Test direct input file upload via setInputFiles
  - Test button-triggered filechooser interception
  - Test buffer upload (cloud storage scenario)
  - Test drag-and-drop upload
  - Test file size validation
  - Mock Playwright Page and filechooser events
- **Dependencies:** GH-028
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/unit/engine/fileUploadHelper.test.ts` (NEW)
- **Estimated Effort:** S

---

#### GH-037: Metrics dashboard (cost, success rate, healing events)

- **Epic:** E8 - Metrics & Polish
- **Priority:** P3 (nice-to-have)
- **Labels:** [sprint-4] [api]
- **Description:** API endpoints for querying automation metrics: cookbook hit rate, cost savings, healing event frequency, per-platform success rates.
- **Acceptance Criteria:**
  - `GET /api/v1/gh/metrics/overview` returns: total jobs, cookbook_hit_rate, avg_cost, cost_savings_pct
  - `GET /api/v1/gh/metrics/cookbooks` returns: per-cookbook stats
  - `GET /api/v1/gh/metrics/costs` returns: daily/weekly cost breakdown by mode
  - Time range filtering (last 7d, 30d, 90d)
- **Dependencies:** GH-027, GH-029
- **Files to Create/Modify:**
  - `packages/ghosthands/src/api/routes/metrics.ts` (NEW)
  - `packages/ghosthands/src/api/routes/index.ts` (MODIFY)
- **Estimated Effort:** L

---

#### GH-038: Documentation updates for Phase 2

- **Epic:** E8 - Metrics & Polish
- **Priority:** P2 (medium)
- **Labels:** [sprint-4] [docs]
- **Description:** Update all documentation to reflect Phase 2 implementation.
- **Acceptance Criteria:**
  - DEV-GUIDE-MAGNITUDE.md updated with engine usage, Stagehand/ActionBook integration
  - VALET-INTEGRATION-CONTRACT updated with resume endpoint, interaction payload, session fields
  - ONBOARDING-AND-GETTING-STARTED.md updated with engine configuration, new env vars
  - CHANGELOG.md updated with all Phase 2 features
- **Dependencies:** All Phase 2 tickets
- **Files to Create/Modify:**
  - `docs/DEV-GUIDE-MAGNITUDE.md` (MODIFY)
  - `docs/VALET-INTEGRATION-CONTRACT-007.md` (MODIFY)
  - `docs/ONBOARDING-AND-GETTING-STARTED.md` (MODIFY)
  - `CHANGELOG.md` (MODIFY)
- **Estimated Effort:** M

---

#### GH-039: E2E test — full job lifecycle with cookbook learning

- **Epic:** E11 - Test Infrastructure
- **Priority:** P1 (high)
- **Labels:** [sprint-4] [test]
- **Description:** End-to-end test that exercises the complete lifecycle: (1) Submit a job to a test page, (2) AI agent fills the form (first run, no cookbook), (3) TraceRecorder saves the trace as a cookbook, (4) Submit same job again, (5) CookbookExecutor replays without LLM.
- **Acceptance Criteria:**
  - Test serves a simple HTML form locally
  - First run: uses AI agent, records trace, saves cookbook
  - Second run: uses cookbook replay, zero LLM calls
  - Both runs produce same result
  - Second run is faster and has zero token usage
  - Test can run in CI (no external dependencies)
- **Dependencies:** GH-027, GH-029
- **Files to Create/Modify:**
  - `packages/ghosthands/__tests__/e2e/cookbookLearning.test.ts` (NEW)
  - `packages/ghosthands/__tests__/e2e/fixtures/testForm.html` (NEW)
- **Estimated Effort:** XL

---

### Epic E9: Browser Operator (Phase 3)

---

#### GH-040: Chrome extension scaffold (Manifest V3)

- **Epic:** E9 - Browser Operator
- **Priority:** P2 (medium)
- **Labels:** [phase-3a] [backend]
- **Description:** Create the Chrome extension project structure with Manifest V3.
- **Acceptance Criteria:**
  - `extension/manifest.json` with MV3 structure and required permissions
  - `extension/background.ts` service worker with WebSocket connection management
  - `extension/content.ts` content script stub
  - `extension/popup/` directory with basic HTML/CSS/JS
  - Extension loads in Chrome without errors
  - Build script compiles TypeScript to extension format
- **Dependencies:** None
- **Files to Create/Modify:**
  - `extension/manifest.json` (NEW)
  - `extension/background.ts` (NEW)
  - `extension/content.ts` (NEW)
  - `extension/popup/` (NEW)
  - `extension/tsconfig.json` (NEW)
- **Estimated Effort:** L

---

#### GH-041: WebSocket bridge (server-side)

- **Epic:** E9 - Browser Operator
- **Priority:** P2 (medium)
- **Labels:** [phase-3a] [api]
- **Description:** WebSocket endpoint for browser extension connections. Authentication, connection registry, command routing, heartbeat.
- **Dependencies:** GH-040
- **Estimated Effort:** L

---

#### GH-042: BrowserOperatorAdapter

- **Epic:** E9 - Browser Operator
- **Priority:** P2 (medium)
- **Labels:** [phase-3a] [adapter]
- **Description:** Adapter that connects to existing browser via CDP through extension's WebSocket bridge.
- **Dependencies:** GH-041
- **Estimated Effort:** XL

---

#### GH-043: CDP connection management and adapter factory

- **Epic:** E9 - Browser Operator
- **Priority:** P2 (medium)
- **Labels:** [phase-3b] [adapter] [worker]
- **Description:** Update adapter factory to select between MagnitudeAdapter and BrowserOperatorAdapter based on `browser_mode` in job payload.
- **Dependencies:** GH-042
- **Estimated Effort:** M

---

#### GH-044: Extension commands (openTab, readFile, checkSession)

- **Epic:** E9 - Browser Operator
- **Priority:** P2 (medium)
- **Labels:** [phase-3b] [backend]
- **Description:** Core extension command handlers for browser operator mode.
- **Dependencies:** GH-040, GH-041
- **Estimated Effort:** L

---

#### GH-045: Browser Operator tests

- **Epic:** E11 - Test Infrastructure
- **Priority:** P2 (medium)
- **Labels:** [phase-3b] [test]
- **Description:** Unit and integration tests for Browser Operator components.
- **Dependencies:** GH-042, GH-043, GH-044
- **Estimated Effort:** L

---

#### GH-046: Production hardening (reconnection, isolation, scoping)

- **Epic:** E9 - Browser Operator
- **Priority:** P3 (nice-to-have)
- **Labels:** [phase-3d] [backend]
- **Description:** Harden Browser Operator for production: reconnection, multi-tab isolation, domain scoping.
- **Dependencies:** GH-042, GH-044
- **Estimated Effort:** L

---

## Part 3: Architecture & Data Flow

---

### 3.1 Job Submission Flow (with resume passed at start)

```
VALET (or any client)
  │
  │  POST /api/v1/gh/valet/apply
  │  {
  │    valet_task_id, valet_user_id, target_url,
  │    profile: { first_name, last_name, email, ... },
  │    resume: { storage_path: "resumes/user123/resume.pdf" },
  │    browser_mode: "server",          <-- Phase 3: "operator" option
  │    execution_mode: "auto",          <-- Phase 2: override mode
  │    target_worker_id: null
  │  }
  │
  ▼
API Server (Hono)
  │  Validates via ValetApplySchema
  │  Transforms profile -> input_data.user_data
  │  INSERT INTO gh_automation_jobs (...)
  │
  ▼
gh_automation_jobs table (Supabase)
  │  status: 'pending'
  │  resume_ref: { storage_path: "resumes/user123/resume.pdf" }
  │
  ▼
JobPoller (worker process)
  │  gh_pickup_next_job(worker_id)
  │  status: 'pending' -> 'running'
  │
  ▼
JobExecutor
  │  1. Pre-flight budget check
  │  2. ** Load session ** via SessionManager.load(userId, domain)
  │  3. Resolve TaskHandler (ApplyHandler)
  │  4. Load credentials
  │  5. Download resume via ResumeDownloader
  │  6. Build LLM client config
  │  7. Create adapter (MagnitudeAdapter)
  │  8. Start adapter (with storageState if session exists)
  │  9. Create StagehandObserver (attach to browser via CDP)
  │  10. Create ActionBookConnector
  │  11. Create engine components (PageObserver, ManualStore, etc.)
  │  12. Build TaskContext { job, adapter, engine, ... }
  │  13. Delegate to handler.execute(ctx)
  │
  ▼
ApplyHandler.execute(ctx)
  │  Uses ExecutionEngine.execute(ctx)
  │
  ▼
Result
  │  Update gh_automation_jobs: status, result_data, cost
  │  ** Save session ** via SessionManager.save(userId, domain, context)
  │  Fire callback to VALET (if callback_url set)
```

---

### 3.2 Cookbook Lookup Chain (with ActionBook)

```
ExecutionEngine.execute(ctx)
  │
  │  1. OBSERVE: PageObserver.observe(page, stagehandObserver)
  │     ├── Stagehand.observe("find all interactive elements")  <-- LLM call (cheap model)
  │     ├── Platform detection (URL + DOM heuristics)           <-- no LLM
  │     └── URL pattern generation                              <-- no LLM
  │     Returns: platform=workday, pageType=form, urlPattern=*.workday.com/*/apply/*
  │
  │  2. LOOKUP LOCAL: ManualStore.lookup(urlPattern, taskType, platform)
  │     Returns: ActionManual or null
  │
  │  3a. If local cookbook (health >= 70):
  │      FAST PATH: CookbookExecutor.executeAll(page, cookbook, userData)
  │      Zero LLM calls, ~0.5s total
  │
  │  3b. If NO local cookbook:
  │      LOOKUP ACTIONBOOK: ActionBookConnector.searchActions(query, url)
  │      ├── ActionBook has manual? → Convert, seed gh_action_manuals (health=80)
  │      │   → Execute seeded cookbook (still no expensive LLM)
  │      └── ActionBook has nothing? → Fall through to AI agent
  │
  │  3c. AGENT PATH: adapter.act() with CookbookConnector + ActionBookConnector
  │      Agent explores with AI vision (~10 LLM calls, ~$0.02)
  │      TraceRecorder captures each action → save as new cookbook
  │
  │  4. LEARN: On success, save trace as cookbook for future runs
```

---

### 3.3 HITL Pause -> Notify -> Resume Flow

```
Agent encounters blocker (e.g., CAPTCHA):

  During execution (AI path or cookbook path):
    │
    │  DETECT:
    │    Level 1: BlockerDetector.detect(page)
    │      DOM pattern: iframe[src*="recaptcha"] found
    │      Returns: { type: "captcha", confidence: 0.9 }
    │    Level 2: Agent thought matches: /captcha|recaptcha/i
    │    Level 3: Error classification: "captcha_blocked"
    │
    ▼
  JobExecutor.requestHumanIntervention(job, adapter, blocker, progress)
    │
    │  1. PAUSE: adapter.pause()
    │  2. SCREENSHOT: adapter.screenshot() -> upload
    │  3. UPDATE DB: status='paused', interaction_type, interaction_data, paused_at
    │  4. NOTIFY VALET: callbackNotifier.notifyInteraction()
    │  5. WAIT: Postgres LISTEN on 'gh_job_resume' (timeout 5min)
    │
    ▼
  VALET receives callback → shows notification → user solves blocker
    │
    ▼
  VALET calls: POST /api/v1/gh/valet/resume/:jobId
    │  → NOTIFY gh_job_resume, '<jobId>'
    │
    ▼
  Worker receives NOTIFY → adapter.resume() → continue execution
```

---

### 3.4 Session Persistence Flow

```
FIRST JOB (no stored session):

  JobExecutor.execute(job)
    │  SessionManager.load(userId, domain)  → null
    │  adapter.start({ url: target_url })   → fresh browser, no cookies
    │  ... job executes (may need login, CAPTCHA) ...
    │  On success: SessionManager.save(userId, domain, context)
    │    → exports storageState (cookies + localStorage)
    │    → encrypts with AES-256-GCM
    │    → stores in gh_browser_sessions


SUBSEQUENT JOB (session exists):

  JobExecutor.execute(job)
    │  SessionManager.load(userId, domain)  → decrypted storageState
    │  adapter.start({ url, storageState }) → browser starts with saved cookies
    │  ... job executes MUCH FASTER (already logged in) ...
    │  On success: SessionManager.save()    → refresh stored session
```

---

### 3.5 Component Dependency Diagram

```
                         ┌─────────────────────────────┐
                         │       Job Submission          │
                         │  (VALET / API / Client SDK)   │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │         API Server            │
                         │  routes/valet.ts              │
                         │  routes/operator.ts  [P3]     │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │     gh_automation_jobs        │
                         │  (Supabase / PostgreSQL)      │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │        JobExecutor            │
                         │                               │
                         │  SessionManager ────── gh_browser_sessions (DB)
                         │  ResumeDownloader              │
                         │  CostTracker                   │
                         │  BlockerDetector               │
                         │  StagehandObserver ── @browserbasehq/stagehand
                         │  ActionBookConnector ── @actionbookdev/sdk
                         └──────────────┬───────────────┘
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  │                     │                     │
        ┌─────────▼──────────┐ ┌────────▼─────────┐ ┌────────▼────────┐
        │  ApplyHandler      │ │  ScrapeHandler   │ │ CustomHandler   │
        │  (uses Engine)     │ │  (uses Engine)   │ │ (pure AI only)  │
        └─────────┬──────────┘ └────────┬─────────┘ └────────┬────────┘
                  │                     │                     │
                  └─────────┬───────────┘                     │
                            │                                 │
                  ┌─────────▼───────────┐              ┌──────▼───────┐
                  │  ExecutionEngine     │              │ adapter.act()│
                  │                     │              │ (direct)     │
                  │  Lookup chain:      │              └──────────────┘
                  │  1. PageObserver    │
                  │     └── Stagehand  │
                  │  2. ManualStore    │──────── gh_action_manuals (DB)
                  │  3. ActionBook     │──────── api.actionbook.dev
                  │  4. AI Agent       │
                  │                     │
                  │  ┌───────────────┐  │
                  │  │ Fast Path     │  │
                  │  │ Cookbook       │  │
                  │  │ Executor      │  │
                  │  │               │  │
                  │  │ Locator       │  │
                  │  │ Resolver      │  │
                  │  └───────────────┘  │
                  └─────────────────────┘


  HITL Flow (cross-cutting):

    BlockerDetector ──► JobExecutor.requestHumanIntervention()
         │                    │
         │              adapter.pause()
         │              CallbackNotifier.notifyInteraction()
         │              pgListener (LISTEN gh_job_resume)
         │                    │
         │              VALET ──► POST /valet/resume/:jobId
         │                    │
         │              adapter.resume()
         ▼
```

---

## Part 4: Testing Strategy

---

### 4.1 Unit Test Plan

| Component | File | Key Test Cases | Mock Strategy |
|-----------|------|----------------|---------------|
| SessionManager | `sessionManager.test.ts` | Encrypt/decrypt, save/load, expiry, invalidate, corrupted state | Mock Supabase, mock crypto |
| BlockerDetector | `blockerDetector.test.ts` | DOM patterns (7+ patterns), thought patterns, confidence scoring | Mock DOM query results |
| CallbackNotifier | `callbackNotifier.test.ts` | needs_human payload, retry logic, all three statuses | Mock fetch |
| StagehandObserver | `stagehandObserver.test.ts` | Init with cdpUrl, observe() mapping, connection failure fallback | Mock Stagehand instance |
| PageObserver | `pageObserver.test.ts` | Platform detection (7+ platforms), page type, form discovery, URL patterns, works with/without Stagehand | Mock Stagehand, mock Playwright Page |
| ActionBookConnector | `actionbookConnector.test.ts` | searchActions, getActionByAreaId, format conversion, no-result fallback | Mock ActionBook SDK |
| LocatorDescriptor types | `types.test.ts` | Zod validation, required/optional fields | None (pure types) |
| LocatorResolver | `locatorResolver.test.ts` | Strategy priority, fallback, timeout, stale element retry | Mock Playwright Page |
| TraceRecorder | `traceRecorder.test.ts` | Event subscription, elementFromPoint, template detection, multi-page | Mock adapter events, mock page.evaluate |
| ManualStore | `manualStore.test.ts` | Lookup, save (from trace and ActionBook), health score math | Mock Supabase client |
| CookbookExecutor | `cookbookExecutor.test.ts` | Full replay, template substitution, step failure, verification | Mock Playwright Page, mock LocatorResolver |
| templateResolver | `templateResolver.test.ts` | Simple substitution, missing vars, no-op, multiple vars | None (pure function) |
| FileUploadHelper | `fileUploadHelper.test.ts` | Direct input, filechooser, buffer, drag-drop, size validation | Mock Playwright Page |
| CookbookConnector | `cookbookConnector.test.ts` | collectObservations, action space, try-step, instructions | Mock dependencies |
| ExecutionEngine | `executionEngine.test.ts` | Fast path, agent path, ActionBook path, hybrid, mode override | Mock all dependencies |

### 4.2 Integration Test Plan

| Test Suite | File | What It Verifies |
|-----------|------|------------------|
| Session persistence | `sessionPersistence.test.ts` | Save -> reload -> browser starts with cookies |
| HITL pause/resume | `pauseResume.test.ts` | Blocker -> pause -> callback -> resume -> continue |
| ExecutionEngine flow | `executionEngine.test.ts` | Full observe -> decide -> execute -> learn cycle |
| ActionBook seed | `actionbookSeed.test.ts` | Query ActionBook -> seed cookbook -> replay |
| CookbookConnector + Agent | `cookbookConnector.test.ts` | Connector injects context, agent uses cookbook actions |
| TaskHandler + Engine | `handlerEngine.test.ts` | ApplyHandler delegates to engine |

### 4.3 E2E Test Plan

| Test | File | Scope |
|------|------|-------|
| Cookbook learning cycle | `cookbookLearning.test.ts` | Submit job -> AI fills form -> trace saved -> replay |
| HITL full cycle | `hitlCycle.test.ts` | Submit -> CAPTCHA -> pause -> API resume -> continue |
| Session reuse | `sessionReuse.test.ts` | Job 1 logs in -> saves session -> Job 2 starts logged in |

### 4.4 Mock Strategy

| External Service | Mock Approach |
|------------------|---------------|
| **Supabase** | In-memory mock with `.from()`, `.select()`, `.insert()`, `.update()` |
| **Playwright Page** | Mock object with `.locator()`, `.$$eval()`, `.evaluate()` |
| **Magnitude Agent** | MockAdapter (already exists) |
| **Stagehand** | Mock StagehandObserver returning fixture Action[] |
| **ActionBook SDK** | Mock Actionbook client returning fixture ChunkActionDetail |
| **Postgres LISTEN/NOTIFY** | Mock pg client with EventEmitter |
| **Fetch (callbacks)** | Mock global fetch |

---

## Part 5: Implementation Order

---

### 5.1 Critical Path

```
Sprint 1 (P0 — Session Persistence + HITL):
  GH-001 (browser sessions migration) ── no deps
  GH-005 (interaction columns migration) ── no deps
  GH-002 (SessionManager) ──► GH-003 (Wire into JobExecutor)
  GH-006 (Pause/resume adapter) ── no deps
  GH-007 (CallbackNotifier) ── no deps
  GH-008 (Resume endpoint) ──► GH-010 (HITL wiring)
  GH-009 (BlockerDetector) ──► GH-010 (HITL wiring)
  GH-004 (Session tests), GH-012 (HITL tests)

Sprint 2 (P0 — Stagehand + ActionBook + Cookbooks):
  GH-013 (Stagehand setup) ──► GH-014 (PageObserver) ──► GH-015 (observe on adapter)
  GH-017 (ActionBook connector) ──► GH-018 (Seed cookbooks)
  GH-020 (Types) ──► GH-021 (LocatorResolver) ──► GH-024 (CookbookExecutor)
  GH-020 ──► GH-022 (TraceRecorder)
  GH-020 ──► GH-023 (ManualStore)

Sprint 3 (P0 — Execution Engine):
  GH-026 (CookbookConnector) ──► GH-027 (ExecutionEngine) ──► GH-029 (Wire into handlers)
  GH-028 (FileUploadHelper)
  GH-030 (Engine integration tests)

Sprint 4 (P2 — Optimization + Polish):
  GH-031 (Per-step health) ──► GH-032 (Self-healing)
  GH-033 (Template detection)
  GH-034 (Multi-step forms)
  GH-035-039 (Benchmarks, tests, metrics, docs, E2E)

Sprint 5-7 (P2 — Browser Operator / Phase 3):
  GH-040 through GH-046
```

### 5.2 Sprint Plan (2-week sprints)

#### Sprint 1: Session Persistence + HITL — Weeks 1-2

**Goal:** Browser sessions reused across jobs. HITL pause/resume working end-to-end.

| Ticket | Title | Effort | Parallelizable? |
|--------|-------|--------|-----------------|
| GH-001 | Migration: gh_browser_sessions | S | Start immediately |
| GH-005 | Migration: interaction columns | S | Parallel with GH-001 |
| GH-006 | Pause/resume on adapter | S | Parallel with GH-001 |
| GH-007 | Extend CallbackNotifier | S | Parallel |
| GH-002 | SessionManager | L | After GH-001 |
| GH-003 | Wire SessionManager into JobExecutor | M | After GH-002 |
| GH-008 | Resume API endpoint | M | After GH-005 |
| GH-009 | Blocker detection | M | Parallel with GH-002 |
| GH-010 | Wire HITL in JobExecutor + LISTEN | XL | After GH-005, GH-006, GH-007, GH-008, GH-009 |
| GH-011 | Update status endpoint | S | After GH-010 |
| GH-004 | Session persistence tests | M | After GH-003 |
| GH-012 | HITL tests | L | After GH-010 |

**Parallelization:**
- Dev A: GH-001 → GH-002 → GH-003 → GH-004
- Dev B: GH-005 → GH-008 → GH-009 → GH-010
- Dev C: GH-006 → GH-007 → GH-011 → GH-012

#### Sprint 2: Stagehand + ActionBook + Cookbook Foundation — Weeks 3-4

**Goal:** Stagehand observing pages, ActionBook providing seed manuals, cookbook types/store/resolver/executor built.

| Ticket | Title | Effort | Parallelizable? |
|--------|-------|--------|-----------------|
| GH-020 | LocatorDescriptor types | S | Start immediately |
| GH-013 | Install/configure Stagehand | L | Start immediately |
| GH-017 | ActionBook SDK + connector | L | Start immediately |
| GH-014 | PageObserver (uses Stagehand) | L | After GH-013, GH-009 |
| GH-015 | MagnitudeAdapter.observe() | S | After GH-013 |
| GH-018 | Seed cookbooks from ActionBook | M | After GH-017, GH-023 |
| GH-021 | LocatorResolver | M | After GH-020 |
| GH-022 | TraceRecorder | L | After GH-020 |
| GH-023 | ManualStore | M | After GH-020 |
| GH-024 | CookbookExecutor | L | After GH-020, GH-021 |
| GH-016 | Stagehand tests | M | After GH-014 |
| GH-019 | ActionBook tests | M | After GH-018 |
| GH-025 | Cookbook foundation tests | L | After GH-021-GH-024 |

**Parallelization:**
- Dev A: GH-013 → GH-014 → GH-015 → GH-016
- Dev B: GH-017 → GH-018 → GH-019
- Dev C: GH-020 → GH-021 → GH-024 → GH-025
- Dev D: GH-022 → GH-023

#### Sprint 3: Execution Engine — Weeks 5-6

**Goal:** Full hybrid engine working. Jobs use cookbooks, ActionBook seeds, and AI with session persistence.

| Ticket | Title | Effort | Parallelizable? |
|--------|-------|--------|-----------------|
| GH-026 | CookbookConnector | L | Start of sprint |
| GH-028 | FileUploadHelper | M | Parallel |
| GH-027 | ExecutionEngine | XL | After GH-026 |
| GH-029 | Wire into TaskHandlers | L | After GH-027 |
| GH-030 | Integration tests (Engine) | L | After GH-029 |

**Parallelization:**
- Dev A: GH-026 → GH-027 → GH-029
- Dev B: GH-028 → GH-030

#### Sprint 4: Optimization + Polish — Weeks 7-8

**Goal:** Self-healing, templates, multi-step forms, metrics, E2E tests, docs.

| Ticket | Title | Effort | Parallelizable? |
|--------|-------|--------|-----------------|
| GH-031 | Per-step health scores | M | Start |
| GH-032 | Self-healing selectors | M | After GH-031 |
| GH-033 | Template detection | M | Parallel |
| GH-034 | Multi-step form navigation | L | Parallel |
| GH-035 | Performance benchmarks | M | Parallel |
| GH-036 | FileUploadHelper tests | S | Parallel |
| GH-037 | Metrics dashboard | L | Parallel |
| GH-038 | Documentation updates | M | Parallel |
| GH-039 | E2E test (cookbook learning) | XL | Parallel |

#### Sprint 5-7 (Phase 3): Browser Operator — Weeks 9-14

| Ticket | Title | Effort |
|--------|-------|--------|
| GH-040 | Extension scaffold | L |
| GH-041 | WebSocket bridge | L |
| GH-042 | BrowserOperatorAdapter | XL |
| GH-043 | CDP + adapter factory | M |
| GH-044 | Extension commands | L |
| GH-045 | Browser Operator tests | L |
| GH-046 | Production hardening | L |

---

## Appendix: Ticket Summary Table

| ID | Title | Sprint | Priority | Epic | Effort | Depends On |
|----|-------|--------|----------|------|--------|------------|
| GH-001 | Migration: gh_browser_sessions | 1 | P0 | E1 | S | - |
| GH-002 | SessionManager | 1 | P0 | E1 | L | GH-001 |
| GH-003 | Wire SessionManager into JobExecutor | 1 | P0 | E1 | M | GH-002 |
| GH-004 | Session persistence tests | 1 | P0 | E11 | M | GH-002, GH-003 |
| GH-005 | Migration: interaction columns | 1 | P0 | E2 | S | - |
| GH-006 | Pause/resume on adapter | 1 | P0 | E2 | S | - |
| GH-007 | Extend CallbackNotifier | 1 | P0 | E2 | S | - |
| GH-008 | Resume API endpoint | 1 | P0 | E2 | M | GH-005 |
| GH-009 | Blocker detection | 1 | P0 | E2 | M | - |
| GH-010 | Wire HITL in JobExecutor + LISTEN | 1 | P0 | E2 | XL | GH-005, GH-006, GH-007, GH-008, GH-009 |
| GH-011 | Update status endpoint | 1 | P0 | E2 | S | GH-005, GH-010 |
| GH-012 | HITL tests | 1 | P0 | E11 | L | GH-005-GH-011 |
| GH-013 | Install/configure Stagehand | 2 | P0 | E3 | L | - |
| GH-014 | PageObserver (uses Stagehand) | 2 | P0 | E3 | L | GH-013, GH-009 |
| GH-015 | MagnitudeAdapter.observe() | 2 | P1 | E3 | S | GH-013 |
| GH-016 | Stagehand tests | 2 | P0 | E11 | M | GH-013, GH-014 |
| GH-017 | ActionBook SDK + connector | 2 | P0 | E4 | L | - |
| GH-018 | Seed cookbooks from ActionBook | 2 | P1 | E4 | M | GH-017, GH-023 |
| GH-019 | ActionBook tests | 2 | P1 | E11 | M | GH-017, GH-018 |
| GH-020 | LocatorDescriptor types | 2 | P0 | E5 | S | - |
| GH-021 | LocatorResolver | 2 | P0 | E5 | M | GH-020 |
| GH-022 | TraceRecorder | 2 | P0 | E5 | L | GH-020 |
| GH-023 | ManualStore | 2 | P0 | E5 | M | GH-020 |
| GH-024 | CookbookExecutor | 2 | P0 | E5 | L | GH-020, GH-021 |
| GH-025 | Cookbook foundation tests | 2 | P0 | E11 | L | GH-020-GH-024 |
| GH-026 | CookbookConnector | 3 | P0 | E6 | L | GH-014, GH-023, GH-024, GH-028 |
| GH-027 | ExecutionEngine | 3 | P0 | E6 | XL | GH-014, GH-017, GH-022-GH-024, GH-026 |
| GH-028 | FileUploadHelper | 3 | P1 | E7 | M | GH-020 |
| GH-029 | Wire into TaskHandlers | 3 | P0 | E6 | L | GH-027 |
| GH-030 | Integration tests (Engine) | 3 | P0 | E11 | L | GH-027, GH-029 |
| GH-031 | Per-step health scores | 4 | P2 | E5 | M | GH-023, GH-024 |
| GH-032 | Self-healing selectors | 4 | P2 | E5 | M | GH-021, GH-024, GH-031 |
| GH-033 | Template detection | 4 | P2 | E5 | M | GH-022 |
| GH-034 | Multi-step form navigation | 4 | P2 | E5 | L | GH-024, GH-022 |
| GH-035 | Performance benchmarks | 4 | P2 | E8 | M | GH-027, GH-029 |
| GH-036 | FileUploadHelper tests | 4 | P1 | E11 | S | GH-028 |
| GH-037 | Metrics dashboard | 4 | P3 | E8 | L | GH-027, GH-029 |
| GH-038 | Documentation updates | 4 | P2 | E8 | M | All Phase 2 |
| GH-039 | E2E test (cookbook learning) | 4 | P1 | E11 | XL | GH-027, GH-029 |
| GH-040 | Extension scaffold | 5 | P2 | E9 | L | - |
| GH-041 | WebSocket bridge | 5 | P2 | E9 | L | GH-040 |
| GH-042 | BrowserOperatorAdapter | 5 | P2 | E9 | XL | GH-041 |
| GH-043 | CDP + adapter factory | 6 | P2 | E9 | M | GH-042 |
| GH-044 | Extension commands | 6 | P2 | E9 | L | GH-040, GH-041 |
| GH-045 | Browser Operator tests | 6 | P2 | E11 | L | GH-042-GH-044 |
| GH-046 | Production hardening | 7 | P3 | E9 | L | GH-042, GH-044 |
| GH-047 | Fix browser_crashed error | 1 | P1 | E1 | L | GH-002 |
| GH-048 | Session Management API for VALET | 1 | P0 | E1 | S | GH-001 |

---

### Bugs & Operational

---

#### GH-047: Fix browser_crashed — "Target page, context or browser has been closed"

- **Epic:** E1 - Session Persistence
- **Priority:** P1 (high)
- **Labels:** [bug] [worker] [adapter]
- **Description:** Worker logs show `Target page, context or browser has been closed` error during LinkedIn and Workday job execution. The browser context is being destroyed mid-execution, causing jobs to fail with `browser_crashed`. Root cause suspected: Patchright/Playwright browser process dying under memory pressure or anti-bot detection triggering process kill. Need to investigate whether this is a resource issue (OOM), an anti-bot kill, or a Patchright bug.
- **Acceptance Criteria:**
  - Identify root cause (memory, anti-bot, Patchright bug, or timeout)
  - Add browser process health monitoring (check `browser.isConnected()` before actions)
  - Implement browser restart + session restore on crash (reload from `gh_browser_sessions`)
  - Add `browser_crashed` to retry-eligible error codes (currently fails permanently)
  - Log browser process exit code and signal for debugging
  - Add resource limits documentation for Docker containers
- **Dependencies:** GH-002 (SessionManager — for session restore after crash)
- **Files to Create/Modify:**
  - `packages/ghosthands/src/adapters/magnitude.ts` (MODIFY — health check + reconnect)
  - `packages/ghosthands/src/workers/JobExecutor.ts` (MODIFY — crash recovery)
- **Estimated Effort:** L

---

#### GH-048: Session Management API for VALET

- **Epic:** E1 - Session Persistence
- **Priority:** P0 (critical)
- **Labels:** [sprint-1] [api] [valet]
- **Description:** Expose REST endpoints for VALET to list, inspect, and clear stored browser sessions. Sessions are managed transparently by JobExecutor, but VALET needs visibility and control for UX (show stored sessions, "log out everywhere" button, troubleshooting).
- **Acceptance Criteria:**
  - `GET /api/v1/gh/valet/sessions/:userId` — List all stored sessions (domain, timestamps, no encrypted data)
  - `DELETE /api/v1/gh/valet/sessions/:userId/:domain` — Clear specific domain session
  - `DELETE /api/v1/gh/valet/sessions/:userId` — Clear ALL sessions for user
  - Protected by same auth middleware as other VALET routes
  - Returns 404 when no session found for specific domain delete
  - Contract documented in VALET-SESSION-CONTRACT.md
- **Dependencies:** GH-001 (gh_browser_sessions table)
- **Files to Create/Modify:**
  - `packages/ghosthands/src/api/routes/valet.ts` (MODIFY — add session endpoints)
  - `packages/ghosthands/src/api/schemas/valet.ts` (MODIFY — add session schema)
  - `docs/VALET-SESSION-CONTRACT.md` (NEW — session integration doc for VALET team)
- **Estimated Effort:** S

---

**Totals:** 48 tickets across 11 epics, ~7 sprints (14 weeks)

**Effort distribution:**
- S (Small, <1 day): 10 tickets
- M (Medium, 1-3 days): 14 tickets
- L (Large, 3-5 days): 17 tickets
- XL (Extra Large, 5-10 days): 7 tickets

**External dependencies added:**
- `@browserbasehq/stagehand` v3.0.8 — page observation via CDP Accessibility Tree
- `@actionbookdev/sdk` v0.3.0 — pre-built ATS action manuals (Apache-2.0)
