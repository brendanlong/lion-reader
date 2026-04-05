import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import { signupConfig } from "@/server/config/env";

export const ADMIN_COOKIE_NAME = "admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Creates a signed admin session token.
 * Format: `<nonce>.<timestamp>.<hmac>` where HMAC signs `<nonce>.<timestamp>`.
 */
export function createAdminSessionToken(): string {
  const secret = signupConfig.allowlistSecret;
  if (!secret) throw new Error("ALLOWLIST_SECRET not configured");

  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${nonce}.${timestamp}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Validates a signed admin session token.
 * Checks HMAC signature and TTL.
 */
export function validateAdminSessionToken(token: string): boolean {
  const secret = signupConfig.allowlistSecret;
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [nonce, timestampStr, signature] = parts;
  if (!nonce || !timestampStr || !signature) return false;

  // Verify HMAC using fixed-length hash comparison
  const payload = `${nonce}.${timestampStr}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const expectedHash = createHmac("sha256", "token-validate").update(expected).digest();
  const signatureHash = createHmac("sha256", "token-validate").update(signature).digest();

  if (!timingSafeEqual(expectedHash, signatureHash)) {
    return false;
  }

  // Check TTL (reject future timestamps and expired tokens)
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;
  return age >= 0 && age < ADMIN_SESSION_TTL_SECONDS;
}

/**
 * Validates the raw admin secret using timing-safe comparison.
 * Compares HMAC digests to ensure constant-length buffers regardless of input length.
 */
export function validateAdminSecret(input: string): boolean {
  const secret = signupConfig.allowlistSecret;
  if (!secret) return false;

  const inputHash = createHmac("sha256", "admin-validate").update(input).digest();
  const secretHash = createHmac("sha256", "admin-validate").update(secret).digest();
  return timingSafeEqual(inputHash, secretHash);
}
