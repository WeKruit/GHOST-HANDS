# Designer Brief: WeKruit Valet — Complete UX Workflow

> **Purpose**: Comprehensive reference for designing all screens, interactions, and flows across the Valet web dashboard and Chrome extension. Covers every user-facing surface from first touch to power-user workflows across all 4 subscription tiers.

---

## 1. User Personas

### 1.1 Individual Job Seeker (Primary)

**Profile**: Recent graduate or mid-career professional applying to 10-50+ jobs per week. Technically comfortable but not a developer. Values time savings and accuracy over granular control.

**Goals**:
- Reduce repetitive form-filling across job boards
- Maintain accuracy — no wrong answers submitted on their behalf
- Track application status in one place
- Build confidence that automation won't get them flagged or rejected

**Pain Points**:
- Spends 30-60 min per application on multi-page forms
- Keeps losing track of which jobs they applied to
- Worried about browser fingerprinting and detection
- Wants to review AI-generated answers before submission

**Tier Journey**: Free (extension-only) → Local (companion app) → Starter (cloud copilot) → Pro (autopilot + batch)

### 1.2 Agency Operator (Secondary — Future)

**Profile**: Staffing agency or career coach managing applications for multiple clients. Needs multi-profile support, bulk operations, and reporting.

**Goals**:
- Manage 5-50 candidate profiles simultaneously
- Run batch applications across multiple job postings
- Generate reports on application success rates
- White-label or co-brand the service

**Tier Journey**: Pro → Premium (dedicated infrastructure + API access)

### 1.3 Admin / Internal Operator

**Profile**: WeKruit team member monitoring platform health, managing users, and debugging failed automations.

**Goals**:
- Monitor system health across all sandbox tiers
- Debug failed applications with full session recordings
- Manage user accounts and subscription overrides
- View aggregate metrics and conversion funnels

**Access**: Internal admin panel (not covered in this brief — separate backoffice project)

---

## 2. Subscription Tiers & User Journeys

### 2.1 Tier Overview

| Aspect | Free | Local ($9-12/mo) | Starter ($19/mo) | Pro ($39/mo) | Premium ($79-99/mo) |
|--------|------|-------------------|------------------|--------------|---------------------|
| **Sandbox** | User's browser (extension) | User's machine (companion app) | Browserbase cloud | Browserbase cloud | EC2 + AdsPower |
| **Mode** | Copilot only | Copilot + Autopilot | Copilot (Autopilot after 3 apps) | Copilot + Autopilot | Copilot + Autopilot |
| **Applications/mo** | 10 | 30 | 50 | 200 | Unlimited |
| **Batch Queue** | No | No | No | Yes (5 concurrent) | Yes (20 concurrent) |
| **Live View** | Extension overlay | Extension overlay | noVNC embed | Browserbase LiveView iframe | noVNC embed |
| **Anti-detect** | User's own browser | User's own Chrome | Browserbase stealth | Browserbase stealth | AdsPower fingerprint profiles |
| **Engine Cascade** | DOM only | DOM → CUA → Magnitude | Stagehand DOM → CUA | DOM → CUA → Magnitude | DOM → CUA → Magnitude → Human |
| **Human Fallback** | Self (extension prompt) | Self (extension overlay) | VNC takeover | LiveView iframe | VNC takeover + priority queue |
| **Session Recording** | No | No | Last 5 sessions | All sessions (30 days) | All sessions (90 days) |
| **Q&A Bank** | 20 entries | 50 entries | 100 entries | Unlimited | Unlimited + auto-learn |
| **API Access** | No | No | No | No | Yes (REST + webhooks) |

### 2.2 Free Tier Journey

```
Install Extension → Google Sign-in → Onboarding (upload resume, review profile)
    ↓
Browse job boards normally → See "Fill with Valet" button on forms
    ↓
Click Fill → Extension analyzes form → Shows field-by-field preview with confidence
    ↓
Review each field → Edit as needed → Click "Submit" (user submits manually)
    ↓
Application tracked in extension popup → Synced to dashboard
    ↓
After 10 apps/month → Upgrade prompt → Local tier
```

**Key UX Moments**:
- First Fill: celebratory animation, tooltip explaining confidence scores
- 5th application: prompt to try Local for smarter engines
- 10th application: soft gate — "You've used all free applications this month"
- Every failed fill: "Upgrade for smarter engines and fallback"

### 2.3 Local Tier Journey

```
Upgrade → Download companion app installer → Run installer
    ↓
Installer registers Native Messaging host → Extension detects companion
    ↓
Paste job URL in extension side panel → Start application
    ↓
Extension → Native Messaging → Companion launches Chrome with CDP
    ↓
Companion runs Stagehand/Magnitude locally → Reports progress to extension
    ↓
Live progress overlay on job application page (8-step timeline)
    ↓
Copilot mode: AI fills fields → Pauses for review in extension panel
    ↓
User reviews fields, edits, approves → AI submits
    ↓
After 3 successful apps: Autopilot mode unlocks (AI submits without pause)
```

**Key UX Moments**:
- Companion installation: one-time setup with progress indicator
- First local automation: "Running on your machine" badge
- Extension overlay shows live progress with engine indicator
- Companion health check: green dot in extension popup when running
- Fallback to cloud: "Upgrade to Starter for cloud automation when AFK"

### 2.4 Starter Tier Journey

```
Sign up / Upgrade → Dashboard unlocks cloud features
    ↓
Paste job URL in Apply page → Select resume → Start application
    ↓
Task created → Queued → EC2 + AdsPower spins up sandbox
    ↓
Live progress in dashboard (8-step timeline, WebSocket updates)
    ↓
Copilot mode: AI fills fields → Pauses at "waiting_human" → Field review panel
    ↓
User reviews fields, edits, approves → AI submits
    ↓
After 3 successful copilot apps: Autopilot mode unlocks
    ↓
Autopilot: AI fills + submits without pause (user notified on completion)
```

**Key UX Moments**:
- First cloud application: guided tour of progress timeline
- Autopilot unlock: congratulatory modal with explanation of the mode
- VNC takeover: "AI needs help" notification → embedded VNC viewer
- Session recording playback: available in task detail after completion

### 2.5 Pro Tier Journey

```
Upgrade → Batch queue and advanced features unlock
    ↓
Batch mode: Paste multiple URLs or upload CSV → Queue management screen
    ↓
Concurrent applications (up to 5) with individual progress tracking
    ↓
Browserbase LiveView: watch automation live in embedded iframe
    ↓
Engine cascade: DOM → CUA → Magnitude with automatic switching
    ↓
All sessions recorded → Playback in task detail → Analytics dashboard
```

**Key UX Moments**:
- First batch operation: walkthrough of queue management
- LiveView: full-screen mode with takeover capability
- Engine switch notification: "Switching to visual AI for complex form element"
- Monthly analytics email: success rate, time saved, applications completed

