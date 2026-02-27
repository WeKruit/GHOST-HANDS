"use strict";
const electron = require("electron");
const IPC = {
  APPLY: "apply",
  CANCEL_APPLY: "cancel-apply",
  SAVE_PROFILE: "save-profile",
  GET_PROFILE: "get-profile",
  GET_HISTORY: "get-history",
  CLEAR_HISTORY: "clear-history",
  SELECT_RESUME: "select-resume",
  GET_RESUME_PATH: "get-resume-path",
  PROGRESS: "progress",
  IMPORT_COOKBOOK: "import-cookbook",
  GET_COOKBOOKS: "get-cookbooks",
  DELETE_COOKBOOK: "delete-cookbook",
  SIGN_IN_GOOGLE: "sign-in-google",
  SIGN_OUT: "sign-out",
  GET_SESSION: "get-session"
};
const api = {
  getProfile: () => electron.ipcRenderer.invoke(IPC.GET_PROFILE),
  saveProfile: (profile) => electron.ipcRenderer.invoke(IPC.SAVE_PROFILE, profile),
  selectResume: () => electron.ipcRenderer.invoke(IPC.SELECT_RESUME),
  getResumePath: () => electron.ipcRenderer.invoke(IPC.GET_RESUME_PATH),
  apply: (url) => electron.ipcRenderer.invoke(IPC.APPLY, url),
  cancelApply: () => electron.ipcRenderer.invoke(IPC.CANCEL_APPLY),
  getHistory: () => electron.ipcRenderer.invoke(IPC.GET_HISTORY),
  clearHistory: () => electron.ipcRenderer.invoke(IPC.CLEAR_HISTORY),
  importCookbook: () => electron.ipcRenderer.invoke(IPC.IMPORT_COOKBOOK),
  getCookbooks: () => electron.ipcRenderer.invoke(IPC.GET_COOKBOOKS),
  deleteCookbook: (id) => electron.ipcRenderer.invoke(IPC.DELETE_COOKBOOK, id),
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on(IPC.PROGRESS, handler);
    return () => {
      electron.ipcRenderer.removeListener(IPC.PROGRESS, handler);
    };
  },
  signInWithGoogle: () => electron.ipcRenderer.invoke(IPC.SIGN_IN_GOOGLE),
  signOut: () => electron.ipcRenderer.invoke(IPC.SIGN_OUT),
  getSession: () => electron.ipcRenderer.invoke(IPC.GET_SESSION)
};
electron.contextBridge.exposeInMainWorld("ghosthands", api);
