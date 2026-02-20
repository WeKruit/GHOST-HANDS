/**
 * Security Regression Tests: Credential Encryption (SEC-011 to SEC-013)
 *
 * Tests AES-256-GCM encryption/decryption roundtrip, IV uniqueness,
 * and tamper detection.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { CredentialEncryption } from '../../../src/db/encryption.js';

describe('Security: Credential Encryption', () => {
  let encryption: CredentialEncryption;

  beforeEach(() => {
    encryption = new CredentialEncryption({
      primaryKeyHex: 'a'.repeat(64), // 64 hex chars = 32 bytes
      primaryKeyId: 1,
    });
  });

  // SEC-011: Encrypt then decrypt roundtrip matches original JSON string
  test('SEC-011: encrypt/decrypt roundtrip matches original', () => {
    const original = JSON.stringify({
      username: 'test@example.com',
      password: 'super-secret-123!',
      platform: 'linkedin',
    });

    const encrypted = encryption.encrypt(original);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.keyId).toBe(1);

    const decrypted = encryption.decrypt(encrypted.ciphertext);
    expect(decrypted).toBe(original);
  });

  // SEC-012: Two encryptions of same plaintext produce different ciphertexts (unique IV)
  test('SEC-012: two encryptions produce different ciphertexts (unique IV)', () => {
    const plaintext = 'identical-plaintext-for-both-calls';

    const encrypted1 = encryption.encrypt(plaintext);
    const encrypted2 = encryption.encrypt(plaintext);

    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

    // Both should still decrypt to the same value
    expect(encryption.decrypt(encrypted1.ciphertext)).toBe(plaintext);
    expect(encryption.decrypt(encrypted2.ciphertext)).toBe(plaintext);
  });

  // SEC-013: Corrupted ciphertext throws on decrypt, no crash
  test('SEC-013: corrupted ciphertext throws on decrypt', () => {
    const plaintext = 'sensitive-data';
    const encrypted = encryption.encrypt(plaintext);

    // Decode, corrupt a byte in the ciphertext body, re-encode
    const buf = Buffer.from(encrypted.ciphertext, 'base64');
    // Flip a byte near the end (inside the ciphertext portion)
    buf[buf.length - 1] ^= 0xff;
    const corrupted = buf.toString('base64');

    expect(() => encryption.decrypt(corrupted)).toThrow();
  });
});
