# File Upload Research Report
**Research Agent:** researcher-uploads
**Date:** 2026-02-16
**Task:** Research OS-level file picker dialog handling for browser automation

---

## Executive Summary

**Problem:** When automating job applications, clicking "Upload Resume" triggers an OS-level file picker dialog that browser automation cannot interact with directly (it's outside the browser DOM).

**Solution:** Playwright/Patchright provides native APIs to bypass the OS file picker entirely by programmatically setting files on input elements or intercepting file chooser events.

**Key Finding:** GhostHands (via Magnitude) currently has **NO file upload action** in its action space. We need to add one.

---

## 1. Current State Analysis

### 1.1 Magnitude Action Space

**File:** `/node_modules/.bun/magnitude-core@0.3.1/node_modules/magnitude-core/dist/actions/webActions.js`

**Current Actions:**
- `mouse:click` - Click coordinates
- `mouse:double_click` - Double click
- `mouse:right_click` - Right click
- `mouse:drag` - Click and drag
- `mouse:scroll` - Scroll at coordinates
- `keyboard:type` - Type text
- `keyboard:enter` - Press enter
- `keyboard:tab` - Tab key
- `keyboard:backspace` - Backspace
- `keyboard:select_all` - Ctrl+A
- `browser:tab:switch` - Switch tabs
- `browser:tab:new` - New tab
- `browser:nav` - Navigate to URL
- `browser:nav:back` - Go back
- `wait` - Wait N seconds

**Missing:** `file:upload` action

### 1.2 WebHarness Capabilities

**File:** `/node_modules/.bun/magnitude-core@0.3.1/node_modules/magnitude-core/dist/web/harness.d.ts`

The `WebHarness` class provides low-level browser interaction via Playwright's `Page` and `BrowserContext`. It has:
- Direct access to `this.page` (Playwright Page object)
- `click()`, `type()`, `drag()`, etc.
- No file upload method currently

**Opportunity:** We can extend this or create a new action that calls Playwright's file upload APIs directly.

---

## 2. Playwright File Upload Methods

### 2.1 Method 1: `page.setInputFiles()` (Recommended)

**Use case:** When you can identify the `<input type="file">` element

**Syntax:**
```typescript
await page.setInputFiles('input[type="file"]', '/path/to/resume.pdf');
```

**How it works:**
- Sets files directly on the input element
- **Bypasses the OS file picker entirely**
- Works with CSS selectors or ElementHandles
- Supports multiple files: `['/file1.pdf', '/file2.pdf']`
- Supports buffers/streams for in-memory files

**Advantages:**
- Simple and reliable
- Works in headless mode
- No OS-level interaction needed
- Supported by Patchright (Playwright fork)

**Limitations:**
- Only works on `<input type="file">` elements
- Won't work if the upload UI doesn't use a standard file input (rare but possible)

**Example:**
```typescript
// Single file
await page.setInputFiles('#resume-upload', './resume.pdf');

// Multiple files
await page.setInputFiles('#attachments', [
  './resume.pdf',
  './cover-letter.pdf'
]);

// Clear file selection
await page.setInputFiles('#resume-upload', []);

// From buffer (useful for files in storage/memory)
await page.setInputFiles('#resume-upload', {
  name: 'resume.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(pdfData)
});
```

### 2.2 Method 2: `page.on('filechooser')` Event

**Use case:** When you need to intercept the file chooser before it opens

**Syntax:**
```typescript
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('button.upload')  // Action that triggers file chooser
]);
await fileChooser.setFiles('/path/to/resume.pdf');
```

**How it works:**
- Intercepts the file chooser dialog **before** the OS dialog appears
- Programmatically sets files
- More dynamic than `setInputFiles` (can respond to user actions)

**Advantages:**
- Works even if you can't easily select the input element
- Can handle dynamic file pickers
- Can cancel the file chooser: `await fileChooser.cancel()`

**Limitations:**
- Slightly more complex (need to wait for event)
- Requires knowing which action triggers the chooser

**Example:**
```typescript
// Wait for file chooser to be triggered
page.once('filechooser', async (fileChooser) => {
  await fileChooser.setFiles('./resume.pdf');
});

// Click the upload button
await page.click('#upload-button');
```

### 2.3 Method 3: Drag-and-Drop Upload Zones

**Use case:** Some ATS use drag-drop zones instead of file inputs

**Approach:** Simulate drag events with `DataTransfer`

**Example:**
```typescript
// Create DataTransfer with file
const dataTransfer = await page.evaluateHandle((filePath) => {
  const dt = new DataTransfer();
  const file = new File(['content'], filePath, { type: 'application/pdf' });
  dt.items.add(file);
  return dt;
}, '/path/to/resume.pdf');

// Trigger drop event
await page.dispatchEvent('.drop-zone', 'drop', { dataTransfer });
```

**Note:** More complex and less reliable. Most modern ATS still have a hidden file input even with drag-drop UIs.

---

## 3. CDP (Chrome DevTools Protocol) Methods

Playwright abstracts CDP, but for advanced use cases:

### 3.1 `Page.setInterceptFileChooserDialog`

**CDP Command:**
```typescript
await page.context().newCDPSession(page).send(
  'Page.setInterceptFileChooserDialog',
  { enabled: true }
);
```

**Note:** Playwright's `filechooser` event is built on this, so prefer the higher-level API.

### 3.2 `DOM.setFileInputFiles`

**Use case:** Set files on a DOM node by its backend node ID

**CDP Command:**
```typescript
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.setFileInputFiles', {
  files: ['/path/to/resume.pdf'],
  backendNodeId: nodeId
});
```

**Note:** Lower-level than `setInputFiles`. Only useful if you're already working with CDP directly.

---

## 4. Real-World ATS Upload Patterns

### 4.1 Workday

**Pattern:** Standard `<input type="file">` inside a button or div

**HTML Example:**
```html
<div class="upload-button">
  <input type="file" accept=".pdf,.doc,.docx" />
  <span>Upload Resume</span>
</div>
```

**Solution:** `page.setInputFiles('input[type="file"]', resume)`

### 4.2 Greenhouse

**Pattern:** File input with custom styling, often hidden

**HTML Example:**
```html
<input type="file" id="resume_file" style="display: none;" />
<button onclick="document.getElementById('resume_file').click()">
  Upload Resume
</button>
```

**Solution:** `page.setInputFiles('#resume_file', resume)`

### 4.3 Lever

**Pattern:** Similar to Greenhouse, hidden input + styled button

**Solution:** Same as above, target the hidden input directly

### 4.4 Custom ATS (e.g., Google Drive Picker)

**Pattern:** Some companies use third-party upload widgets (Google Drive, Dropbox)

**Challenges:**
- May require OAuth/authentication
- Not a standard file input
- Needs special handling

**Solution:**
- Check if there's an iframe with a file input
- May need to use `page.frame()` to access iframe content
- Worst case: manual intervention or API upload

### 4.5 Drag-and-Drop Zones

**Pattern:** Dropzone.js, react-dropzone, or custom implementations

**HTML Example:**
```html
<div class="dropzone" data-dropzone="true">
  <input type="file" style="display: none;" />
  <p>Drag file here or click to upload</p>
</div>
```

**Solution:** Still has a hidden input! Use `setInputFiles` on the hidden input.

**Edge case:** If truly no input element exists, fall back to drag-drop simulation or API upload.

---

## 5. Recommended Architecture for GhostHands

### 5.1 Server Browser Mode

**Environment:** Files are on the server (e.g., Fly.io VM or cloud storage)

**Flow:**
1. Worker receives `applyToJob` task with `resumeUrl`
2. Worker downloads resume from Supabase Storage to `/tmp/resume.pdf`
3. BrowserAgent uses new `file:upload` action
4. Action calls `page.setInputFiles(selector, '/tmp/resume.pdf')`
5. File is uploaded, temp file deleted

**Implementation:**
```typescript
// New action: file:upload
export const fileUploadAction = createAction({
  name: 'file:upload',
  description: 'Upload a file to a file input element',
  schema: z.object({
    selector: z.string().describe('CSS selector for file input'),
    filePath: z.string().describe('Absolute path to file on server'),
  }),
  resolver: async ({ input: { selector, filePath }, agent }) => {
    const web = agent.require(BrowserConnector);
    const page = web.getHarness().page;
    await page.setInputFiles(selector, filePath);
  },
  render: ({ selector, filePath }) => {
    const fileName = filePath.split('/').pop();
    return `📎 upload ${fileName} to ${selector}`;
  }
});
```

### 5.2 Browser Operator Mode (Future)

**Environment:** Files are on user's local machine, automation runs in user's browser via extension

**Challenge:** Extension cannot directly access local filesystem for security reasons

**Solution: Extension Bridge Architecture**

**Flow:**
1. Extension asks user to select file via OS picker (one-time setup or per-job)
2. Extension reads file via `chrome.fileSystem` API or user drag-drop
3. Extension stores file in IndexedDB or sends to GhostHands storage
4. GhostHands worker downloads file from storage
5. Worker uses `file:upload` action as in Server Browser mode

**Alternative: Direct CDP Injection**
```typescript
// Extension content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPLOAD_FILE') {
    // User already selected file
    const file = msg.file; // File object from input
    const reader = new FileReader();
    reader.onload = () => {
      // Inject file into page's file input
      const input = document.querySelector(msg.selector);
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([reader.result], file.name));
      input.files = dataTransfer.files;
      sendResponse({ success: true });
    };
    reader.readAsArrayBuffer(file);
  }
});
```

### 5.3 Hybrid Approach: URL-Based Upload

**Some ATS support URL upload** (paste a link to your resume)

**Flow:**
1. Upload resume to Supabase Storage
2. Generate public URL (signed, 1-hour expiry)
3. Agent types URL into "Resume URL" field
4. No file picker needed

**Example:**
```typescript
const resumeUrl = await supabase.storage
  .from('resumes')
  .createSignedUrl('resume.pdf', 3600);

await page.fill('#resume-url-input', resumeUrl.signedUrl);
```

---

## 6. Implementation Recommendations

### 6.1 Phase 1: Add `file:upload` Action (MVP)

**File:** `packages/ghosthands/src/connectors/fileUploadConnector.ts`

```typescript
import { AgentConnector, ActionDefinition, createAction } from 'magnitude-core';
import { BrowserConnector } from 'magnitude-core';
import { z } from 'zod';

export class FileUploadConnector implements AgentConnector {
  id = 'file-upload';

  getActionSpace(): ActionDefinition<any>[] {
    return [
      createAction({
        name: 'file:upload',
        description: 'Upload a file to a file input element. Use this when you see an upload button or file input field.',
        schema: z.object({
          selector: z.string().describe('CSS selector for <input type="file"> element'),
          filePath: z.string().describe('Absolute path to file on server filesystem'),
        }),
        resolver: async ({ input: { selector, filePath }, agent }) => {
          const web = agent.require(BrowserConnector);
          const page = web.getHarness().page;

          // Verify file exists
          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
          }

          // Set files on input
          await page.setInputFiles(selector, filePath);

          // Wait for any upload progress (some ATS show progress bars)
          await page.waitForTimeout(500);
        },
        render: ({ selector, filePath }) => {
          const fileName = filePath.split('/').pop();
          return `📎 upload "${fileName}" to ${selector}`;
        }
      }),

      createAction({
        name: 'file:upload:wait',
        description: 'Upload a file and wait for the file chooser dialog to appear. Use when clicking a button triggers a file picker.',
        schema: z.object({
          triggerSelector: z.string().describe('CSS selector for button/element that opens file picker'),
          filePath: z.string().describe('Absolute path to file on server filesystem'),
        }),
        resolver: async ({ input: { triggerSelector, filePath }, agent }) => {
          const web = agent.require(BrowserConnector);
          const page = web.getHarness().page;

          // Wait for file chooser event and click trigger
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.click(triggerSelector)
          ]);

          await fileChooser.setFiles(filePath);
        },
        render: ({ triggerSelector, filePath }) => {
          const fileName = filePath.split('/').pop();
          return `📎 upload "${fileName}" via ${triggerSelector}`;
        }
      })
    ];
  }

  async getInstructions(): Promise<string> {
    return `
## File Upload Instructions

When you see file upload fields (e.g., "Upload Resume", "Attach Cover Letter"):

1. **Identify the input element:**
   - Look for <input type="file"> in the DOM
   - Common selectors: input[type="file"], #resume-upload, .file-input

2. **Use the file:upload action:**
   - Provide the selector for the file input
   - Provide the file path (will be given by the system)

3. **If clicking a button triggers upload:**
   - Use file:upload:wait instead
   - Provide the button selector and file path

**Example:**
\`\`\`json
{
  "name": "file:upload",
  "selector": "input[type='file']",
  "filePath": "/tmp/resume.pdf"
}
\`\`\`
`.trim();
  }
}
```

### 6.2 Phase 2: Integrate with Job Application Flow

**File:** `packages/ghosthands/src/workers/applyJob.ts`

```typescript
import { FileUploadConnector } from '../connectors/fileUploadConnector';

