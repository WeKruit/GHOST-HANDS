#!/usr/bin/env node
/**
 * Copies the Playwright/Patchright Chromium browser binary into
 * playwright-browsers/ so electron-builder can bundle it as an extraResource.
 *
 * Run automatically via `predist` script before packaging.
 */

import { execSync } from 'child_process';
import { cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const dest = join(desktopRoot, 'playwright-browsers');

// Detect the Chromium path that patchright/playwright resolves to
let chromiumExec;
try {
  chromiumExec = execSync(
    `node -e "const pw = require('patchright'); console.log(pw.chromium.executablePath())"`,
    { cwd: join(desktopRoot, '../..'), encoding: 'utf-8' },
  ).trim();
} catch {
  try {
    chromiumExec = execSync(
      `node -e "const pw = require('playwright'); console.log(pw.chromium.executablePath())"`,
      { cwd: desktopRoot, encoding: 'utf-8' },
    ).trim();
  } catch (e) {
    console.error('Could not resolve Chromium path. Run `playwright install chromium` first.');
    process.exit(1);
  }
}

console.log(`Chromium executable: ${chromiumExec}`);

// Walk up from the executable to find the versioned browser directory
// e.g. .../ms-playwright/chromium-1200/chrome-mac-arm64/... → .../ms-playwright/chromium-1200
let browserDir = dirname(chromiumExec);
while (browserDir && !browserDir.match(/chromium-\d+$/)) {
  const parent = dirname(browserDir);
  if (parent === browserDir) break; // reached root
  browserDir = parent;
}

if (!browserDir.match(/chromium-\d+$/)) {
  console.error(`Could not find chromium-XXXX directory from: ${chromiumExec}`);
  process.exit(1);
}

const browserDirName = browserDir.split('/').pop(); // e.g. "chromium-1200"
console.log(`Browser directory: ${browserDir} (${browserDirName})`);

// Clean and copy
if (existsSync(dest)) {
  rmSync(dest, { recursive: true });
}
mkdirSync(dest, { recursive: true });

const targetDir = join(dest, browserDirName);
console.log(`Copying to ${targetDir}...`);
cpSync(browserDir, targetDir, { recursive: true });

console.log('Browser bundled successfully.');
