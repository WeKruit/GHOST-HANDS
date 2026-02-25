import { z } from 'zod';

// --- Constants ---

export const PHONE_2FA_TIMEOUT_MS = 180_000; // 3 minutes
export const PHONE_2FA_POLL_INTERVAL_MS = 5_000;
export const PAGE_TRANSITION_WAIT_MS = 3_000;
export const MAX_FORM_PAGES = 30; // safety limit to avoid infinite loops

// --- Page type detection schema ---

export const PageStateSchema = z.object({
  page_type: z.enum([
    'job_listing',
    'login',
    'google_signin',
    'verification_code',
    'phone_2fa',
    'account_creation',
    'personal_info',
    'experience',
    'resume_upload',
    'questions',
    'voluntary_disclosure',
    'self_identify',
    'review',
    'confirmation',
    'error',
    'unknown',
  ]),
  page_title: z.string().optional().default('').catch(''),
  has_apply_button: z.boolean().optional().default(false).catch(false),
  has_next_button: z.boolean().optional().default(false).catch(false),
  has_submit_button: z.boolean().optional().default(false).catch(false),
  has_sign_in_with_google: z.boolean().optional().default(false).catch(false),
  error_message: z.string().optional().default('').catch(''),
});

export type PageState = z.input<typeof PageStateSchema>;
