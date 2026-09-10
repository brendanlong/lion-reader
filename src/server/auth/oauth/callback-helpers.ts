/**
 * OAuth Callback Helpers
 *
 * Shared utilities for OAuth callback routes to reduce duplication across providers.
 * These helpers handle common tasks like:
 * - Extracting client info from requests
 * - Handling invite-related errors
 * - Creating sessions and setting cookies
 * - Linking a provider to the account its flow was started from
 */

import { NextRequest, NextResponse } from "next/server";
import { createSession, isSessionActive } from "@/server/auth/session";
import { db } from "@/server/db";
import { extractClientInfo } from "@/server/http/client-ip";
import { clearOAuthStateCookie } from "@/server/auth/oauth/state-cookie";
import { linkOAuthAccount } from "@/server/services/oauth-accounts";
import type { OAuthLinkTarget, OAuthProviderName } from "@/server/auth/oauth/config";

// ============================================================================
// Types
// ============================================================================

/**
 * Error codes from processOAuthCallback that should redirect to login with an error.
 * Includes invite errors and signup provider restriction errors.
 */
type SignupErrorCode =
  | "INVITE_REQUIRED"
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_ALREADY_USED"
  | "SIGNUP_PROVIDER_NOT_ALLOWED";

/**
 * Map of signup error codes to URL error parameters
 */
const SIGNUP_ERROR_MAP: Record<SignupErrorCode, string> = {
  INVITE_REQUIRED: "invite_required",
  INVITE_INVALID: "invite_invalid",
  INVITE_EXPIRED: "invite_expired",
  INVITE_ALREADY_USED: "invite_already_used",
  SIGNUP_PROVIDER_NOT_ALLOWED: "signup_provider_not_allowed",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts the error code from an error's cause, if present.
 * Used to detect signup-related errors from processOAuthCallback.
 *
 * @param error - The error to extract the code from
 * @returns The error code, or undefined if not found
 */
function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && "cause" in error) {
    const cause = error.cause as { code?: string } | undefined;
    return cause?.code;
  }
  return undefined;
}

/**
 * Checks if an error is a signup-related error (invite or provider restriction)
 * and returns the appropriate redirect.
 * Returns null if the error is not a recognized signup error.
 *
 * @param error - The error to check
 * @param appUrl - The base app URL for redirects
 * @param redirectStatus - HTTP status for redirect (default 302, use 303 for POST->GET)
 * @returns A redirect response if signup error, null otherwise
 */
export function handleSignupError(
  error: unknown,
  appUrl: string,
  redirectStatus?: number
): NextResponse | null {
  const errorCode = getErrorCode(error);

  if (errorCode && errorCode in SIGNUP_ERROR_MAP) {
    const urlError = SIGNUP_ERROR_MAP[errorCode as SignupErrorCode];
    return NextResponse.redirect(`${appUrl}/login?error=${urlError}`, redirectStatus);
  }

  return null;
}

/**
 * Creates a session for the user and returns a redirect response with the session cookie.
 * Used after successful OAuth authentication.
 *
 * @param userId - The authenticated user's ID
 * @param request - The incoming request (for client info extraction)
 * @param appUrl - The base app URL for redirects
 * @param options - Optional configuration
 * @param options.redirectStatus - HTTP status for redirect (default 302, use 303 for POST->GET)
 * @param options.isNewUser - Whether this is a new user (redirects to complete-signup)
 * @returns A redirect response with the session cookie set
 */
