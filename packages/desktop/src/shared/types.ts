/** User profile data for job applications */
export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedIn?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  qaAnswers?: Record<string, string>;
}

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  startYear: number;
  endYear?: number;
}

export interface ExperienceEntry {
  company: string;
  title: string;
  startDate: string;
  endDate?: string;
  description: string;
}

export interface AppSettings {
  llmProvider: 'openai' | 'anthropic' | 'deepseek';
  llmApiKey: string;
  llmModel: string;
}

export interface ApplicationRecord {
  id: string;
  url: string;
  company: string;
  jobTitle: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ProgressEvent {
  type: 'action' | 'thought' | 'screenshot' | 'status' | 'error' | 'complete';
  message?: string;
  screenshot?: string;
  step?: number;
  totalSteps?: number;
  timestamp: number;
}

export const IPC = {
  APPLY: 'apply',
  CANCEL_APPLY: 'cancel-apply',
  SAVE_PROFILE: 'save-profile',
  GET_PROFILE: 'get-profile',
  SAVE_SETTINGS: 'save-settings',
  GET_SETTINGS: 'get-settings',
  GET_HISTORY: 'get-history',
  CLEAR_HISTORY: 'clear-history',
  SELECT_RESUME: 'select-resume',
  GET_RESUME_PATH: 'get-resume-path',
  PROGRESS: 'progress',
  IMPORT_COOKBOOK: 'import-cookbook',
  GET_COOKBOOKS: 'get-cookbooks',
  DELETE_COOKBOOK: 'delete-cookbook',
} as const;
