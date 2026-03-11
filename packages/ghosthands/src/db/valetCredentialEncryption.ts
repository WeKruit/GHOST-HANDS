import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const VALET_CREDENTIAL_SALT = 'valet-cred-salt';

function getCredentialKey(): Buffer {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY ?? '';
  if (!key) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set');
  }
  return scryptSync(key, VALET_CREDENTIAL_SALT, 32);
}

export function normalizeValetPlatformCredentialDomain(
  domainOrUrl: string | null | undefined,
): string | null {
  if (typeof domainOrUrl !== 'string') return null;
  const trimmed = domainOrUrl.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export function encryptValetPlatformCredentialSecret(secret: string): string {
  const key = getCredentialKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptValetPlatformCredentialSecret(encoded: string): string {
  const key = getCredentialKey();
  const payload = Buffer.from(encoded, 'base64');
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
