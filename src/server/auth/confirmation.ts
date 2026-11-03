/**
 * Signup confirmation check
 *
 * A user has completed signup confirmation once they have verified their email
 * address, agreed to the Terms of Service and Privacy Policy and — on
 * EU-restricted instances — certified they are not in the EU. The tRPC surface enforces this via
 * `confirmedMiddleware`; every other credential surface that mints its own
 * tokens (MCP, Wallabag, Google Reader), and the Discord bot, must apply the
 * same gate so those surfaces can't be used to bypass confirmation.
 */

import type { User } from "@/server/db/schema";
import { signupConfig } from "@/server/config/env";

/** The user fields confirmation depends on. */
export type ConfirmationFields = Pick<
  User,
  "emailVerifiedAt" | "tosAgreedAt" | "privacyPolicyAgreedAt" | "notEuAgreedAt"
>;

/**
 * Returns true if the user has completed the signup confirmation flow (verified
 * email, ToS, Privacy Policy, and — only when `EU_RESTRICTED` is set — the
 * not-in-the-EU certification). This is the single source of truth for confirmation; the
 * layouts, `confirmedMiddleware`, and `isConfirmed` all delegate here so the
 * EU gate stays consistent everywhere.
 */
export function isSignupConfirmed(user: ConfirmationFields): boolean {
  const euConfirmed = !signupConfig.euRestricted || !!user.notEuAgreedAt;
  return !!(user.emailVerifiedAt && user.tosAgreedAt && user.privacyPolicyAgreedAt && euConfirmed);
}

/**
 * Where a *validated* session belongs when it lands on a public/entry surface
 * (`/`, `/login`, `/register`): the app for a confirmed user, the confirmation
 * flow otherwise. Single source of truth for the proxy redirect
 * (`maybeSessionRedirect` in `src/proxy.ts`) and the server-side fallback
 * (`(spa)/page.tsx`) so they can't drift.
 */
export function sessionHomePath(user: ConfirmationFields): "/all" | "/complete-signup" {
  return isSignupConfirmed(user) ? "/all" : "/complete-signup";
}
