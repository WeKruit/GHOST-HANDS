# 05 -- Infrastructure Providers Reference

> Complete API reference, session lifecycle, and integration guide for AdsPower Local API and Browserbase Sessions API as used in the Valet multi-tier sandbox architecture.

---

## Table of Contents

1. [AdsPower Local API](#1-adspower-local-api)
   - [1.1 Overview & Authentication](#11-overview--authentication)
   - [1.2 Browser Endpoints](#12-browser-endpoints)
   - [1.3 Profile Endpoints](#13-profile-endpoints)
   - [1.4 Group Endpoints](#14-group-endpoints)
   - [1.5 Proxy Endpoints](#15-proxy-endpoints)
   - [1.6 TypeScript Types](#16-typescript-types)
   - [1.7 Session/Profile Lifecycle](#17-sessionprofile-lifecycle)
   - [1.8 CDP URL Extraction & Connection](#18-cdp-url-extraction--connection)
   - [1.9 Rate Limiting & Error Handling](#19-rate-limiting--error-handling)
   - [1.10 Anti-Detect Features](#110-anti-detect-features)
   - [1.11 Proxy Integration](#111-proxy-integration)
   - [1.12 Headless / EC2 Deployment](#112-headless--ec2-deployment)
   - [1.13 Licensing & Concurrency](#113-licensing--concurrency)
   - [1.14 Production Best Practices](#114-production-best-practices)
2. [Browserbase Sessions API](#2-browserbase-sessions-api)
   - [2.1 Overview & Authentication](#21-overview--authentication)
   - [2.2 Sessions API](#22-sessions-api)
   - [2.3 Contexts API](#23-contexts-api)
   - [2.4 Live View](#24-live-view)
   - [2.5 Session Inspector](#25-session-inspector)
   - [2.6 Stealth Mode](#26-stealth-mode)
   - [2.7 TypeScript Types](#27-typescript-types)
   - [2.8 Session Lifecycle](#28-session-lifecycle)
   - [2.9 Stagehand Integration](#29-stagehand-integration)
   - [2.10 Playwright / Puppeteer Connection](#210-playwright--puppeteer-connection)
   - [2.11 Proxy Configuration](#211-proxy-configuration)
   - [2.12 Human-in-the-Loop](#212-human-in-the-loop)
   - [2.13 Pricing & Limits](#213-pricing--limits)
   - [2.14 Production Best Practices](#214-production-best-practices)
3. [Provider Comparison for Valet](#3-provider-comparison-for-valet)

---

## 1. AdsPower Local API

### 1.1 Overview & Authentication

AdsPower is an anti-detect browser that runs locally and exposes a REST API for programmatic browser profile management. Valet uses it in **Tier 1 (Dedicated EC2)** for the highest level of fingerprint protection.

**Base URL:**

```
http://local.adspower.net:50325   (alias: http://localhost:50325)
```

**Authentication:**

When an API key is set (required for headless mode), all requests must include:

```
Authorization: Bearer {apiKey}
```

**Response Envelope:**

All endpoints return the same envelope:

```typescript
// Success
{ "code": 0, "data": { /* payload */ }, "msg": "success" }

// Failure
{ "code": -1, "data": {}, "msg": "failed" }
```

**API Versions:**

- **V1** (`/api/v1/*`): Original API, GET-based browser ops, POST-based profile CRUD
- **V2** (`/api/v2/*`): Newer endpoints with POST for browser ops and `profile_id`/`profile_no` in responses

Both versions are fully supported. V2 endpoints return slightly richer response objects.

---

### 1.2 Browser Endpoints

#### Start Browser (V1)

```
GET /api/v1/browser/start?user_id={profileId}
```

| Param | Required | Default | Type | Description |
|---|---|---|---|---|
| `user_id` | YES | -- | string | Profile ID (takes priority over serial_number) |
| `serial_number` | NO | -- | string | Alternative to user_id |
| `open_tabs` | NO | `0` | int | 0 = no tabs, 1 = open platform/historical pages |
| `ip_tab` | NO | `1` | int | Show IP detection page (1=yes, 0=no) |
| `new_first_tab` | NO | `0` | int | IP detection version: 0=old, 1=new |
| `launch_args` | NO | -- | JSON array | Chrome flags, e.g. `["--window-position=400,0"]` |
| `headless` | NO | `0` | int | 0 = visible, 1 = headless |
| `disable_password_filling` | NO | `0` | int | 1 = disable autofill |
| `clear_cache_after_closing` | NO | `0` | int | 1 = delete cache on close |
| `enable_password_saving` | NO | `0` | int | 1 = allow password storage |
| `cdp_mask` | NO | `1` | int | 1 = mask CDP detection |
| `device_scale` | NO | -- | float | Mobile only; range 0.1-2.0 |

**Success Response:**

```json
{
  "code": 0,
  "data": {
    "ws": {
      "selenium": "127.0.0.1:9222",
      "puppeteer": "ws://127.0.0.1:9222/devtools/browser/abc123-def456"
    },
    "debug_port": "9222",
    "webdriver": "/path/to/chromedriver"
  },
  "msg": "success"
}
```

#### Start Browser (V2)

```
POST /api/v2/browser-profile/start
Content-Type: application/json
```

```json
{
  "profile_id": "abc123",
  "last_opened_tabs": "0",
  "proxy_detection": "0"
}
```

Returns the same `ws` / `debug_port` / `webdriver` structure as V1.

#### Stop Browser

```
GET /api/v1/browser/stop?user_id={profileId}
```

| Param | Required | Description |
|---|---|---|
| `user_id` | YES | Profile ID |
| `serial_number` | NO | Alternative ID |

**Response:** `{ "code": 0, "data": {}, "msg": "success" }`

#### Check Browser Status (Single Profile)

```
GET /api/v1/browser/active?user_id={profileId}
```

**Running:**

```json
{
  "code": 0,
  "data": {
    "status": "Active",
    "ws": {
      "selenium": "127.0.0.1:9222",
      "puppeteer": "ws://127.0.0.1:9222/devtools/browser/abc123"
    }
  },
  "msg": "success"
}
```

**Not running:**

```json
{ "code": 0, "data": { "status": "Inactive" }, "msg": "success" }
```

#### List All Active Browsers (Local Device)

```
GET /api/v1/browser/local-active
```

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "user_id": "abc123",
        "ws": {
          "puppeteer": "ws://127.0.0.1:9222/devtools/browser/abc123",
          "selenium": "127.0.0.1:9222"
        },
        "debug_port": "9222",
        "webdriver": "/path/to/chromedriver"
      }
    ]
  },
  "msg": "success"
}
```

---

### 1.3 Profile Endpoints

#### Create Profile (V1)

```
POST /api/v1/user/create
Content-Type: application/json
```

| Body Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | NO | Profile name (max 100 chars) |
| `group_id` | string | **YES** | Group ID ("0" for ungrouped) |
| `domain_name` | string | NO | Platform domain (e.g. "linkedin.com") |
| `open_urls` | list | NO | URLs to open on browser launch |
| `username` | string | NO | Account username |
| `password` | string | NO | Account password |
| `fakey` | string | NO | 2FA key for TOTP generators |
| `cookie` | string | NO | Cookie data in JSON or Netscape format |
| `country` | string | NO | Country code for geolocation |
| `remark` | string | NO | Profile description |
| `user_proxy_config` | object | Cond. | Proxy config (required if no `proxyid`) |
| `proxyid` | string | Cond. | Existing proxy ID or "random" |
| `fingerprint_config` | object | **YES** | Fingerprint settings (cannot be `{}`) |
| `ip` | string | NO | Proxy IP address |
| `sys_app_cate_id` | string | NO | Application category ID |
| `repeat_config` | list | NO | Deduplication: 0=allow, 2=name/pwd, 3=cookie |
| `ignore_cookie_error` | string | NO | 0=error on bad cookie, 1=filter |

**Success:** `{ "code": 0, "data": { "id": "jc29dag5" }, "msg": "Success" }`

#### Create Profile (V2)

```
POST /api/v2/browser-profile/create
Content-Type: application/json
```

Same parameters as V1 with minor naming changes. Response includes both `profile_id` and `profile_no`:

```json
{ "code": 0, "data": { "profile_id": "xxxx", "profile_no": "xxxx" }, "msg": "Success" }
```

#### Update Profile

```
POST /api/v1/user/update
Content-Type: application/json
```

Same fields as create, plus `user_id` (required) to identify the profile. Only included fields are changed.

| Key Param | Type | Required | Description |
|---|---|---|---|
| `user_id` | string | **YES** | Profile to update |
| `name` | string | NO | New name |
| `user_proxy_config` | object | NO | New proxy config |
| `fingerprint_config` | object | NO | New fingerprint config |
| `cookie` | string | NO | New cookies |
| *(all other create params)* | -- | NO | Any field from create |

#### Query Profiles

```
GET /api/v1/user/list?page=1&page_size=50
```

| Param | Required | Default | Description |
|---|---|---|---|
| `group_id` | NO | all | Filter by group |
| `user_id` | NO | -- | Filter by profile ID |
| `serial_number` | NO | -- | Filter by serial number |
| `page` | NO | 1 | Page number |
| `page_size` | NO | 1 | Results per page (max 100) |
| `user_sort` | NO | `{"serial_number":"desc"}` | Sort field+direction |

**Response:**

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "serial_number": "1",
        "user_id": "jc29dag5",
        "name": "valet-linkedin-001",
        "group_id": "1",
        "group_name": "valet-prod",
        "domain_name": "linkedin.com",
        "username": "",
        "remark": "",
        "created_time": "1712520997",
        "ip": "203.0.113.42",
        "ip_country": "us",
        "last_open_time": "1712621030"
      }
    ],
    "page": 1,
    "page_size": 50
  },
  "msg": "Success"
}
```

#### Delete Profiles

```
POST /api/v1/user/delete
Content-Type: application/json
```

```json
{ "user_ids": ["profileId1", "profileId2"] }
```

Max batch size: 100 profiles per request.

#### Query Profile Cookies

```
GET /api/v1/user/cookies?user_id={profileId}
```

Returns stored cookies for the profile, useful for state inspection and debugging.

---

### 1.4 Group Endpoints

#### Create Group

```
POST /api/v1/group/create
Content-Type: application/json
```

| Param | Type | Required | Description |
|---|---|---|---|
| `group_name` | string | **YES** | Unique group name |
| `remark` | string | NO | Group notes (v2.6.7.2+) |

**Response:**

```json
{
  "code": 0,
  "data": {
    "group_id": "abc123",
    "group_name": "valet-prod",
    "remark": "Production profiles"
  },
  "msg": "Success"
}
```

#### Edit Group

```
POST /api/v1/group/edit
```

Body: `{ "group_id": "abc123", "group_name": "new-name", "remark": "updated" }`

#### Query Groups

```
GET /api/v1/group/list?page=1&page_size=100
```

Returns paginated list of groups with `group_id`, `group_name`, `remark`.

---

### 1.5 Proxy Endpoints

#### Proxy Config Object (`user_proxy_config`)

Used in profile create/update:

```typescript
interface AdsPowerProxyConfig {
  proxy_soft: string;   // REQUIRED: "other", "brightdata", "no_proxy", etc.
  proxy_type?: string;  // "http" | "https" | "socks5"
  proxy_host?: string;  // hostname or IP
  proxy_port?: string;  // port (as string)
  proxy_user?: string;  // auth username
  proxy_password?: string; // auth password
  proxy_url?: string;   // for mobile proxy IP rotation links
  global_config?: string; // "0" | "1" - use saved proxy configuration
}
```

**Supported `proxy_soft` values:**

| Value | Protocols | Description |
|---|---|---|
| `other` | http, https, socks5 | Custom proxy (Valet default) |
| `brightdata` | http, https, socks5 | Bright Data integration |
| `brightauto` | auto | Bright Data auto-config |
| `oxylabsauto` | auto | Oxylabs auto-config |
| `no_proxy` | -- | Disable proxy |

#### Add Proxy

```
POST /api/v1/proxy/add
```

Creates a standalone proxy entry that can be referenced by `proxyid` in profiles.

#### Update Proxy

```
POST /api/v1/proxy/update
```

#### Delete Proxy

```
POST /api/v1/proxy/delete
```

#### Query Proxies

```
GET /api/v1/proxy/list
```

---

### 1.6 TypeScript Types

```typescript
// --- Response Envelope ---

interface AdsPowerResponse<T = Record<string, unknown>> {
  code: number;   // 0 = success, -1 = failure
  data: T;
  msg: string;
}

// --- Browser Endpoints ---

interface AdsPowerWsEndpoints {
  selenium: string;    // "127.0.0.1:9222"
  puppeteer: string;   // "ws://127.0.0.1:9222/devtools/browser/..."
}

interface AdsPowerBrowserStartResponse {
  ws: AdsPowerWsEndpoints;
  debug_port: string;
  webdriver: string;
}

interface AdsPowerBrowserActiveResponse {
  status: "Active" | "Inactive";
  ws?: AdsPowerWsEndpoints;
}

interface AdsPowerLocalActiveEntry {
  user_id: string;
  ws: AdsPowerWsEndpoints;
  debug_port: string;
  webdriver: string;
}

// --- Profile Endpoints ---

interface AdsPowerCreateProfileResponse {
  id: string;  // V1
}

interface AdsPowerCreateProfileV2Response {
  profile_id: string;
  profile_no: string;
}

interface AdsPowerProfileEntry {
  serial_number: string;
  user_id: string;
  name: string;
  group_id: string;
  group_name: string;
  domain_name: string;
  username: string;
  remark: string;
  created_time: string;   // Unix timestamp as string
  ip: string;
  ip_country: string;
  last_open_time: string; // Unix timestamp as string
}

interface AdsPowerProfileListResponse {
  list: AdsPowerProfileEntry[];
  page: number;
  page_size: number;
}

// --- Group Endpoints ---

interface AdsPowerGroupEntry {
  group_id: string;
  group_name: string;
  remark: string;
}

// --- Proxy Config ---

interface AdsPowerProxyConfig {
  proxy_soft: "other" | "brightdata" | "brightauto" | "oxylabsauto" | "no_proxy";
  proxy_type?: "http" | "https" | "socks5";
  proxy_host?: string;
  proxy_port?: string;
  proxy_user?: string;
  proxy_password?: string;
  proxy_url?: string;
  global_config?: "0" | "1";
}

// --- Fingerprint Config ---

interface AdsPowerFingerprintConfig {
  automatic_timezone?: "0" | "1";
  webrtc?: "forward" | "proxy" | "local" | "disabled";
  location?: "ask" | "allow" | "block";
  location_switch?: "0" | "1";
  language_switch?: "0" | "1";
  language?: string[];
  ua?: string;
  screen_resolution?: string;  // "none" | "random" | "1920_1080"
  fonts?: string[];
  canvas?: "0" | "1";          // 0=real, 1=noise
  webgl_image?: "0" | "1";
  webgl?: "0" | "2" | "3";     // 0=real, 2=custom, 3=random match
  audio?: "0" | "1";
  do_not_track?: "default" | "0" | "1";
  hardware_concurrency?: "2" | "4" | "6" | "8" | "16";
  device_memory?: "2" | "4" | "6" | "8";
  flash?: "block" | "allow";
  scan_port_type?: "0" | "1";
  media_devices?: "0" | "1" | "2";
  client_rects?: "0" | "1";
  device_name_switch?: "0" | "1";
  speech_switch?: "0" | "1";
  gpu?: "0" | "1";
}

// --- Client Options ---

interface AdsPowerClientOptions {
  baseUrl?: string;     // default: "http://local.adspower.net:50325"
  apiKey?: string;      // required for headless mode
  timeoutMs?: number;   // default: 30000
  maxRetries?: number;  // default: 3
  retryDelayMs?: number; // default: 1000
}
```

---

### 1.7 Session/Profile Lifecycle

```
[not_exists] ──create──> [available] ──start──> [running] ──stop──> [available]
                              |                    |                    |
                              |                    +──crash──> [error] ─+──recover
                              |                                         |
                              +──retire──> [retired] ──delete──> [not_exists]
```

**Lifecycle in code:**

```typescript
// 1. Create profile (one-time per user+platform)
const profile = await adspower.createProfile({
  name: `valet-linkedin-${userId}`,
  group_id: "0",
  fingerprint_config: { automatic_timezone: "1", webrtc: "disabled", canvas: "1" },
  user_proxy_config: { proxy_soft: "other", proxy_type: "socks5", proxy_host: "geo.iproyal.com", proxy_port: "12321", proxy_user: "user", proxy_password: "pass" },
});
// Store profile.id in database

// 2. Start browser for task
const session = await adspower.startBrowser(profile.id);
// session.ws.puppeteer = "ws://127.0.0.1:9222/devtools/browser/..."

// 3. Connect automation framework
const browser = await puppeteer.connect({ browserWSEndpoint: session.ws.puppeteer });
// OR
const browser = await chromium.connectOverCDP(session.ws.puppeteer);

// 4. Run automation...

// 5. Stop browser after task
await adspower.stopBrowser(profile.id);

// 6. After N tasks, retire and delete
await adspower.deleteProfiles([profile.id]);
```

**State persistence:** AdsPower profiles persist cookies, localStorage, IndexedDB, cache, and extensions on local disk. No external state management needed. This is the primary advantage over ephemeral tiers.

---

### 1.8 CDP URL Extraction & Connection

AdsPower returns two connection endpoints from `/browser/start`:

| Endpoint | Format | Use With |
|---|---|---|
| `ws.selenium` | `127.0.0.1:9222` | Selenium `debuggerAddress` option |
| `ws.puppeteer` | `ws://127.0.0.1:9222/devtools/browser/...` | Puppeteer `connect()` / Playwright `connectOverCDP()` |

**Selenium connection:**

```typescript
const options = new ChromeOptions();
options.set("debuggerAddress", session.ws.selenium);
const driver = new Builder().forBrowser("chrome")
  .setChromeOptions(options)
  .setChromeService(new Service(session.webdriver))
  .build();
```

**Puppeteer connection:**

```typescript
const browser = await puppeteer.connect({
  browserWSEndpoint: session.ws.puppeteer,
  defaultViewport: null,
});
```

**Playwright connection:**

```typescript
const browser = await chromium.connectOverCDP(session.ws.puppeteer);
const context = browser.contexts()[0]!;
const page = context.pages()[0]!;
```

**Remote / sandbox rewriting:** When AdsPower runs on a separate host (e.g., EC2), replace `127.0.0.1` with the reachable address:

```typescript
function rewriteCdpUrl(original: string, targetHost: string, targetPort?: number): string {
  const url = new URL(original);
  url.hostname = targetHost;
  if (targetPort) url.port = String(targetPort);
  return url.toString();
}
```

---

### 1.9 Rate Limiting & Error Handling

**Rate limits (v2.8.2.1+):**

| Profile Count | Max Requests/Second |
|---|---|
| 0--200 | 2 req/s |
| 200--5000 | 5 req/s |
| 5000+ | 10 req/s |

Certain endpoints (group operations, proxy management): **1 req/s**.

**Error categories:**

| Error | Detection | Recovery |
|---|---|---|
| AdsPower not running | `fetch` throws `ECONNREFUSED` | Retry with backoff; alert if persistent |
| Profile locked | `code: -1`, msg contains "locked" | Wait 10s and retry; force-stop if stuck |
| CDP connection timeout | `puppeteer.connect` times out | Stop browser, mark error, restart |
| Browser crash | CDP WebSocket closes unexpectedly | Detect via `browser.on('disconnected')`, restart |
| Rate limit exceeded | HTTP 429 or rapid `code: -1` | Exponential backoff |
| Profile creation failure | `code: -1` on `/user/create` | Check plan quota; retry |

**Retry strategy:**

```typescript
// Exponential backoff: 1s, 2s, 4s
const backoff = retryDelayMs * Math.pow(2, attempt - 1);

// Do NOT retry business logic errors (code: -1) — only network/timeout errors
if (err instanceof AdsPowerApiError) throw err; // no retry
```

---

### 1.10 Anti-Detect Features

AdsPower's anti-detect capabilities operate at the Chromium fork level (not JavaScript injection):

| Feature | How It Works | Config Key |
|---|---|---|
| **Canvas fingerprint** | Hardware-level noise injection per profile | `canvas: "1"` |
| **WebGL fingerprint** | Spoofed vendor/renderer strings | `webgl: "3"` (random match) |
| **Audio fingerprint** | AudioContext output noise | `audio: "1"` |
| **WebRTC** | Disable or proxy real IPs | `webrtc: "disabled"` |
| **Navigator properties** | Custom hardwareConcurrency, deviceMemory, platform | Individual config keys |
| **Screen resolution** | Per-profile viewport matching proxy geo | `screen_resolution: "1920_1080"` |
| **Font enumeration** | Custom font list per profile | `fonts: ["all"]` |
| **ClientRects** | Noise in getBoundingClientRect | `client_rects: "1"` |
| **Media devices** | Spoofed device enumeration | `media_devices: "1"` |
| **Speech voices** | Modified speechSynthesis voices | `speech_switch: "1"` |
| **CDP masking** | Hide Chrome DevTools Protocol markers | `cdp_mask: "1"` |
| **Timezone** | Auto-set from proxy IP location | `automatic_timezone: "1"` |

**Key advantage:** These are compiled into the browser binary. Unlike JS-injection approaches (fingerprint-suite), they cannot be detected by examining JavaScript execution timing or prototype chains.

---

### 1.11 Proxy Integration

**For Valet with IPRoyal residential proxies:**

```json
{
  "proxy_soft": "other",
  "proxy_type": "socks5",
  "proxy_host": "geo.iproyal.com",
  "proxy_port": "12321",
  "proxy_user": "username",
  "proxy_password": "password_country-us_session-abc123_lifetime-30m"
}
```

**Sticky session via password suffix:**

```
{base_password}_country-{CC}_session-{sessionId}_lifetime-{duration}
```

- `country`: `us`, `gb`, etc. -- geo-target the exit IP
- `session`: Random UUID -- same session = same IP
- `lifetime`: `10m` to `24h` -- sticky duration

**Per-task rotation:** Generate a new `session` UUID per task so each application gets a fresh IP address, while maintaining the same IP throughout one application flow (typically 3-5 minutes).

---

### 1.12 Headless / EC2 Deployment

**System requirements:**

- Ubuntu 22.04+ or Debian 12+
- 2 GB RAM minimum per instance (recommend 4+ GB for multiple profiles)
- Xvfb for any rendering (non-headless mode in sandbox)
- AdsPower app v3.3.2+ with kernel v2.4.2.8+
- Paid plan (Professional $9/mo+ for API access)

**Startup command:**

```bash
./AdsPower --headless=true \
  --api-key="${ADSPOWER_API_KEY}" \
  --api-port=50325
```

**First-time setup:** License activation requires VNC access to the EC2 instance. After activation, headless mode works without GUI.

**Installation:**

```bash
wget -q "https://version.adspower.net/download/linux/AdsPower-Global-latest.deb" \
  -O /tmp/adspower.deb
dpkg -i /tmp/adspower.deb
rm /tmp/adspower.deb
```

**Health check before worker starts:**

```bash
for i in $(seq 1 30); do
  if curl -sf http://localhost:50325/api/v1/browser/local-active > /dev/null 2>&1; then
    echo "AdsPower ready"
    break
  fi
  sleep 1
done
```

---

### 1.13 Licensing & Concurrency

| Plan | Price | Profiles | API Access | Concurrent Browsers |
|---|---|---|---|---|
| Free | $0/mo | 5 | NO | 5 |
| Professional | $9/mo | 10+5 | YES | 15 |
| Business | $36/mo | 100 | YES | 100 |
| Custom | Contact | 10,000+ | YES | Configurable |

**Key constraints:**

- 1 profile = 1 concurrent browser session (cannot open same profile twice)
- Rate limits are per-account, shared across all API clients
- Multi-device login only works in headless mode
- Cannot run headless and GUI simultaneously on the same machine
- Resetting the API key invalidates the previous key

---

### 1.14 Production Best Practices

1. **Profile grouping**: Create a `valet-{env}` group per environment. Use `group_id` for isolation.
2. **Warm-up after start**: Wait 2-3s after `browser/start` before connecting CDP. Verify with `about:blank` navigation.
3. **Cool-down before stop**: Navigate to `about:blank`, wait 1s for pending requests, then disconnect and stop.
4. **Reconciliation cron (every 5 min)**: Cross-reference `browser/local-active` with DB `status = 'in_use'`. Stop orphans, mark stale rows.
5. **Profile rotation**: Retire profiles after 50 completed tasks. Delete retired profiles nightly.
6. **Error isolation**: Mark profiles as `error` on CDP connection failure. Don't reuse until manually verified.
7. **API key security**: Store in Fly secrets / AWS SSM, never in code. Rotate quarterly.
8. **Headless-only on servers**: Never install GUI dependencies on production EC2 instances beyond Xvfb.

---

## 2. Browserbase Sessions API

### 2.1 Overview & Authentication

Browserbase is a managed browser infrastructure service. Valet uses it in **Tier 2 (Managed Cloud)** for standard applications and human-in-the-loop copilot mode.

**Base URL:**

```
https://api.browserbase.com/v1
```

**Authentication:**

All API requests require the `x-bb-api-key` header (or SDK `apiKey` parameter):

```
x-bb-api-key: {BROWSERBASE_API_KEY}
```

**SDK Installation:**

```bash
npm install @browserbasehq/sdk playwright-core
```

**SDK Initialization:**

```typescript
import Browserbase from "@browserbasehq/sdk";

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY!,
});
```

---

### 2.2 Sessions API

#### Create Session

```
POST /v1/sessions
```

**SDK:**

```typescript
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  browserSettings: {
    advancedStealth: true,           // Scale plan only
    blockAds: false,
    solveCaptchas: true,
    captchaImageSelector: undefined, // CSS selector for custom CAPTCHAs
    captchaInputSelector: undefined,
    context: {
      id: contextId,                 // optional: persist state
      persist: true,                 // save changes back to context
    },
    fingerprint: {
      browsers: ["chrome"],
      devices: ["desktop"],
      operatingSystems: ["linux"],
      locales: ["en-US"],
      httpVersion: 2,
      screen: {
        maxHeight: 1080,
        maxWidth: 1920,
        minHeight: 768,
        minWidth: 1024,
      },
    },
    viewport: {
      width: 1920,
      height: 1080,
    },
    recordSession: true,
    logSession: true,
  },
  proxies: true,    // enable built-in residential proxies
  // OR custom proxy config:
  // proxies: [{
  //   type: "browserbase",
  //   geolocation: { city: "New York", state: "NY", country: "US" },
  // }],
  keepAlive: false,  // true = session survives disconnection
  region: "us-east-1",
  userMetadata: {
    valetUserId: "user-123",
    valetTaskId: "task-456",
  },
});
```

**Response properties:**

```typescript
interface BrowserbaseSession {
  id: string;
  createdAt: string;         // ISO 8601
  updatedAt: string;
  projectId: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  status: "RUNNING" | "REQUEST_RELEASE" | "RELEASING" | "COMPLETED" | "ERROR" | "TIMED_OUT";
  proxyBytes: number;
  keepAlive: boolean;
  contextId: string | null;
  region: string;
  userMetadata: Record<string, string>;
  connectUrl: string;          // CDP WebSocket URL
  seleniumRemoteUrl: string;   // Selenium Grid URL
  signingKey: string;          // for signed requests
}
```

**Critical timing:** You have **5 minutes** to connect to a newly created session before it auto-terminates.

#### List Sessions

```
GET /v1/sessions?status=RUNNING
```

#### Get Session

```
GET /v1/sessions/{sessionId}
```

#### Update Session

```
POST /v1/sessions/{sessionId}
```

Update `status` (to `REQUEST_RELEASE` for graceful close) or `userMetadata`.

#### Debug Session (Live View URLs)

```
GET /v1/sessions/{sessionId}/debug
```

**SDK:**

```typescript
const debug = await bb.sessions.debug(session.id);
// debug.debuggerFullscreenUrl  -- fullscreen, no browser chrome
// debug.debuggerUrl             -- with browser chrome border
// debug.pages                   -- per-tab live view URLs
```

#### Get Session Logs

```
GET /v1/sessions/{sessionId}/logs
```

Returns CDP events captured during the session. Useful for post-mortem debugging.

#### Get Session Recording

Available via the dashboard Session Inspector after session completes. Video recording of up to 10 tabs.

---

### 2.3 Contexts API

Contexts persist browser state (cookies, localStorage, cache) across sessions. Each user should have one context per platform.

#### Create Context

```
POST /v1/contexts
```

```typescript
const context = await bb.contexts.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
});
// Store context.id in user's DB record: users.browserbase_context_id
```

#### Use Context in Session

```typescript
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  browserSettings: {
    context: {
      id: savedContextId,
      persist: true,  // save session changes back to context
    },
  },
});
```

**`persist: true`** -- All cookies/localStorage/cache modifications during the session are saved back to the context when the session ends.

**`persist: false`** -- Read-only access to context data. Changes during the session are discarded.

#### Delete Context

```
DELETE /v1/contexts/{contextId}
```

Permanent and irreversible.

#### Lifecycle notes

- Contexts **never expire** on Browserbase's side (deleted only explicitly)
- External factors (website session expiry, password changes) can invalidate stored credentials
- Wait **several seconds** after closing a session before reusing its context
- **Do not** use the same context in simultaneous sessions (sites may force-logout)
- Use one context per site + login combination
- Maintain consistent geolocation across sessions sharing a context

---

### 2.4 Live View

Browserbase Live View embeds a real-time browser view in an iframe, enabling human-in-the-loop interaction.

#### Getting the Live View URL

```typescript
const debug = await bb.sessions.debug(session.id);

// Options:
const fullscreenUrl = debug.debuggerFullscreenUrl;           // clean, no chrome
const borderedUrl = debug.debuggerUrl;                       // with browser chrome
const noNavbar = debug.debuggerFullscreenUrl + "&navbar=false"; // hide top bar
```

Per-tab URLs are also available via `debug.pages`.

#### Iframe Embedding

**Read-write (human can interact):**

```html
<iframe
  src="${liveViewUrl}"
  sandbox="allow-same-origin allow-scripts"
  allow="clipboard-read; clipboard-write"
  style="width: 100%; height: 600px; border-radius: 8px; border: 1px solid #e5e7eb;"
/>
```

**Read-only (monitoring only):**

```html
<iframe
  src="${liveViewUrl}"
  sandbox="allow-same-origin allow-scripts"
  allow="clipboard-read; clipboard-write"
  style="width: 100%; height: 600px; pointer-events: none;"
/>
```

#### Interaction capabilities

When embedded in read-write mode, users can:
- Click, type, and scroll within the browser
- Upload files
- Handle credential entry and MFA prompts
- Solve CAPTCHAs manually
- Copy/paste (requires `clipboard-read; clipboard-write` permissions)

#### Disconnection handling

Listen for session end:

```typescript
window.addEventListener("message", (event) => {
  if (event.data === "browserbase-disconnected") {
    // Session ended -- show completion UI
  }
});
```

#### Mobile viewport

Set viewport dimensions (e.g., 360x800) at session creation. For virtual keyboards, use a library like `react-simple-keyboard` and forward key events via `page.keyboard.press()`.

---

### 2.5 Session Inspector

Every session is automatically recorded (when `recordSession: true`, the default).

**Capabilities:**

| Feature | Description |
|---|---|
| **Video playback** | Full recording of up to 10 tabs |
| **Live debug view** | Real-time monitoring via "Copy Debug URL" in dashboard |
| **Events timeline** | Chronological CDP events (Runtime, Page, Input, Log) |
| **DOM inspector** | Element attributes and state snapshots |
| **Console logs** | All `console.*` output + system messages |
| **Network monitor** | HTTP requests/responses via CDP |
| **Stagehand details** | Token usage, duration, extraction schemas/results |

**Programmatic access:**

```typescript
// Retrieve CDP event logs
const logs = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/logs`, {
  headers: { "x-bb-api-key": process.env.BROWSERBASE_API_KEY! },
});
```

**CAPTCHA solving events (listen in automation):**

```typescript
page.on("console", (msg) => {
  if (msg.text() === "browserbase-solving-started") {
    console.log("CAPTCHA solving in progress...");
  }
  if (msg.text() === "browserbase-solving-finished") {
    console.log("CAPTCHA solved");
  }
});
```

---

### 2.6 Stealth Mode

| Tier | Available On | What It Does |
|---|---|---|
| **Basic Stealth** | All paid plans | Randomized fingerprints + viewport per session. Surface-level CAPTCHAs solved automatically. |
| **Advanced Stealth** | Scale plan only | Custom Chromium fork by Browserbase Stealth Team. Deep environmental signal mimicking. |

**Enabling Advanced Stealth:**

```typescript
const session = await bb.sessions.create({
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  browserSettings: {
    advancedStealth: true,
  },
  proxies: true,  // recommended for stealth
});
```

**Fingerprint configuration (Basic Stealth only):**

When `advancedStealth: false`, you can customize:

```typescript
fingerprint: {
  browsers: ["chrome"],
  devices: ["desktop"],
  operatingSystems: ["linux", "windows"],
  locales: ["en-US"],
  httpVersion: 2,
  screen: { maxHeight: 1080, maxWidth: 1920, minHeight: 768, minWidth: 1024 },
}
```

When `advancedStealth: true`, custom fingerprint configuration has **no effect** -- Browserbase handles it entirely.

**CAPTCHA solving:**

- Enabled by default on all paid plans
- Takes up to 30 seconds depending on complexity
- Requires proxies enabled for higher success rates
- For custom CAPTCHAs, provide CSS selectors: `captchaImageSelector`, `captchaInputSelector`
- Disable with `solveCaptchas: false`

**Browserbase Identity (Beta, Scale plan):**

Cryptographic authentication that provides official Cloudflare bot detection bypass via the Signed Agents partnership. Reduces CAPTCHA challenges significantly.

---

### 2.7 TypeScript Types

```typescript
// --- Session ---

interface BrowserbaseSessionCreateParams {
  projectId: string;
  browserSettings?: {
    advancedStealth?: boolean;
    blockAds?: boolean;
    solveCaptchas?: boolean;
    captchaImageSelector?: string;
    captchaInputSelector?: string;
    context?: {
      id: string;
      persist: boolean;
    };
    fingerprint?: BrowserbaseFingerprint;
    viewport?: { width: number; height: number };
    recordSession?: boolean;
    logSession?: boolean;
  };
  proxies?: boolean | BrowserbaseProxyConfig[];
  keepAlive?: boolean;
  region?: string;
  userMetadata?: Record<string, string>;
}

interface BrowserbaseFingerprint {
  browsers?: ("chrome" | "firefox" | "edge")[];
  devices?: ("desktop" | "mobile")[];
  operatingSystems?: ("linux" | "windows" | "macos")[];
  locales?: string[];
  httpVersion?: 1 | 2;
  screen?: {
    maxHeight?: number;
    maxWidth?: number;
    minHeight?: number;
    minWidth?: number;
  };
}

interface BrowserbaseProxyConfig {
  type: "browserbase";
  geolocation?: {
    city?: string;
    state?: string;
    country?: string;
  };
}

interface BrowserbaseSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  status: BrowserbaseSessionStatus;
  proxyBytes: number;
  keepAlive: boolean;
  contextId: string | null;
  region: string;
  userMetadata: Record<string, string>;
  connectUrl: string;
  seleniumRemoteUrl: string;
  signingKey: string;
}

type BrowserbaseSessionStatus =
  | "RUNNING"
  | "REQUEST_RELEASE"
  | "RELEASING"
  | "COMPLETED"
  | "ERROR"
  | "TIMED_OUT";

// --- Context ---

interface BrowserbaseContext {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

// --- Debug / Live View ---

interface BrowserbaseDebugInfo {
  debuggerFullscreenUrl: string;
  debuggerUrl: string;
  pages: BrowserbaseDebugPage[];
}

interface BrowserbaseDebugPage {
  id: string;
  url: string;
  debuggerUrl: string;
  debuggerFullscreenUrl: string;
}

// --- SDK Client ---

interface BrowserbaseClientOptions {
  apiKey: string;
}
```

---

### 2.8 Session Lifecycle

```
create() ──5min timeout──> [TIMED_OUT]
    |
    +──connect──> [RUNNING] ──automation──> disconnect ──> [COMPLETED]
                      |                                        |
                      +──error──> [ERROR]                      |
                      |                                        |
                      +──keepAlive: true──> survives disconnect |
                      |                                        |
                      +──REQUEST_RELEASE──> [RELEASING] ──> [COMPLETED]
```

**Full lifecycle in code:**

```typescript
// 1. Create or reuse a context
let contextId = user.browserbaseContextId;
if (!contextId) {
  const ctx = await bb.contexts.create({ projectId });
  contextId = ctx.id;
  await db.update(users).set({ browserbaseContextId: ctx.id }).where(eq(users.id, userId));
}

// 2. Create session
const session = await bb.sessions.create({
  projectId,
  browserSettings: {
    context: { id: contextId, persist: true },
    solveCaptchas: true,
    viewport: { width: 1920, height: 1080 },
  },
  proxies: [{ type: "browserbase", geolocation: { country: "US" } }],
});

// 3. Connect (must happen within 5 minutes)
const browser = await chromium.connectOverCDP(session.connectUrl);
const context = browser.contexts()[0]!;
const page = context.pages()[0]!;

// 4. Run automation...
await page.goto("https://example.com/apply");

// 5. Disconnect (session auto-completes)
await browser.close();
// Context is persisted if persist: true
```

**Session timeout:** Max 6 hours on Developer/Startup plans. After timeout, session is force-terminated.

---

### 2.9 Stagehand Integration

Stagehand v3 has native Browserbase support (same company). It uses CDP directly (no Playwright dependency).

```typescript
import { Stagehand } from "@browserbasehq/stagehand";

// Option A: Let Stagehand create the session
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  modelName: "anthropic/claude-sonnet-4-20250514",
  modelClientOptions: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
});
await stagehand.init();

// Option B: Attach to an existing session (for context + Live View setup)
const stagehand = new Stagehand({
  env: "BROWSERBASE",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  browserbaseSessionID: existingSession.id,  // pre-created with context + proxies
  modelName: "anthropic/claude-sonnet-4-20250514",
  modelClientOptions: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
});
await stagehand.init();

// Use Stagehand's AI actions
await stagehand.page.act({ action: "Click the 'Easy Apply' button" });
const data = await stagehand.page.extract({
  instruction: "Extract all form fields with their labels and types",
  schema: formFieldsSchema,
});
await stagehand.page.observe({ instruction: "What buttons are visible?" });

// Cleanup
await stagehand.close();
```

**Stagehand adjusts timeouts** automatically when `env === "BROWSERBASE"` to account for network latency in remote browser execution.

---

### 2.10 Playwright / Puppeteer Connection

#### Playwright

```typescript
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(session.connectUrl);
const context = browser.contexts()[0]!;   // MUST use default context for stealth
const page = context.pages()[0]!;

await page.goto("https://example.com");
await page.fill("#email", "user@example.com");
await page.click('button[type="submit"]');

await browser.close();
```

#### Puppeteer

```typescript
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: session.connectUrl,
});
const pages = await browser.pages();
const page = pages[0]!;

await page.goto("https://example.com");
await browser.close();
```

**Important:** Always use the default context and page returned by Browserbase. Creating new contexts bypasses stealth features.

---

### 2.11 Proxy Configuration

**Built-in residential proxies (simplest):**

```typescript
const session = await bb.sessions.create({
  projectId,
  proxies: true,  // auto-assign residential proxy
});
```

**Geo-targeted proxies:**

```typescript
const session = await bb.sessions.create({
  projectId,
  proxies: [{
    type: "browserbase",
    geolocation: {
      city: "San Francisco",
      state: "CA",
      country: "US",
    },
  }],
});
```

**Proxy bandwidth costs:**

| Plan | Included | Overage |
|---|---|---|
| Free | 0 GB | N/A |
| Developer | 1 GB | $12/GB |
| Startup | 5 GB | $10/GB |
| Scale | Usage-based | Negotiable |

Typical session bandwidth: 3-5 MB per application (one session uses ~0.003-0.005 GB).

---

### 2.12 Human-in-the-Loop

Browserbase Live View is the recommended HITL mechanism for Tier 2.

**Backend flow (Hatchet durable task):**

```typescript
// In the workflow when HITL is needed (CAPTCHA, verification, ambiguity)
const debug = await bb.sessions.debug(sessionId);
const liveViewUrl = debug.debuggerFullscreenUrl + "&navbar=false";

// Notify frontend via WebSocket
ws.send(JSON.stringify({
  type: "hitl_required",
  taskId,
  reason: "captcha_detected",
  liveViewUrl,
  sessionId,
}));

// Wait for human to complete action (Hatchet durable task waits)
const humanResult = await ctx.waitForEvent("hitl_completed", { timeout: "5m" });
```

**Frontend:**

```tsx
// Embed in task detail page
<iframe
  src={liveViewUrl}
  className="w-full h-[600px] rounded-lg border"
  sandbox="allow-same-origin allow-scripts"
  allow="clipboard-read; clipboard-write"
/>

// Listen for disconnect
useEffect(() => {
  const handler = (event: MessageEvent) => {
    if (event.data === "browserbase-disconnected") {
      onSessionEnd();
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}, []);
```

**Advantage over noVNC:** Zero infrastructure. No Xvfb, no x11vnc, no websockify. Browserbase handles the WebSocket proxy, TLS, and rendering.

---

### 2.13 Pricing & Limits

| Feature | Free | Developer | Startup | Scale |
|---|---|---|---|---|
| **Monthly** | $0 | $20 | $99 | Custom |
| **Browser hours** | 1 | 100 | 500 | Usage-based |
| **Concurrent browsers** | 1 | 25 | 100 | 250+ |
| **Browser creation rate** | 5/min | 25/min | 50/min | 150+/min |
| **Max session duration** | 15 min | 6 hours | 6 hours | 6+ hours |
| **Proxy bandwidth** | 0 GB | 1 GB | 5 GB | Usage-based |
| **Data retention** | 7 days | 30 days | 30 days | 30+ days |
| **Projects** | 1 | 2 | 5 | 5+ |
| **Stealth** | None | Basic | Basic | Advanced |
| **CAPTCHA solving** | No | Yes | Yes | Yes |
| **Support** | Email | Standard | Priority | Slack + Priority |

**Overage pricing:**

| Resource | Developer | Startup |
|---|---|---|
| Browser hours | $0.12/hr | $0.10/hr |
| Proxy bandwidth | $12/GB | $10/GB |
| Compute | $0.0000167/GB-s | $0.00001389/GB-s |

**Rate limiting:** Session creation is rate-limited based on plan's concurrent session limit. Creating sessions beyond your limit returns an error.

**For Valet at 100 users:** Startup plan ($99/mo) covers ~500 browser-hours = ~10,000 applications/month at 3 min each. Overage at $0.10/hr.

---

### 2.14 Production Best Practices

1. **Context per user per platform**: Store `browserbase_context_id` in the users table. One context per platform (LinkedIn context, Indeed context, etc.).
2. **Connect immediately**: You have 5 minutes after session creation. Create the session and connect in the same function.
3. **Use default context and page**: Never create new browser contexts -- this bypasses stealth features.
4. **Enable proxies with geo-targeting**: Match proxy location to the job posting's country.
5. **Wait before context reuse**: After a session closes, wait 3-5 seconds before creating a new session with the same context.
6. **No concurrent context sharing**: Never use the same context in two simultaneous sessions.
7. **Monitor proxy bandwidth**: At $10-12/GB overage, track `session.proxyBytes` and alert on spikes.
8. **Handle CAPTCHA events**: Listen for `browserbase-solving-started` console events. If solving takes >30s, escalate to human via Live View.
9. **Graceful shutdown**: Use `REQUEST_RELEASE` status to allow context persistence before session termination.
10. **Store session IDs for debugging**: Log `session.id` with every task for post-mortem via Session Inspector.

---

## 3. Provider Comparison for Valet

| Dimension | AdsPower (Tier 1) | Browserbase (Tier 2) |
|---|---|---|
| **Deployment model** | Self-hosted on EC2 | Managed SaaS |
| **Anti-detect quality** | Best (Chromium fork, hardware-level) | Good (Basic) / Excellent (Advanced, Scale only) |
| **State persistence** | Local disk (full: cookies, cache, IndexedDB) | Contexts API (cookies, localStorage) |
| **Human-in-the-loop** | noVNC (requires Xvfb stack) | Live View iframe (zero infra) |
| **Session start time** | ~2-5s (profile already exists on disk) | ~2-3s (session creation + connect) |
| **Cost per session** | ~$0.002 (EC2 RI amortized) | ~$0.006-0.012 (browser-hour based) |
| **Ops complexity** | High (EC2, AdsPower license, VNC stack) | Low (SDK calls only) |
| **Concurrency** | Limited by EC2 count + profiles | Up to 100 (Startup) or 250+ (Scale) |
| **CAPTCHA solving** | Manual / external service | Built-in (all paid plans) |
| **Proxy** | BYO (IPRoyal recommended) | Built-in residential (pay per GB) |
| **Best for** | LinkedIn, persistent identity sites, premium users | Standard ATS, copilot mode, burst capacity |
| **Valet tier** | Tier 1 (Dedicated) | Tier 2 (Managed Cloud) |

### When to use which

- **LinkedIn, high-security sites**: Tier 1 (AdsPower). Best fingerprint protection, persistent profile with cookies and cache.
- **Copilot mode / human takeover**: Tier 2 (Browserbase). Live View iframe is the simplest HITL integration.
- **Standard ATS applications**: Tier 2 (Browserbase). Managed stealth + auto CAPTCHA solving.
- **Burst traffic beyond EC2 capacity**: Tier 2 (Browserbase). Elastic, no provisioning delay.
- **Cost-sensitive bulk applications**: Tier 3 (Fly Machines + Camoufox, not covered in this doc).
- **ATS with public APIs**: Tier 4 (API-Direct, not covered in this doc).

---

*Last updated: 2026-02-13*
*Sources: [AdsPower Local API Docs](https://localapi-doc-en.adspower.com/), [Browserbase Docs](https://docs.browserbase.com/), [AdsPower GitHub](https://github.com/AdsPower/localAPI)*
*Depends on: [01-adspower-integration.md](../integration/01-adspower-integration.md), [04-multi-tier-sandbox-architecture.md](../sandbox/04-multi-tier-sandbox-architecture.md)*
