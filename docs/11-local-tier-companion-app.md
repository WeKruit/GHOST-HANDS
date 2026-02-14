# 11 - Local Tier: Chrome Extension + Companion App (BACKLOG)

> **Status: BACKLOG** — This tier is deferred. Focus is on cloud tiers (Hatchet + EC2/AdsPower + Browserbase) first.
> This doc captures the technical research and architecture for future implementation.

---

## Overview

A "Local" tier ($9-12/mo) where automation runs on the user's own machine via a Chrome Extension + native companion app. Positioned between Free (extension autofill) and Starter ($19/mo cloud).

## Architecture

```
Chrome Extension (MV3)
  │  connectNative() + 20s heartbeat
  ▼
Companion App (Valet.app, ~60-90MB)
  ├── Bundled Node.js runtime (~40MB)
  ├── App code (Stagehand v3 + Magnitude)
  ├── Native Messaging stdin/stdout handler
  └── Launches Chrome with:
        --remote-debugging-port=9222
        --user-data-dir=~/Library/.../Valet/chrome-profile
        └── Stagehand connects via cdpUrl
```

## User Experience

1. Install extension from Chrome Web Store (1 click)
2. Extension prompts to download companion app (~60-90MB .dmg/.exe)
3. User installs companion to Applications (standard app install)
4. Companion registers as Chrome Native Messaging Host automatically
5. User clicks "Apply" in extension → companion launches Valet Browser window → automation runs

## Technical Challenges

### Critical (Must Solve)

**MV3 Service Worker Lifecycle:**
- Service worker dies after 30s idle, killing the native host process
- Fix: 20s heartbeat ping/pong between native host and service worker
- Chrome 110+ improved this but heartbeat is still required
- Claude Code hit this exact bug (github.com/anthropics/claude-code/issues/16350)

**Chrome v136 CDP Security Change:**
- `--remote-debugging-port` requires non-default `--user-data-dir` since Chrome v136
- Cannot attach CDP to user's existing Chrome profile
- Must use a dedicated "Valet Browser" profile — user logs into sites once

**Code Signing (Mandatory):**
- macOS Sequoia: unsigned apps get multi-step Gatekeeper block, practically unusable
- Windows: SmartScreen "unknown publisher" warning without signing
- Cost: Apple Developer $99/yr + Microsoft Trusted Signing $9.99/mo (~$220/yr)

**Binary Packaging:**
- `bun build --compile`: Incompatible with Playwright/Patchright ecosystem
- `pkg` (Vercel): Deprecated
- `nexe`: Abandoned
- Node.js SEA: Works but can't embed browser binaries
- Solution: Ship bundled directory (Node.js binary + app code), not single executable

### Medium Risk

**Stagehand + Magnitude CDP Conflict:**
- Both engines connecting to same Chrome instance needs testing
- May need to run sequentially (disconnect Stagehand, connect Magnitude)
- CDP mutex pattern from doc 04 applies

**Content Script Limitation:**
- Content scripts cannot use Native Messaging directly
- Must relay through service worker: Content Script → Service Worker → Native Host
- Adds small latency per message

**Auto-Update Mechanism:**
- Need Sparkle (macOS) / WinSparkle (Windows) or custom HTTP updater
- Must verify signatures (Ed25519) on downloaded updates

### Low Risk

**Chrome Web Store Policy:**
- Extensions requiring native companions are explicitly allowed
- 1Password, Bitwarden, KeePassXC all use this pattern
- Frame as "user-assisted" automation, disclose companion requirement

**`chrome.debugger` Alternative:**
- Ruled out: shows undismissable yellow "debugging" banner
- `--silent-debugger-extension-api` flag exists but requires Chrome launch flag (impractical)

## Native Messaging Host Registration

**macOS:**
- User: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wekruit.valet.companion.json`
- System: `/Library/Google/Chrome/NativeMessagingHosts/com.wekruit.valet.companion.json`

**Windows:**
- Registry: `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.wekruit.valet.companion`
- Value = path to manifest JSON file

**Linux:**
- User: `~/.config/google-chrome/NativeMessagingHosts/com.wekruit.valet.companion.json`
- System: `/etc/opt/chrome/native-messaging-hosts/com.wekruit.valet.companion.json`

**Manifest format:**
```json
{
  "name": "com.wekruit.valet.companion",
  "description": "Valet Companion - Browser Automation Engine",
  "path": "/Applications/Valet.app/Contents/MacOS/valet-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

## Native Messaging Protocol

- Messages: 4-byte length header (uint32, native byte order) + JSON payload
- Extension → Host: max 64 MiB per message
- Host → Extension: max 1 MB per message
- Windows: must set stdin/stdout to `O_BINARY` mode
- `connectNative()` for persistent connection (not `sendNativeMessage()` which spawns new process per message)

## Companion App Structure

```
Valet.app/  (macOS)
  Contents/
    MacOS/
      valet-native-host     (launcher script)
      node                  (bundled Node.js, ~40MB)
    Resources/
      app/
        dist/               (compiled TypeScript)
        node_modules/       (Stagehand, Magnitude, etc.)
      manifest.json         (Native Messaging Host manifest)
```

Estimated size: ~60-90MB (using user's Chrome) or ~250-290MB (bundling Chrome for Testing)

## Monorepo Location

```
apps/agent/
  ├── src/
  │   ├── main.ts              — Entry point, Native Messaging listener
  │   ├── native-messaging.ts  — Chrome NM protocol (stdin/stdout framing)
  │   ├── browser-manager.ts   — Launch/manage Chrome with CDP
  │   ├── heartbeat.ts         — 20s ping/pong keep-alive
  │   ├── automation/
  │   │   ├── sandbox-controller.ts  — Shared with apps/worker
  │   │   ├── stagehand-engine.ts
  │   │   └── magnitude-engine.ts
  │   └── api-client.ts        — Valet API for profile/LLM routing
  ├── package.json
  └── scripts/
      ├── build-macos.sh       — Build .app bundle + sign + notarize
      └── build-windows.sh     — Build .exe + sign
```

## Cost Model

- $0 infrastructure cost per application
- ~$0.02/app LLM cost (routed through Valet API)
- Subscription ($9-12/mo) covers API access + LLM routing
- Code signing: ~$220/year fixed cost

## Precedents

| Product | Extension | Native Companion | Communication |
|---------|-----------|-----------------|---------------|
| 1Password | Chrome ext | Electron app | Native Messaging |
| Bitwarden | Chrome ext | Electron app + Rust proxy | Native Messaging |
| KeePassXC | Chrome ext | C++ app | Native Messaging |
| browserpass | Chrome ext | Go binary | Native Messaging |

## Implementation Phase

Deferred to after Phase 5 (see doc 08). Prerequisites:
- Chrome Extension (Phase 4) must be built first
- Shared SandboxController must be extracted from apps/worker
- Code signing certificates must be obtained
