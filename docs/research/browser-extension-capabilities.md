# Browser Extension Capabilities Research Report

**Project:** GhostHands Browser Operator Mode
**Researcher:** researcher-extension
**Date:** 2026-02-16
**Status:** Comprehensive Findings

---

## Executive Summary

This report analyzes browser extension capabilities needed for GhostHands' "Browser Operator" mode, which will connect a user's existing Chrome/Edge browser to GhostHands via WebSocket + CDP. The architecture is inspired by [Manus Browser Operator](https://manus.im/blog/manus-browser-operator), which successfully demonstrates this pattern in production.

**Key Findings:**
- Chrome Extension Manifest V3 provides all necessary APIs for Browser Operator mode
- The `chrome.debugger` API is the critical component, enabling CDP command routing
- Minimal required permissions: `debugger`, `activeTab`, `storage`, `tabs`, `notifications`
- WebSocket connections in service workers are fully supported (Chrome 116+)
- Alternative approaches (remote debugging port, native messaging) are viable but less user-friendly

---

## 1. Chrome Extension APIs Required

### 1.1 Core APIs (Essential)

#### **`chrome.debugger` - The Foundation**

**Purpose:** Attach to tabs and send CDP (Chrome DevTools Protocol) commands

**Required Permissions:**
```json
{
  "permissions": ["debugger"],
  "manifest_version": 3
}
```

**Warning Displayed to Users:**
- "Access the page debugger backend"
- "Read and change all your data on all websites"

**Key Methods:**
- `chrome.debugger.attach(target, version)` - Attach to a tab
- `chrome.debugger.sendCommand(target, method, params)` - Send CDP commands
- `chrome.debugger.onEvent.addListener()` - Listen for CDP events
- `chrome.debugger.detach(target)` - Clean disconnect

**Available CDP Domains:**
- **Essential for GhostHands:** Page, Runtime, DOM, Input, Network, Target
- **Nice-to-have:** Emulation, Performance, Storage, Fetch
- **Full list:** Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn

**Example Usage:**
```typescript
// Attach to tab
await chrome.debugger.attach({ tabId: activeTab.id }, "1.3");

// Send CDP command (e.g., click element)
await chrome.debugger.sendCommand(
  { tabId: activeTab.id },
  "Runtime.evaluate",
  { expression: "document.querySelector('#submit-btn').click()" }
);

// Auto-attach to iframes
await chrome.debugger.sendCommand(
  { tabId: activeTab.id },
  "Target.setAutoAttach",
  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
);
```

**References:**
- [Chrome Debugger API Documentation](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol Specification](https://chromedevtools.github.io/devtools-protocol/)

---

#### **`chrome.tabs` - Tab Management**

**Purpose:** Create, close, query, and manage browser tabs

**Required Permissions:**
```json
{
  "permissions": ["tabs"]
}
```

**Key Methods:**
- `chrome.tabs.create()` - Open new tabs
- `chrome.tabs.update()` - Navigate or focus tabs
- `chrome.tabs.query()` - Find specific tabs
- `chrome.tabs.remove()` - Close tabs
- `chrome.tabs.captureVisibleTab()` - Screenshot capture (requires `activeTab` or `<all_urls>`)

**Example Usage:**
```typescript
// Get active tab
const [activeTab] = await chrome.tabs.query({
  active: true,
  lastFocusedWindow: true
});

// Screenshot capture
const screenshot = await chrome.tabs.captureVisibleTab(
  null,
  { format: 'png' }
);
```

**References:**
- [Chrome Tabs API Documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs)

---

#### **`chrome.scripting` - Content Script Injection**

**Purpose:** Inject JavaScript to extract page content (Readability.js, Turndown.js)

**Required Permissions:**
```json
{
  "permissions": ["scripting"],
  "host_permissions": ["<all_urls>"]
}
```

**Manifest V3 Changes:**
- Moved from `chrome.tabs.executeScript()` (MV2) to `chrome.scripting.executeScript()` (MV3)
- Requires explicit `scripting` permission + host permissions OR `activeTab`

**Key Methods:**
- `chrome.scripting.executeScript()` - Run JS in page context
- `chrome.scripting.insertCSS()` - Inject styles
- `chrome.scripting.removeCSS()` - Clean up

**Example Usage:**
```typescript
// Inject Readability.js to extract article content
const results = await chrome.scripting.executeScript({
  target: { tabId: activeTab.id },
  func: () => {
    const article = new Readability(document.cloneNode(true)).parse();
    return article;
  }
});
```

**Real-World Examples:**
- [LLMFeeder Extension](https://github.com/jatinkrmalik/LLMFeeder) - Uses Readability.js + Turndown.js for Markdown conversion
- [MarkSnip Extension](https://chromewebstore.google.com/detail/marksnip-markdown-web-cli/kcbaglhfgbkjdnpeokaamjjkddempipm) - Clean article extraction

**References:**
- [Chrome Scripting API Introduction](https://developer.chrome.com/blog/crx-scripting-api)
- [Content Scripts Documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

---

#### **`chrome.storage` - Persistent Configuration**

**Purpose:** Store WebSocket URLs, auth tokens, task state

**Required Permissions:**
```json
{
  "permissions": ["storage"]
}
```

**Key Methods:**
- `chrome.storage.local.set()` / `.get()` - Local storage (unlimited size)
- `chrome.storage.sync.set()` / `.get()` - Synced across devices (limited size)
- `chrome.storage.session` - Session-only storage (MV3)

**Example Usage:**
```typescript
// Store WebSocket URL
await chrome.storage.local.set({
  wsUrl: "wss://ghosthands.example.com/connect",
  authToken: "encrypted_token_here"
});

// Retrieve config
const { wsUrl, authToken } = await chrome.storage.local.get([
  'wsUrl',
  'authToken'
]);
```

**Security Note:** Encrypt sensitive data before storing (AES-256 recommended).

**References:**
- [Chrome Storage API Documentation](https://developer.chrome.com/docs/extensions/reference/api/storage)

---

### 1.2 Secondary APIs (High Value)

#### **`chrome.cookies` - Session Detection**

**Purpose:** Read session cookies to detect which ATS sites the user is logged into

**Required Permissions:**
```json
{
  "permissions": ["cookies"],
  "host_permissions": ["*://*.greenhouse.io/*", "*://*.lever.co/*"]
}
```

**Key Methods:**
- `chrome.cookies.get()` - Read specific cookie
- `chrome.cookies.getAll()` - Read all matching cookies
- `chrome.cookies.onChanged` - Listen for cookie changes

**Example Usage:**
```typescript
// Check if user is logged into Greenhouse
const cookies = await chrome.cookies.getAll({
  domain: ".greenhouse.io",
  name: "user_session"
});

const isLoggedIn = cookies.length > 0 && cookies[0].value !== "";
```

**Use Case for GhostHands:**
- Detect login state for ATS sites (Greenhouse, Lever, Workday)
- Show "Ready" indicator when authenticated
- Warn user if session expired during job application

**References:**
- [Chrome Cookies API Documentation](https://developer.chrome.com/docs/extensions/reference/api/cookies)

---

#### **`chrome.downloads` - File Download Management**

**Purpose:** Manage file downloads, detect completion

**Required Permissions:**
```json
{
  "permissions": ["downloads"]
}
```

**Key Methods:**
- `chrome.downloads.download()` - Initiate download
- `chrome.downloads.search()` - Find downloads
- `chrome.downloads.onChanged` - Detect download completion

**Example Usage:**
```typescript
// Start download
const downloadId = await chrome.downloads.download({
  url: "https://example.com/resume.pdf",
  filename: "resume.pdf"
});

// Wait for completion
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.id === downloadId && delta.state?.current === 'complete') {
    console.log('Download finished!');
  }
});
```

**Use Case for GhostHands:**
- Download confirmation emails as PDFs
- Save application receipts
- Verify resume upload succeeded

**References:**
- [Chrome Downloads API Documentation](https://developer.chrome.com/docs/extensions/reference/api/downloads)

---

#### **`chrome.notifications` - User Alerts**

**Purpose:** Show task status to user (success, errors, progress)

**Required Permissions:**
```json
{
  "permissions": ["notifications"]
}
```

**Notification Types:**
- `basic` - Icon, title, message, up to 2 buttons
- `image` - Includes an image
- `list` - Shows list of items
- `progress` - Progress bar

**Example Usage:**
```typescript
// Show success notification
await chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon128.png',
  title: 'GhostHands Task Complete',
  message: 'Successfully applied to 5 jobs at ACME Corp',
  buttons: [
    { title: 'View Details' },
    { title: 'Dismiss' }
  ]
});
```

**References:**
- [Chrome Notifications API Documentation](https://developer.chrome.com/docs/extensions/reference/api/notifications)

---

#### **`chrome.action` - Extension Icon & Popup**

**Purpose:** Display connection status, control automation

**Required Permissions:**
```json
{
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
```

**Key Methods:**
- `chrome.action.setBadgeText()` - Show text on icon (e.g., "LIVE")
- `chrome.action.setBadgeBackgroundColor()` - Status color
- `chrome.action.openPopup()` - Open popup programmatically

**Example Badge Design (Color-Coded Status):**
```typescript
// Connected - Green badge
await chrome.action.setBadgeText({ text: '✓' });
await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });

// Active task - Blue badge with animation
await chrome.action.setBadgeText({ text: '⚙' });
await chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' });

// Error - Red badge
await chrome.action.setBadgeText({ text: '!' });
await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
```

**References:**
- [User Interface Components Documentation](https://developer.chrome.com/docs/extensions/develop/ui)
- [Browser Status Dashboard Example](https://chromewebstore.google.com/detail/browser-status-dashboard/kdekjcmplepcfadmdofbppdcjhoplpch)

---

### 1.3 Manifest V3 Requirements

**Key Changes from MV2:**
1. **Service Workers Replace Background Pages**
   - No persistent background page
   - Service worker can terminate after 30s of inactivity
   - **Exception:** WebSocket connections keep service worker alive (Chrome 116+)

2. **Host Permissions Separated**
   ```json
   {
     "permissions": ["debugger", "tabs", "storage"],
     "host_permissions": ["<all_urls>"],
     "optional_host_permissions": ["*://*.greenhouse.io/*"]
   }
   ```

3. **ExecuteScript Moved**
   - MV2: `chrome.tabs.executeScript()`
   - MV3: `chrome.scripting.executeScript()`

**Complete Manifest Example:**
```json
{
  "manifest_version": 3,
  "name": "GhostHands Browser Operator",
  "version": "1.0.0",
  "description": "Connect your browser to GhostHands automation",
  "permissions": [
    "debugger",
    "tabs",
    "scripting",
    "storage",
    "notifications",
    "cookies",
    "downloads",
    "activeTab"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**References:**
- [Declare Permissions Documentation](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Migrate to Service Workers](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)

---

## 2. Extension Invocation Patterns

### When Does the Agent Need the Extension?

| Scenario | Why Extension Needed | Chrome API Used | Alternative? |
|----------|---------------------|-----------------|--------------|
| **File Uploads** | OS file picker requires user interaction | None (extension shows UI to user) | ❌ No programmatic alternative |
| **Clipboard Operations** | Web pages can't write to OS clipboard | None (native messaging host needed) | ⚠️ Limited (web Clipboard API exists but restricted) |
| **Download Management** | Detect when file download completes | `chrome.downloads.onChanged` | ❌ Web pages can't reliably detect this |
| **Tab Focus/Visibility** | Some sites check `document.visibilityState` | `chrome.tabs.update()`, `chrome.windows.update()` | ✅ CDP can simulate but janky |
| **Window/Popup Management** | OAuth popups, new windows | `chrome.windows.create()`, `chrome.windows.remove()` | ✅ CDP `Target.createTarget()` works but complex |
| **Cookie Reading** | Detect logged-in state | `chrome.cookies.getAll()` | ✅ CDP `Network.getCookies()` works |
| **Screenshot Capture** | Visual verification | `chrome.tabs.captureVisibleTab()` | ✅ CDP `Page.captureScreenshot()` works |
| **CDP Command Routing** | Execute arbitrary CDP commands | `chrome.debugger.sendCommand()` | ❌ **This is the core value** |

**Key Insight:** The extension's primary value is **CDP command routing**, not specific capabilities. Once you have `chrome.debugger`, you can do almost anything. The other APIs (cookies, downloads, etc.) are convenience wrappers.

---

### 2.1 Critical: File Upload Bypass

**Problem:** Web pages can't programmatically set `<input type="file">` values due to security restrictions.

**Extension-Based Solutions:**

#### Option A: User Interaction Required (Most Secure)
```typescript
// Extension shows file picker to user
const fileHandle = await showOpenFilePicker({
  types: [{
    description: 'Resume',
    accept: { 'application/pdf': ['.pdf'] }
  }]
});

// Read file and inject into page
const file = await fileHandle.getFile();
const dataUrl = await fileToDataUrl(file);

// Use CDP to set file input
await chrome.debugger.sendCommand(
  { tabId },
  "DOM.setFileInputFiles",
  { files: [dataUrl], nodeId }
);
```

#### Option B: Clipboard-Based Upload (User Copies File First)
- User copies file in OS
- Extension detects clipboard content
- Injects file into `<input>` element

**Real-World Examples:**
- [Copy-n-Paste Extension](https://chromewebstore.google.com/detail/copy-n-paste-clipboard-up/bnmdedmhngbeofnafobjmcihealecgnf) - Paste clipboard images directly
- [ClipboardToFileInput](https://github.com/GooglyBlox/ClipboardToFileInput) - Paste to file inputs

**Limitation:** Extensions cannot read the file system directly. User must either:
1. Use the extension's file picker UI
2. Copy the file to clipboard first
3. Have file pre-staged in a known location (requires native messaging host)

**References:**
- [Copy-n-Paste GitHub Repo](https://github.com/kazcfz/Copy-n-Paste)
- [Clipboard2File Chrome Extension](https://github.com/daijro/Clipboard2File-Chrome)

---

### 2.2 Clipboard Operations

**Problem:** Web pages have limited clipboard access (requires user gesture, HTTPS, permissions).

**Extension Solution:**
```typescript
// Native messaging to read OS clipboard
const clipboardContent = await chrome.runtime.sendNativeMessage(
  'com.ghosthands.clipboard_helper',
  { action: 'read' }
);

// Or use Web Clipboard API (limited)
const clipboardText = await navigator.clipboard.readText();
```

**Limitation:** Chrome extensions themselves can't directly read OS clipboard. Options:
1. **Native Messaging Host** - Separate binary that reads clipboard
2. **Web Clipboard API** - Works but requires user gesture + permission
3. **Paste Event Listener** - Wait for user to paste (Ctrl+V)

**Recommendation:** For GhostHands, use **Web Clipboard API** when possible, fall back to asking user to paste.

**References:**
- [Native Messaging Documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

---

## 3. Manus Browser Operator Architecture

Based on public information and analysis of the [Manus Browser Operator announcement](https://manus.im/blog/manus-browser-operator):

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Manus Cloud Infrastructure (AI Brain)                  │
│  - Task Planning (LLM)                                  │
│  - Action Execution Logic                               │
│  - WebSocket Server                                     │
└───────────────────┬─────────────────────────────────────┘
                    │
                    │ WebSocket (Encrypted, AES-256)
                    │
┌───────────────────▼─────────────────────────────────────┐
│  Chrome Extension (Local Proxy)                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Background Service Worker                        │   │
│  │ - WebSocket bridge                               │   │
│  │ - Command router                                 │   │
│  │ - chrome.debugger manager                        │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Content Script (Injected into pages)             │   │
│  │ - Readability.js (article extraction)            │   │
│  │ - Turndown.js (HTML → Markdown)                  │   │
│  │ - Screenshot capture                             │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────┬─────────────────────────────────────┘
                    │
                    │ CDP Commands
                    │
┌───────────────────▼─────────────────────────────────────┐
│  User's Chrome Browser                                  │
│  - Tabs with active sessions (Gmail, ATS, etc.)         │
│  - User's cookies and login state                       │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Key Components

#### **Permissions Model**
```json
{
  "permissions": [
    "debugger",
    "tabs",
    "scripting",
    "cookies",
    "storage",
    "notifications",
    "<all_urls>"
  ]
}
```

#### **Background Service Worker (WebSocket Bridge)**
```typescript
// Pseudo-code based on public info
let ws: WebSocket | null = null;
let attachedTabs = new Map<number, boolean>();

// Connect to Manus cloud
async function connectToManusCloud(authToken: string) {
  ws = new WebSocket('wss://manus-api.example.com/browser-operator');

  ws.onmessage = async (event) => {
    const command = JSON.parse(event.data);

    switch (command.type) {
      case 'CDP_COMMAND':
        await executeCdpCommand(command.tabId, command.method, command.params);
        break;
      case 'EXTRACT_CONTENT':
        await extractPageContent(command.tabId);
        break;
      case 'SCREENSHOT':
        await captureScreenshot(command.tabId);
        break;
    }
  };
}

// Execute CDP command
async function executeCdpCommand(tabId: number, method: string, params: any) {
  // Attach if not already
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.set(tabId, true);
  }

  // Send command
  const result = await chrome.debugger.sendCommand(
    { tabId },
    method,
    params
  );

  // Send result back to cloud
  ws?.send(JSON.stringify({ type: 'RESULT', result }));
}
```

#### **Content Script (Page Data Extraction)**
```typescript
// Injected into pages to extract content
async function extractContent() {
  // Use Readability.js to get clean article
  const article = new Readability(document.cloneNode(true)).parse();

  // Convert to Markdown
  const markdown = new TurndownService().turndown(article.content);

  return {
    title: article.title,
    content: markdown,
    url: window.location.href
  };
}

// Listen for extraction requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'EXTRACT_CONTENT') {
    extractContent().then(sendResponse);
    return true; // Async response
  }
});
```

### 3.3 Security Features

**OAuth 2.0 Device Flow:**
- Extension shows 6-digit code to user
- User enters code at `manus.im/activate`
- No credentials exposed to extension
- Tokens stored encrypted in `chrome.storage.local`

**Data Encryption:**
- WebSocket traffic encrypted with AES-256
- Ephemeral keys regenerated per session
- Tokens encrypted before storage

**Scoped Access:**
- Extension only activates when user clicks icon
- Can detach from tabs when not in use
- User can see which tabs are being controlled

**References:**
- [Manus Browser Operator Security Analysis](https://mindgard.ai/blog/manus-rubra-full-browser-remote-control)
- [OAuth 2.0 Device Flow RFC](https://datatracker.ietf.org/doc/html/rfc8628)

---

## 4. Security Model & Trust

### 4.1 Required vs. Optional Permissions

#### Minimum Viable Permissions (MVP)
```json
{
  "permissions": [
    "debugger",      // REQUIRED - CDP access
    "activeTab",     // REQUIRED - Current tab access
    "storage"        // REQUIRED - Store config
  ]
}
```

**Warning Level:** ⚠️ **HIGH** - "Access page debugger backend" + "Read and change all your data"

#### Recommended Permissions (Full Features)
```json
{
  "permissions": [
    "debugger",
    "tabs",          // Tab management
    "scripting",     // Content extraction
    "storage",
    "notifications", // Task status
    "cookies"        // Login detection
  ],
  "host_permissions": ["<all_urls>"]
}
```

**Warning Level:** ⚠️ **VERY HIGH** - Same as above + "Access your data for all websites"

#### Progressive Permissions Strategy
```json
{
  "permissions": ["debugger", "activeTab", "storage"],
  "optional_permissions": ["tabs", "notifications", "cookies"],
  "optional_host_permissions": [
    "*://*.greenhouse.io/*",
    "*://*.lever.co/*",
    "*://*.workday.com/*"
  ]
}
```

**User Flow:**
1. Initial install: Only core permissions
2. First job application: "GhostHands needs access to Greenhouse.io to apply"
3. User approves specific domain
4. Extension requests permissions dynamically

**References:**
- [Chrome Extension Permissions Guide](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Permission Warnings List](https://developer.chrome.com/docs/extensions/reference/permissions-list)

---

### 4.2 Chrome Web Store Review Process

**Debugger Permission Scrutiny:**

From [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies):

> "Extensions must require only the narrowest set of permissions necessary to provide their existing services or features."

**For `debugger` permission specifically:**
- Triggers manual review (not automated)
- Requires justification in submission notes
- Must demonstrate legitimate use case
- **Higher rejection rate** than standard extensions

**Best Practices to Pass Review:**

1. **Clear Privacy Policy**
   - Explain exactly what data is collected
   - Where data is sent (to your servers vs. stays local)
   - User control options

2. **Justification Statement**
   ```
   Example submission notes:

   "GhostHands uses the chrome.debugger API to automate job applications
   on behalf of users. The debugger permission is required to:
   - Interact with web forms programmatically
   - Navigate multi-step application flows
   - Detect page state changes

   All automation is user-initiated and controlled. Data flows:
   - User's browser → GhostHands servers (encrypted via WSS)
   - No third-party data sharing
   - Users can revoke access anytime

   Full source code available at: github.com/yourorg/ghosthands-extension"
   ```

3. **Open Source (Recommended)**
   - Public GitHub repo builds trust
   - Easier for reviewers to verify claims
   - Community can audit security

4. **2-Step Verification Required**
   - All Chrome Web Store developer accounts require 2FA

**Timeline:**
- Standard extension: 1-3 days review
- `debugger` extension: 5-14 days (manual review)

**Rejection Risks:**
- Unclear purpose of `debugger` permission
- Excessive permissions without justification
- Privacy policy missing/incomplete
- Code obfuscation (red flag for security)

**References:**
- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Troubleshooting Violations](https://developer.chrome.com/docs/webstore/troubleshooting)
- [Permission Security Research](https://dspace.networks.imdea.org/bitstream/handle/20.500.12761/1704/eurosp2023-final51.pdf?sequence=1)

---

### 4.3 Making the Extension Trustworthy

**Trust Factors:**

| Factor | Impact | Implementation |
|--------|--------|----------------|
| **Open Source** | 🟢 Very High | Public GitHub repo, reproducible builds |
| **Limited Scope** | 🟢 High | Only request essential permissions |
| **Transparent Data Flow** | 🟢 High | Privacy policy + architecture diagram |
| **User Control** | 🟢 High | Easy on/off toggle, per-domain permissions |
| **No Telemetry** | 🟡 Medium | Or make it opt-in with clear disclosure |
| **Audited** | 🟡 Medium | Third-party security audit (expensive) |
| **Brand Trust** | 🟡 Medium | If WeKruit is established brand |

**Recommended Approach for GhostHands:**

1. **Open Source Extension**
   - Publish full extension source on GitHub
   - Separate repo from main GhostHands codebase
   - MIT or Apache 2.0 license

2. **Minimal Data Collection**
   ```
   Data that STAYS in browser:
   - User's cookies
   - Page content
   - Screenshots

   Data sent to GhostHands servers:
   - Task commands (encrypted)
   - Task results (encrypted)
   - Error logs (anonymized)

   Data NEVER collected:
   - Browsing history
   - Passwords
   - Credit card info
   ```

3. **Clear Consent Flow**
   ```
   First run experience:

   [GhostHands Setup]

   This extension needs powerful permissions to automate job applications:

   ✓ Access page debugger (to fill forms)
   ✓ Read cookies (to detect login state)
   ✓ Manage tabs (to navigate application flows)

   Your data never leaves your device except:
   - When sending commands to GhostHands servers (encrypted)
   - Logs for debugging (anonymized)

   [Review Privacy Policy] [Cancel] [Authorize]
   ```

4. **Audit Trail**
   - Show user exactly what the extension did
   - Log all CDP commands sent
   - "History" view in popup

**References:**
- [Chrome Extension Security Best Practices](https://spin.ai/blog/chrome-extension-permission-security-tips-for-businesses/)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

---

### 4.4 Data Flow Architecture

**Three Data Flow Models:**

#### Model A: Maximum Privacy (Local-Only)
```
User's Browser ←→ Extension ←→ GhostHands Desktop App (localhost)
                                      ↓
                                 Cloud API (minimal)
```
- Extension connects to localhost WebSocket
- GhostHands runs as desktop app
- Only sends task commands to cloud, not page data
- **Privacy:** 🟢 Excellent | **UX:** 🟡 Requires install

#### Model B: Hybrid (Recommended)
```
User's Browser ←→ Extension ←→ WSS (encrypted) ←→ GhostHands Cloud
                    ↓
              localStorage
             (encrypted)
```
- Extension connects directly to GhostHands cloud
- Page data extracted locally, sent encrypted
- Temporary storage in `chrome.storage.local`
- **Privacy:** 🟡 Good | **UX:** 🟢 Excellent

#### Model C: Full Cloud (Most Convenient)
```
User's Browser ←→ Extension ←→ GhostHands Cloud ←→ AI Models
```
- All processing in cloud
- Extension is thin client
- **Privacy:** 🔴 Concerns | **UX:** 🟢 Excellent

**Recommendation:** Use **Model B (Hybrid)** for GhostHands.

---

## 5. Alternative Approaches (No Extension)

### 5.1 Remote Debugging Port (Playwright/Puppeteer)

**How It Works:**
```bash
# User launches Chrome with debugging enabled
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

```typescript
// GhostHands connects via Playwright
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
const pages = contexts[0].pages();
```

**Pros:**
- ✅ No extension needed
- ✅ Full CDP access
- ✅ Playwright's high-level API
- ✅ Works with existing sessions (if correct user-data-dir)

**Cons:**
- ❌ User must manually launch Chrome with flags
- ❌ Can't attach to their normal browsing profile easily
- ❌ Security warning: "Chrome is being controlled by automated software"
- ❌ Port 9222 must be open (firewall issues)
- ❌ Only works locally (can't reach remote browser)

**When to Use:**
- Developer/power user mode
- Internal tools (not end-user product)
- Testing/debugging

**References:**
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype)
- [Connecting to Existing Browser Guide](https://www.browserstack.com/guide/playwright-connect-to-existing-browser)

---

### 5.2 Native Messaging Host

**How It Works:**
```
GhostHands Desktop App ←→ Native Messaging Host ←→ Chrome Extension
                              (JSON-RPC)
```

**Native Host Manifest (`com.ghosthands.bridge.json`):**
```json
{
  "name": "com.ghosthands.bridge",
  "description": "GhostHands Browser Bridge",
  "path": "/usr/local/bin/ghosthands-bridge",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://abc123.../"
  ]
}
```

**Extension Code:**
```typescript
// Send message to native app
const response = await chrome.runtime.sendNativeMessage(
  'com.ghosthands.bridge',
  { action: 'GET_CLIPBOARD' }
);
```

**Pros:**
- ✅ Access to OS features (clipboard, file system, process management)
- ✅ Bypass browser security restrictions
- ✅ Can run background tasks without service worker limits

**Cons:**
- ❌ Requires separate native app install
- ❌ Platform-specific (macOS, Windows, Linux)
- ❌ More complex distribution (app + extension)
- ❌ Additional security review needed

**When to Use:**
- Need OS-level features (clipboard, file system)
- Running long-lived background tasks
- Desktop app already exists

**References:**
- [Native Messaging Documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Native Messaging as Bridge (Medium)](https://medium.com/fme-developer-stories/native-messaging-as-bridge-between-web-and-desktop-d288ea28cfd7)

---

### 5.3 PWA with Extended Capabilities

**How It Works:**
```typescript
// Request extended permissions in PWA
const fileHandle = await window.showOpenFilePicker();
const clipboardText = await navigator.clipboard.readText();
```

**Pros:**
- ✅ No extension install
- ✅ Web-based (cross-platform)
- ✅ Some advanced APIs (File System Access, Clipboard)

**Cons:**
- ❌ No CDP access (dealbreaker for GhostHands)
- ❌ Can't interact with other tabs/windows
- ❌ Limited to single origin
- ❌ Requires HTTPS + service worker

**When to Use:**
- Simple web app with file access needs
- No need for cross-origin or CDP

**Verdict for GhostHands:** ❌ **Not viable** - PWAs can't access CDP, which is essential.

**References:**
- [PWA Capabilities 2026](https://progressier.com/pwa-capabilities)
- [What PWA Can Do Today](https://whatpwacando.today/)

---

### 5.4 Comparison Matrix

| Approach | CDP Access | User Sessions | Setup Complexity | Security | Recommendation |
|----------|-----------|---------------|------------------|----------|----------------|
| **Chrome Extension** | ✅ Full | ✅ Yes | 🟢 Easy (1 install) | 🟡 Requires trust | ⭐ **BEST for GhostHands** |
| **Remote Debug Port** | ✅ Full | ⚠️ Partial | 🔴 Hard (manual flags) | 🟢 Local only | Good for dev mode |
| **Native Messaging** | ✅ Via extension | ✅ Yes | 🔴 Hard (2 installs) | 🟡 OS-level access | Good for advanced features |
| **PWA** | ❌ None | ❌ No | 🟢 Easy | 🟢 Sandboxed | ❌ Not viable |

**Recommendation:** Use **Chrome Extension** as primary approach, with **Remote Debug Port** as developer/debugging fallback.

---

## 6. Extension Popup/UI Design

### 6.1 Status Display Patterns

**Connection Status Badge:**
```typescript
// Color-coded status on extension icon
const STATUS_COLORS = {
  CONNECTED: '#10B981',    // Green
  ACTIVE: '#3B82F6',       // Blue (task running)
  ERROR: '#EF4444',        // Red
  DISCONNECTED: '#6B7280'  // Gray
};

const STATUS_ICONS = {
  CONNECTED: '✓',
  ACTIVE: '⚙',
  ERROR: '!',
  DISCONNECTED: '○'
};

async function updateStatus(status: keyof typeof STATUS_COLORS) {
  await chrome.action.setBadgeText({ text: STATUS_ICONS[status] });
  await chrome.action.setBadgeBackgroundColor({
    color: STATUS_COLORS[status]
  });
}
```

**Real-World Example:**
- [Browser Status Dashboard](https://chromewebstore.google.com/detail/browser-status-dashboard/kdekjcmplepcfadmdofbppdcjhoplpch) - Color-coded status with response time badges

---

### 6.2 Popup UI Structure

**Minimal Popup (MVP):**
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { width: 320px; padding: 16px; font-family: system-ui; }
    .status { display: flex; align-items: center; gap: 8px; }
    .status-dot { width: 12px; height: 12px; border-radius: 50%; }
    .status-dot.connected { background: #10B981; }
    .status-dot.disconnected { background: #6B7280; }
  </style>
</head>
<body>
  <div class="status">
    <span class="status-dot connected"></span>
    <span>Connected to GhostHands</span>
  </div>

  <div class="task-info">
    <p><strong>Active Task:</strong> Applying to jobs at ACME Corp</p>
    <progress value="3" max="5"></progress>
    <p>3 of 5 applications complete</p>
  </div>

  <button id="stop-btn">Stop Automation</button>
</body>
</html>
```

**Full-Featured Popup:**
```html
<!-- Add these sections -->

<!-- Connection Settings -->
<div class="settings">
  <label>
    WebSocket URL:
    <input type="text" id="ws-url" value="wss://api.ghosthands.com/connect" />
  </label>
  <button id="connect-btn">Connect</button>
</div>

<!-- Session Status -->
<div class="sessions">
  <h3>Detected Logins</h3>
  <div class="session">
    ✓ Greenhouse.io (logged in as user@example.com)
  </div>
  <div class="session">
    ✗ Lever.co (not logged in)
  </div>
</div>

<!-- Task History -->
<div class="history">
  <h3>Recent Tasks</h3>
  <ul>
    <li>✓ Applied to 5 jobs at ACME Corp (2 min ago)</li>
    <li>✓ Filled Workday profile (10 min ago)</li>
  </ul>
</div>

<!-- Permission Controls -->
<div class="permissions">
  <label>
    <input type="checkbox" checked disabled /> Greenhouse.io
  </label>
  <label>
    <input type="checkbox" /> Lever.co
    <button>Grant Access</button>
  </label>
</div>
```

---

### 6.3 Real-Time Task Progress

**WebSocket → Popup Communication:**
```typescript
// background.js (Service Worker)
let currentTask = null;

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'TASK_PROGRESS') {
    currentTask = message.task;

    // Update badge
    updateStatus('ACTIVE');

    // Notify popup if open
    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      task: currentTask
    });
  }
};

// popup.js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TASK_UPDATE') {
    document.getElementById('task-name').textContent = message.task.name;
    document.getElementById('progress').value = message.task.progress;
  }
});
```

**Desktop Notification (for long-running tasks):**
```typescript
// Show notification when task completes
chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon128.png',
  title: 'GhostHands Task Complete',
  message: 'Successfully applied to 5 jobs at ACME Corp',
  buttons: [
    { title: 'View Results' }
  ]
});
```

**References:**
- [Ultimate Guide to Browser Extensions Design](https://lab.interface-design.co.uk/the-ultimate-guide-to-browser-extensions-design-ea858d6634a6)
- [User Interface Components](https://developer.chrome.com/docs/extensions/develop/ui)

---

## 7. Recommended Architecture for GhostHands

### 7.1 Minimal Viable Extension (MVP)

**Scope:** Prove the Browser Operator concept works

**Features:**
- Connect to GhostHands cloud via WebSocket
- Execute CDP commands sent from server
- Simple status display (connected/disconnected)
- Emergency stop button

**Permissions:**
```json
{
  "permissions": ["debugger", "activeTab", "storage"]
}
```

**Files:**
```
ghosthands-extension/
├── manifest.json
├── background.js        # WebSocket bridge + CDP router
├── popup.html          # Simple status UI
├── popup.js            # Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

**Timeline:** 1-2 weeks to build and test

---

### 7.2 Full-Featured Extension (V1.0)

**Additional Features:**
- Cookie-based login detection
- Content extraction (Readability.js + Turndown.js)
- Screenshot capture
- Download management
- Task progress display
- Permission controls per domain

**Permissions:**
```json
{
  "permissions": [
    "debugger",
    "tabs",
    "scripting",
    "storage",
    "notifications",
    "cookies",
    "downloads"
  ],
  "optional_host_permissions": [
    "*://*.greenhouse.io/*",
    "*://*.lever.co/*",
    "*://*.workday.com/*"
  ]
}
```

**Additional Files:**
```
├── content-script.js    # Readability + Turndown
├── lib/
│   ├── readability.min.js
│   └── turndown.min.js
└── styles/
    └── popup.css
```

**Timeline:** 4-6 weeks after MVP

---

### 7.3 Code Examples

#### Background Service Worker (WebSocket Bridge)
```typescript
// background.js
let ws: WebSocket | null = null;
let attachedTabs = new Map<number, boolean>();

// Connect to GhostHands cloud
async function connect() {
  const { wsUrl, authToken } = await chrome.storage.local.get([
    'wsUrl',
    'authToken'
  ]);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to GhostHands');
    updateBadge('CONNECTED');

    // Authenticate
    ws.send(JSON.stringify({
      type: 'AUTH',
      token: authToken
    }));
  };

  ws.onmessage = async (event) => {
    const command = JSON.parse(event.data);
    await handleCommand(command);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateBadge('ERROR');
  };

  ws.onclose = () => {
    console.log('Disconnected from GhostHands');
    updateBadge('DISCONNECTED');

    // Detach from all tabs
    for (const tabId of attachedTabs.keys()) {
      chrome.debugger.detach({ tabId });
    }
    attachedTabs.clear();
  };
}

// Handle commands from server
async function handleCommand(command: any) {
  switch (command.type) {
    case 'CDP_COMMAND':
      await executeCdpCommand(
        command.tabId,
        command.method,
        command.params
      );
      break;

    case 'EXTRACT_CONTENT':
      await extractContent(command.tabId);
      break;

    case 'SCREENSHOT':
      await captureScreenshot(command.tabId);
      break;

    case 'CHECK_LOGIN':
      await checkLoginState(command.domain);
      break;
  }
}

// Execute CDP command
async function executeCdpCommand(
  tabId: number,
  method: string,
  params: any
) {
  try {
    // Attach if not already
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.set(tabId, true);
    }

    // Send command
    const result = await chrome.debugger.sendCommand(
      { tabId },
      method,
      params
    );

    // Send result back
    ws?.send(JSON.stringify({
      type: 'RESULT',
      commandId: command.id,
      result
    }));
  } catch (error) {
    ws?.send(JSON.stringify({
      type: 'ERROR',
      commandId: command.id,
      error: error.message
    }));
  }
}

// Extract page content
async function extractContent(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // @ts-ignore - Readability injected separately
      const article = new Readability(document.cloneNode(true)).parse();
      // @ts-ignore - Turndown injected separately
      const markdown = new TurndownService().turndown(article.content);

      return {
        title: article.title,
        content: markdown,
        url: window.location.href
      };
    }
  });

  ws?.send(JSON.stringify({
    type: 'CONTENT',
    content: results[0].result
  }));
}

// Check login state via cookies
async function checkLoginState(domain: string) {
  const cookies = await chrome.cookies.getAll({ domain });
  const hasSessionCookie = cookies.some(c =>
    c.name.includes('session') || c.name.includes('token')
  );

  ws?.send(JSON.stringify({
    type: 'LOGIN_STATE',
    domain,
    loggedIn: hasSessionCookie
  }));
}

// Update status badge
function updateBadge(status: string) {
  const badges = {
    CONNECTED: { text: '✓', color: '#10B981' },
    ACTIVE: { text: '⚙', color: '#3B82F6' },
    ERROR: { text: '!', color: '#EF4444' },
    DISCONNECTED: { text: '○', color: '#6B7280' }
  };

  const badge = badges[status];
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    wsUrl: 'wss://api.ghosthands.com/connect',
    authToken: null
  });
});

// Auto-connect if token exists
chrome.storage.local.get(['authToken'], ({ authToken }) => {
  if (authToken) {
    connect();
  }
});
```

---

## 8. Key Recommendations

### 8.1 For MVP (Phase 2)

**Must Have:**
1. ✅ Chrome extension with `debugger`, `activeTab`, `storage` permissions
2. ✅ WebSocket bridge to GhostHands cloud
3. ✅ CDP command router (execute commands sent from server)
4. ✅ Simple popup UI (connection status + stop button)
5. ✅ OAuth 2.0 device flow for authentication

**Nice to Have (can defer):**
- Content extraction (Readability/Turndown)
- Cookie-based login detection
- Download management
- Notifications

**MVP Success Criteria:**
- User installs extension
- Connects to GhostHands cloud
- Extension executes CDP commands (navigate, click, type)
- User can stop automation from popup

---

### 8.2 Security Best Practices

1. **Minimal Permissions**
   - Start with `debugger`, `activeTab`, `storage` only
   - Add others progressively as features are built
   - Use `optional_permissions` for non-essential features

2. **Data Encryption**
   - WSS (WebSocket Secure) for all communication
   - Encrypt auth tokens before storing in `chrome.storage.local`
   - Use AES-256 with Web Crypto API

3. **Open Source**
   - Publish extension source on GitHub
   - Builds trust with users and reviewers
   - Easier Chrome Web Store approval

4. **Privacy Policy**
   - Clear explanation of data flow
   - What data is collected vs. what stays local
   - User rights (delete data, revoke access)

5. **Audit Trail**
   - Log all CDP commands executed
   - Show user what the extension did
   - Export logs for debugging

---

### 8.3 Chrome Web Store Submission Tips

**Before Submission:**
- [ ] Clear privacy policy published
- [ ] Justification for `debugger` permission written
- [ ] All code unobfuscated (no webpack/minification for review)
- [ ] Developer account has 2FA enabled
- [ ] Screenshots prepared (show UI, not just generic browser)
- [ ] Promotional tile (440x280px) designed

**Submission Notes Template:**
```
Extension Name: GhostHands Browser Operator
Category: Productivity

JUSTIFICATION FOR DEBUGGER PERMISSION:

GhostHands automates job applications on behalf of users. The chrome.debugger
API is required to:

1. Programmatically interact with web forms (fill fields, click buttons)
2. Navigate multi-step application flows
3. Detect dynamic page state changes (SPA navigation)

All automation is user-initiated via the GhostHands dashboard. The extension
acts as a bridge between the user's browser and GhostHands cloud service.

DATA FLOW:
- User's browser ←→ Extension ←→ GhostHands servers (WSS encrypted)
- No third-party data sharing
- Users control which sites are automated via permission grants

OPEN SOURCE:
Full source code: https://github.com/yourorg/ghosthands-extension

PRIVACY POLICY:
https://ghosthands.com/privacy
```

**Expected Timeline:**
- Submit → Manual review starts: 1-2 days
- Review in progress: 5-14 days
- Approval/rejection: Total 7-16 days

---

### 8.4 Alternative: Developer Mode (Bypass Store)

**For internal testing or enterprise users:**

```bash
# User loads unpacked extension
1. Open chrome://extensions/
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select extension directory
```

**Pros:**
- ✅ No review process
- ✅ Instant updates (just refresh)
- ✅ Can use test servers

**Cons:**
- ❌ Chrome shows "Developer mode extensions" warning
- ❌ Doesn't auto-update
- ❌ Not suitable for end users

**Use Case:** Internal beta testing before Web Store submission

---

## 9. Conclusion

### 9.1 Summary

**Chrome Extension is the right approach for GhostHands Browser Operator:**
- Full CDP access via `chrome.debugger` API
- Access to user's existing browser sessions
- Reasonable setup complexity (single install)
- Proven pattern (Manus Browser Operator demonstrates viability)

**Minimal Viable Extension requires:**
- `debugger`, `activeTab`, `storage` permissions
- WebSocket bridge to cloud
- CDP command router
- Simple status UI

**Key Risks:**
1. Chrome Web Store review (debugger permission scrutiny)
2. User trust (powerful permissions warning)
3. Service worker lifecycle (WebSocket keep-alive)

**Mitigation:**
1. Clear justification + open source + privacy policy
2. Transparent data flow + audit trail
3. Heartbeat messages every 25s to keep worker alive

---

### 9.2 Next Steps

**For GhostHands Phase 2:**

1. **Prototype MVP Extension (Week 1-2)**
   - Basic WebSocket bridge
   - CDP command execution
   - Simple popup UI

2. **Test with Real Automation (Week 3)**
   - Connect to GhostHands cloud (staging)
   - Execute job application flow
   - Verify CDP commands work reliably

3. **Add Security Features (Week 4)**
   - OAuth 2.0 device flow
   - Token encryption
   - Privacy policy draft

4. **Submit to Chrome Web Store (Week 5)**
   - Prepare justification
   - Create promotional assets
   - Submit for review

5. **Monitor & Iterate (Week 6+)**
   - Address reviewer feedback
   - Add features based on user needs
   - Optimize performance

**Estimated Timeline:** 6-8 weeks from start to Chrome Web Store approval

---

## 10. References & Resources

### Official Documentation
- [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/develop/migrate/api-calls)
- [Chrome Web Store Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Service Workers in Extensions](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)

### Real-World Examples
- [Manus Browser Operator](https://manus.im/blog/manus-browser-operator)
- [LLMFeeder Extension (Readability + Turndown)](https://github.com/jatinkrmalik/LLMFeeder)
- [Copy-n-Paste (Clipboard Upload)](https://github.com/kazcfz/Copy-n-Paste)
- [Browser Status Dashboard](https://chromewebstore.google.com/detail/browser-status-dashboard/kdekjcmplepcfadmdofbppdcjhoplpch)

### Security Research
- [Chrowned by an Extension: Abusing CDP](https://dspace.networks.imdea.org/bitstream/handle/20.500.12761/1704/eurosp2023-final51.pdf)
- [Chrome Extension Permission Security](https://spin.ai/blog/chrome-extension-permission-security-tips-for-businesses/)

### Development Tools
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype)
- [Chrome Remote Interface (Node.js)](https://github.com/cyrus-and/chrome-remote-interface)
- [Getting Started with CDP](https://github.com/aslushnikov/getting-started-with-cdp)

---

**Report Status:** ✅ Complete
**Research Coverage:** All 6 requested areas covered
**Recommendation:** Proceed with Chrome Extension approach using Minimal Viable Extension (MVP) scope

---

*This report synthesized information from 40+ sources including official Chrome documentation, security research papers, real-world extension examples, and architecture analyses. All recommendations are based on current Chrome Extension Manifest V3 standards as of February 2026.*
