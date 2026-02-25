/**
 * Maps the desktop app's camelCase UserProfile to the snake_case
 * WorkdayUserProfile that the staging pipeline expects.
 */

import type { UserProfile } from '../../../shared/types.js';
import type { WorkdayUserProfile } from './workdayTypes.js';

export function mapDesktopProfileToWorkday(
  profile: UserProfile,
  resumePath?: string,
): WorkdayUserProfile {
  return {
    // Personal
    first_name: profile.firstName,
    last_name: profile.lastName,
    email: profile.email,
    phone: profile.phone,
    phone_device_type: 'Mobile',
    phone_country_code: '+1',
    address: {
      street: profile.address || '',
      city: profile.city || '',
      state: profile.state || '',
      zip: profile.zipCode || '',
      country: 'United States',
    },

    // Professional links
    linkedin_url: profile.linkedIn || undefined,

    // Education
    education: profile.education.map((edu) => ({
      school: edu.school,
      degree: edu.degree,
      field_of_study: edu.field,
      start_date: String(edu.startYear),
      end_date: edu.endYear ? String(edu.endYear) : '',
    })),

    // Experience
    experience: profile.experience.map((exp) => ({
      company: exp.company,
      title: exp.title,
      currently_work_here: !exp.endDate,
      start_date: exp.startDate,
      end_date: exp.endDate || '',
      description: exp.description,
    })),

    // Skills
    skills: [],

    // Resume
    resume_path: resumePath,

    // Legal/compliance
    work_authorization: 'Yes',
    visa_sponsorship: 'No',

    // Voluntary self-identification defaults
    gender: 'Male',
    race_ethnicity: 'Asian',
    veteran_status: 'I am not a protected veteran',
    disability_status: 'I do not wish to answer',
  };
}