### 2.6 Premium Tier Journey

```
Upgrade → Dedicated infrastructure + API access
    ↓
API keys page: generate tokens, configure webhooks
    ↓
Priority queue: applications processed first, 20 concurrent
    ↓
Human fallback queue: dedicated operators for stuck applications
    ↓
90-day session recording archive → Export/download
    ↓
Auto-learn Q&A: system learns from corrections, suggests new entries
```

**Key UX Moments**:
- API documentation inline in dashboard
- Webhook test panel with live event stream
- Priority badge on all tasks in queue
- Human operator status: "An operator is reviewing your application"

---

## 3. Complete Screen Inventory

### 3.1 Web Dashboard Screens

#### Authentication & Onboarding

| Screen | Route | Status | Description |
|--------|-------|--------|-------------|
| Login | `/login` | Built | Google OAuth with trust signals (AES-256, SOC 2, GDPR) |
| Onboarding Step 1 | `/onboarding/upload` | Built | Resume upload (drag-and-drop, PDF/DOCX) |
| Onboarding Step 2 | `/onboarding/review` | Built | Review parsed resume data, edit profile fields |
| Onboarding Step 3 | `/onboarding/disclaimer` | Built | Terms of service, automation disclaimer, get started |
| Plan Selection | `/onboarding/plan` | **New** | Tier comparison, free tier default, upgrade CTAs |

#### Core Application

| Screen | Route | Status | Description |
|--------|-------|--------|-------------|
| Dashboard | `/dashboard` | Built | Stats cards, active tasks, recent applications, WS indicator |
| Apply (Single) | `/apply` | Built | URL input, platform detection, resume selector, mode indicator |
| Apply (Batch) | `/apply/batch` | **New** | Multi-URL input or CSV upload, queue preview, Pro+ only |
| Task List | `/tasks` | Built | Paginated task list with status badges, mode indicators |
| Task Detail | `/tasks/:id` | Built | Status, progress timeline, field review, error details |
| Task Detail — Live View | `/tasks/:id/live` | **New** | Embedded VNC/LiveView for watching automation |
| Task Detail — Recording | `/tasks/:id/recording` | **New** | Session recording playback (Starter+) |

#### Settings

| Screen | Route | Status | Description |
|--------|-------|--------|-------------|
| Settings — Resumes | `/settings/resumes` | Built | Upload, manage, parse status, set default |
| Settings — Profile | `/settings/profile` | Built | Personal info, skills, work history, education |
| Settings — Q&A Bank | `/settings/answers` | Built | CRUD for Q&A entries, categories, usage modes |
| Settings — Automation | `/settings/automation` | Built | Copilot/Autopilot toggle with lock gate |
| Settings — Billing | `/settings/billing` | **New** | Current plan, usage, upgrade/downgrade, payment method |
| Settings — API Keys | `/settings/api` | **New** | Token generation, webhook config (Premium only) |
| Settings — Notifications | `/settings/notifications` | **New** | Email/push preferences, alert thresholds |

#### Analytics & Reporting (Pro+)

| Screen | Route | Status | Description |
|--------|-------|--------|-------------|
| Analytics | `/analytics` | **New** | Success rates, time saved, platform breakdown, trends |
| Batch Queue | `/queue` | **New** | Active batch jobs, queue position, pause/resume/cancel |

### 3.2 Chrome Extension Screens

| Surface | Trigger | Status | Description |
|---------|---------|--------|-------------|
| Popup | Click extension icon | **New** | Quick stats, recent apps, login state, tier badge |
| Side Panel | Click "Open Valet" in popup | **New** | Full task list, apply form, settings access |
| Content Script — Fill Button | Detect job application form | **New** | Floating "Fill with Valet" button on form pages |
| Content Script — Field Overlay | After fill, per-field | **New** | Inline confidence badges, edit buttons on each field |
| Content Script — Review Panel | All fields filled | **New** | Bottom sheet or sidebar with full review + submit |
| Content Script — Progress Toast | During automation | **New** | Small floating progress indicator during fill |
| Options Page | Extension settings | **New** | Login, tier display, preferences, keyboard shortcuts |

---

## 4. Key Interactions

### 4.1 Live Automation View

The live automation view is the core differentiator — users watch the AI fill out their application in real time.

**Implementation per tier**:

| Tier | Technology | Latency | User Action |
|------|-----------|---------|-------------|
| Free | Extension content script overlay | Instant | Watches form fields populate |
| Starter | noVNC WebSocket → EC2 desktop | ~200ms | Can observe, takeover on intervention |
| Pro | Browserbase LiveView `<iframe>` | ~150ms | Can observe, click to takeover |
| Premium | noVNC WebSocket → Fly Machine | ~100ms | Can observe, takeover, annotate |

**Live View Screen Layout** (web dashboard):

```
┌──────────────────────────────────────────────────────────┐
│ ← Back to Task    Task #1234    ● LIVE    [Full Screen]  │
├────────────────────────────────┬─────────────────────────┤
│                                │  Progress Timeline      │
│                                │  ✓ Queued               │
│                                │  ✓ Starting sandbox     │
│   VNC / LiveView Embed         │  ● Analyzing form...    │
│   (Resizable)                  │  ○ Filling fields       │
│                                │  ○ Review               │
│                                │  ○ Submitting           │
│                                │  ○ Done                 │
│                                ├─────────────────────────┤
│                                │  Current Action         │
│                                │  "Filling: Work Auth."  │
│                                ├─────────────────────────┤
│                                │  [Take Over] [Cancel]   │
├────────────────────────────────┴─────────────────────────┤
│  Engine: Stagehand DOM  |  Sandbox: Browserbase  |  2:34 │
└──────────────────────────────────────────────────────────┘
```

**Key behaviors**:
- Auto-opens when task transitions to `in_progress`
- "Take Over" button pauses AI and gives user mouse/keyboard control
- Engine badge updates in real-time when cascade switches engines
- Timer shows elapsed time since task started
- Full-screen mode hides sidebar and fills viewport

### 4.2 Human-in-the-Loop (HITL) Intervention

Intervention triggers when:
1. Engine cascade exhausted (all engines failed on a field)
2. CAPTCHA detected
3. Multi-factor auth required
4. Unexpected page navigation
5. Confidence below threshold on critical field (e.g., salary expectation)

**HITL Flow**:

```
AI encounters obstacle → Sets task status to "waiting_human"
    ↓
Dashboard: Task badge turns amber, notification sound
    ↓
If VNC/LiveView available:
    → "AI needs your help" banner in live view
    → Highlight the problematic element with red border
    → Instruction text: "Please complete the CAPTCHA" / "Please fill in: Expected Salary"
    → User interacts directly in VNC/LiveView
    → User clicks "Resume AI" button → AI continues from where it left off
    ↓
If Extension (Free tier):
    → Extension popup notification
    → Content script highlights stuck field
    → User fills field manually
    → Extension detects change → Reports to API → AI marks field complete
    ↓
If user doesn't respond within timeout (configurable, default 5 min):
    → Task status → "timed_out"
    → Notification: "Application paused — please review"
    → User can resume later from task detail page
```

