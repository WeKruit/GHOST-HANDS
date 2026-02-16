# VALET Session Management Contract

**Date:** 2026-02-16
**Sprint:** 1 (Session Persistence)
**Status:** Implemented
**Breaking:** No (all additive)

---

## Summary

GhostHands now automatically persists browser sessions (cookies + localStorage) across jobs. When a user's job successfully logs into a site, the session is encrypted and stored. The next job for the same user + domain skips login entirely.

**Session persistence is transparent** — VALET does not need to pass sessions at job creation time. The JobExecutor handles load/save automatically.

However, VALET needs management endpoints to:
- Show users which sessions are stored
- Let users "log out everywhere" (clear all sessions)
- Clear sessions for a specific site (troubleshooting)

---

## How It Works

```
FIRST JOB for user + linkedin.com:
  JobExecutor → SessionManager.load(userId, "linkedin.com") → null
  → Fresh browser, no cookies
  → Job logs in, fills forms, completes
  → SessionManager.save(userId, "linkedin.com", storageState)
  → Encrypted, stored in gh_browser_sessions

NEXT JOB for user + linkedin.com:
  JobExecutor → SessionManager.load(userId, "linkedin.com") → decrypted storageState
  → Browser starts WITH saved cookies (already logged in)
  → Job skips login, fills forms directly — MUCH faster
  → SessionManager.save() refreshes the stored session
```

**Key points:**
- VALET does NOT pass sessions in job payloads
- Session load/save is automatic inside JobExecutor
- Sessions are keyed by `(user_id, domain)` — one session per user per site
- Sessions are encrypted at rest with AES-256-GCM
- Expired/corrupted sessions are auto-cleaned (graceful fallback to fresh browser)

---

## API Endpoints

All endpoints are under `/api/v1/gh/valet/` and protected by the same `X-GH-Service-Key` header as all VALET routes.

### 1. List Sessions — `GET /valet/sessions/:userId`

Returns all stored browser sessions for a user. **Does NOT return session data** (encrypted blobs) — only metadata.

**Request:**

```bash
GET /api/v1/gh/valet/sessions/00000000-0000-0000-0000-000000000001
X-GH-Service-Key: <service_key>
```

**Response (200):**

```jsonc
{
  "user_id": "00000000-0000-0000-0000-000000000001",
  "sessions": [
    {
      "domain": "linkedin.com",
      "last_used_at": "2026-02-16T10:30:00Z",
      "created_at": "2026-02-14T08:00:00Z",
      "updated_at": "2026-02-16T10:30:00Z",
      "expires_at": null
    },
    {
      "domain": "myworkdayjobs.com",
      "last_used_at": "2026-02-15T14:20:00Z",
      "created_at": "2026-02-15T14:20:00Z",
      "updated_at": "2026-02-15T14:20:00Z",
      "expires_at": "2026-02-22T14:20:00Z"
    }
  ],
  "count": 2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessions[].domain` | `string` | Site hostname (e.g., `linkedin.com`) |
| `sessions[].last_used_at` | `string` | Last time a job used this session |
| `sessions[].created_at` | `string` | When the session was first captured |
| `sessions[].updated_at` | `string` | Last time session data was refreshed |
| `sessions[].expires_at` | `string \| null` | Optional TTL; `null` = no expiry |
| `count` | `number` | Total number of stored sessions |

**Use in VALET UI:**
- Show a "Saved Logins" section in user settings
- Display each domain with "Last used" timestamp
- Offer per-domain "Remove" button and "Clear All" button

### 2. Clear Specific Session — `DELETE /valet/sessions/:userId/:domain`

Delete a single stored session for a user + domain.

**Request:**

```bash
DELETE /api/v1/gh/valet/sessions/00000000-0000-0000-0000-000000000001/linkedin.com
X-GH-Service-Key: <service_key>
```

**Response (200 — success):**

```jsonc
{
  "user_id": "00000000-0000-0000-0000-000000000001",
  "domain": "linkedin.com",
  "deleted": true
}
```

**Response (404 — no session found):**

```jsonc
{
  "error": "not_found",
  "message": "No session found for this user/domain"
}
```

**Note:** The domain in the URL path should be URL-encoded if it contains special characters (e.g., `my.workday.com` → `my.workday.com` — no encoding needed for dots).

**Use in VALET UI:**
- "Remove" button next to each saved login
- Confirm dialog: "Remove saved login for linkedin.com? The next job will need to log in again."

