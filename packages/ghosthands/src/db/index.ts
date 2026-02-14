// Database barrel export

export { getSupabaseClient, getSupabaseUserClient } from './client.js';

export {
  CredentialEncryption,
  createEncryptionFromEnv,
} from './encryption.js';
export type {
  EncryptionKey,
  EncryptedPayload,
  CredentialEncryptionConfig,
} from './encryption.js';
