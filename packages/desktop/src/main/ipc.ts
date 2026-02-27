import { ipcMain, dialog, BrowserWindow } from 'electron';
import { readFileSync } from 'fs';
import { IPC } from '../shared/types';
import type { UserProfile, ProgressEvent, SignInResult } from '../shared/types';
import * as store from './store';
import * as auth from './auth';
import { runApplication, cancelApplication, getManualStore } from './engine';
import { ActionManualSchema } from './engine/types';
import { randomUUID } from 'crypto';

const GH_API_URL = process.env.GH_API_URL || 'http://localhost:3100';

/** Fetch profile from the API (best-effort, returns null on failure) */
async function fetchProfileFromApi(): Promise<UserProfile | null> {
  const token = auth.getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${GH_API_URL}/api/v1/gh/desktop/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.profile ?? null;
  } catch {
    return null;
  }
}

/** Push profile to the API (best-effort, silent failure) */
async function syncProfileToApi(profile: UserProfile): Promise<void> {
  const token = auth.getAccessToken();
  if (!token) return;
  try {
    await fetch(`${GH_API_URL}/api/v1/gh/desktop/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(profile),
    });
  } catch {
    // Silent failure on network error
  }
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // ── Auth handlers ─────────────────────────────────────────────────

  ipcMain.handle(IPC.SIGN_IN_GOOGLE, async (): Promise<SignInResult> => {
    try {
      const result = await auth.signInWithGoogle();
      if (result.session) {
        const refreshToken = auth.getRefreshToken();
        if (refreshToken) store.setRefreshToken(refreshToken);
        return { success: true, session: result.session };
      }
      return { success: false, error: result.error };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.SIGN_OUT, async () => {
    await auth.signOut();
    store.setRefreshToken(null);
  });

  ipcMain.handle(IPC.GET_SESSION, async () => {
    // Try in-memory session first
    const session = auth.getSession();
    if (session) return session;

    // Fall back to stored refresh token
    const refreshToken = store.getRefreshToken();
    if (refreshToken) {
      const restored = await auth.tryRestoreSession(refreshToken);
      if (restored) {
        // Update stored refresh token (may have changed)
        const newRefreshToken = auth.getRefreshToken();
        if (newRefreshToken) store.setRefreshToken(newRefreshToken);
        return restored;
      }
      // Stored token is invalid — clear it
      store.setRefreshToken(null);
    }
    return null;
  });

  // ── Profile handlers ──────────────────────────────────────────────

  ipcMain.handle(IPC.GET_PROFILE, async () => {
    // If signed in, try to fetch from API first
    if (auth.getAccessToken()) {
      const remote = await fetchProfileFromApi();
      if (remote) {
        store.saveProfile(remote); // Update local cache
        return remote;
      }
    }
    return store.getProfile();
  });

  ipcMain.handle(IPC.SAVE_PROFILE, async (_event, profile: UserProfile) => {
    store.saveProfile(profile);
    // Best-effort sync to API
    await syncProfileToApi(profile);
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
    const resumePath = store.getResumePath();

    if (!profile) return { success: false, message: 'Please set up your profile first' };

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
