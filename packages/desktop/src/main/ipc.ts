import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFileSync } from 'fs';
import { IPC } from '../shared/types';
import type { UserProfile, AppSettings, ProgressEvent } from '../shared/types';
import * as store from './store';
import { runApplication, cancelApplication, getManualStore } from './engine';
import { ActionManualSchema } from './engine/types';
import { randomUUID } from 'crypto';

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.GET_PROFILE, () => store.getProfile());

  ipcMain.handle(IPC.SAVE_PROFILE, (_event, profile: UserProfile) => {
    store.saveProfile(profile);
  });

  ipcMain.handle(IPC.GET_SETTINGS, () => store.getSettings());

  ipcMain.handle(IPC.SAVE_SETTINGS, (_event, settings: AppSettings) => {
    store.saveSettings(settings);
  });

  ipcMain.handle(IPC.SELECT_RESUME, async () => {
    const win = getMainWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      title: 'Select Resume',
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const path = result.filePaths[0];
    store.setResumePath(path);
    return path;
  });

  ipcMain.handle(IPC.GET_RESUME_PATH, () => store.getResumePath());

  ipcMain.handle(IPC.APPLY, async (_event, url: string) => {
    const win = getMainWindow();
    const profile = store.getProfile();
    const settings = store.getSettings();
    const resumePath = store.getResumePath();

    if (!profile) return { success: false, message: 'Please set up your profile first' };
    if (!settings.llmApiKey) return { success: false, message: 'Please configure your LLM API key in settings' };

    const recordId = randomUUID();
    store.addHistory({
      id: recordId,
      url,
      company: extractCompanyFromUrl(url),
      jobTitle: '',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const onProgress = (event: ProgressEvent) => {
      win?.webContents.send(IPC.PROGRESS, event);
    };

    const result = await runApplication({
      targetUrl: url,
      profile,
      resumePath: resumePath ?? undefined,
      settings,
      onProgress,
    });

    store.updateHistory(recordId, {
      status: result.success ? 'success' : 'failed',
      completedAt: new Date().toISOString(),
      error: result.success ? undefined : result.message,
    });

    return result;
  });

  ipcMain.handle(IPC.CANCEL_APPLY, () => cancelApplication());

  ipcMain.handle(IPC.GET_HISTORY, () => store.getHistory());

  ipcMain.handle(IPC.CLEAR_HISTORY, () => store.clearHistory());

  // ── Cookbook management ──────────────────────────────────────────────

  ipcMain.handle(IPC.IMPORT_COOKBOOK, async () => {
    const win = getMainWindow();
    if (!win) return { success: false, message: 'No window available' };

    const result = await dialog.showOpenDialog(win, {
      title: 'Import Cookbook',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'Cancelled' };
    }

    try {
      const raw = readFileSync(result.filePaths[0], 'utf-8');
      const parsed = JSON.parse(raw);
      const manual = ActionManualSchema.parse(parsed);
      getManualStore().save(manual);
      return { success: true, message: `Imported cookbook: ${manual.platform} — ${manual.url_pattern}` };
    } catch (err: any) {
      return { success: false, message: `Invalid cookbook file: ${err.message}` };
    }
  });

  ipcMain.handle(IPC.GET_COOKBOOKS, () => {
    return getManualStore().getAll();
  });

  ipcMain.handle(IPC.DELETE_COOKBOOK, (_event, id: string) => {
    return getManualStore().remove(id);
  });
}

function extractCompanyFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const match = hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/);
    if (match) return match[1];
    const parts = hostname.split('.');
    return parts[0] === 'www' ? parts[1] : parts[0];
  } catch {
    return 'Unknown';
  }
}
