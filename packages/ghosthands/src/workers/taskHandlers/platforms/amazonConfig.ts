import type { PageState } from './types.js';
import { GenericPlatformConfig } from './genericConfig.js';

// ---------------------------------------------------------------------------
// AmazonPlatformConfig — extends GenericPlatformConfig with Amazon URL detection
// ---------------------------------------------------------------------------

export class AmazonPlatformConfig extends GenericPlatformConfig {
  override readonly platformId = 'amazon';
  override readonly displayName = 'Amazon Jobs';
  override readonly authDomains = ['amazon.com', 'amazon.jobs'];

  override detectPageByUrl(url: string): PageState | null {
    // Amazon SSO detection
    if (url.includes('amazon.com/ap/signin')) {
      return { page_type: 'login', page_title: 'Amazon Sign-In' };
    }
    // MFA/2FA page — not a login page, needs verification code handling
    if (url.includes('amazon.com/ap/mfa')) {
      return { page_type: 'verification_code', page_title: 'Amazon MFA' };
    }
    // Account creation
    if (url.includes('amazon.com/ap/register')) {
      return { page_type: 'account_creation', page_title: 'Amazon Account Creation' };
    }

    // Google SSO (shared with parent)
    const googleResult = super.detectPageByUrl(url);
    if (googleResult) return googleResult;

    // Amazon job listing page
    if (url.includes('amazon.jobs') && url.match(/\/(?:[a-z]{2}\/)?(?:internal\/)?jobs\/\d+/)) {
      return { page_type: 'job_listing', page_title: 'Amazon Job Listing' };
    }

    return null;
  }
}