**HITL notification hierarchy**:
1. In-app banner (if dashboard is open and focused)
2. Browser push notification (if enabled)
3. Email (if push not enabled, after 2 min delay)

### 4.3 Field-by-Field Review (Copilot Mode)

This is the core quality assurance step in Copilot mode. The AI fills all fields, then pauses for user review before submission.

**Current Implementation** (built in `field-review.tsx`):

```
┌─────────────────────────────────────────────────────────┐
│ Review Application Fields                               │
│ Review the AI-filled fields below. Edit any values      │
│ before submitting.                                      │
├───────────┬──────────────────┬────────┬─────────────────┤
│ Field     │ Value            │ Conf.  │ Source          │
├───────────┼──────────────────┼────────┼─────────────────┤
│ Full Name │ [Adam Smith    ] │ 98%    │ 📄 Resume      │
│ Email     │ [adam@email.com] │ 99%    │ 📄 Resume      │
│ Phone     │ [+1 555-0123  ] │ 95%    │ 📄 Resume      │
│ Salary    │ [85,000       ] │ 62%    │ 🤖 AI Generated│
│ Work Auth │ [Yes           ] │ 100%   │ 💬 Q&A Bank    │
│ Start     │ [2 weeks      ] │ 45%    │ 🤖 AI Generated│
│ Cover Ltr │ [View/Edit...  ] │ 78%    │ 🤖 AI Generated│
├───────────┴──────────────────┴────────┴─────────────────┤
│                              [Reject All] [Approve & ✓] │
└─────────────────────────────────────────────────────────┘
```

**Confidence color coding**:
- 90%+: Green — high confidence, likely correct
- 70-89%: Amber — moderate confidence, worth reviewing
- <70%: Red — low confidence, user should verify or edit

**Source badges**:
- Resume: Extracted from parsed resume data
- AI Generated: LLM-generated answer based on context
- Q&A Bank: Matched from user's saved Q&A entries

**Enhanced behaviors (to be built)**:
- Click on a field to expand inline editing with rich text for cover letters
- "Learn from correction" toggle — saves edited value to Q&A bank automatically
- Bulk approve: select multiple high-confidence fields at once
- Side-by-side view: show original form alongside review panel
- Diff view: highlight what changed from resume/Q&A bank source

### 4.4 Q&A Bank Interaction

The Q&A bank is the user's persistent knowledge base that the AI draws from when filling applications.

**Current Implementation** (built in `qa-bank-settings.tsx`):

Categories: work_authorization, experience, compensation, availability, identity, custom

Usage modes per entry:
- **Always use**: AI uses this answer automatically
- **Ask each time**: AI pauses for confirmation
- **Decline to answer**: AI leaves field blank or selects "prefer not to answer"

**Enhanced behaviors (to be built)**:
- **Auto-learn**: When user corrects a field in review, prompt "Save this answer for future applications?"
- **Smart suggestions**: After 5+ applications, suggest new Q&A entries based on repeated corrections
- **Import from resume**: Button to bulk-create Q&A entries from parsed resume data
- **Platform-specific overrides**: "Use this answer on LinkedIn, different answer on Greenhouse"
- **Conflict detection**: Alert when Q&A bank has conflicting answers for similar questions

### 4.5 Application Tracking

**Dashboard view** (current: stats cards + active tasks + recent applications):

```
┌─────────────────────────────────────────────────────────┐
│ Dashboard                                    ● Connected│
├─────────┬──────────┬──────────┬─────────────────────────┤
│ Total   │ Complete │ Active   │ Needs Review            │
│  47     │  38      │  3       │  2                      │
├─────────┴──────────┴──────────┴─────────────────────────┤
│ Active Tasks                                            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Senior Dev @ Stripe  ████████░░ 80%  Filling fields │ │
│ │ PM @ Notion          ██░░░░░░░░ 20%  Analyzing form │ │
│ │ Engineer @ Linear    ░░░░░░░░░░  0%  Queued         │ │
│ └─────────────────────────────────────────────────────┘ │
│ Recent Applications                                     │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ✓ Designer @ Figma      Completed    2 hours ago    │ │
│ │ ✗ Engineer @ Meta       Failed       3 hours ago    │ │
│ │ ● Analyst @ Google      In Progress  5 min ago      │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Enhanced tracking features (to be built)**:
- Filter/sort by status, platform, date range
- Search by company name or job title (requires storing parsed job data)
- Export to CSV/spreadsheet
- Calendar view: applications by date
- Response tracking: link to follow-up emails (future integration)

### 4.6 Batch Queue (Pro+)

Batch mode allows submitting multiple applications in a single operation.

**Batch Apply Screen**:

```
┌─────────────────────────────────────────────────────────┐
│ Batch Apply                              [Pro Feature]  │
├─────────────────────────────────────────────────────────┤
│ Add Job URLs                                            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Paste URLs (one per line) or upload CSV             │ │
│ │ https://linkedin.com/jobs/view/123456               │ │
│ │ https://greenhouse.io/company/job/789               │ │
│ │ https://lever.co/company/position                   │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│ [Upload CSV]  [Paste from clipboard]                    │
│                                                         │
│ Resume: [Default Resume ▾]   Mode: [Autopilot ▾]       │
│                                                         │
│ Queue Preview                          3 jobs detected  │
│ ┌────┬────────────────┬───────────┬───────────────────┐ │
│ │ #  │ URL            │ Platform  │ Status            │ │
│ ├────┼────────────────┼───────────┼───────────────────┤ │
│ │ 1  │ linkedin/123.. │ LinkedIn  │ Ready             │ │
│ │ 2  │ greenhouse/7.. │ Greenhouse│ Ready             │ │
│ │ 3  │ lever/positi.. │ Lever     │ Ready             │ │
│ └────┴────────────────┴───────────┴───────────────────┘ │
│                                                         │
│ Concurrency: [5 ▾] (max for Pro plan)                   │
│                                                         │
│ [Cancel]                              [Start Batch ▶]   │
└─────────────────────────────────────────────────────────┘
```

**Queue Management Screen** (`/queue`):

```
┌─────────────────────────────────────────────────────────┐
│ Batch Queue                    3 active / 12 total      │
├─────────────────────────────────────────────────────────┤
│ Batch #42 — Started 5 min ago              [Pause All]  │
│ ┌────┬────────────────┬────────┬────────┬─────────────┐ │
│ │ #  │ Job            │ Status │ Prog.  │ Action      │ │
│ ├────┼────────────────┼────────┼────────┼─────────────┤ │
│ │ 1  │ Dev @ Stripe   │●Active │ ███ 60%│ [View Live] │ │
│ │ 2  │ PM @ Notion    │●Active │ █░░ 20%│ [View Live] │ │
│ │ 3  │ Eng @ Linear   │●Active │ ░░░  5%│ [View Live] │ │
│ │ 4  │ Des @ Figma    │ Queued │ ░░░  — │ [Skip]      │ │
│ │ 5  │ Eng @ Meta     │ Queued │ ░░░  — │ [Skip]      │ │
│ │ 6  │ PM @ Airbnb    │⚠Review │ ███ 75%│ [Review]    │ │
│ │ 7  │ Dev @ Vercel   │✓ Done  │ ███100%│ [Details]   │ │
│ └────┴────────────────┴────────┴────────┴─────────────┘ │
│                                                         │
│ [Pause All] [Cancel Remaining] [Add More to Queue]      │
└─────────────────────────────────────────────────────────┘
```

### 4.7 Tier-Specific Settings

**Billing & Plan Screen** (`/settings/billing`):

```
┌─────────────────────────────────────────────────────────┐
│ Plan & Billing                                          │
├─────────────────────────────────────────────────────────┤
│ Current Plan: Starter ($19/mo)        [Manage Plan]     │
│ Billing cycle: Jan 15 – Feb 14                          │
│ Next charge: $19.00 on Feb 15                           │
│                                                         │
│ Usage This Period                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Applications  ████████████████░░░░  38/50           │ │
│ │ Q&A Entries   ████░░░░░░░░░░░░░░░░  22/100          │ │
│ │ Resumes       ██░░░░░░░░░░░░░░░░░░   2/5            │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ⚡ Upgrade to Pro for batch applications and LiveView   │
│    [Compare Plans]                                      │
│                                                         │
│ Payment Method                                          │
│ Visa ending in 4242  Exp 12/27       [Update Card]      │
│                                                         │
│ Billing History                                         │
│ Jan 15, 2026  $19.00  Starter Monthly  [Receipt]        │
│ Dec 15, 2025  $19.00  Starter Monthly  [Receipt]        │
└─────────────────────────────────────────────────────────┘
```

---

## 5. State Visibility

### 5.1 Task Status Model

```
created → queued → in_progress → waiting_human → in_progress → completed
                                                             → failed
                                                             → cancelled
                                                → timed_out
