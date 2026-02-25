import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { UserProfile, AppSettings, ApplicationRecord } from '../shared/types';

interface StoreSchema {
  profile: UserProfile | null;
  settings: AppSettings;
  resumePath: string | null;
  history: ApplicationRecord[];
}

const defaults: StoreSchema = {
  profile: null,
  settings: {
    llmProvider: 'openai',
    llmApiKey: '',
    llmModel: 'gpt-4o',
  },
  resumePath: null,
  history: [],
};

let data: StoreSchema = { ...defaults };
let filePath = '';

function getFilePath(): string {
  if (!filePath) {
    const dir = app.getPath('userData');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    filePath = join(dir, 'ghosthands-config.json');
  }
  return filePath;
}

function load(): StoreSchema {
  try {
    const raw = readFileSync(getFilePath(), 'utf-8');
    data = { ...defaults, ...JSON.parse(raw) };
  } catch {
    data = { ...defaults };
  }
  return data;
}

function save(): void {
  writeFileSync(getFilePath(), JSON.stringify(data, null, 2), 'utf-8');
}

let loaded = false;
function ensureLoaded(): void {
  if (!loaded) {
    load();
    loaded = true;
  }
}

export function getProfile(): UserProfile | null {
  ensureLoaded();
  return data.profile;
}

export function saveProfile(profile: UserProfile): void {
  ensureLoaded();
  data.profile = profile;
  save();
}

export function getSettings(): AppSettings {
  ensureLoaded();
  return data.settings;
}

export function saveSettings(settings: AppSettings): void {
  ensureLoaded();
  data.settings = settings;
  save();
}

export function getResumePath(): string | null {
  ensureLoaded();
  return data.resumePath;
}

export function setResumePath(path: string): void {
  ensureLoaded();
  data.resumePath = path;
  save();
}

export function getHistory(): ApplicationRecord[] {
  ensureLoaded();
  return data.history;
}

export function addHistory(record: ApplicationRecord): void {
  ensureLoaded();
  data.history.unshift(record);
  data.history = data.history.slice(0, 100);
  save();
}

export function updateHistory(id: string, updates: Partial<ApplicationRecord>): void {
  ensureLoaded();
  const idx = data.history.findIndex((r) => r.id === id);
  if (idx !== -1) {
    data.history[idx] = { ...data.history[idx], ...updates };
    save();
  }
}

export function clearHistory(): void {
  ensureLoaded();
  data.history = [];
  save();
}
