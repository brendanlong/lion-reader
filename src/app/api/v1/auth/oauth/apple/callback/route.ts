/**
 * Apple OAuth Callback Route
 *
 * Apple Sign in with Apple uses response_mode=form_post, which means Apple
 * POSTs the callback data (code, state, user) to this endpoint using
 * application/x-www-form-urlencoded format.
 *
 * This route:
 * 1. Receives the POST from Apple
 * 2. Validates the OAuth callback using our auth functions
 * 3. Creates a session and sets the session cookie
 * 4. Redirects to the app
 *
 * Note: This is NOT the tRPC endpoint - this handles the browser redirect from Apple
 */

import { NextRequest, NextResponse } from "next/server";
import { validateAppleCallback, isAppleOAuthEnabled } from "@/server/auth/oauth/apple";
import { createSession, processOAuthCallback } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Handle Apple OAuth form_post callback
 *
 * Apple sends:
 * - code: authorization code
 * - state: CSRF protection state
 * - user: JSON string with name and email (only on first auth)
 * - id_token: JWT token (we use this from validateAppleCallback)
 */
export async function POST(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    // Check if Apple OAuth is enabled
    if (!isAppleOAuthEnabled()) {
      // Use 303 to convert POST to GET for the redirect
      return NextResponse.redirect(`${appUrl}/login?error=provider_not_configured`, 303);
    }

    // Parse the form data
    const formData = await request.formData();
    const code = formData.get("code") as string | null;
    const state = formData.get("state") as string | null;
    const userDataRaw = formData.get("user") as string | null;

    // Validate required fields
    if (!code) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`, 303);
    }

    if (!state) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`, 303);
    }

    // Parse user data if provided (only on first auth)
    let userData: { name?: { firstName?: string; lastName?: string }; email?: string } | undefined;
    if (userDataRaw) {
      try {
        userData = JSON.parse(userDataRaw);
      } catch {
        // Invalid JSON, continue without user data
      }
    }

    // Validate the OAuth callback
    let appleResult;
    try {
      appleResult = await validateAppleCallback(code, state, userData);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Invalid or expired OAuth state")) {
          return NextResponse.redirect(`${appUrl}/login?error=invalid_state`, 303);
        }
      }
      console.error("Apple OAuth callback validation failed:", error);
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`, 303);
    }

    const { userInfo, firstAuthData, tokens } = appleResult;

    // Get email from JWT or first-auth data
    // Apple only sends email on first auth, but we can look up returning users by providerAccountId
    const email = userInfo.email ?? firstAuthData?.email;

    // Process OAuth callback - handles existing accounts, linking, and new user creation
    // Note: inviteToken is passed through from Redis state data
    const oauthResult = await processOAuthCallback({
      provider: "apple",
      providerAccountId: userInfo.sub,
      email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      inviteToken: appleResult.inviteToken,
    });

    // Get client info from headers
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      request.headers.get("x-real-ip") ??
      undefined;

    // Create session
    const { token } = await createSession(db, {
      userId: oauthResult.userId,
      userAgent,
      ipAddress,
    });

    // Redirect to app with session cookie
    // Use 303 to convert POST to GET for the redirect
    const response = NextResponse.redirect(`${appUrl}/all`, 303);

    // Set session cookie (30 days)
    response.cookies.set("session", token, {
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
      sameSite: "lax",
      httpOnly: false, // Allow JS access for client-side session management
    });

    return response;
  } catch (error) {
    console.error("Apple OAuth callback error:", error);

    // Check for invite-related errors and provide specific error codes
    const cause =
      error instanceof Error && "cause" in error ? (error.cause as { code?: string }) : null;
    const errorCode = cause?.code;

    // Use 303 to convert POST to GET for all redirects
    if (errorCode === "INVITE_REQUIRED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_required`, 303);
    }
    if (errorCode === "INVITE_INVALID") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_invalid`, 303);
    }
    if (errorCode === "INVITE_EXPIRED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_expired`, 303);
    }
    if (errorCode === "INVITE_ALREADY_USED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_already_used`, 303);
    }

    return NextResponse.redirect(`${appUrl}/login?error=callback_failed`, 303);
  }
}