### 3. Clear All Sessions — `DELETE /valet/sessions/:userId`

Delete ALL stored sessions for a user ("log out everywhere").

**Request:**

```bash
DELETE /api/v1/gh/valet/sessions/00000000-0000-0000-0000-000000000001
X-GH-Service-Key: <service_key>
```

**Response (200):**

```jsonc
{
  "user_id": "00000000-0000-0000-0000-000000000001",
  "deleted_count": 3
}
```

**Use in VALET UI:**
- "Clear All Saved Logins" button in user settings
- Confirm dialog: "Remove all saved logins? Future jobs will need to log in again."

---

## Integration Checklist for VALET Team

### Display Stored Sessions

- [ ] Call `GET /valet/sessions/:userId` to fetch stored sessions
- [ ] Display sessions in user settings under "Saved Logins" or "Browser Sessions"
- [ ] Show: domain name, last used date, created date
- [ ] Show session count badge (e.g., "3 saved logins")

### Clear Individual Sessions

- [ ] Add "Remove" button per session row
- [ ] On click: `DELETE /valet/sessions/:userId/:domain`
- [ ] Show confirmation dialog before clearing
- [ ] Refresh list after successful deletion

### Clear All Sessions

- [ ] Add "Clear All" button
- [ ] On click: `DELETE /valet/sessions/:userId`
- [ ] Show confirmation dialog: "This will require re-login on all sites"
- [ ] Refresh list after successful deletion

### Handling Session-Related Job Failures

When a job fails with `login_required` error:
- [ ] Check if user has a stored session for that domain
- [ ] If yes: offer "Clear saved login and retry" (the stored session may be stale)
- [ ] If no: this is expected for first-time sites

---

## Database Schema

**Table:** `gh_browser_sessions`

```sql
CREATE TABLE gh_browser_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    domain TEXT NOT NULL,
    session_data TEXT NOT NULL,          -- AES-256-GCM encrypted JSON
    encryption_key_id TEXT NOT NULL,     -- tracks key version for rotation
    expires_at TIMESTAMPTZ,             -- optional session expiry
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gh_browser_sessions_user_domain UNIQUE (user_id, domain)
);
```

**Key properties:**
- One session per (user_id, domain) — enforced by UNIQUE constraint
- Session data is encrypted; only the worker can decrypt it
- `last_used_at` is updated every time a job loads the session
- `expires_at` is optional; the cleanup cron deletes expired rows

---

## Security Notes

- **No session data in API responses:** The list endpoint returns only metadata (domain, timestamps). Encrypted session data is never exposed via API.
- **Service key required:** All session endpoints require `X-GH-Service-Key` header — same as all VALET routes.
- **UUID validation:** User IDs are cast to `::UUID` in queries — no SQL injection risk.
- **RLS active:** Authenticated users can only SELECT/DELETE their own rows. Service role has full access.

---

## Backward Compatibility

| Scenario | Before | After |
|----------|--------|-------|
| Job for new user + domain | Fresh browser, login needed | Same (session table empty) |
| Job for returning user + domain | Fresh browser, login needed | Loads saved session — skips login |
| VALET doesn't call session endpoints | N/A | No impact — sessions work transparently |
| VALET calls list/clear endpoints | N/A | Full session management UI |
| Worker restarts | N/A | Sessions persist in DB — no data loss |

**VALET does not need to implement session management immediately.** Sessions work automatically. The management endpoints are for UX convenience.

---

## Testing with curl

### List Sessions

```bash
curl https://your-gh-api/api/v1/gh/valet/sessions/USER_UUID_HERE \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY"
```

### Clear Specific Session

```bash
curl -X DELETE https://your-gh-api/api/v1/gh/valet/sessions/USER_UUID_HERE/linkedin.com \
  -H "X-GH-Service-Key: YOUR_SERVICE_KEY"
```

### Clear All Sessions

```bash
curl -X DELETE https://your-gh-api/api/v1/gh/valet/sessions/USER_UUID_HERE \
  -H "X-GH-Service-KEY: YOUR_SERVICE_KEY"
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/api/routes/valet.ts` | Added GET/DELETE session endpoints |
| `src/api/schemas/valet.ts` | Added `ValetSessionDeleteSchema` |
| `docs/VALET-SESSION-CONTRACT.md` | This document |
| `docs/ROADMAP-TICKETS.md` | Added GH-047 (browser_crashed) and GH-048 (session API) |
