/**
 * Signup provider access resolution.
 *
 * Pure logic for deciding whether a given signup provider is allowed publicly,
 * only with a valid invite, or not at all. Shared by the signup service (which
 * enforces it) and the signupConfig endpoint (which describes it to the UI).
 */

import type { SignupProvider } from "@/server/config/env";

export type SignupProviderAccess =
  /** Provider can sign up without an invite. */
  | "public"
  /** Provider can sign up, but only with a valid invite. */
  | "invite-only"
  /** Provider cannot sign up at all. */
  | "denied";

export interface SignupProviderLists {
  /** Providers allowed with a valid invite (master allowlist). */
  allowedSignupProviders: readonly SignupProvider[];
  /** Providers allowed without an invite (subset of allowedSignupProviders). */
  publicSignupProviders: readonly SignupProvider[];
}

/**
 * Resolve how a provider may sign up given the configured provider lists.
 *
 * `publicSignupProviders` is assumed to already be a subset of
 * `allowedSignupProviders` (enforced at config-parse time), so a public
 * provider is implicitly allowed with an invite too.
 */
export function resolveSignupProviderAccess(
  provider: SignupProvider,
  lists: SignupProviderLists
): SignupProviderAccess {
  if (!lists.allowedSignupProviders.includes(provider)) {
    return "denied";
  }
  if (lists.publicSignupProviders.includes(provider)) {
    return "public";
  }
  return "invite-only";
}
