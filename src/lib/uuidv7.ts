import { randomBytes } from "crypto";

/**
 * Generates a UUIDv7 as specified in RFC 9562.
 *
 * UUIDv7 provides:
 * - Global uniqueness without coordination
 * - Time-ordered (roughly chronological, good for pagination)
 * - Better B-tree index performance than UUIDv4 (sequential inserts)
 * - Extractable timestamp if needed
 *
 * Format (128 bits total):
 * - 48 bits: Unix timestamp in milliseconds
 * - 4 bits: version (0111 = 7)
 * - 12 bits: random
 * - 2 bits: variant (10)
 * - 62 bits: random
 */
export function generateUuidv7(): string {
  const timestamp = Date.now();

  // Get 16 random bytes
  const bytes = randomBytes(16);

  // Set the timestamp (first 48 bits / 6 bytes)
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Set version to 7 (high nibble of byte 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Set variant to 10xx (high 2 bits of byte 8)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to UUID string format
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Validates that a string is a valid UUID format.
 */
export function isValidUuid(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
