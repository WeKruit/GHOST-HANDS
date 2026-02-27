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
  skills?: string[];
  qaAnswers?: Record<string, string>;
  workAuthorization?: string;
  visaSponsorship?: string;
  gender?: string;
  raceEthnicity?: string;
  veteranStatus?: string;
  disabilityStatus?: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  gpa?: string;
  startDate: string;   // "YYYY-MM" or "YYYY"
  endDate?: string;     // "YYYY-MM" or "YYYY"
}

export interface ExperienceEntry {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string;
  description: string;
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

/** Authenticated user info */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

/** Session returned to the renderer */
export interface AuthSession {
  accessToken: string;
  user: AuthUser;
  expiresAt: number;
}

/** Result of a sign-in attempt */
export interface SignInResult {
  success: boolean;
  session?: AuthSession;
  error?: string;
}

export const IPC = {
  APPLY: 'apply',
  CANCEL_APPLY: 'cancel-apply',
  SAVE_PROFILE: 'save-profile',
  GET_PROFILE: 'get-profile',
  GET_HISTORY: 'get-history',
  CLEAR_HISTORY: 'clear-history',
  SELECT_RESUME: 'select-resume',
  GET_RESUME_PATH: 'get-resume-path',
  PROGRESS: 'progress',
  IMPORT_COOKBOOK: 'import-cookbook',
  GET_COOKBOOKS: 'get-cookbooks',
  DELETE_COOKBOOK: 'delete-cookbook',
  SIGN_IN_GOOGLE: 'sign-in-google',
  SIGN_OUT: 'sign-out',
  GET_SESSION: 'get-session',
} as const;
