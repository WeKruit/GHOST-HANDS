/**
 * WorkdayPlatformHandler — Workday-specific field detection, label maps,
 * and automation-id mappings for the v2 hybrid execution engine.
 */

import type {
  PlatformHandler,
  PageModel,
  FieldType,
  RawElementData,
} from '../v2types';

export class WorkdayPlatformHandler implements PlatformHandler {
  readonly platformId = 'workday';

  /**
   * Map of Workday `data-automation-id` attribute values to canonical user data keys.
   * These are the stable IDs embedded in Workday's rendered HTML.
   */
  getAutomationIdMap(): Record<string, string> {
    return {
      // Legal name section
      legalNameSection_firstName: 'first_name',
      legalNameSection_lastName: 'last_name',
      legalNameSection_middleName: 'middle_name',
      legalNameSection_preferredFirstName: 'preferred_first_name',

      // Address section
      addressSection_addressLine1: 'street',
      addressSection_addressLine2: 'street2',
      addressSection_city: 'city',
      addressSection_countryRegion: 'country',
      addressSection_postalCode: 'zip',
      addressSection_stateProvince: 'state',

      // Phone section
      phone_number: 'phone',
      'phone-device-type': 'phone_device_type',
      countryPhoneCode: 'phone_country_code',

      // Email
      email: 'email',
      emailAddress: 'email',

      // Links
      linkedInQuestion: 'linkedin_url',
      websiteQuestion: 'website_url',

      // Self-identification
      genderDropdown: 'gender',
      ethnicityDropdown: 'race_ethnicity',
      veteranStatusDropdown: 'veteran_status',
      disabilityStatusDropdown: 'disability_status',

      // Education section
      'education-school': 'school',
      'education-degree': 'degree',
      'education-fieldOfStudy': 'field_of_study',
      'education-gpa': 'gpa',
      'education-startDate': 'education_start_date',
      'education-endDate': 'education_end_date',

      // Work experience section
      'workExperience-jobTitle': 'job_title',
      'workExperience-company': 'company',
      'workExperience-startDate': 'work_start_date',
      'workExperience-endDate': 'work_end_date',
      'workExperience-description': 'work_description',

      // Resume
      'file-upload-input-ref': 'resume_path',
    };
  }

  /**
   * Map of common Workday label text (case-sensitive as displayed) to canonical
   * user data keys. Used by FieldMatcher for label_exact and label_fuzzy strategies.
   */
  getLabelMap(): Record<string, string> {
    return {
      // Name fields
      'First Name': 'first_name',
      'Legal First Name': 'first_name',
      'Preferred First Name': 'preferred_first_name',
      'Last Name': 'last_name',
      'Legal Last Name': 'last_name',
      'Middle Name': 'middle_name',

      // Contact fields
      'Email Address': 'email',
      'Email': 'email',
      'Phone Number': 'phone',
      'Phone': 'phone',
      'Mobile Phone Number': 'phone',
      'Phone Device Type': 'phone_device_type',
      'Phone Type': 'phone_device_type',
      'Country Phone Code': 'phone_country_code',

      // Address fields
      'Country': 'country',
      'Country/Territory': 'country',
      'Address Line 1': 'street',
      'Street': 'street',
      'Street Address': 'street',
      'Address Line 2': 'street2',
      'City': 'city',
      'State': 'state',
      'State/Province': 'state',
      'Province': 'state',
      'Postal Code': 'zip',
      'ZIP Code': 'zip',
      'ZIP': 'zip',

      // Links
      'LinkedIn': 'linkedin_url',
      'LinkedIn URL': 'linkedin_url',
      'LinkedIn Profile': 'linkedin_url',
      'Website': 'website_url',
      'Website URL': 'website_url',
      'Personal Website': 'website_url',

      // Self-identification
      'Gender': 'gender',
      'Race/Ethnicity': 'race_ethnicity',
      'Race': 'race_ethnicity',
      'Ethnicity': 'race_ethnicity',
      'Veteran Status': 'veteran_status',
      'Are you a protected veteran': 'veteran_status',
      'Disability Status': 'disability_status',
      'Disability': 'disability_status',
      'Please indicate if you have a disability': 'disability_status',

      // Education
      'School': 'school',
      'School or University': 'school',
      'Degree': 'degree',
      'Field of Study': 'field_of_study',
      'GPA': 'gpa',

      // Work experience
      'Job Title': 'job_title',
      'Company': 'company',
      'Location': 'work_location',
      'Description': 'work_description',

      // Common questions
      'Name': 'full_name',
      'Full Name': 'full_name',
      'Signature': 'full_name',
      'Please enter your name': 'full_name',
      'Your name': 'full_name',
      'Enter your name': 'full_name',
      'Desired Salary': 'desired_salary',
      'What is your desired salary?': 'desired_salary',
    };
  }

