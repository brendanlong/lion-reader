/**
 * Discord OAuth Callback Route
 *
 * Discord OAuth uses standard redirect with query parameters.
 * This route handles the browser redirect from Discord after authentication.
 *
 * Flow:
 * 1. Creates or links user account
 * 2. Creates a session and sets the session cookie
 * 3. Redirects to /all
 */

import { NextRequest, NextResponse } from "next/server";
import { validateDiscordCallback, isDiscordOAuthEnabled } from "@/server/auth/oauth/discord";
import { createSession, processOAuthCallback } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Handle Discord OAuth redirect callback
 *
 * Discord sends:
 * - code: authorization code
 * - state: CSRF protection state
 */
export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    // Check if Discord OAuth is enabled
    if (!isDiscordOAuthEnabled()) {
      return NextResponse.redirect(`${appUrl}/login?error=provider_not_configured`);
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    // Validate required fields
    if (!code) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    if (!state) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    // Validate the OAuth callback
    let discordResult;
    try {
      discordResult = await validateDiscordCallback(code, state);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Invalid or expired OAuth state")) {
          return NextResponse.redirect(`${appUrl}/login?error=invalid_state`);
        }
      }
      console.error("Discord OAuth callback validation failed:", error);
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    const { userInfo, tokens, inviteToken } = discordResult;

    // Process OAuth callback - handles existing accounts, linking, and new user creation
    const oauthResult = await processOAuthCallback({
      provider: "discord",
      providerAccountId: userInfo.id,
      email: userInfo.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      inviteToken,
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

    // Redirect through OAuth completion page to broadcast success for PWAs
    const response = NextResponse.redirect(`${appUrl}/auth/oauth/complete?redirect=/all`);

    // Set session cookie (30 days)
    response.cookies.set("session", token, {
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
      sameSite: "lax",
      httpOnly: false, // Allow JS access for client-side session management
    });

    return response;
  } catch (error) {
    console.error("Discord OAuth callback error:", error);

    // Check for invite-related errors and provide specific error codes
    const cause =
      error instanceof Error && "cause" in error ? (error.cause as { code?: string }) : null;
    const errorCode = cause?.code;

    if (errorCode === "INVITE_REQUIRED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_required`);
    }
    if (errorCode === "INVITE_INVALID") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_invalid`);
    }
    if (errorCode === "INVITE_EXPIRED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_expired`);
    }
    if (errorCode === "INVITE_ALREADY_USED") {
      return NextResponse.redirect(`${appUrl}/login?error=invite_already_used`);
    }

    return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
  }
}
