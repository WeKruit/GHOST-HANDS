# VALET Integration Contract: Sprint 3

**Date:** 2026-02-16
**Sprint:** 3 (Execution Engine & Mode Tracking)
**Status:** Complete
**Breaking:** No (all changes are additive and backward compatible)

---

## Summary

Sprint 3 adds the ExecutionEngine orchestrator that enables cookbook-based replay (near-zero LLM cost) for known ATS platforms, with automatic fallback to Magnitude LLM mode when no cookbook manual exists or when replay fails.

Key additions:
1. **ExecutionEngine** -- Orchestrates mode selection (cookbook vs Magnitude)
2. **Mode tracking columns** -- Track requested and actual execution modes per job
3. **Extended status/callback** -- Expose mode, manual, and cost breakdown data to VALET
4. **Manual training** -- Successful Magnitude runs automatically create cookbooks for future use

---

## 1. Database Schema Changes

### Migration: `011_execution_mode_tracking.sql`

Three new columns on `gh_automation_jobs`:

```sql
ALTER TABLE gh_automation_jobs
  ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'auto'
    CHECK (execution_mode IN ('auto', 'ai_only', 'cookbook_only')),
  ADD COLUMN IF NOT EXISTS browser_mode TEXT DEFAULT 'server'
    CHECK (browser_mode IN ('server', 'operator')),
  ADD COLUMN IF NOT EXISTS final_mode TEXT
    CHECK (final_mode IN ('cookbook', 'magnitude', 'hybrid'));
```

| Column | Type | Default | Values | Description |
|--------|------|---------|--------|-------------|
| `execution_mode` | TEXT | 'auto' | auto, ai_only, cookbook_only | User-requested execution strategy |
| `browser_mode` | TEXT | 'server' | server, operator | Browser execution context |
| `final_mode` | TEXT | NULL | cookbook, magnitude, hybrid | Actual mode used (set on completion) |

New index: `idx_gh_jobs_execution_mode` on `execution_mode`

---

## 2. Extended Status Response

**Endpoint:** `GET /api/v1/gh/valet/status/:jobId`

New fields (all optional, backward compatible):

```json
{
  "job_id": "uuid",
  "status": "completed",
  "status_message": "Application complete",

  "execution_mode": "auto",
  "browser_mode": "server",
  "final_mode": "cookbook",

  "manual": {
    "id": "manual-uuid",
    "status": "cookbook_success",
    "health_score": 95,
    "fallback_reason": null
  },

  "cost_breakdown": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0,
    "cookbook_steps": 8,
    "magnitude_steps": 0,
    "cookbook_cost_usd": 0.0005,
    "magnitude_cost_usd": 0.0
  },

  "progress": { "..." : "existing fields" },
  "result": { "..." : "existing fields" },
  "timestamps": { "..." : "existing fields" }
}
```

### manual.status values

| Status | Description |
|--------|-------------|
| `cookbook_success` | Manual found, cookbook executed successfully |
| `cookbook_failed_fallback` | Manual found, cookbook failed, fell back to Magnitude |
| `no_manual_available` | No matching manual in ManualStore |
| `ai_only` | `execution_mode` was 'ai_only' (cookbook skipped by request) |

---

## 3. Extended Callback Payload

**Webhook:** `POST {callback_url}`

Same new fields appended to existing `CallbackPayload`:

```json
{
  "job_id": "uuid",
  "valet_task_id": "uuid",
  "status": "completed",
  "result_data": {},
  "result_summary": "Application submitted",
  "screenshot_url": "https://...",
  "cost": { "total_cost_usd": 0.0005, "action_count": 8, "total_tokens": 0 },

  "execution_mode": "auto",
  "browser_mode": "server",
  "final_mode": "cookbook",
  "manual": {
    "id": "manual-uuid",
    "status": "cookbook_success",
    "health_score": 95,
    "fallback_reason": null
  },
  "cost_breakdown": {
    "total_cost_usd": 0.0005,
    "action_count": 8,
    "total_tokens": 0,
    "cookbook_steps": 8,
    "magnitude_steps": 0,
    "cookbook_cost_usd": 0.0005,
    "magnitude_cost_usd": 0.0
  },

  "completed_at": "2026-02-16T..."
}
```

---

## 4. Progress Event Extensions

`gh_job_events.metadata` for `progress_update` events now includes:

| Field | Type | Description |
|-------|------|-------------|
| `execution_mode` | string | Current mode: 'cookbook' or 'magnitude' |
| `manual_id` | string\|null | Active manual ID (if cookbook mode) |
| `step_cost_cents` | number | Per-step cost (reserved for Sprint 4) |