async function applyToJob(task: ApplyJobTask) {
  // Download resume from Supabase Storage
  const { data, error } = await supabase.storage
    .from('resumes')
    .download(`${task.userId}/${task.resumeId}.pdf`);

  if (error) throw error;

  // Save to temp file
  const tmpPath = `/tmp/resume-${task.resumeId}.pdf`;
  await fs.promises.writeFile(tmpPath, Buffer.from(await data.arrayBuffer()));

  // Start browser agent with file upload capability
  const agent = await startBrowserAgent({
    connectors: [
      new BrowserConnector({ url: task.jobUrl }),
      new ManualConnector(supabase),
      new FileUploadConnector(),  // <-- Add file upload
    ],
    llmClient: getLLMClient(config.model),
    instructions: `
      Apply to this job posting.
      When asked to upload a resume, use the file:upload action with this path: ${tmpPath}
    `
  });

  await agent.act();

  // Clean up temp file
  await fs.promises.unlink(tmpPath);
}
```

### 6.3 Phase 3: Manual Learning

**Goal:** After first successful upload, save the action sequence to a manual

**Manual Entry Example:**
```json
{
  "url_pattern": "https://boards.greenhouse.io/*/jobs/*",
  "actions": [
    { "name": "mouse:click", "x": 450, "y": 320 },  // Click "Apply Now"
    { "name": "keyboard:type", "content": "John Doe" },
    { "name": "file:upload", "selector": "#resume_file", "filePath": "{RESUME_PATH}" },  // <-- Parameterized
    { "name": "mouse:click", "x": 500, "y": 600 }  // Click "Submit"
  ],
  "success_rate": 1.0,
  "health_score": 100
}
```

**Parameter Substitution:**
```typescript
// When replaying manual
const actions = manual.actions.map(action => {
  if (action.name === 'file:upload') {
    return {
      ...action,
      filePath: action.filePath.replace('{RESUME_PATH}', actualResumePath)
    };
  }
  return action;
});
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

