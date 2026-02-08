/**
 * OAuth Callback Helpers
 *
 * Shared utilities for OAuth callback routes to reduce duplication across providers.
 * These helpers handle common tasks like:
 * - Extracting client info from requests
 * - Handling invite-related errors
 * - Creating sessions and setting cookies
 */

import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/server/auth";
import { db } from "@/server/db";

// ============================================================================
// Types
// ============================================================================

/**
 * Client information extracted from the request
 */
export interface ClientInfo {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Invite error codes that can be returned from processOAuthCallback
 */
type InviteErrorCode =
  | "INVITE_REQUIRED"
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_ALREADY_USED";

/**
 * Map of invite error codes to URL error parameters
 */
const INVITE_ERROR_MAP: Record<InviteErrorCode, string> = {
  INVITE_REQUIRED: "invite_required",
  INVITE_INVALID: "invite_invalid",
  INVITE_EXPIRED: "invite_expired",
  INVITE_ALREADY_USED: "invite_already_used",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts client information (user agent, IP address) from a request.
 * Used for session creation to track client details.
 *
 * @param request - The incoming request
 * @returns Client info object with userAgent and ipAddress
 */
function extractClientInfo(request: NextRequest): ClientInfo {
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    undefined;

  return { userAgent, ipAddress };
}

/**
 * Extracts the error code from an error's cause, if present.
 * Used to detect invite-related errors from processOAuthCallback.
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
 * Checks if an error is an invite-related error and returns the appropriate redirect.
 * Returns null if the error is not invite-related.
 *
 * @param error - The error to check
 * @param appUrl - The base app URL for redirects
 * @param redirectStatus - HTTP status for redirect (default 302, use 303 for POST->GET)
 * @returns A redirect response if invite error, null otherwise
 */
export function handleInviteError(
  error: unknown,
  appUrl: string,
  redirectStatus?: number
): NextResponse | null {
  const errorCode = getErrorCode(error);

  if (errorCode && errorCode in INVITE_ERROR_MAP) {
    const urlError = INVITE_ERROR_MAP[errorCode as InviteErrorCode];
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
 * @param redirectStatus - HTTP status for redirect (default 302, use 303 for POST->GET)
 * @returns A redirect response with the session cookie set
 */
export async function createSessionResponse(
  userId: string,
  request: NextRequest,
  appUrl: string,
  redirectStatus?: number
): Promise<NextResponse> {
  const { userAgent, ipAddress } = extractClientInfo(request);

  // Create session
  const { token } = await createSession(db, {
    userId,
    userAgent,
    ipAddress,
  });

  // Redirect through OAuth completion page to broadcast success for PWAs
  const response = NextResponse.redirect(
    `${appUrl}/auth/oauth/complete?redirect=/all`,
    redirectStatus
  );

  // Set session cookie (30 days)
  response.cookies.set("session", token, {
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: false, // Allow JS access for client-side session management
  });

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
  return NextResponse.redirect(`${appUrl}/login?error=${errorParam}`, redirectStatus);
}