---

## 5. New Event Types

New `event_type` values in `gh_job_events`:

| Event | Description | metadata fields |
|-------|-------------|-----------------|
| `mode_selected` | Engine selects initial mode | `mode`, `manual_id?`, `reason` |
| `mode_switched` | Fallback from cookbook to magnitude | `from_mode`, `to_mode`, `reason` |
| `manual_found` | ManualStore.lookup returned a match | `manual_id`, `health_score`, `url_pattern` |
| `manual_created` | New manual saved from trace | `steps`, `url_pattern` |

---

## 6. What Changed (Before/After)

| Field | Before Sprint 3 | After Sprint 3 |
|-------|-----------------|----------------|
| `execution_mode` column | N/A | 'auto' (default) |
| `browser_mode` column | N/A | 'server' (default) |
| `final_mode` column | N/A | null until completion |
| Status: `manual` | N/A | Object or null |
| Status: `cost_breakdown` | N/A | Object or null |
| Callback: `manual` | N/A | Same as status |
| Callback: `cost_breakdown` | N/A | Same as status |
| Events: mode tracking | N/A | 4 new event types |

---

## 7. Integration Checklist for VALET Team

- [ ] Run migration `011_execution_mode_tracking.sql` on staging
- [ ] Update status polling to handle new optional fields (all null-safe)
- [ ] Update callback handler to parse optional `manual` and `cost_breakdown`
- [ ] (Optional) Display `final_mode` in VALET dashboard
- [ ] (Optional) Display `cost_breakdown` for cost analytics
- [ ] (Optional) Pass `execution_mode` in job creation to force mode
- [ ] Run migration on production after staging verification

---

## 8. curl Test Examples

### Create a job (unchanged)
```bash
curl -X POST http://localhost:3000/api/v1/gh/valet/apply \
  -H "Content-Type: application/json" \
  -H "X-GH-Service-Key: $SERVICE_KEY" \
  -d '{
    "valet_user_id": "user-uuid",
    "valet_task_id": "task-uuid",
    "target_url": "https://boards.greenhouse.io/acme/jobs/123",
    "callback_url": "https://valet.example.com/webhook",
    "profile": { "name": "Test User", "email": "test@example.com" }
  }'
```

### Poll status with new fields
```bash
curl -s http://localhost:3000/api/v1/gh/valet/status/{job_id} \
  -H "X-GH-Service-Key: $SERVICE_KEY" \
  | jq '{execution_mode, final_mode, manual, cost_breakdown}'
```

### Query mode events
```sql
SELECT event_type, metadata->>'mode' as mode,
       metadata->>'manual_id' as manual_id,
       metadata->>'reason' as reason
FROM gh_job_events
WHERE job_id = 'xxx'
  AND event_type IN ('mode_selected', 'mode_switched', 'manual_found', 'manual_created')
ORDER BY created_at;
```

---

## 9. Backward Compatibility

All changes are **additive**. Existing VALET clients that do not read the new fields continue to work unchanged:

- New columns have sensible defaults ('auto', 'server', NULL)
- New response fields are nullable/optional
- No changes to request schemas
- No changes to authentication
- No changes to existing callback payload fields
- No removal of existing fields

---

## 10. UI Visualization Guide

This section describes how VALET should consume Sprint 3 data to render mode switching, thinking, actions, and cost tracking in the dashboard UI.

### 10.1 Data Sources

VALET has **three ways** to get live data:

| Source | Mechanism | Latency | Use Case |
|--------|-----------|---------|----------|
| **Job row updates** | Supabase Realtime on `gh_automation_jobs` (existing) | ~100ms | Progress bar, mode badge, cost ticker |
| **Event stream** | Supabase Realtime on `gh_job_events` (NEW, migration 012) | ~100ms | Action timeline, mode switch animation, thinking feed |
| **Status polling** | `GET /valet/status/:jobId` | ~500ms | Fallback if Realtime unavailable |

### 10.2 Real-Time Event Subscription (NEW)

**Migration required:** `012_gh_job_events_realtime.sql` — adds `gh_job_events` to the `supabase_realtime` publication.

**Client code** (using `RealtimeSubscriber`):

