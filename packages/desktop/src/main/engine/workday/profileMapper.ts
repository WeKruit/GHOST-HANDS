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
      gpa: edu.gpa || undefined,
      start_date: edu.startDate,
      end_date: edu.endDate || '',
    })),

    // Experience
    experience: profile.experience.map((exp) => {
      const isPresent = !exp.endDate || exp.endDate.toLowerCase().trim() === 'present';
      return {
        company: exp.company,
        title: exp.title,
        location: exp.location || '',
        currently_work_here: isPresent,
        start_date: exp.startDate,
        end_date: isPresent ? '' : exp.endDate || '',
        description: exp.description,
      };
    }),

    // Skills
    skills: profile.skills || [],

    // Resume
    resume_path: resumePath,

    // Legal/compliance
    work_authorization: profile.workAuthorization || 'Yes',
    visa_sponsorship: profile.visaSponsorship || 'No',

    // Voluntary self-identification
    gender: profile.gender || 'Male',
    race_ethnicity: profile.raceEthnicity || 'Asian (Not Hispanic or Latino)',
    veteran_status: profile.veteranStatus || 'I am not a protected veteran',
    disability_status: profile.disabilityStatus || "No, I Don't Have A Disability",
  };
}
