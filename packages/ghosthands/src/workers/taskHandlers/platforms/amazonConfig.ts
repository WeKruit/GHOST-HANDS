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
    if (url.includes('amazon.com/ap/signin') || url.includes('amazon.com/ap/mfa')) {
      return { page_type: 'login', page_title: 'Amazon Sign-In' };
    }

    // Google SSO (shared with parent)
    const googleResult = super.detectPageByUrl(url);
    if (googleResult) return googleResult;

    // Amazon job listing page
    if (url.includes('amazon.jobs') && url.match(/\/en\/jobs\/\d+/)) {
      return { page_type: 'job_listing', page_title: 'Amazon Job Listing' };
    }

    return null;
  }
}