```

**Status badge colors** (existing):
- `created` / `queued` / `cancelled`: Default (grey)
- `in_progress`: Info (blue)
- `waiting_human`: Warning (amber)
- `completed`: Success (green)
- `failed`: Error (red)

### 5.2 Progress Timeline (8 Steps)

Currently implemented in `task-progress.tsx`:

| Step | Label | Description |
|------|-------|-------------|
| 1 | Queued | Task created, waiting for sandbox |
| 2 | Starting | Sandbox provisioning (browser profile, proxy) |
| 3 | Navigating | Opening job URL in sandbox browser |
| 4 | Analyzing | AI scanning form structure, identifying fields |
| 5 | Filling | AI populating fields from resume/Q&A/LLM |
| 6 | Review | Copilot: waiting for human review. Autopilot: self-verifying |
| 7 | Submitting | Clicking submit button, handling confirmations |
| 8 | Done | Application submitted, capturing confirmation |

**Visual states per step**:
- Completed: Green circle with check icon
- Current: Blue circle with spinning animation + pulsing dot
- Error: Red circle with alert triangle
- Pending: Grey hollow circle

### 5.3 Real-Time Updates (WebSocket)

Current implementation uses a Zustand store (`realtime.store.ts`) with WebSocket connection.

**Events pushed to client**:

| Event | Payload | UI Update |
|-------|---------|-----------|
| `task.progress` | `{ taskId, step, progress }` | Update progress bar + timeline |
| `task.status` | `{ taskId, status }` | Update badge, trigger notifications |
| `task.field_update` | `{ taskId, fields[] }` | Populate field review panel |
| `task.engine_switch` | `{ taskId, from, to }` | Update engine badge in live view |
| `task.intervention` | `{ taskId, reason, element }` | Trigger HITL notification + highlight |
| `task.error` | `{ taskId, error, recoverable }` | Show error details, offer retry |
| `task.completed` | `{ taskId, confirmationUrl? }` | Show success animation, update stats |

**Connection indicator** (current): Green dot with "Connected" / Red dot with "Disconnected" in dashboard header.

**Enhanced indicators (to be built)**:
- Reconnection countdown when disconnected
- Queued events that replay on reconnect
- Per-task live indicator (pulsing dot next to active tasks)
- Sound effects for key events (intervention needed, completion)

### 5.4 Sidebar Badge Counts

The sidebar navigation should show real-time badge counts:

```
📊 Dashboard
📋 Applications  (2)    ← "2" = tasks in waiting_human status
➕ Apply
📋 Queue         (5)    ← "5" = active batch items (Pro+)
⚙️ Settings
```

---

## 6. Error & Edge Cases

### 6.1 Automation Failure Scenarios

| Failure | Detection | User Experience | Recovery |
|---------|-----------|-----------------|----------|
| **Form not found** | DOM analysis returns 0 fields | "No application form detected on this page" | User verifies URL, retries |
| **Login wall** | Redirect to login page detected | "This job requires you to log in first" | HITL: user logs in via VNC/LiveView |
| **CAPTCHA** | CAPTCHA element detected | "CAPTCHA detected — please solve it" | HITL: user solves in VNC/LiveView |
| **Multi-page form timeout** | Page transition exceeds 30s | "Form navigation timed out" | Retry with fresh session |
| **Field type unsupported** | Engine can't interact with custom widget | "Complex form element detected — switching engine" | Engine cascade, then HITL |
| **Submission blocked** | Error message after submit click | "The website rejected the submission" | Show error text, user reviews fields |
| **Sandbox crash** | WebSocket disconnect + no heartbeat | "Connection to automation lost" | Auto-retry with new sandbox |
| **Rate limited** | HTTP 429 or "too many requests" text | "Job board is rate limiting — waiting to retry" | Exponential backoff, notify user |
| **Profile mismatch** | Resume data doesn't match form expectations | "Some fields couldn't be filled from your resume" | HITL for missing fields |

### 6.2 Rate Limit Handling

Per-platform rate limits tracked server-side:

```
┌─────────────────────────────────────────────────────────┐
│ ⚠ Rate Limit Active                                    │
│                                                         │
│ LinkedIn is temporarily limiting requests.               │
│ Your application will resume automatically in ~3 min.    │
│                                                         │
│ [████████░░░░░░░░░░░░]  Retrying in 2:47                │
│                                                         │
│ [Cancel Application]  [Switch to Different Job Board]    │
└─────────────────────────────────────────────────────────┘
```

### 6.3 Engine Switching Notification

When the automation engine cascade switches mid-task:

```
┌────────────────────────────────────────────┐
│ 🔄 Engine Switch                          │
│                                            │
│ Switching from Stagehand DOM to CUA        │
│ Reason: Complex dropdown widget detected   │
│                                            │
│ This may take a moment...                  │
└────────────────────────────────────────────┘
```

Displayed as a transient toast in the live view panel. Engine badge in footer updates immediately.

### 6.4 Network Disconnection

```
┌─────────────────────────────────────────────────────────┐
│ ⚠ Connection Lost                                      │
│                                                         │
│ Lost connection to the Valet server.                     │
│ Your active tasks continue running in the cloud.         │
│                                                         │
│ Reconnecting...  Attempt 3/5  (next in 8s)              │
│                                                         │
│ [Retry Now]                                              │
└─────────────────────────────────────────────────────────┘
```

### 6.5 Tier Limit Reached

```
┌─────────────────────────────────────────────────────────┐
│ Application Limit Reached                               │
│                                                         │
│ You've used 50/50 applications this month.               │
│ Your limit resets on Feb 15.                             │
│                                                         │
│ Upgrade to Pro for 200 applications/month               │
│ + batch queue + LiveView + session recordings.           │
│                                                         │
│ [View Plans]                [Remind Me Later]            │
└─────────────────────────────────────────────────────────┘
```

---

## 7. Chrome Extension UX

### 7.1 Architecture (Manifest V3)

```
Extension
├── Popup (click icon)          — Quick stats, login, tier badge
├── Side Panel (open from popup) — Full dashboard in sidebar
├── Content Scripts              — Injected into job board pages
│   ├── Form Detector            — Finds application forms
│   ├── Fill Button              — Floating action button
│   ├── Field Overlay            — Per-field confidence badges
│   └── Review Panel             — Full review before submit
├── Background Service Worker    — API communication, auth, state
└── Options Page                 — Full settings, login flow
```

### 7.2 Fill Button

**Appearance**: Floating pill-shaped button, appears when a job application form is detected on the page.

```
Position: Bottom-right of form container, or fixed bottom-right if form spans page
Size: ~140px × 40px
Style: Brand gradient (copilot blue or autopilot purple), rounded, subtle shadow
Animation: Slides in from right with spring animation, 500ms after form detection

