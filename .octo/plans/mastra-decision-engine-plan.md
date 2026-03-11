# Mastra Decision Engine — Architecture Plan

## Status: Phase 2 (Define) in progress

## Branch: `feat/octo-mastra-decision-engine` (from staging)

---

## Discovery Findings Summary

### Entry Points (from Codex)
- **Desktop engine** (`runApplication()`): Goes to `magnitude-core startBrowserAgent()` — does NOT reach SmartApplyHandler or Mastra
- **Hosted worker**: `POST /valet/apply` → `gh_automation_jobs` → `JobPoller/PgBossConsumer` → `JobExecutor.execute()`
  - `execution_mode === 'mastra'`: `buildApplyWorkflow(rt)` → `check_blockers` → `execute_handler` → `SmartApplyHandler.execute()`
  - else: `SmartApplyHandler.execute()` directly
- SmartApplyHandler imported only in `taskHandlers/index.ts` (registered as singleton)

### Existing Reusable Components
| Component | File | Reuse |
|---|---|---|
| PageScanner v3 | `engine/v3/PageScanner.ts` | 80% of TextObserver |
| extractFields() | `formFiller.ts:819-980` | Shadow DOM field extraction |
| detectRepeaters() | `formFiller.ts:2950-3091` | Add button discovery |
| BlockerDetector | `detection/BlockerDetector.ts` | 40+ CAPTCHA/login patterns |
| getPageFingerprint() | `smartApplyHandler.ts:3768-3808` | Stuck loop detection |
| detectPlatform/PageType | `PageObserver.ts` | URL + basic classification |

### Platform Guardrails (from Gemini)
- **Workday**: GUARDRAIL (base rules, auth, credential resolution), EXECUTOR (segmented dates, skills pills, dropdowns), MIGRATE (experience handler)
- **Generic**: GUARDRAIL (base rules, visibility check), EXECUTOR (fillByNativeSetter, field extraction), OBSOLETE (simple navigation)
- **Amazon**: GUARDRAIL (page detection, MFA), EXECUTOR (shared Google SSO)

### Key Gaps
1. No unified observation — 7 files each extract partial state
2. No action history tracking
3. No constrained decision schema — LLM gets freeform prose
4. Repeater detection skipped for Magnitude path
5. Workday account creation false positive
6. No modal/overlay detection
7. No "page still loading" check

---

## Architecture Design (Phase 2)

### New Files
```
packages/ghosthands/src/workflows/mastra/decision/
  types.ts          — PageDecisionContext, DecisionAction, ExecutorResult (Zod schemas)
  TextObserver.ts   — Unified DOM observation (composes PageScanner + repeaters + fingerprint + blockers)
  ActionExecutor.ts — Execute DecisionAction via DOM → Stagehand → Magnitude cascade
  DecisionEngine.ts — LLM decision step (observe → decide → execute → loop)
  index.ts          — Barrel exports
```

### PageDecisionContext (LLM Input)
- url, title, platform, pageType
- headings: string[]
- fields: FieldSnapshot[] (from PageScanner)
- buttons: ButtonSnapshot[] (from PageScanner)
- stepContext: StepContext | null
- repeaters: RepeaterInfo[]
- fingerprint: PageFingerprint
- blocker: BlockerStatus
- actionHistory: ActionHistoryEntry[]
- guardrailHints: GuardrailHint[]
- observationConfidence: number (0-1)
- observedAt: number

### DecisionAction (LLM Output — Constrained)
- fill_fields_dom (field IDs + values)
- expand_repeaters_dom (button selector + count)
- click_dom (element selector + intent)
- use_stagehand (natural language instruction)
- use_magnitude (task description)
- stop_for_review (HITL prompt)
- mark_incompatible (terminal)
- retry_after_observation (re-observe, optionally with screenshot)
- All carry `reasoning: string` for traceability

### ExecutorResult
- status: action_succeeded | action_failed_retryable | action_failed_terminal | needs_review
- fieldsChanged, durationMs, costUsd, pageNavigated, error, summary

### Workflow Integration
- Replace Mastra `execute_handler` step with page decision loop
- Loop: TextObserver.observe() → LLM decides → ActionExecutor.execute() → repeat
- Platform guardrails can override unsafe decisions
- Termination: confirmation page, review page, error, stuck loop, budget exceeded

### Desktop Entry Point Change
- `runApplication()` needs to route into Mastra workflow instead of direct magnitude-core
- Keep backward compatibility via feature flag during rollout
