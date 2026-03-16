# Backend Architect Memory

## GHOST-HANDS Architecture (2026-03-11)

### Mastra Workflow System
- 2-step workflow: `check_blockers_checkpoint` -> `execute_handler`
- RuntimeContext is closure-injected (non-serializable: adapter, Playwright page, costTracker)
- WorkflowState is Zod-validated, persisted via PostgresStore
- HITL: suspend() serializes state, resume() re-enters step with resumeData
- Resume coordination: atomic claim via Postgres UPDATE...RETURNING

### Entry Points
- **Hosted worker**: `jobExecutor.ts` -> `executeMastraWorkflow()` (execution_mode='mastra' or 'mastra_decision')
- **Desktop direct**: `packages/engine/src/runApplication.ts` -> magnitude-core directly
- **Desktop brokered**: `packages/engine/src/desktop.ts` -> broker API -> hosted worker

### v3 Engine (exists, not wired to production)
- `LayerHand` abstract: observe/process/execute/review/throwError
- `DOMHand` ($0), `StagehandHand` ($0.0005), `MagnitudeHand` ($0.005)
- `SectionOrchestrator` per-page with escalation policy
- Files: `packages/ghosthands/src/engine/v3/`

### Key Constraint
- Mastra step boundaries serialize to Postgres (~200ms)
- Browser session (Playwright Page) cannot survive step boundaries
- Decision loops MUST run inside single step, suspend only for HITL

## Decision Engine Architecture

### Architecture Doc
- Full design: `docs/MASTRA-DECISION-ENGINE-ARCHITECTURE.md`

### Core Design
- New Mastra step `page_decision_loop` replaces `execute_handler`
- LLM decision via tool_use (Haiku, constrained 16-action schema)
- Execution cascade reuses v3 DOMHand -> StagehandHand -> MagnitudeHand
- Rollout: execution_mode 'mastra_decision' (opt-in) -> default -> deprecate SmartApplyHandler

### File Locations
- Decision types: `packages/ghosthands/src/workflows/mastra/decision/types.ts`
- TextObserver: `packages/ghosthands/src/workflows/mastra/decision/TextObserver.ts`
- Decision loop step: `packages/ghosthands/src/workflows/mastra/steps/pageDecisionLoop.ts`
- Workflow state (with decisionLoop): `packages/ghosthands/src/workflows/mastra/types.ts`
- Decision workflow builder: `buildDecisionApplyWorkflow()` in `applyWorkflow.ts`

### Mastra Integration Pattern (wired 2026-03-11)
- `buildPageDecisionLoopStep(rt, loopRunnerFactory)` takes factory injection (not direct import)
- Factory pattern avoids import-time dependency on engine/decision (not yet built)
- DecisionLoopRunnerFactory interface defines `create()` -> `{run(): Promise<DecisionLoopResult>}`
- Step reuses `blockerResumeSchema` from check_blockers_checkpoint for HITL
- Action history capped at 50 entries in workflow state (LLM sees last 10)
- Workflow ID: `gh_apply_decision` (distinct from `gh_apply`)
- JobExecutor HITL resume: in-process uses `result.suspended[0]` to detect step; external uses `undefined` (auto-detect)
- `mastra_decision` added to VALID_FINAL_MODES and step key extraction fallback
- Decision engine metrics persisted to `job.metadata.decision_engine` before finalization
- Stub DecisionLoopRunnerFactory in JobExecutor -- replace with real factory when engine/decision/ is built

### Type Hierarchy
- DecisionContext: url, platform, fields, buttons, actionHistory, budget
- DecisionAction (16 variants): fill_form, click_next, click_apply, login, etc.
- Execution: SectionOrchestrator for fill_form, single-element cascade for clicks
- Termination: confirmation, review_page, stuck, budget_exceeded, error, max_iterations

### Existing Code Reuse
- PageScanner.scan() from `engine/v3/PageScanner.ts`
- BlockerDetector from `detection/BlockerDetector.ts`
- detectPlatform/detectPageType from `engine/PageObserver.ts`
- Fingerprint logic from smartApplyHandler.ts:getPageFingerprint()
- formFiller.ts fillFormOnPage() for credential/account flows
