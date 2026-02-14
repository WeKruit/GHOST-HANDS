/**
 * Credential Encryption at Rest
 *
 * Implements AES-256-GCM encryption for user credentials stored in the
 * gh_user_credentials table. Each credential gets a unique IV to prevent
 * identical plaintexts from producing identical ciphertexts. Supports key
 * rotation by tagging ciphertext with a key version identifier.
 *
 * Security report references: S3 (Section 3.2), S5 (Section 4.2)
 */

import crypto from 'node:crypto';

// ── Constants ──────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // NIST-recommended for GCM
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // 256 bits
const ENCODING = 'base64' as const;

// Envelope format: version(1) + keyId(2) + iv(12) + authTag(16) + ciphertext(variable)
const ENVELOPE_HEADER_BYTES = 1 + 2 + IV_BYTES + AUTH_TAG_BYTES;
const CURRENT_ENVELOPE_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────────────

export interface EncryptionKey {
  /** Short numeric identifier embedded in the ciphertext envelope. */
  id: number;
  /** 32-byte raw key material. */
  key: Buffer;
  /** ISO timestamp of when this key was created. */
  createdAt: string;
  /** Whether this key is the current default for encryption. */
  active: boolean;
}

export interface EncryptedPayload {
  /** Base64-encoded envelope (version + keyId + iv + tag + ciphertext). */
  ciphertext: string;
  /** Key ID used for encryption (for audit/rotation tracking). */
  keyId: number;
}

export interface CredentialEncryptionConfig {
  /** Primary encryption key (hex-encoded, 64 hex chars = 32 bytes). */
  primaryKeyHex: string;
  /** Key ID for the primary key. Default 1. */
  primaryKeyId: number;
  /** Previous keys for decryption during rotation (hex-encoded). */
  previousKeys?: Array<{ id: number; keyHex: string }>;
}

// ── Key management ─────────────────────────────────────────────────────────

export class CredentialEncryption {
  private keys: Map<number, EncryptionKey> = new Map();
  private activeKeyId: number;

  constructor(config: CredentialEncryptionConfig) {
    const primaryKey = this.parseKey(config.primaryKeyHex, config.primaryKeyId, true);
    this.keys.set(primaryKey.id, primaryKey);
    this.activeKeyId = primaryKey.id;

    if (config.previousKeys) {
      for (const prev of config.previousKeys) {
        const key = this.parseKey(prev.keyHex, prev.id, false);
        this.keys.set(key.id, key);
      }
    }
  }

  /**
   * Generate a new random encryption key.
   * Returns hex-encoded key material suitable for environment variables.
   */
  static generateKey(): string {
    return crypto.randomBytes(KEY_BYTES).toString('hex');
  }

  /**
   * Encrypt a plaintext credential value.
   *
   * Produces a base64-encoded envelope:
   *   [version:1][keyId:2][iv:12][authTag:16][ciphertext:*]
   *
   * The IV is generated fresh for every encryption call.
   */
  encrypt(plaintext: string): EncryptedPayload {
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      throw new Error('CredentialEncryption: active key not found');
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Build envelope
    const envelope = Buffer.alloc(ENVELOPE_HEADER_BYTES + encrypted.length);
    let offset = 0;

    // Version byte
    envelope.writeUInt8(CURRENT_ENVELOPE_VERSION, offset);
    offset += 1;

    // Key ID (2 bytes, big-endian)
    envelope.writeUInt16BE(key.id, offset);
    offset += 2;

    // IV
    iv.copy(envelope, offset);
    offset += IV_BYTES;

    // Auth tag
    authTag.copy(envelope, offset);
    offset += AUTH_TAG_BYTES;

    // Ciphertext
    encrypted.copy(envelope, offset);

    return {
      ciphertext: envelope.toString(ENCODING),
      keyId: key.id,
    };
  }

  /**
   * Decrypt an encrypted credential envelope.
   *
   * Automatically selects the correct key based on the keyId in the envelope,
   * enabling seamless key rotation: new writes use the active key, old
   * ciphertexts are decrypted with their original key.
   */
  decrypt(ciphertextBase64: string): string {
    const envelope = Buffer.from(ciphertextBase64, ENCODING);

    if (envelope.length < ENVELOPE_HEADER_BYTES) {
      throw new Error('CredentialEncryption: envelope too short');
    }

    let offset = 0;

    // Version
    const version = envelope.readUInt8(offset);
    offset += 1;
    if (version !== CURRENT_ENVELOPE_VERSION) {
      throw new Error(`CredentialEncryption: unsupported envelope version ${version}`);
    }

    // Key ID
    const keyId = envelope.readUInt16BE(offset);
    offset += 2;

    // IV
    const iv = envelope.subarray(offset, offset + IV_BYTES);
    offset += IV_BYTES;

    // Auth tag
    const authTag = envelope.subarray(offset, offset + AUTH_TAG_BYTES);
    offset += AUTH_TAG_BYTES;

    // Ciphertext
    const encrypted = envelope.subarray(offset);

    // Resolve key
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`CredentialEncryption: key ${keyId} not found (rotation gap?)`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Re-encrypt a credential with the current active key.
   * Used during key rotation to migrate old ciphertexts.
   */
  rotate(ciphertextBase64: string): EncryptedPayload {
    const plaintext = this.decrypt(ciphertextBase64);
    return this.encrypt(plaintext);
  }

  /**
   * Check which key ID was used for a given ciphertext without decrypting.
   */
  getKeyId(ciphertextBase64: string): number {
    const envelope = Buffer.from(ciphertextBase64, ENCODING);
    if (envelope.length < 3) {
      throw new Error('CredentialEncryption: envelope too short');
    }
    return envelope.readUInt16BE(1);
  }

  /** The currently active key ID. */
  get currentKeyId(): number {
    return this.activeKeyId;
  }

  /** All loaded key IDs. */
  get loadedKeyIds(): number[] {
    return Array.from(this.keys.keys());
  }

  // ── Private ────────────────────────────────────────────────────────────

  private parseKey(hex: string, id: number, active: boolean): EncryptionKey {
    if (hex.length !== KEY_BYTES * 2) {
      throw new Error(
        `CredentialEncryption: key must be ${KEY_BYTES * 2} hex characters (${KEY_BYTES} bytes), got ${hex.length}`
      );
    }
    return {
      id,
      key: Buffer.from(hex, 'hex'),
      createdAt: new Date().toISOString(),
      active,
    };
  }
}

/**
 * Create a CredentialEncryption instance from environment variables.
 *
 * Expected env vars:
 *   GH_CREDENTIAL_KEY       - Primary key (64 hex chars)
 *   GH_CREDENTIAL_KEY_ID    - Primary key ID (default "1")
 *   GH_CREDENTIAL_PREV_KEYS - JSON array of {id, keyHex} for rotation
 */
export function createEncryptionFromEnv(): CredentialEncryption {
  const primaryKeyHex = process.env.GH_CREDENTIAL_KEY;
  if (!primaryKeyHex) {
    throw new Error(
      'Missing GH_CREDENTIAL_KEY environment variable. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const primaryKeyId = parseInt(process.env.GH_CREDENTIAL_KEY_ID || '1', 10);

  let previousKeys: Array<{ id: number; keyHex: string }> | undefined;
  const prevKeysJson = process.env.GH_CREDENTIAL_PREV_KEYS;
  if (prevKeysJson) {
    previousKeys = JSON.parse(prevKeysJson);
  }

  return new CredentialEncryption({
    primaryKeyHex,
    primaryKeyId,
    previousKeys,
  });
}
