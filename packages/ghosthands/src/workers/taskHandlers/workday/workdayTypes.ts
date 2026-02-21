import { z } from 'zod';

/**
 * Comprehensive user profile schema for Workday job applications.
 * Covers all typical fields encountered across Workday application forms.
 */

export const WorkdayAddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  country: z.string().default('United States'),
});

export const WorkdayEducationSchema = z.object({
  school: z.string(),
  degree: z.string(),
  field_of_study: z.string(),
  gpa: z.string().optional(),
  start_date: z.string(),
  end_date: z.string(),
});

export const WorkdayExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  location: z.string().optional(),
  currently_work_here: z.boolean().optional().default(false),
  start_date: z.string(),
  end_date: z.string(),
  description: z.string(),
});

export const WorkdayUserProfileSchema = z.object({
  // Personal
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  phone_device_type: z.string().default('Mobile'),
  phone_country_code: z.string().default('+1'),
  address: WorkdayAddressSchema,

  // Professional links
  linkedin_url: z.string().optional(),
  website_url: z.string().optional(),
  current_company: z.string().optional(),
  current_title: z.string().optional(),

  // Education history
  education: z.array(WorkdayEducationSchema).min(1),

  // Work experience
  experience: z.array(WorkdayExperienceSchema).default([]),

  // Skills (typeahead tags on My Experience page)
  skills: z.array(z.string()).default([]),

  // Resume file path (relative to cwd or absolute)
  resume_path: z.string().optional(),

  // Legal/compliance
  work_authorization: z.string().default('Yes'),
  visa_sponsorship: z.string().default('No'),

  // Voluntary self-identification (defaults to decline)
  gender: z.string().default('Male'),
  race_ethnicity: z.string().default('Asian'),
  veteran_status: z.string().default('I am not a protected veteran'),
  disability_status: z.string().default('I do not wish to answer'),
});

export type WorkdayUserProfile = z.infer<typeof WorkdayUserProfileSchema>;
