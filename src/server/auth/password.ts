/**
 * Password verification with constant-timing.
 *
 * All three password-accepting surfaces (tRPC `auth.login`, Google Reader
 * `ClientLogin`, and the Wallabag password grant) must not leak — via response
 * latency — whether an email maps to an existing, password-having account.
 * Returning early for a missing user or a passwordless (OAuth-only) user skips
 * the argon2 verify, making a valid email measurably slower and giving an
 * attacker a user-enumeration timing oracle (#1267).
 *
 * `verifyPassword` closes that gap: when the stored hash is absent it runs a
 * dummy `argon2.verify` against a constant decoy hash so every path pays the
 * same argon2 cost, then returns false. The response body/status are already
 * identical across cases, so this removes the only remaining side channel.
 */

import * as argon2 from "argon2";
import { eq } from "drizzle-orm";
import type { Database } from "@/server/db";
import { users, type User } from "@/server/db/schema";

/**
 * A constant, valid argon2id hash generated with the library's default
 * parameters (the same ones `argon2.hash` uses when we store passwords). It
 * exists only to give the failure paths something real to verify against so
 * their timing matches a genuine password check. It is not a hash of any known
 * password and is never a valid credential.
 */
const DECOY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$55sNRJVjeRFos8fTiP7RKg$nwoaceza55GphfhJ/X6mdLeyS7PSy33AYPvj8fhIBu8";

/**
 * Verifies a password against a stored argon2 hash in constant time relative to
 * whether the user exists / has a password.
 *
 * Pass the stored hash (or `null`/`undefined` when the user was not found or is
 * OAuth-only). When the hash is absent, a dummy verify runs against
 * {@link DECOY_HASH} so the argon2 cost is always paid, and the function returns
 * false. Callers must still treat every falsey result as the same generic
 * "invalid credentials" outcome.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string
): Promise<boolean> {
  if (!storedHash) {
    // Equalize timing: run argon2 against the decoy so a missing/passwordless
    // user isn't measurably faster than a real password check (#1267).
    await argon2.verify(DECOY_HASH, password);
    return false;
  }

  return argon2.verify(storedHash, password);
}

/**
 * Looks up a user by email and verifies their password — the lookup every
 * password-accepting surface shares. Runs exactly one argon2 verify whether the
 * user is missing, passwordless, or real. On failure `user` is whatever the
 * lookup found, for callers that log why; the caller's response must not vary
 * with it.
 */
export async function verifyEmailPassword(
  db: Database,
  email: string,
  password: string
): Promise<{ valid: true; user: User } | { valid: false; user: User | undefined }> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const valid = await verifyPassword(user?.passwordHash, password);
  return valid && user ? { valid: true, user } : { valid: false, user };
}
