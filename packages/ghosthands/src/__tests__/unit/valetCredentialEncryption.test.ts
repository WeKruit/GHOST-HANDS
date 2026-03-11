import { afterEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  decryptValetPlatformCredentialSecret,
  encryptValetPlatformCredentialSecret,
  normalizeValetPlatformCredentialDomain,
} from '../../db/valetCredentialEncryption.js';

const ORIGINAL_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function valetStyleEncrypt(secret: string, key: string): string {
  const derivedKey = scryptSync(key, 'valet-cred-salt', 32);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function valetStyleDecrypt(encoded: string, key: string): string {
  const derivedKey = scryptSync(key, 'valet-cred-salt', 32);
  const payload = Buffer.from(encoded, 'base64');
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

afterEach(() => {
  if (ORIGINAL_KEY == null) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe('valetCredentialEncryption', () => {
  test('normalizes tenant host from url', () => {
    expect(
      normalizeValetPlatformCredentialDomain(
        'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/foo',
      ),
    ).toBe('cadence.wd1.myworkdayjobs.com');
  });

  test('GhostHands-encrypted secrets decrypt with VALET-compatible logic', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-credential-key';
    const encoded = encryptValetPlatformCredentialSecret('TenantWorkday!234');
    expect(valetStyleDecrypt(encoded, 'test-credential-key')).toBe('TenantWorkday!234');
  });

  test('VALET-style encrypted secrets decrypt with GhostHands logic', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-credential-key';
    const encoded = valetStyleEncrypt('TenantWorkday!234', 'test-credential-key');
    expect(decryptValetPlatformCredentialSecret(encoded)).toBe('TenantWorkday!234');
  });
});
