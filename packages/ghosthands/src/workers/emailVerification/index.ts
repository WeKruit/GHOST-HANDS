export type {
  VerificationSignal,
  VerificationResult,
  EmailProvider,
  EmailSearchOptions,
  RecentInboxMessage,
  RecentInboxOptions,
  AutoVerifyOptions,
  EmailVerificationService,
} from './types.js';

export { MissingEmailConnectionError, TokenRefreshFailedError } from './errors.js';
export { GmailApiProvider } from './gmailApiProvider.js';
export {
  DEFAULT_GOOGLE_SCOPES,
  buildGoogleOAuthAuthorizeUrl,
  exchangeGoogleCodeForTokens,
  fetchGmailProfile,
  getGoogleOAuthConfigFromEnv,
  refreshGoogleAccessToken,
} from './googleOAuth.js';
export {
  createGoogleOAuthStateToken,
  resolveGoogleOAuthStateSecret,
  verifyGoogleOAuthStateToken,
} from './oauthState.js';
export { GmailConnectionStore, createEmailTokenEncryptionFromEnv } from './tokenStore.js';
export { GmailEmailVerificationService, createEmailVerificationServiceFromEnv } from './service.js';