┌──────────────────┐
│  ⚡ Fill with Valet │
└──────────────────┘
```

**States**:
- **Ready**: Default gradient, "Fill with Valet"
- **Filling**: Pulsing animation, "Filling..." with spinner
- **Done**: Green check, "Filled — Review Below"
- **Error**: Red, "Fill Failed — Retry?"
- **Disabled**: Grey, "Limit Reached" (free tier exhausted)
- **Logged out**: Grey outline, "Sign in to Fill"

**Behavior**:
1. Form detection runs on `DOMContentLoaded` and on SPA navigation events
2. Scans for `<form>` elements containing typical job application fields
3. Button positioned relative to form or fixed position if form is long
4. Click triggers analysis → fill → overlay flow
5. Draggable to reposition (stores last position per domain)
6. Dismissable with "X" button (re-appears on page reload)
7. Keyboard shortcut: `Ctrl+Shift+V` (configurable in options)

### 7.3 Field Overlay

After the AI fills fields, each form field gets an overlay badge showing confidence and source.

```
┌─────────────────────────────────────────────────────┐
│ Full Name                                            │
│ ┌──────────────────────────────────┐                 │
│ │ Adam Smith                  [98%]│ ← Confidence    │
│ └──────────────────────────────────┘   badge (green) │
│                                   📄 Resume           │
│                                   ↑ Source tooltip    │
│                                                      │
│ Expected Salary                                      │
│ ┌──────────────────────────────────┐                 │
│ │ 85,000                     [62%]│ ← Confidence    │
│ └──────────────────────────────────┘   badge (red)   │
│                                   🤖 AI Generated     │
│                                   [Edit] [Accept]     │
│                                   ↑ Action buttons    │
│                                     for low-conf      │
└─────────────────────────────────────────────────────┘
```

**Overlay positioning**:
- Small badge (confidence %) positioned at top-right corner of input field
- Source label appears on hover or when field is focused
- Low-confidence fields (<70%) automatically expand to show Edit/Accept buttons
- Color matches confidence thresholds (green/amber/red)

**Overlay behaviors**:
- Click badge to cycle through: show source, edit, accept, dismiss
- Hover on badge shows tooltip with full explanation: "98% — Extracted from your resume (page 1)"
- Edit opens inline editing (replaces input value, saves to Q&A bank if toggled)
- Overlays disappear after user manually edits a field (field is then user-controlled)
- Tab navigation works normally — overlays don't trap focus

### 7.4 Review Panel (Extension)

After all fields are filled, a review panel slides up from the bottom of the page.

```
┌─────────────────────────────────────────────────────────┐
│ Review Application                        Valet ● Free  │
│                                                         │
│ 12 fields filled  |  10 high confidence  |  2 to review │
│                                                         │
│ ⚠ Low Confidence Fields                                │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Expected Salary    [85,000      ]  62% 🤖           │ │
│ │ Start Date         [2 weeks     ]  45% 🤖           │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ✓ 10 fields auto-filled with high confidence            │
│   [Show All Fields]                                     │
│                                                         │
│ □ Save corrections to Q&A Bank                          │
│                                                         │
│ [Cancel]        [Edit on Page]        [Approve All ✓]   │
│                                                         │
│ You will submit the form manually after approving.      │
└─────────────────────────────────────────────────────────┘
```

**Behaviors**:
- Only low-confidence and AI-generated fields shown by default
- "Show All Fields" expands to full list
- "Edit on Page" scrolls to the first low-confidence field and focuses it
- "Approve All" marks all fields as accepted, hides panel, shows "Ready to Submit" badge
- Free tier: user must click the actual submit button themselves
- Paid tiers (via extension): can auto-submit after approval if in Autopilot mode

### 7.5 Popup

```
┌──────────────────────────────┐
│ Valet                  [Pro] │
│                              │
│ Applications this month      │
│ ████████████████░░░░  38/200 │
│                              │
│ Recent                       │
│ ✓ Stripe     2h ago          │
│ ✗ Meta       3h ago          │
│ ● Google     Active          │
│                              │
│ [Open Dashboard]             │
│ [Open Side Panel]            │
└──────────────────────────────┘
```

Width: 350px. Height: auto (max 500px with scroll).

### 7.6 Side Panel

The side panel mirrors the web dashboard in a narrow sidebar format (400px wide). Contains:
- Compact task list with status badges
- Quick-apply form (URL + resume selector)
- Compact Q&A bank editor
- Link to full dashboard

---

## 8. Upgrade Prompts & Conversion Moments

### 8.1 Conversion Strategy

The free tier is a "try before you buy" experience. Upgrade prompts appear at natural friction points, never blocking core functionality aggressively.

### 8.2 Prompt Triggers

| Trigger | Tier | Prompt | Location |
|---------|------|--------|----------|
| 5th application completed | Free | "You're on a roll! Upgrade for cloud automation." | Dashboard banner |
| Application limit reached | Free/Starter | "Limit reached — upgrade for more applications." | Apply page modal |
| First failed automation | Free | "Cloud tiers have smarter engines and human fallback." | Task detail error panel |
| CAPTCHA on Free tier | Free | "Paid tiers handle CAPTCHAs with human operators." | Extension notification |
| Batch URL pasted | Starter | "Upgrade to Pro for batch applications." | Apply page inline |
| Autopilot lock gate | Free/Starter | "Complete 3 copilot applications to unlock Autopilot." | Settings automation tab |
| Session recording request | Free | "Upgrade to Starter to record and replay sessions." | Task detail action |
| API key request | Pro | "API access is available on Premium." | Settings API tab |
| 80% usage threshold | Any | "You're approaching your monthly limit." | Dashboard notification |
| After successful batch | Pro | "Need more concurrency? Premium supports 20 concurrent." | Queue completion |

### 8.3 Prompt Design Principles

1. **Show value first**: Always demonstrate what the free tier can do before asking to upgrade
2. **Contextual, not interruptive**: Prompts appear in relevant locations, not as random pop-ups
3. **Dismissable**: Every prompt can be dismissed and won't reappear for 7 days
4. **Progressive**: Prompts get more prominent as usage increases (banner → inline → modal)
5. **Honest**: Show exact pricing and what changes. No dark patterns or hidden fees.

### 8.4 Plan Comparison Component

Used in onboarding, billing page, and upgrade modals:

```
┌───────────┬───────────┬───────────┬────────────┐
│   Free    │  Starter  │    Pro    │  Premium   │
│   $0/mo   │  $19/mo   │  $39/mo   │  $79-99/mo │
├───────────┼───────────┼───────────┼────────────┤
│ 10 apps   │ 50 apps   │ 200 apps  │ Unlimited  │
│ Extension │ Cloud     │ Cloud     │ Dedicated  │
│ Copilot   │ Co+Auto   │ Co+Auto   │ Co+Auto    │
│ —         │ —         │ Batch     │ Batch      │
│ —         │ VNC       │ LiveView  │ VNC+API    │
│ —         │ 5 record  │ All (30d) │ All (90d)  │
│ 20 Q&A    │ 100 Q&A   │ Unlimited │ Unl+Learn  │
│           │           │           │            │
│ [Current] │ [Upgrade] │ [Upgrade] │ [Contact]  │
└───────────┴───────────┴───────────┴────────────┘
```

---

## 9. Text-Based Wireframe Descriptions

### 9.1 Login Page (Existing — Reference)

**Layout**: Centered card on gradient background.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│              ┌─────────────────────────┐                │
│              │     🟢 Valet Logo       │                │
│              │                         │                │
│              │  Automate your job      │                │
│              │  applications           │                │
│              │                         │                │
│              │  [Sign in with Google]  │                │
│              │                         │                │
│              │  🔒 AES-256 | SOC 2 |  │                │
│              │     GDPR Compliant     │                │
│              └─────────────────────────┘                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 9.2 Dashboard (Enhanced — Full Design)

**Layout**: Sidebar (240px) + Main content. Header with search and user menu.

```
┌────────┬────────────────────────────────────────────────┐
│ VALET  │  Dashboard                    🔔  👤 Adam ▾    │
│        │                                                │
│ 📊 Dash│  Welcome back, Adam          ● Connected      │
│ 📋 Apps│                                                │
│ ➕ Apply│  ┌──────┬──────┬──────┬──────────┐            │
│ 📋Queue│  │Total │Done  │Active│ Review   │            │
│ ⚙️ Set │  │ 47   │ 38   │  3   │   2      │            │
│        │  └──────┴──────┴──────┴──────────┘            │
│        │                                                │
│        │  ┌─ Active Tasks ─────────────────────────┐   │
│        │  │ Senior Dev @ Stripe  ████████░░ 80%     │   │
│        │  │ PM @ Notion          ██░░░░░░░░ 20%     │   │
│        │  │ Engineer @ Linear    ░░░░░░░░░░ Queued  │   │
│        │  └─────────────────────────────────────────┘   │
│        │                                                │
│        │  ┌─ Recent Applications ──────────────────┐   │
│        │  │ ✓ Designer @ Figma   Completed   2h ago │   │
│        │  │ ✗ Engineer @ Meta    Failed      3h ago │   │
│        │  │ ⚠ Analyst @ Google   Needs Review  5m   │   │
│        │  └─────────────────────────────────────────┘   │
│        │                                                │
│        │  ┌─ Usage ────────────────────────────────┐   │
│ Theme  │  │ Applications ████████░░░░  38/50       │   │
│ 🌙     │  │ Plan: Starter  [Upgrade to Pro →]      │   │
│ v1.0   │  └─────────────────────────────────────────┘   │
└────────┴────────────────────────────────────────────────┘
```

### 9.3 Apply Page — Single Application (Existing — Reference)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  New Application                               │
│        │                                                │
│        │  Job URL                                       │
│        │  ┌────────────────────────────────────────┐    │
│        │  │ https://                               │    │
│        │  └────────────────────────────────────────┘    │
│        │  Platform: ● Auto-detected                     │
│        │                                                │
│        │  Sample URLs:                                  │
│        │  [LinkedIn] [Greenhouse] [Lever] [Workday]     │
│        │                                                │
│        │  Resume                                        │
│        │  ┌────────────────────────────────────────┐    │
│        │  │ Adam_Smith_Resume.pdf           ▾      │    │
│        │  └────────────────────────────────────────┘    │
│        │                                                │
│        │  Additional Notes (optional)                   │
│        │  ┌────────────────────────────────────────┐    │
│        │  │                                        │    │
│        │  └────────────────────────────────────────┘    │
│        │                                                │
│        │  Mode: 🟦 Copilot — AI fills, you review      │
│        │                                                │
│        │                      [Start Application ▶]     │
└────────┴────────────────────────────────────────────────┘
```

