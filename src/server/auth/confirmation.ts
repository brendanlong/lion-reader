/**
 * Signup confirmation check
 *
 * A user has completed signup confirmation once they have agreed to the Terms
 * of Service and Privacy Policy and answered the EU residency question. The
 * tRPC surface enforces this via `confirmedMiddleware`; every other credential
 * surface that mints its own tokens (MCP, Wallabag, Google Reader) must apply
 * the same gate so those APIs can't be used to bypass confirmation.
 */

import type { User } from "@/server/db/schema";

/**
 * Returns true if the user has completed the signup confirmation flow (ToS,
 * Privacy Policy, EU check). Mirrors `confirmedMiddleware` in
 * `src/server/trpc/trpc.ts` — keep the two in sync.
 */
export function isSignupConfirmed(
  user: Pick<User, "tosAgreedAt" | "privacyPolicyAgreedAt" | "notEuAgreedAt">
): boolean {
  return !!(user.tosAgreedAt && user.privacyPolicyAgreedAt && user.notEuAgreedAt);
}
