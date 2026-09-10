/**
 * OAuth Callback Helpers
 *
 * Shared utilities for OAuth callback routes to reduce duplication across providers.
 * These helpers handle common tasks like:
 * - Extracting client info from requests
 * - Handling invite-related errors
 * - Creating sessions and setting cookies
 * - Linking a provider to the signed-in account (`mode: "link"`)
 */

import { NextRequest, NextResponse } from "next/server";
import { createSession, validateSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { extractClientInfo } from "@/server/http/client-ip";
import { clearOAuthStateCookie } from "@/server/auth/oauth/state-cookie";
import { linkOAuthAccount } from "@/server/services/oauth-accounts";
import type { OAuthProviderName } from "@/server/auth/oauth/config";

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
 * The provider identity a `mode: "link"` callback just verified.
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
 * Attach the provider account to the user the **session cookie** identifies, and
 * redirect back to settings.
 *
 * Identifying the account by session rather than by the provider's email is the
 * whole point of `mode: "link"` (#1603): the two addresses need not match, and a
 * mismatch must never be resolved by signing the visitor into some other account.
 * That also makes an unauthenticated visitor an error rather than a sign-in.
 */
export async function createLinkResponse(
  request: NextRequest,
  appUrl: string,
  params: OAuthLinkParams,
  options?: { redirectStatus?: number }
): Promise<NextResponse> {
  const { provider, ...link } = params;
  const redirectStatus = options?.redirectStatus;

  const redirect = (path: string) => {
    const response = NextResponse.redirect(`${appUrl}${path}`, redirectStatus);
    clearOAuthStateCookie(response);
    return response;
  };

  const sessionToken = request.cookies.get("session")?.value;
  const session = sessionToken ? await validateSession(sessionToken) : null;

  if (!session) {
    return redirect("/login?error=link_requires_login");
  }

  try {
    await linkOAuthAccount(db, {
      userId: session.user.id,
      currentSessionId: session.session.id,
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