```typescript
import { RealtimeSubscriber } from '@ghosthands/client';

const subscriber = new RealtimeSubscriber(supabase);

// Subscribe to all events for a job
const sub = subscriber.subscribeToJobEvents(jobId, {
  onEvent: (event) => {
    switch (event.event_type) {
      case 'mode_selected':
        // Initial mode chosen — update mode badge
        setCurrentMode(event.metadata.mode);       // 'cookbook' | 'magnitude'
        setManualId(event.metadata.manual_id);       // uuid | null
        setModeReason(event.metadata.reason);        // 'manual_found' | 'no_manual_found'
        break;

      case 'mode_switched':
        // Fallback happened — animate transition
        animateModeSwitch(event.metadata.from_mode, event.metadata.to_mode);
        setCurrentMode(event.metadata.to_mode);
        setFallbackReason(event.metadata.reason);
        break;

      case 'manual_found':
        // Show manual info badge
        setManualHealth(event.metadata.health_score);
        setManualPattern(event.metadata.url_pattern);
        break;

      case 'manual_created':
        // Show "New cookbook saved!" toast
        showToast(`Cookbook saved (${event.metadata.steps} steps)`);
        break;

      case 'progress_update':
        // Update progress bar + action description
        setProgress(event.metadata.progress_pct);
        setCurrentAction(event.metadata.current_action);
        setExecutionMode(event.metadata.execution_mode);
        break;

      case 'step_started':
        // Add to action timeline
        appendTimeline({
          action: event.metadata.current_action,
          mode: event.metadata.execution_mode || 'magnitude',
          timestamp: event.created_at,
        });
        break;
    }
  },
  onError: (err) => console.error('Event stream error:', err),
  autoUnsubscribe: true,  // Auto-cleanup on job completion
});

// Also subscribe to progress for the progress bar + mode
subscriber.subscribeToJobProgress(jobId, {
  onProgress: (progress) => {
    setProgress(progress.progress_pct);
    setStep(progress.step);
    setDescription(progress.description);
    setExecutionMode(progress.execution_mode);   // 'cookbook' | 'magnitude'
    setManualId(progress.manual_id);             // uuid | null
    setElapsedMs(progress.elapsed_ms);
    setEtaMs(progress.eta_ms);
  },
});

// Cleanup on component unmount
return () => sub.unsubscribe();
```

### 10.3 UI Components

#### Mode Badge

Shows the current execution mode with a color indicator.

```
State Machine:
  [initializing] → [mode_selected event] → show badge

Badge variants:
  - "Cookbook"   — green — replaying from saved manual, near-zero cost
  - "AI Agent"  — blue  — Magnitude LLM mode, full exploration
  - "Hybrid"    — amber — started cookbook, fell back to AI Agent

Data source: progress.execution_mode (from subscribeToJobProgress)
             OR mode_selected event (from subscribeToJobEvents)
```

| Mode | Badge Color | Icon | Tooltip |
|------|-------------|------|---------|
| `cookbook` | Green | Replay icon | "Replaying saved manual — near-zero AI cost" |
| `magnitude` | Blue | Brain icon | "AI Agent exploring — full LLM reasoning" |
| `hybrid` | Amber | Switch icon | "Started cookbook, fell back to AI Agent" |

#### Mode Switch Animation

When `mode_switched` event fires, animate the transition:

```
Event: mode_switched { from_mode: 'cookbook', to_mode: 'magnitude', reason: 'step_failed' }

UI sequence:
  1. Badge pulses amber for 1s
  2. Slide transition: green badge → blue badge
  3. Show inline message: "Cookbook step failed — switching to AI Agent"
  4. After 3s, fade out the message
```

#### Action Timeline

A scrolling list of actions performed, color-coded by mode.

```
Data source: subscribeToJobEvents with eventTypes filter

Timeline entry structure:
  [timestamp] [mode-dot] [action description]

Examples:
  10:32:01  🟢  Navigated to application page
  10:32:02  🟢  Filled "First Name" with "Alice"
  10:32:02  🟢  Filled "Email" with "alice@example.com"
  10:32:03  🟢  Clicked "Submit Application"
  10:32:03  🟢  ✓ Cookbook complete (4 steps, $0.0005)

Or with fallback:
  10:32:01  🟢  Navigated to application page
  10:32:02  🟢  Filled "First Name" with "Alice"
  10:32:03  🟠  Cookbook step failed: "Submit" button not found
  10:32:03  🔵  Switching to AI Agent...
  10:32:04  🔵  Analyzing page structure
  10:32:05  🔵  Found alternative submit: "Apply Now" button
  10:32:06  🔵  Clicked "Apply Now"
  10:32:07  🔵  ✓ Application submitted via AI Agent ($0.018)

Color key:
  🟢 = cookbook step
  🔵 = magnitude (AI Agent) step
  🟠 = mode switch / warning
```