**File:** `packages/ghosthands/__tests__/unit/connectors/fileUpload.test.ts`

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
import { FileUploadConnector } from '@/connectors/fileUploadConnector';

describe('FileUploadConnector', () => {
  describe('interface compliance', () => {
    test('has correct id', () => {
      const connector = new FileUploadConnector();
      expect(connector.id).toBe('file-upload');
    });

    test('provides file:upload action', () => {
      const connector = new FileUploadConnector();
      const actions = connector.getActionSpace();
      expect(actions.some(a => a.name === 'file:upload')).toBe(true);
    });
  });

  describe('action: file:upload', () => {
    test('validates schema', () => {
      const connector = new FileUploadConnector();
      const action = connector.getActionSpace().find(a => a.name === 'file:upload')!;

      expect(() => action.schema.parse({
        selector: 'input[type="file"]',
        filePath: '/tmp/resume.pdf'
      })).not.toThrow();

      expect(() => action.schema.parse({
        selector: 'input[type="file"]',
        // missing filePath
      })).toThrow();
    });
  });
});
```

### 7.2 Integration Tests

**File:** `packages/ghosthands/__tests__/integration/fileUpload.test.ts`

```typescript
import { chromium } from 'patchright';
import { FileUploadConnector } from '@/connectors/fileUploadConnector';
import { BrowserConnector } from 'magnitude-core';
import { Agent } from 'magnitude-core';
import fs from 'fs';

