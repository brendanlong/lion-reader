/**
 * Encryption utilities for sensitive data at rest.
 *
 * Uses AES-256-GCM for authenticated encryption of API keys stored in the database.
 * Requires API_KEY_ENCRYPTION_KEY environment variable (base64-encoded 32-byte key).
 *
 * Format: base64(iv + ciphertext + authTag)
 *   - iv: 12 bytes (GCM standard)
 *   - ciphertext: variable length
 *   - authTag: 16 bytes
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Returns the encryption key from the environment.
 * Throws if the key is not configured or is the wrong size.
 */
function getEncryptionKey(): Buffer {
  const keyBase64 = process.env.API_KEY_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new Error(
      "API_KEY_ENCRYPTION_KEY is required to store user API keys. Generate with: openssl rand -base64 32"
    );
  }

  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `API_KEY_ENCRYPTION_KEY must be 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`
    );
  }
  return key;
}

/**
 * Returns true if the encryption key is configured.
 */
export function isEncryptionConfigured(): boolean {
  return !!process.env.API_KEY_ENCRYPTION_KEY;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * Throws if API_KEY_ENCRYPTION_KEY is not configured.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack as: iv + ciphertext + authTag
  const packed = Buffer.concat([iv, ciphertext, authTag]);
  return packed.toString("base64");
}

/**
 * Decrypts a value that was encrypted with {@link encryptApiKey}.
 *
 * Throws if API_KEY_ENCRYPTION_KEY is not configured or if decryption fails.
 */
export function decryptApiKey(encrypted: string): string {
  const key = getEncryptionKey();

  const packed = Buffer.from(encrypted, "base64");

  // Minimum length: IV (12) + at least 1 byte ciphertext + authTag (16) = 29
  if (packed.length < IV_LENGTH + 1 + AUTH_TAG_LENGTH) {
    throw new Error("Encrypted value is too short to be valid");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
