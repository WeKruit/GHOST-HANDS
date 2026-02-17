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

  // Legal/compliance
  work_authorization: z.string().default('Yes'),
  visa_sponsorship: z.string().default('No'),

  // Voluntary self-identification (defaults to decline)
  gender: z.string().default('I do not wish to answer'),
  race_ethnicity: z.string().default('I do not wish to answer'),
  veteran_status: z.string().default('I am not a protected veteran'),
  disability_status: z.string().default('I do not wish to answer'),
});

export type WorkdayUserProfile = z.infer<typeof WorkdayUserProfileSchema>;

/**
 * Fabricated test user profile for development and testing.
 * Matches the test Gmail account HappyWu192@gmail.com.
 */
export const TEST_WORKDAY_PROFILE: WorkdayUserProfile = {
  first_name: 'Happy',
  last_name: 'Wu',
  email: 'HappyWu192@gmail.com',
  phone: '4085551234',
  phone_device_type: 'Mobile',
  phone_country_code: '+1',
  address: {
    street: '123 Test Avenue',
    city: 'San Jose',
    state: 'California',
    zip: '95112',
    country: 'United States of America',
  },
  linkedin_url: 'https://linkedin.com/in/happywu192',
  website_url: 'https://happywu.dev',
  current_company: '',
  current_title: 'Student',

  education: [
    {
      school: 'University of California, Berkeley',
      degree: "Bachelor's Degree",
      field_of_study: 'Computer Science',
      gpa: '3.7',
      start_date: '2023-08',
      end_date: '2027-05',
    },
  ],

  experience: [
    {
      company: 'Tech Startup Inc',
      title: 'Software Engineering Intern',
      start_date: '2025-06',
      end_date: '2025-08',
      description:
        'Built REST APIs using Node.js and TypeScript. Developed React components for a SaaS platform. Wrote unit and integration tests with Jest.',
    },
  ],

  work_authorization: 'Yes',
  visa_sponsorship: 'No',
  veteran_status: 'I am not a protected veteran',
  disability_status: 'I do not wish to answer',
  gender: 'I do not wish to answer',
  race_ethnicity: 'I do not wish to answer',
};

/**
 * Default Q&A overrides for common Workday screening questions.
 */
export const TEST_QA_OVERRIDES: Record<string, string> = {
  // Workday-specific
  'Have you previously worked for or are you currently working for Workday as an employee or contractor?': 'No',
  'In your current job, do you use or work on the Workday system?': 'No',
  'Have you previously worked for this company?': 'No',
  // Legal/authorization
  'Are you legally authorized to work in the United States?': 'Yes',
  'Will you now or in the future require sponsorship for employment visa status?': 'No',
  'Are you at least 18 years of age?': 'Yes',
  // General — "How did you hear" is a NESTED dropdown:
  //   Step 1: select "Website"
  //   Step 2: a sub-menu appears — select "workday.com" (or similar)
  //   WARNING: Do NOT click the "← Website" back button — that goes backwards.
  'How did you hear about this position?': 'Website → then select "workday.com" from the sub-menu',
  'How did you hear about us?': 'Website → then select "workday.com" from the sub-menu',
  'What is your expected graduation date?': 'May 2027',
  'Are you willing to relocate?': 'Yes',
  'What is your desired salary?': 'Open to discussion',
};