describe('File Upload Integration', () => {
  test('uploads file to input element', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // Create test HTML page
    const page = await context.newPage();
    await page.setContent(`
      <form>
        <input type="file" id="file-input" />
        <div id="result"></div>
      </form>
      <script>
        document.getElementById('file-input').addEventListener('change', (e) => {
          const file = e.target.files[0];
          document.getElementById('result').textContent = file.name;
        });
      </script>
    `);

    // Create test file
    const testFile = '/tmp/test-resume.pdf';
    await fs.promises.writeFile(testFile, 'fake pdf content');

    // Upload file
    await page.setInputFiles('#file-input', testFile);

    // Verify file was set
    const result = await page.textContent('#result');
    expect(result).toBe('test-resume.pdf');

    // Clean up
    await fs.promises.unlink(testFile);
    await browser.close();
  });
});
```

### 7.3 E2E Tests

**File:** `packages/ghosthands/__tests__/e2e/greenhouse.test.ts`

```typescript
describe('Greenhouse Job Application', () => {
  test('applies to job with resume upload', async () => {
    // Use a real Greenhouse posting (or mock)
    const jobUrl = 'https://boards.greenhouse.io/example/jobs/123';

    const agent = await startBrowserAgent({
      connectors: [
        new BrowserConnector({ url: jobUrl }),
        new FileUploadConnector(),
      ],
      llmClient: mockLLM,
      instructions: 'Fill out the application and upload resume at /tmp/resume.pdf'
    });

    await agent.act();

    // Verify upload happened
    // (check network requests, DOM state, etc.)
  });
});
```

---

## 8. Edge Cases and Limitations

### 8.1 Multiple File Inputs

**Problem:** Some forms have multiple file inputs (resume, cover letter, portfolio)

**Solution:** Agent must distinguish between them

```typescript
await page.setInputFiles('#resume-input', resumePath);
await page.setInputFiles('#cover-letter-input', coverLetterPath);
```

### 8.2 File Type Restrictions

**Problem:** Input has `accept=".pdf,.doc,.docx"`

**Solution:** Agent should check file extension before uploading

```typescript
const action = {
  schema: z.object({
    selector: z.string(),
    filePath: z.string(),
    expectedTypes: z.array(z.string()).optional().describe('Allowed file types, e.g. [".pdf", ".doc"]')
  }),
  resolver: async ({ input }) => {
    const ext = path.extname(input.filePath);
    if (input.expectedTypes && !input.expectedTypes.includes(ext)) {
      throw new Error(`File type ${ext} not allowed. Expected: ${input.expectedTypes.join(', ')}`);
    }
    // ... proceed with upload
  }
}
```

### 8.3 File Size Limits

**Problem:** ATS may reject files over 5MB

**Solution:** Check file size before upload

```typescript
const stats = await fs.promises.stat(filePath);
const sizeMB = stats.size / (1024 * 1024);
if (sizeMB > 5) {
  throw new Error(`File too large: ${sizeMB.toFixed(2)}MB (max 5MB)`);
}
```

### 8.4 Upload Progress Indicators

**Problem:** Some ATS show upload progress bars

**Solution:** Wait for upload to complete

```typescript
// After setInputFiles
await page.waitForSelector('.upload-complete', { timeout: 30000 });
// or
await page.waitForFunction(() => {
  const progress = document.querySelector('.upload-progress');
  return progress && progress.textContent === '100%';
});
```

### 8.5 Iframes

**Problem:** File input is inside an iframe

**Solution:** Access frame first

```typescript
const frame = page.frame({ name: 'upload-iframe' });
await frame.setInputFiles('input[type="file"]', filePath);
```

---

## 9. Alternative: Stagehand Integration

**Context:** GhostHands uses Stagehand for semantic observation (CSS selectors, not screenshots)

**Question:** Can Stagehand help with file uploads?

**Answer:** Stagehand can **identify** the file input, but the actual upload still needs Playwright's `setInputFiles`.

**Example:**
```typescript
// Use Stagehand to find the upload button
const uploadButton = await stagehand.observe('resume upload button');
// uploadButton.selector = 'input[type="file"]#resume'