### 9.4 Task Detail with Live View (New — Key Screen)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  ← Back     Task #1234      ● LIVE  [Expand]  │
│        ├────────────────────────────┬───────────────────┤
│        │                            │ Progress          │
│        │                            │ ✓ Queued          │
│        │                            │ ✓ Starting        │
│        │                            │ ✓ Navigating      │
│        │  ┌──────────────────────┐  │ ● Filling...      │
│        │  │                      │  │ ○ Review          │
│        │  │   VNC / LiveView     │  │ ○ Submitting      │
│        │  │   Embed              │  │ ○ Done            │
│        │  │                      │  │                   │
│        │  │   (live browser      │  ├───────────────────┤
│        │  │    session)          │  │ Details           │
│        │  │                      │  │ URL: linkedin/..  │
│        │  │                      │  │ Platform: LinkedIn│
│        │  └──────────────────────┘  │ Mode: Copilot     │
│        │                            │ Resume: Default   │
│        │                            │ Started: 2 min ago│
│        │  Engine: Stagehand DOM     ├───────────────────┤
│        │  Sandbox: Browserbase      │                   │
│        │  Elapsed: 2:34             │ [Take Over]       │
│        │                            │ [Cancel Task]     │
└────────┴────────────────────────────┴───────────────────┘
```

### 9.5 Task Detail with Field Review (Existing + Enhanced)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  ← Back     Task #1234       ⚠ Needs Review   │
│        ├────────────────────────────────────────────────┤
│        │  Senior Developer @ Stripe                     │
│        │  linkedin.com/jobs/view/123456                  │
│        │  🟦 Copilot  |  🟢 LinkedIn  |  5 min ago      │
│        │                                                │
│        │  Progress                                      │
│        │  ✓ Queued → Starting → Navigating → Analyzing  │
│        │  → Filling → ● Review → ○ Submit → ○ Done      │
│        │                                                │
│        │  ┌─ Field Review ─────────────────────────┐    │
│        │  │ Review AI-filled fields before submit   │    │
│        │  │                                         │    │
│        │  │ Full Name    [Adam Smith    ]  98% 📄   │    │
│        │  │ Email        [adam@wk.com   ]  99% 📄   │    │
│        │  │ Phone        [+1 555-0123  ]  95% 📄   │    │
│        │  │ ⚠ Salary    [85,000       ]  62% 🤖   │    │
│        │  │ Work Auth    [Yes           ] 100% 💬   │    │
│        │  │ ⚠ Start     [2 weeks      ]  45% 🤖   │    │
│        │  │ Cover Letter [View/Edit... ]  78% 🤖   │    │
│        │  │                                         │    │
│        │  │ □ Save corrections to Q&A Bank          │    │
│        │  │                                         │    │
│        │  │ [Reject All]           [Approve & ✓]    │    │
│        │  └─────────────────────────────────────────┘    │
└────────┴────────────────────────────────────────────────┘
```

