/**
 * Signup confirmation check
 *
 * A user has completed signup confirmation once they have agreed to the Terms
 * of Service and Privacy Policy and — on EU-restricted instances — certified
 * they are not in the EU. The tRPC surface enforces this via
 * `confirmedMiddleware`; every other credential surface that mints its own
 * tokens (MCP, Wallabag, Google Reader) must apply the same gate so those APIs
 * can't be used to bypass confirmation.
 */

import type { User } from "@/server/db/schema";
import { signupConfig } from "@/server/config/env";

/**
 * Returns true if the user has completed the signup confirmation flow (ToS,
 * Privacy Policy, and — only when `EU_RESTRICTED` is set — the not-in-the-EU
 * certification). This is the single source of truth for confirmation; the
 * layouts, `confirmedMiddleware`, and `isConfirmed` all delegate here so the
 * EU gate stays consistent everywhere.
 */
export function isSignupConfirmed(
  user: Pick<User, "tosAgreedAt" | "privacyPolicyAgreedAt" | "notEuAgreedAt">
): boolean {
  const euConfirmed = !signupConfig.euRestricted || !!user.notEuAgreedAt;
  return !!(user.tosAgreedAt && user.privacyPolicyAgreedAt && euConfirmed);
}
