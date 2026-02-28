/**
 * ResumeProfileLoader — Fetches parsed resume data from VALET's `resumes` table
 * and maps it to GhostHands' WorkdayUserProfile format.
 *
 * VALET parses resumes asynchronously and stores structured data in the
 * `parsed_data` JSONB column. This loader reads that data so GhostHands
 * can fill job applications dynamically per-user instead of using hardcoded profiles.
 *
 * Default values for Workday-specific fields (gender, veteran status, etc.)
 * are defined in WORKDAY_PROFILE_DEFAULTS below and can be easily modified.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkdayUserProfile } from '../workers/taskHandlers/workday/workdayTypes.js';
import { getLogger } from '../monitoring/logger.js';

// ── VALET parsed_data types (camelCase, matching VALET's Zod schema) ────

export interface ValetParsedData {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  skills?: string[];
  education?: Array<{
    school: string;
    degree: string;
    fieldOfStudy?: string;
    gpa?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    expectedGraduation?: string | null;
    honors?: string | null;
  }>;
  workHistory?: Array<{
    title: string;
    company: string;
    location?: string;
    startDate?: string | null;
    endDate?: string | null;
    description?: string;
    bullets?: string[];
    achievements?: string[];
  }>;
  projects?: Array<{
    name: string;
    description?: string;
    technologies?: string[];
    url?: string;
  }>;
  certifications?: string[];
  languages?: string[];
  interests?: string[];
  awards?: Array<{
    title: string;
    issuer?: string;
    date?: string;
  }>;
  volunteerWork?: Array<{
    organization: string;
    role?: string;
    description?: string;
    startDate?: string | null;
    endDate?: string | null;
  }>;
  websites?: string[];
  totalYearsExperience?: number | null;
  workAuthorization?: string | null;
  parseConfidence?: number;
}

// ── Result type ─────────────────────────────────────────────────────────

export interface ResumeProfileResult {
  /** Mapped WorkdayUserProfile ready for form filling */
  profile: WorkdayUserProfile;
  /** S3/Supabase Storage key for the resume file (e.g. "resumes/userId/uuid-file.pdf") */
  fileKey: string | null;
  /** VALET user ID (use this as gh_automation_jobs.user_id) */
  userId: string;
  /** Resume row ID */
  resumeId: string;
  /** VALET's parsing confidence score (0.0–1.0) */
  parsingConfidence: number | null;
  /** Raw extracted text from the resume PDF/DOCX */
  rawText: string | null;
}

// ── Workday-specific defaults ───────────────────────────────────────────
// Edit these to change the default values used when a field is not present
// in VALET's parsed resume data. These are Workday form-specific.

export const WORKDAY_PROFILE_DEFAULTS = {
  phone_device_type: 'Mobile',
  phone_country_code: '+1',
  address: {
    street: '',
    city: '',
    state: '',
    zip: '',
    country: 'United States of America',
  },
  work_authorization: 'Yes',
  visa_sponsorship: 'No',
  veteran_status: 'I am not a protected veteran',
  disability_status: 'No, I Don\'t Have A Disability',
  gender: 'Male',
  race_ethnicity: 'Asian (Not Hispanic or Latino)',
};

// ── ResumeProfileLoader ─────────────────────────────────────────────────

export class ResumeProfileLoader {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Load the default parsed resume for a user from VALET's `resumes` table.
   *
   * If no userId is provided, discovers any user with a parsed resume
   * (useful for development/testing).
   *
   * Prefers the user's default resume; falls back to most recently created.
   */
  async loadForUser(userId?: string): Promise<ResumeProfileResult> {
    const logger = getLogger();

    let query = this.supabase
      .from('resumes')
      .select('id, user_id, file_key, parsed_data, parsing_confidence, raw_text')
      .eq('status', 'parsed')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      const context = userId ? `user_id=${userId}` : 'any user';
      throw new Error(
        `No parsed resume found for ${context}. ` +
        `Ensure a resume has been uploaded and parsed in VALET (status = 'parsed'). ` +
        `Supabase error: ${error?.message || 'no rows returned'}`,
      );
    }

    const parsedData = data.parsed_data as ValetParsedData;
    if (!parsedData) {
      throw new Error(`Resume ${data.id} exists but has no parsed_data. It may still be parsing.`);
    }

