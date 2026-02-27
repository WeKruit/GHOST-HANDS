import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { registerIpcHandlers } from './ipc';

// In a packaged app, point Playwright/Patchright to the bundled Chromium binary.
// The browser is bundled via extraResources at: <resources>/playwright-browsers/
if (app.isPackaged) {
  const bundledBrowsers = join(process.resourcesPath, 'playwright-browsers');
  if (existsSync(bundledBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
}

// Load .env file into process.env
// Priority: .env.{GH_ENV} > .env (GH_ENV is set by npm scripts: "staging" or "production")
function loadEnvFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}

const packageRoot = join(__dirname, '../..');
const ghEnv = process.env.GH_ENV;
if (ghEnv) {
  loadEnvFile(join(packageRoot, `.env.${ghEnv}`));
}
// Always load .env as fallback (fills in any keys not set by env-specific file)
loadEnvFile(join(packageRoot, '.env'));

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'GhostHands',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

registerIpcHandlers(() => mainWindow);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