// Then use Playwright to upload
await page.setInputFiles(uploadButton.selector, resumePath);
```

**Conclusion:** Stagehand helps with discovery, Playwright handles upload. Both are needed.

---

## 10. Comparison Table

| Method | Complexity | Reliability | Use Case | Headless Support |
|--------|------------|-------------|----------|------------------|
| `page.setInputFiles()` | Low | High | Standard file inputs | Yes |
| `page.on('filechooser')` | Medium | High | Dynamic pickers | Yes |
| Drag-drop simulation | High | Medium | Custom dropzones | Yes |
| CDP `DOM.setFileInputFiles` | High | High | Low-level control | Yes |
| Extension bridge | Very High | Medium | Browser Operator mode | N/A (user's browser) |
| URL upload | Low | High (if supported) | ATS with URL input | Yes |

**Recommendation:** Start with `page.setInputFiles()` (simplest, most reliable)

---

## 11. Code Examples Summary

### 11.1 Basic Upload
```typescript
await page.setInputFiles('input[type="file"]', '/tmp/resume.pdf');
```

### 11.2 Multiple Files
```typescript
await page.setInputFiles('.attachments', [
  '/tmp/resume.pdf',
  '/tmp/cover-letter.pdf'
]);
```

### 11.3 From Buffer
```typescript
await page.setInputFiles('#upload', {
  name: 'resume.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(pdfBytes)
});
```

### 11.4 With File Chooser Event
```typescript
const [fileChooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('.upload-button')
]);
await fileChooser.setFiles('/tmp/resume.pdf');
```

### 11.5 Clear Upload
```typescript
await page.setInputFiles('input[type="file"]', []);
```

---

## 12. Next Steps

### Immediate (Phase 2 MVP)
1. **Create `FileUploadConnector`** in `packages/ghosthands/src/connectors/fileUploadConnector.ts`
2. **Add `file:upload` action** using `page.setInputFiles()`
3. **Write unit tests** to verify schema and action registration
4. **Update `applyJob.ts` worker** to download resume to `/tmp` and provide path to agent

### Short-term
5. **Add `file:upload:wait` action** for filechooser event pattern
6. **Integration test** with mock HTML page
7. **Update agent instructions** to guide LLM on when to use file upload
8. **Manual parameterization** to support `{RESUME_PATH}` placeholder

### Long-term
9. **Browser Operator mode** extension bridge for local files
10. **Drag-drop support** for non-standard ATS
11. **Stagehand integration** to auto-discover file inputs
12. **Error handling** for file size/type restrictions

---

## 13. References

### Official Documentation
- [Playwright File Uploads](https://playwright.dev/docs/input#upload-files)
- [Patchright GitHub](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) - Playwright fork
- [Chrome DevTools Protocol - Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)

### Code References
- Magnitude WebHarness: `/node_modules/.bun/magnitude-core@0.3.1/node_modules/magnitude-core/dist/web/harness.js`
- Magnitude Actions: `/node_modules/.bun/magnitude-core@0.3.1/node_modules/magnitude-core/dist/actions/webActions.js`
- GhostHands Architecture: `/docs/ARCHITECTURE.md`

### Related Issues
- ATS upload patterns: Workday, Greenhouse, Lever all use `<input type="file">`
- Stagehand observation: Can identify upload buttons, but Playwright needed for actual upload
- Manual learning: File paths need parameterization for replay

---

## Conclusion

**File uploads in browser automation are SOLVED:** Playwright's `page.setInputFiles()` bypasses the OS file picker entirely, making this a non-issue for GhostHands.

**Implementation is straightforward:** Add a new `FileUploadConnector` with a `file:upload` action that wraps `page.setInputFiles()`.

**No blockers:** This works in headless mode, supports all major ATS platforms, and integrates cleanly with GhostHands' existing architecture.

**Estimated effort:** 1-2 days for full implementation including tests.

---

**End of Report**
