import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { UserProfile, AppSettings, ApplicationRecord, ProgressEvent } from '../shared/types';

const api = {
  getProfile: (): Promise<UserProfile | null> => ipcRenderer.invoke(IPC.GET_PROFILE),
  saveProfile: (profile: UserProfile): Promise<void> => ipcRenderer.invoke(IPC.SAVE_PROFILE, profile),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.GET_SETTINGS),
  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke(IPC.SAVE_SETTINGS, settings),

  selectResume: (): Promise<string | null> => ipcRenderer.invoke(IPC.SELECT_RESUME),
  getResumePath: (): Promise<string | null> => ipcRenderer.invoke(IPC.GET_RESUME_PATH),

  apply: (url: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.APPLY, url),
  cancelApply: (): Promise<void> => ipcRenderer.invoke(IPC.CANCEL_APPLY),

  getHistory: (): Promise<ApplicationRecord[]> => ipcRenderer.invoke(IPC.GET_HISTORY),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.CLEAR_HISTORY),

  importCookbook: (): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.IMPORT_COOKBOOK),
  getCookbooks: (): Promise<any[]> => ipcRenderer.invoke(IPC.GET_COOKBOOKS),
  deleteCookbook: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.DELETE_COOKBOOK, id),

  onProgress: (callback: (event: ProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ProgressEvent) => callback(data);
    ipcRenderer.on(IPC.PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.PROGRESS, handler);
  },
};

contextBridge.exposeInMainWorld('ghosthands', api);

export type GhostHandsAPI = typeof api;
