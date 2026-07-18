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

/**
 * Where a *validated* session belongs when it lands on a public/entry surface
 * (`/`, `/login`, `/register`, the OAuth transition pages): the app for a
 * confirmed user, the confirmation flow otherwise. Single source of truth for
 * the proxy redirect (`maybeSessionRedirect` in `src/proxy.ts`) and the
 * server-side fallbacks (`(spa)/page.tsx`, `(spa)/auth/layout.tsx`) so they
 * can't drift.
 */
export function sessionHomePath(
  user: Pick<User, "tosAgreedAt" | "privacyPolicyAgreedAt" | "notEuAgreedAt">
): "/all" | "/complete-signup" {
  return isSignupConfirmed(user) ? "/all" : "/complete-signup";
}