  /**
   * Normalize a question/label for comparison: strip `*`, `Required`,
   * `(optional)`, extra whitespace, and convert to lowercase.
   */
  normalizeLabel(label: string): string {
    return label
      .replace(/\*/g, '')
      .replace(/\brequired\b/gi, '')
      .replace(/\(optional\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * CSS selector for Workday's "Next" / "Save and Continue" navigation button.
   */
  getNextButtonSelector(): string {
    return 'button[data-automation-id="bottom-navigation-next-button"], button:has-text("Save and Continue")';
  }

  /**
   * Detect whether a PageModel represents the final review/submit page.
   *
   * Heuristics:
   * 1. A button with text "Submit Application" exists AND no "Save and Continue" button exists.
   * 2. The pageLabel contains the word "review" (case-insensitive).
   */
  isReviewPage(pageModel: PageModel): boolean {
    const hasSubmitButton = pageModel.buttons.some(
      (btn) =>
        btn.text.toLowerCase().includes('submit application') ||
        (btn.automationId === 'bottom-navigation-next-button' &&
          btn.text.toLowerCase().includes('submit')),
    );

    const hasSaveAndContinue = pageModel.buttons.some(
      (btn) =>
        btn.text.toLowerCase().includes('save and continue') ||
        btn.automationId === 'bottom-navigation-next-button',
    );

    // If there's a Submit Application button but no Save and Continue, it's the review page
    if (hasSubmitButton && !hasSaveAndContinue) {
      return true;
    }

    // If the page label contains "review", treat it as the review page
    if (
      pageModel.pageLabel &&
      pageModel.pageLabel.toLowerCase().includes('review')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Override field type detection for Workday-specific widget patterns.
   *
   * Returns a FieldType if the element matches a known Workday pattern,
   * or null to fall through to generic detection.
   */
  detectFieldType(element: RawElementData): FieldType | null {
    // Button showing "Select One" is a custom dropdown prompt
    if (
      element.tagName.toLowerCase() === 'button' &&
      element.textContent?.trim() === 'Select One'
    ) {
      return 'custom_dropdown';
    }

    // Buttons with aria-haspopup="listbox" are custom dropdowns
    if (
      element.tagName.toLowerCase() === 'button' &&
      element.ariaHasPopup === 'listbox'
    ) {
      return 'custom_dropdown';
    }

    // Date fields identified by automation id containing date indicators
    if (
      element.automationId &&
      (element.automationId.includes('dateSectionMonth') ||
        element.automationId.includes('dateSectionDay') ||
        element.automationId.includes('dateSectionYear'))
    ) {
      return 'date';
    }

    // Typeahead fields near education/skills labels or with specific class patterns
    if (element.ariaRole === 'combobox' && element.ariaHasPopup === 'listbox') {
      return 'typeahead';
    }

    // Inputs with automation IDs that suggest typeahead behavior
    if (
      element.automationId &&
      (element.automationId.includes('fieldOfStudy') ||
        element.automationId.includes('skills') ||
        element.automationId.includes('school') ||
        element.automationId.includes('degree'))
    ) {
      return 'typeahead';
    }

    // Text content hints for typeahead detection
    if (
      element.textContent &&
      (element.textContent.includes('Field of Study') ||
        element.textContent.includes('Skills'))
    ) {
      return 'typeahead';
    }

    return null;
  }
}