export async function createSessionResponse(
  userId: string,
  request: NextRequest,
  appUrl: string,
  options?: { redirectStatus?: number; isNewUser?: boolean }
): Promise<NextResponse> {
  const { userAgent, ipAddress } = extractClientInfo(request.headers);

  // Create session
  const { token } = await createSession(db, {
    userId,
    userAgent,
    ipAddress,
  });

  // New users need to complete signup confirmation first
  const redirectTo = options?.isNewUser ? "/complete-signup" : "/all";

  // Redirect through OAuth completion page to broadcast success for PWAs
  const response = NextResponse.redirect(
    `${appUrl}/auth/oauth/complete?redirect=${encodeURIComponent(redirectTo)}`,
    options?.redirectStatus
  );

  // Set session cookie (30 days). The token is `httpOnly` so it is never exposed
  // to JS (issue #1088); `secure` in production. See "Session Cookie" in
  // src/server/auth/CLAUDE.md.
  response.cookies.set("session", token, {
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });

  // The one-time state binding cookie has served its purpose (issue #1263).
  clearOAuthStateCookie(response);

  return response;
}

/**
 * Creates an error redirect response for OAuth callback failures.
 *
 * @param appUrl - The base app URL for redirects
 * @param errorParam - The error parameter to add to the URL (default: "callback_failed")
 * @param redirectStatus - HTTP status for redirect (default 302, use 303 for POST->GET)
 * @returns A redirect response to the login page with the error parameter
 */
export function createErrorRedirect(
  appUrl: string,
  errorParam: string = "callback_failed",
  redirectStatus?: number
): NextResponse {
  const response = NextResponse.redirect(`${appUrl}/login?error=${errorParam}`, redirectStatus);
  // Clear any state binding cookie so a failed attempt leaves nothing behind (#1263).
  clearOAuthStateCookie(response);
  return response;
}

// ============================================================================
// Linking a provider to the signed-in account
// ============================================================================

/**
 * The provider identity a link callback just verified.
 */
export interface OAuthLinkParams {
  provider: OAuthProviderName;
  /** The provider's stable id for the account (`sub` / Discord user id). */
  providerAccountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  /** Granted scopes, where the provider reports them (Google). */
  scopes?: string[];
}

/**
 * Which `?link_error=` the settings page should show. `linkOAuthAccount` is the
 * only thing that raises these, so each code has exactly one meaning here.
 */
function linkErrorParam(error: unknown): string {
  switch (getErrorCode(error)) {
    case "OAUTH_ALREADY_LINKED":
      return "provider_already_linked";
    case "OAUTH_CALLBACK_FAILED":
      return "already_linked";
    case "SESSION_REVOKE_FAILED":
      return "session_revoke_failed";
    default:
      return "callback_failed";
  }
}

/**
 * Attach the provider account to the `target` its authorization URL was minted
 * for, and redirect back to settings (`OAuthLinkTarget` says why the account
 * comes from there rather than from the request).
 *
 * The target's session must still be live: adding a way to sign in is a
 * credential change, so a flow whose session was logged out or revoked in the
 * meantime is refused rather than applied.
 */
export async function createLinkResponse(
  appUrl: string,
  target: OAuthLinkTarget,
  params: OAuthLinkParams,
  options?: { redirectStatus?: number }
): Promise<NextResponse> {
  const { provider, ...link } = params;

  const redirect = (path: string) => {
    const response = NextResponse.redirect(`${appUrl}${path}`, options?.redirectStatus);
    clearOAuthStateCookie(response);
    return response;
  };

  if (!(await isSessionActive(target.sessionId))) {
    return redirect("/login?error=link_requires_login");
  }

  try {
    await linkOAuthAccount(db, {
      userId: target.userId,
      currentSessionId: target.sessionId,
      provider,
      ...link,
    });
  } catch (error) {
    const errorParam = linkErrorParam(error);
    if (errorParam === "callback_failed") {
      console.error(`Failed to link ${provider} account:`, error);
    }
    if (errorParam === "session_revoke_failed") {
      // The link itself landed; only signing the other devices out failed.
      return redirect(`/settings?linked=${provider}&link_error=${errorParam}`);
    }
    return redirect(`/settings?link_error=${errorParam}`);
  }

  return redirect(`/settings?linked=${provider}`);
}