### 9.6 Batch Queue Management (New — Pro+)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  Batch Queue              3 active / 12 total  │
│        ├────────────────────────────────────────────────┤
│        │  Batch #42  |  Started 5 min ago  |  [Pause]   │
│        │                                                │
│        │  ┌────┬────────────┬────────┬──────┬────────┐  │
│        │  │ #  │ Job        │ Status │ Prog │ Action │  │
│        │  ├────┼────────────┼────────┼──────┼────────┤  │
│        │  │ 1  │ Stripe Dev │ ● Live │ 60%  │ [View] │  │
│        │  │ 2  │ Notion PM  │ ● Live │ 20%  │ [View] │  │
│        │  │ 3  │ Linear Eng │ ● Live │  5%  │ [View] │  │
│        │  │ 4  │ Figma Des  │ Queued │  —   │ [Skip] │  │
│        │  │ 5  │ Meta Eng   │ Queued │  —   │ [Skip] │  │
│        │  │ 6  │ Airbnb PM  │ ⚠ Rev  │ 75%  │ [Rev.] │  │
│        │  │ 7  │ Vercel Dev │ ✓ Done │ 100% │ [Info] │  │
│        │  │ 8  │ Figma PM   │ ✗ Fail │  —   │[Retry] │  │
│        │  └────┴────────────┴────────┴──────┴────────┘  │
│        │                                                │
│        │  Summary: 1 complete, 3 active, 1 review,     │
│        │           2 queued, 1 failed                    │
│        │                                                │
│        │  [Pause All] [Cancel Remaining] [Add More]     │
└────────┴────────────────────────────────────────────────┘
```

### 9.7 Settings — Billing (New)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  Settings > Billing                            │
│        ├────────────────────────────────────────────────┤
│        │  [Resumes] [Profile] [Q&A Bank] [Automation]   │
│        │  [Billing] [Notifications] [API Keys]          │
│        │                                                │
│        │  Current Plan                                  │
│        │  ┌─────────────────────────────────────────┐   │
│        │  │ STARTER                      $19/month  │   │
│        │  │ 50 applications  |  Cloud automation    │   │
│        │  │ Renews Feb 15, 2026                     │   │
│        │  │                                         │   │
│        │  │ [Change Plan]  [Cancel Subscription]    │   │
│        │  └─────────────────────────────────────────┘   │
│        │                                                │
│        │  Usage This Period (Jan 15 — Feb 14)           │
│        │  Applications  ████████████████░░░░  38/50     │
│        │  Q&A Entries   ████░░░░░░░░░░░░░░░░  22/100    │
│        │  Resumes       ██░░░░░░░░░░░░░░░░░░   2/5      │
│        │                                                │
│        │  Payment Method                                │
│        │  💳 Visa ending in 4242  |  Exp 12/27          │
│        │  [Update Payment Method]                       │
│        │                                                │
│        │  Billing History                               │
│        │  Jan 15, 2026  $19.00  Starter  [Receipt ↗]    │
│        │  Dec 15, 2025  $19.00  Starter  [Receipt ↗]    │
│        │  Nov 15, 2025  $19.00  Starter  [Receipt ↗]    │
└────────┴────────────────────────────────────────────────┘
```

