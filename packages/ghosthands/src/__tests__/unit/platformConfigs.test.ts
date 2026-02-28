import { describe, expect, test } from 'bun:test';
import { GenericPlatformConfig } from '../../workers/taskHandlers/platforms/genericConfig.js';
import { WorkdayPlatformConfig } from '../../workers/taskHandlers/platforms/workdayConfig.js';
import { AmazonPlatformConfig } from '../../workers/taskHandlers/platforms/amazonConfig.js';
import {
  detectPlatformFromUrl,
  getPlatformConfig,
} from '../../workers/taskHandlers/platforms/index.js';

// ---------------------------------------------------------------------------
// Platform detection from URL
// ---------------------------------------------------------------------------

describe('detectPlatformFromUrl', () => {
  test('detects Workday URLs', () => {
    const config = detectPlatformFromUrl('https://company.myworkdayjobs.com/en-US/jobs/job/Software-Engineer_R12345');
    expect(config.platformId).toBe('workday');
  });

  test('detects myworkday.com URLs', () => {
    const config = detectPlatformFromUrl('https://wd5.myworkdaysite.com/recruiting/company/jobs');
    expect(config.platformId).toBe('workday');
  });

  test('detects Amazon URLs', () => {
    const config = detectPlatformFromUrl('https://www.amazon.jobs/en/jobs/2712345/software-development-engineer');
    expect(config.platformId).toBe('amazon');
  });

  test('returns generic for unknown URLs', () => {
    const config = detectPlatformFromUrl('https://some-random-company.com/careers/apply');
    expect(config.platformId).toBe('generic');
  });

  test('returns generic for LinkedIn (no custom config yet)', () => {
    const config = detectPlatformFromUrl('https://www.linkedin.com/jobs/view/12345');
    expect(config.platformId).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// getPlatformConfig
// ---------------------------------------------------------------------------

describe('getPlatformConfig', () => {
  test('returns workday config by ID', () => {
    const config = getPlatformConfig('workday');
    expect(config.platformId).toBe('workday');
    expect(config).toBeInstanceOf(WorkdayPlatformConfig);
  });

  test('returns amazon config by ID', () => {
    const config = getPlatformConfig('amazon');
    expect(config.platformId).toBe('amazon');
    expect(config).toBeInstanceOf(AmazonPlatformConfig);
  });

  test('returns generic for unknown platformId', () => {
    const config = getPlatformConfig('nonexistent');
    expect(config.platformId).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// GenericPlatformConfig
// ---------------------------------------------------------------------------

describe('GenericPlatformConfig', () => {
  const config = new GenericPlatformConfig();

  test('has correct platformId', () => {
    expect(config.platformId).toBe('generic');
    expect(config.displayName).toBe('Generic (any site)');
  });

  test('detectPageByUrl identifies Google SSO', () => {
    const result = config.detectPageByUrl('https://accounts.google.com/signin/oauth/id?client_id=abc');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('google_signin');
  });

  test('detectPageByUrl identifies Google challenge as phone_2fa', () => {
    const result = config.detectPageByUrl('https://accounts.google.com/signin/v2/challenge/ipp?flowName=GlifWebSignIn');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('phone_2fa');
  });

  test('detectPageByUrl returns null for non-Google URLs', () => {
    const result = config.detectPageByUrl('https://company.com/apply');
    expect(result).toBeNull();
  });

  test('baseRules contains key instructions', () => {
    expect(config.baseRules).toContain('ZERO SCROLLING');
    expect(config.baseRules).toContain('FULLY VISIBLE ONLY');
    expect(config.baseRules).toContain('ONE ATTEMPT PER FIELD');
    expect(config.baseRules).toContain('NEVER NAVIGATE');
  });

  test('baseRules does NOT contain Workday NO TAB KEY rule', () => {
    expect(config.baseRules).not.toContain('NO TAB KEY');
  });

  test('needsCustomExperienceHandler is false', () => {
    expect(config.needsCustomExperienceHandler).toBe(false);
  });

  test('buildDataPrompt includes profile fields', () => {
    const prompt = config.buildDataPrompt(
      { first_name: 'John', last_name: 'Doe', email: 'john@example.com', phone: '555-1234' },
      { 'Are you authorized to work?': 'Yes' },
    );
    expect(prompt).toContain('John');
    expect(prompt).toContain('Doe');
    expect(prompt).toContain('john@example.com');
    expect(prompt).toContain('555-1234');
    expect(prompt).toContain('Are you authorized to work?');
    expect(prompt).toContain('Yes');
  });

  test('buildQAMap includes profile fields and common defaults', () => {
    const map = config.buildQAMap(
      { first_name: 'John', last_name: 'Doe', email: 'john@example.com' },
      { 'Custom question': 'Custom answer' },
    );
    expect(map['First Name']).toBe('John');
    expect(map['Last Name']).toBe('Doe');
    expect(map['Email']).toBe('john@example.com');
    expect(map['Custom question']).toBe('Custom answer');
    expect(map['Are you at least 18 years of age?']).toBe('Yes');
  });

  test('buildQAMap overrides defaults with user-provided Q&A', () => {
    const map = config.buildQAMap(
      { first_name: 'John' },
      { 'Are you at least 18 years of age?': 'Prefer not to say' },
    );
    expect(map['Are you at least 18 years of age?']).toBe('Prefer not to say');
  });

  test('buildPagePrompt includes base rules and data', () => {
    const prompt = config.buildPagePrompt('personal_info', 'DATA: First Name → John');
    expect(prompt).toContain('ZERO SCROLLING');
    expect(prompt).toContain('personal info');
    expect(prompt).toContain('DATA: First Name → John');
  });

  test('buildClassificationPrompt includes all page types', () => {
    const prompt = config.buildClassificationPrompt(['This is a login page.']);
    expect(prompt).toContain('login');
    expect(prompt).toContain('job_listing');
    expect(prompt).toContain('personal_info');
    expect(prompt).toContain('review');
    expect(prompt).toContain('confirmation');
    expect(prompt).toContain('This is a login page.');
  });
});

// ---------------------------------------------------------------------------
// WorkdayPlatformConfig
// ---------------------------------------------------------------------------

describe('WorkdayPlatformConfig', () => {
  const config = new WorkdayPlatformConfig();

  test('has correct platformId', () => {
    expect(config.platformId).toBe('workday');
    expect(config.displayName).toBe('Workday');
  });

  test('baseRules includes NO TAB KEY', () => {
    expect(config.baseRules).toContain('NO TAB KEY');
  });

  test('needsCustomExperienceHandler is true', () => {
    expect(config.needsCustomExperienceHandler).toBe(true);
  });

  test('authDomains includes Google and Workday', () => {
    expect(config.authDomains).toContain('accounts.google.com');
    expect(config.authDomains).toContain('myworkdayjobs.com');
  });

  test('detectPageByUrl identifies Google SSO pages', () => {
    const result = config.detectPageByUrl('https://accounts.google.com/signin/oauth/id');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('google_signin');
  });

  test('detectPageByUrl identifies Google challenge as phone_2fa', () => {
    const result = config.detectPageByUrl('https://accounts.google.com/signin/v2/challenge/recaptcha');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('phone_2fa');
    expect(result!.page_title).toContain('CAPTCHA');
  });

  test('detectPageByUrl returns null for Workday job URLs', () => {
    // Workday job URLs need DOM/LLM detection, not URL-based
    const result = config.detectPageByUrl('https://company.myworkdayjobs.com/en-US/jobs/job/SWE');
    expect(result).toBeNull();
  });

  test('buildClassificationPrompt includes Workday-specific rules', () => {
    const prompt = config.buildClassificationPrompt([]);
    expect(prompt).toContain('voluntary_disclosure');
    expect(prompt).toContain('self_identify');
    expect(prompt).toContain('Application Questions');
    expect(prompt).toContain('Workday');
  });

  test('buildDataPrompt includes Workday-specific fields', () => {
    const prompt = config.buildDataPrompt(
      {
        first_name: 'Happy',
        last_name: 'Wu',
        email: 'happy@test.com',
        phone: '4085551234',
        phone_device_type: 'Mobile',
        phone_country_code: '+1',
        address: { street: '123 Test Ave', city: 'San Jose', state: 'California', zip: '95112', country: 'United States' },
        work_authorization: 'Yes',
        visa_sponsorship: 'No',
        education: [],
      },
      {},
    );
    expect(prompt).toContain('Happy');
    expect(prompt).toContain('Phone Device Type');
    expect(prompt).toContain('Country Phone Code');
    expect(prompt).toContain('DROPDOWN TECHNIQUE');
    expect(prompt).toContain('NESTED DROPDOWNS');
    expect(prompt).toContain('DATE FIELDS');
    expect(prompt).toContain('NEVER click "Submit Application"');
  });

  test('buildQAMap includes Workday self-identification defaults', () => {
    const map = config.buildQAMap(
      {
        first_name: 'Happy',
        last_name: 'Wu',
        gender: 'Male',
        race_ethnicity: 'Asian',
        veteran_status: 'I am not a protected veteran',
        disability_status: 'I do not wish to answer',
        address: { country: 'United States', state: 'California' },
      },
      {},
    );
    expect(map['Gender']).toBe('Male');
    expect(map['Race/Ethnicity']).toBe('Asian');
    expect(map['Veteran Status']).toBe('I am not a protected veteran');
    expect(map['Disability']).toBe('I do not wish to answer');
    expect(map['Country']).toBe('United States');
    expect(map['Phone Device Type']).toBe('Mobile');
    expect(map['Signature']).toBe('Happy Wu');
  });

  test('buildPagePrompt routes to correct Workday prompt builder', () => {
    // voluntary_disclosure should NOT include data block (self-contained)
    const volPrompt = config.buildPagePrompt('voluntary_disclosure', 'IRRELEVANT DATA');
    expect(volPrompt).toContain('voluntary self-identification');
    expect(volPrompt).not.toContain('IRRELEVANT DATA');

    // self_identify should NOT include data block
    const selfPrompt = config.buildPagePrompt('self_identify', 'IRRELEVANT DATA');
    expect(selfPrompt).toContain('self-identification');
    expect(selfPrompt).toContain('disability');

    // personal_info should include data block
    const personalPrompt = config.buildPagePrompt('personal_info', 'DATA: First Name → Happy');
    expect(personalPrompt).toContain('DATA: First Name → Happy');
    expect(personalPrompt).toContain('ZERO SCROLLING');
  });
});

// ---------------------------------------------------------------------------
// AmazonPlatformConfig
// ---------------------------------------------------------------------------

describe('AmazonPlatformConfig', () => {
  const config = new AmazonPlatformConfig();

  test('has correct platformId', () => {
    expect(config.platformId).toBe('amazon');
    expect(config.displayName).toBe('Amazon Jobs');
  });

  test('extends GenericPlatformConfig', () => {
    expect(config).toBeInstanceOf(GenericPlatformConfig);
  });

  test('authDomains includes Amazon domains', () => {
    expect(config.authDomains).toContain('amazon.com');
    expect(config.authDomains).toContain('amazon.jobs');
  });

  test('detectPageByUrl identifies Amazon SSO', () => {
    const result = config.detectPageByUrl('https://www.amazon.com/ap/signin?openid.return_to=...');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('login');
    expect(result!.page_title).toContain('Amazon');
  });

  test('detectPageByUrl identifies Amazon job listing', () => {
    const result = config.detectPageByUrl('https://www.amazon.jobs/en/jobs/2712345/software-development-engineer');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('job_listing');
  });

  test('detectPageByUrl falls through to parent for Google SSO', () => {
    const result = config.detectPageByUrl('https://accounts.google.com/signin/oauth/id');
    expect(result).not.toBeNull();
    expect(result!.page_type).toBe('google_signin');
  });

  test('detectPageByUrl returns null for non-matching URLs', () => {
    const result = config.detectPageByUrl('https://random-site.com/apply');
    expect(result).toBeNull();
  });

  test('needsCustomExperienceHandler is false (inherits generic)', () => {
    expect(config.needsCustomExperienceHandler).toBe(false);
  });

  test('baseRules does NOT contain NO TAB KEY (inherits generic)', () => {
    expect(config.baseRules).not.toContain('NO TAB KEY');
  });
});