#### Thinking Feed

Shows the AI agent's current reasoning (only visible in Magnitude mode).

```
Data source: progress.current_action from subscribeToJobProgress

Display:
  - Only show when execution_mode === 'magnitude'
  - Fade in/out as current_action changes
  - Italic text, dimmed color
  - Example: "Looking for the submit button on this page..."

When execution_mode === 'cookbook':
  - Show step progress instead: "Step 3/8: Filling email field"
```

#### Cost Breakdown Panel

Real-time cost tracker showing per-mode costs.

```
Data source: GET /valet/status/:jobId → cost_breakdown
             OR callback payload → cost_breakdown

Layout:
  ┌─────────────────────────────────────────┐
  │ Cost Breakdown                          │
  │                                         │
  │  Cookbook    8 steps    $0.0005   🟢     │
  │  AI Agent   0 steps    $0.00     🔵     │
  │  ─────────────────────────────────      │
  │  Total      8 actions   $0.0005         │
  │                                         │
  │  💰 95% cheaper than full AI run        │
  └─────────────────────────────────────────┘

Fields from cost_breakdown:
  - cookbook_steps / cookbook_cost_usd
  - magnitude_steps / magnitude_cost_usd
  - total_cost_usd / action_count / total_tokens

Savings calculation:
  estimated_ai_cost = action_count * 0.0025  // ~$0.0025 per AI step
  savings_pct = (1 - total_cost_usd / estimated_ai_cost) * 100
```

#### Manual Health Indicator

Shows the health status of the manual used (if any).

```
Data source: status response → manual object

Display (when manual.status === 'cookbook_success'):
  "📖 Cookbook: Greenhouse Apply (95% health)"
  Green health bar: ████████░░ 95%

Display (when manual.status === 'cookbook_failed_fallback'):
  "📖 Cookbook failed — fell back to AI Agent"
  "Reason: Submit button not found"
  Orange health bar: ██████░░░░ 60%

Display (when manual.status === 'no_manual_available'):
  "📖 No cookbook available — training new one..."
  Gray placeholder

Display (when manual.status === 'ai_only'):
  "🤖 AI-only mode (user requested)"
```

### 10.4 Event Timeline Query (Historical)

For completed jobs, fetch the full event timeline from `gh_job_events`:

```sql
SELECT
  event_type,
  message,
  metadata,
  created_at
FROM gh_job_events
WHERE job_id = $1
  AND event_type IN (
    'mode_selected', 'mode_switched', 'manual_found', 'manual_created',
    'step_started', 'step_completed', 'progress_update',
    'cookbook_step_completed', 'cookbook_step_failed'
  )
ORDER BY created_at ASC;
```

Or via REST (Supabase PostgREST):

```bash
curl -s "https://$SUPABASE_URL/rest/v1/gh_job_events?\
job_id=eq.$JOB_ID&\
event_type=in.(mode_selected,mode_switched,manual_found,step_started,progress_update)&\
order=created_at.asc" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY"
```

### 10.5 Recommended Polling Fallback

If Supabase Realtime is unavailable (firewall, plan limitations), VALET can poll:

```typescript
// Poll every 2s while job is running
const pollInterval = setInterval(async () => {
  const res = await fetch(`/api/v1/gh/valet/status/${jobId}`, {
    headers: { 'X-GH-Service-Key': serviceKey },
  });
  const data = await res.json();

  // Update UI from status response
  setExecutionMode(data.execution_mode);
  setFinalMode(data.final_mode);
  setManualInfo(data.manual);
  setCostBreakdown(data.cost_breakdown);

  if (['completed', 'failed', 'cancelled', 'expired'].includes(data.status)) {
    clearInterval(pollInterval);
  }
}, 2000);
```

### 10.6 Updated Integration Checklist (UI)

- [ ] Run migration `012_gh_job_events_realtime.sql` on staging
- [ ] Add Supabase Realtime subscription for `gh_job_events` (or use `RealtimeSubscriber.subscribeToJobEvents()`)
- [ ] Render mode badge (cookbook/AI Agent/hybrid) from `progress.execution_mode`
- [ ] Render action timeline from event stream
- [ ] Render thinking feed from `progress.current_action` (magnitude mode only)
- [ ] Render cost breakdown panel from status `cost_breakdown`
- [ ] Handle mode switch animation on `mode_switched` event
- [ ] Show manual health when `manual_found` event received
- [ ] Show "new cookbook saved" toast on `manual_created` event
- [ ] Add polling fallback for environments without Supabase Realtime
