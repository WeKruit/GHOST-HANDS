# VALET Integration Changes — Sprint 5

**Date:** 2026-02-17
**Status:** Deployed to main
**Breaking Changes:** None (all additive, backward compatible)

---

## Summary

Sprint 5 is a **model + events mega-update**:
- 7 new models (including frontier Qwen3.5-Plus, GPT-5.2, Claude Opus, Gemini family)
- Accuracy-focused preset rebalancing
- Unified event system — ALL events now flow to `gh_job_events`
- 672 tests passing, 0 failures

---

## 1. New Models

| Alias | Provider | Vision | Input $/M | Output $/M | Notes |
|-------|----------|--------|-----------|------------|-------|
| **qwen3.5-plus** | Alibaba Cloud | Yes | $0.40 | $2.40 | Frontier accuracy, native GUI automation, 1M context. Released Feb 16 2026. |
| **gpt-5.2** | OpenAI | Yes | $1.75 | $14.00 | Frontier reasoning, multimodal |
| **gpt-4.1** | OpenAI | Yes | $2.00 | $8.00 | Good vision (OCR, VQA), 1M context |
| **claude-opus** | Anthropic | Yes | $5.00 | $25.00 | #1 on intelligence leaderboards. Best for complex flows. |
| **gemini-2.5-pro** | Google | Yes | $1.25 | $10.00 | Strong vision and reasoning, 1M context |
| **gemini-2.5-flash** | Google | Yes | $0.15 | $0.60 | Fast, cheap, decent accuracy |
| **gemini-2.0-flash** | Google | Yes | $0.10 | $0.40 | Ultra-fast Gemini |

**Updated pricing:**
- `deepseek-chat`: output $1.10 → $0.42 (V3.2 price cut)

**Total models available: 25** (was 18)

---

## 2. Updated Presets (Accuracy Focus)

| Preset | Previous Model | New Model | Why |
|--------|---------------|-----------|-----|
| `speed` | qwen-7b | qwen-7b (unchanged) | Still cheapest |
| `balanced` | qwen-72b | **qwen3-235b** | Better accuracy, similar cost |
| `quality` | qwen3-235b | **qwen3.5-plus** | Frontier accuracy, native GUI agent |
| `premium` | gpt-4o | **gpt-5.2** | Newer, better, cheaper input |

**Default** remains `qwen-72b` (safest choice for existing VALET integrations).

To use the new presets, pass the preset name as the `model` field:
```json
{ "model": "quality" }
```

Or specify the alias directly:
```json
{ "model": "qwen3.5-plus" }
```

---

## 3. Unified Event System

**All execution events now flow to `gh_job_events`** — Stagehand observations, cookbook steps, AI thinking, token usage, and trace recording.

### New Event Types

| Event | Description | Key metadata |
|-------|-------------|--------------|
| `thought` | AI reasoning/thinking (throttled: max 1/2s) | `content` (truncated 500 chars) |
| `tokens_used` | LLM token usage per step | `model`, `input_tokens`, `output_tokens`, `cost_usd` |
| `observation_started` | Stagehand observe() call started | `instruction` |
| `observation_completed` | Stagehand observe() returned | `instruction`, `elements_found` |
| `cookbook_step_started` | Cookbook replaying a step | `step_index`, `action`, `selector` |
| `cookbook_step_completed` | Cookbook step succeeded | `step_index`, `action` |
| `cookbook_step_failed` | Cookbook step failed | `step_index`, `action`, `error` |
| `trace_recording_started` | TraceRecorder started | — |
| `trace_recording_completed` | TraceRecorder finished | `steps` |

### VALET UI Integration

Subscribe to `gh_job_events` and add these cases to your event handler:

```typescript
case 'thought':
  // Show AI reasoning in a "thinking" feed
  showThinkingBubble(event.metadata.content);
  break;

case 'tokens_used':
  // Update real-time cost counter
  updateLiveCost(event.metadata.cost_usd);
  showModelBadge(event.metadata.model);
  break;

case 'observation_started':
  showStatus('Observing page elements...');
  break;

case 'cookbook_step_started':
  appendToTimeline({
    icon: '🟢',
    text: `${event.metadata.action} (step ${event.metadata.step_index + 1})`,
  });
  break;

case 'cookbook_step_failed':
  appendToTimeline({
    icon: '🟠',
    text: `Cookbook step failed: ${event.metadata.error}`,
  });
  break;
```

---

## 4. New Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | For qwen3.5-plus | Alibaba Cloud DashScope API key |
| `GOOGLE_API_KEY` | For Gemini models | Google AI API key |

These are only needed if you want to use the corresponding models. All existing models continue to work without new env vars.

---

## 5. Test Status

| Suite | Tests | Failures |
|-------|-------|----------|
| Unit | 479 | 0 |
| Integration | 87 | 0 |
| E2E | 106 | 0 |
| **Total** | **672** | **0** |

---

## 6. No Breaking Changes

All changes are additive:
- New models don't affect existing `model` field usage
- New event types are INSERT-only — existing event handlers won't see them unless subscribed
- Updated presets only affect jobs that explicitly use preset names
- Default model (`qwen-72b`) unchanged

---

## 7. Files Changed

### New Files
- `packages/ghosthands/src/events/JobEventTypes.ts` — 25 typed event constants + ThoughtThrottle
- `packages/ghosthands/__tests__/unit/events/jobEventTypes.test.ts` — 23 tests
- `packages/ghosthands/__tests__/integration/events/eventLogging.test.ts` — 12 tests
- `packages/ghosthands/__tests__/unit/config/models.test.ts` — 39 tests

### Modified Files
- `packages/ghosthands/src/config/models.config.json` — 7 new models, Google provider, preset updates
- `packages/ghosthands/src/workers/JobExecutor.ts` — thought/token event wiring
- `packages/ghosthands/src/engine/StagehandObserver.ts` — observation events
- `packages/ghosthands/src/engine/CookbookExecutor.ts` — cookbook step events
- `docs/VALET-INTEGRATION-CONTRACT.md` — updated to Sprints 1-5

---

## 8. Full Contract Reference

See `docs/VALET-INTEGRATION-CONTRACT.md` (18 sections, Sprints 1-5).

Key sections updated:
- **4.1.1** — Model Reference (25 models, accuracy + budget tiers)
- **6.4** — Event Types Reference (10 new event types)
- **16** — Migration Checklist (new env vars)
- **18** — Known Limitations (updated #10)