### 9.8 Settings — API Keys (New — Premium Only)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  Settings > API Keys                [Premium]  │
│        ├────────────────────────────────────────────────┤
│        │  API Keys                                      │
│        │                                                │
│        │  Use the Valet API to integrate job             │
│        │  applications into your own workflows.          │
│        │                                                │
│        │  ┌─────────────────────────────────────────┐   │
│        │  │ production-key-1       Created Jan 10   │   │
│        │  │ vlt_sk_1a2b3c...      [Copy] [Revoke]  │   │
│        │  ├─────────────────────────────────────────┤   │
│        │  │ test-key              Created Jan 5     │   │
│        │  │ vlt_sk_test_4d5...    [Copy] [Revoke]  │   │
│        │  └─────────────────────────────────────────┘   │
│        │  [+ Generate New Key]                          │
│        │                                                │
│        │  Webhooks                                      │
│        │  ┌─────────────────────────────────────────┐   │
│        │  │ https://myapp.com/webhooks/valet         │   │
│        │  │ Events: task.completed, task.failed      │   │
│        │  │ Status: ✓ Active    [Edit] [Delete]     │   │
│        │  └─────────────────────────────────────────┘   │
│        │  [+ Add Webhook]                               │
│        │                                                │
│        │  [View API Documentation ↗]                    │
└────────┴────────────────────────────────────────────────┘
```

### 9.9 Analytics Dashboard (New — Pro+)

```
┌────────┬────────────────────────────────────────────────┐
│ Sidebar│  Analytics           [Last 30 Days ▾]          │
│        ├────────────────────────────────────────────────┤
│        │                                                │
│        │  ┌──────┬──────┬──────┬──────────────────┐     │
│        │  │ 156  │ 89%  │ 42h  │  4.2 min         │     │
│        │  │ Total│ Succ.│ Saved│  Avg. Time        │     │
│        │  └──────┴──────┴──────┴──────────────────┘     │
│        │                                                │
│        │  Applications Over Time                        │
│        │  ┌─────────────────────────────────────────┐   │
│        │  │    ▂▃█▆▃▅▇█▅▃▆█▅▃▁▂▃▅▆▇█▆▃▂▁▂▃▅▇      │   │
│        │  │  Jan 15            Feb 1           Feb 13│   │
│        │  └─────────────────────────────────────────┘   │
│        │                                                │
│        │  By Platform            By Status              │
│        │  ┌──────────────┐      ┌──────────────┐       │
│        │  │ LinkedIn  62%│      │ Complete  89%│       │
│        │  │ Greenhouse18%│      │ Failed     6%│       │
│        │  │ Lever      12%│      │ Cancelled  3%│       │
│        │  │ Workday     5%│      │ Timeout    2%│       │
│        │  │ Other       3%│      └──────────────┘       │
│        │  └──────────────┘                              │
│        │                                                │
│        │  Engine Usage                                  │
│        │  Stagehand DOM  ████████████████░░  82%        │
│        │  Stagehand CUA  ██████░░░░░░░░░░░  14%        │
│        │  Magnitude      █░░░░░░░░░░░░░░░░   3%        │
│        │  Human Fallback ░░░░░░░░░░░░░░░░░   1%        │
└────────┴────────────────────────────────────────────────┘
```

### 9.10 Onboarding — Plan Selection (New)

```
┌─────────────────────────────────────────────────────────┐
│                Choose Your Plan                         │
│                                                         │
│  Step 4 of 4: ○───○───○───●                             │
│                                                         │
│  ┌──────────┬──────────┬──────────┬──────────┐          │
│  │  Free    │ Starter  │   Pro    │ Premium  │          │
│  │  $0/mo   │ $19/mo   │  $39/mo  │ $79/mo   │          │
│  │          │          │ Popular  │          │          │
│  │ 10 apps  │ 50 apps  │ 200 apps │ Unlim.   │          │
│  │ Ext only │ Cloud    │ Cloud    │ Dedic.   │          │
│  │ Copilot  │ +Autoplt │ +Batch   │ +API     │          │
│  │          │ VNC      │ LiveView │ Priority │          │
│  │          │          │ Record   │ 90d Arch │          │
│  │          │          │          │          │          │
│  │ [Start   │[Start    │[Start    │[Contact  │          │
│  │  Free]   │ Trial]   │ Trial]   │ Sales]   │          │
│  └──────────┴──────────┴──────────┴──────────┘          │
│                                                         │
│  All paid plans include a 7-day free trial.              │
│  Cancel anytime. No commitment.                          │
│                                                         │
│                    [Skip — Start Free →]                  │
└─────────────────────────────────────────────────────────┘
```

---

## 10. Design System Notes

### 10.1 Existing Design Tokens

The app uses CSS custom properties under the `--wk-*` namespace:

| Token | Purpose |
|-------|---------|
| `--wk-text-primary` | Primary text color |
| `--wk-text-secondary` | Secondary text color |
| `--wk-text-tertiary` | Tertiary/muted text color |
| `--wk-surface-sunken` | Inset/recessed surface (progress bar bg) |
| `--wk-copilot` | Copilot mode accent (blue) |
| `--wk-autopilot` | Autopilot mode accent (purple) |
| `--wk-shadow-md` | Medium shadow for hover states |

### 10.2 Component Library

Built on Radix UI + Tailwind CSS (`@valet/ui` package):

- `Card`, `CardContent`, `CardHeader`, `CardTitle`
- `Badge` with variants: `default`, `success`, `warning`, `error`, `info`, `copilot`, `autopilot`
- `Button` with variants and sizes
- `Dialog` for modals
- `Select` for dropdowns
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`
- `Input`, `Label`, `Textarea`

### 10.3 Typography

- Display font: `font-display` class (used for headings)
- Body font: system default sans-serif
- Monospace: used for code snippets, URLs

### 10.4 Layout Patterns

- Sidebar: 240px collapsed/expanded, fixed position
- Content area: fills remaining width, scrollable
- Cards: rounded corners, subtle borders, hover shadow
- Grid: responsive, `space-y-*` for vertical rhythm, `gap-*` for grid spacing
- Max content width: not constrained (fills available space)

---

## 11. Accessibility & Responsiveness

### 11.1 Accessibility Requirements

- All interactive elements must be keyboard navigable
- Focus states must be visible (not just color-based)
- Color coding (confidence scores) must have text/icon alternatives
- Live regions (`aria-live`) for real-time updates (progress, status changes)
- Screen reader announcements for task state transitions
- Extension overlay must not trap focus or break page tab order
- Minimum touch target: 44x44px for mobile-responsive views

### 11.2 Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| < 640px (sm) | Sidebar collapses to bottom nav, single column layout |
| 640-1024px (md) | Sidebar collapsed by default, task detail stacks vertically |
| 1024px+ (lg) | Full sidebar, side-by-side layouts |
| 1280px+ (xl) | Live view + sidebar panel in task detail |

### 11.3 Mobile Considerations

- Mobile web is view-only (no live automation control)
- Extension is desktop-only (Chrome on desktop)
- Mobile push notifications for HITL interventions
- Responsive task list and dashboard stats

---

## 12. Future Considerations

### 12.1 Not In Scope for V1 (Track for V2)

- Multi-profile support (agency use case)
- Team/organization management
- Custom form field mappings
- Integration marketplace (Slack, Notion, Airtable)
- Mobile native app
- White-label/co-branding
- Internationalization (i18n)
- Admin backoffice panel

### 12.2 Technical Constraints for Designers

- VNC embed is a `<canvas>` element — no HTML overlay on top of the VNC stream
- Browserbase LiveView is an `<iframe>` — limited styling control
- Extension content scripts must work across arbitrary web pages — avoid absolute positioning assumptions
- WebSocket updates are not guaranteed in order — UI must handle out-of-order events gracefully
- Session recordings are video files (webm) — player must support seek/speed controls
- Free tier runs entirely in the user's browser — no server-side rendering of the automation view