    const profile = mapToWorkdayProfile(parsedData);

    // Minimal usability check — reject only if the profile is truly unusable.
    // Do NOT validate against the full WorkdayUserProfileSchema here: it requires
    // .email() and education.min(1), which rejects partially parsed but still
    // usable resumes (name + phone + experience). The strict Workday schema
    // validation belongs at the handler level, not at enrichment time.
    if (!profile.first_name && !profile.last_name) {
      throw new Error(
        `Resume ${data.id} mapped to unusable profile: missing both first_name and last_name`,
      );
    }

    logger.info('Loaded resume profile from database', {
      resumeId: data.id,
      userId: data.user_id,
      name: `${profile.first_name} ${profile.last_name}`,
      confidence: data.parsing_confidence,
    });

    return {
      profile,
      fileKey: data.file_key,
      userId: data.user_id,
      resumeId: data.id,
      parsingConfidence: data.parsing_confidence,
      rawText: data.raw_text,
    };
  }
}

// ── Mapping: VALET parsed_data → WorkdayUserProfile ─────────────────────

/**
 * Map VALET's camelCase parsed_data to GhostHands' snake_case WorkdayUserProfile.
 *
 * Fields not present in VALET's parsed data (phone_device_type, veteran_status,
 * disability_status, etc.) are filled from WORKDAY_PROFILE_DEFAULTS.
 */
export function mapToWorkdayProfile(
  data: ValetParsedData,
  defaults = WORKDAY_PROFILE_DEFAULTS,
): WorkdayUserProfile {
  const nameParts = (data.fullName || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const address = parseLocation(data.location, defaults.address);
  const linkedinUrl = data.websites?.find((w) => w.includes('linkedin')) || '';
  const websiteUrl = data.websites?.find((w) => !w.includes('linkedin')) || '';

  // Most recent work experience is current role
  const currentJob = data.workHistory?.[0];

  return {
    first_name: firstName,
    last_name: lastName,
    email: data.email || '',
    phone: (data.phone || '').replace(/[^\d+]/g, ''),
    phone_device_type: defaults.phone_device_type,
    phone_country_code: defaults.phone_country_code,
    address,

    linkedin_url: linkedinUrl,
    website_url: websiteUrl,
    current_company: currentJob?.company || '',
    current_title: currentJob?.title || '',

    education: (data.education || []).map((edu) => ({
      school: edu.school,
      degree: edu.degree,
      field_of_study: edu.fieldOfStudy || '',
      gpa: edu.gpa || undefined,
      start_date: edu.startDate || '',
      end_date: edu.endDate || edu.expectedGraduation || '',
    })),

    experience: (data.workHistory || []).map((job) => ({
      company: job.company,
      title: job.title,
      location: job.location || '',
      currently_work_here: !job.endDate,
      start_date: job.startDate || '',
      end_date: job.endDate || '',
      description: job.description || job.bullets?.join('. ') || '',
    })),

    skills: data.skills || [],
    resume_path: '', // Set by caller from file_key

    work_authorization: data.workAuthorization || defaults.work_authorization,
    visa_sponsorship: defaults.visa_sponsorship,
    veteran_status: defaults.veteran_status,
    disability_status: defaults.disability_status,
    gender: defaults.gender,
    race_ethnicity: defaults.race_ethnicity,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Best-effort parse of a location string (e.g. "San Francisco, CA 95112")
 * into WorkdayUserProfile address fields.
 */
function parseLocation(
  location: string | undefined,
  defaultAddress: typeof WORKDAY_PROFILE_DEFAULTS.address,
): WorkdayUserProfile['address'] {
  if (!location) return { ...defaultAddress };

  const parts = location.split(',').map((s) => s.trim());
  if (parts.length >= 2) {
    const city = parts[0];
    const stateZipParts = parts[parts.length - 1].trim().split(/\s+/);
    const state = stateZipParts[0] || '';
    const zip = stateZipParts[1] || defaultAddress.zip;
    return {
      street: defaultAddress.street,
      city,
      state,
      zip,
      country: defaultAddress.country,
    };
  }

  return { ...defaultAddress, city: location };
}
