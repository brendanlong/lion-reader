/**
 * Google OAuth Callback Route
 *
 * Google OAuth uses standard redirect with query parameters.
 * This route handles the browser redirect from Google after authentication.
 *
 * This route handles three modes (stored in Redis with PKCE data):
 * - "login": Normal OAuth login/signup flow
 * - "link": Linking Google to existing account (from settings)
 * - "save": Incremental authorization for Google Docs (from save page)
 *
 * For login mode:
 * 1. Creates or links user account
 * 2. Creates a session and sets the session cookie
 * 3. Redirects to /all
 *
 * For link/save modes:
 * 1. Updates the existing OAuth account with new tokens/scopes
 * 2. Redirects to appropriate page (no new session needed - user already logged in)
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { validateGoogleCallback, isGoogleOAuthEnabled } from "@/server/auth/oauth/google";
import { generateSessionToken, getSessionExpiry, processOAuthCallback } from "@/server/auth";
import { generateUuidv7 } from "@/lib/uuidv7";
import { db } from "@/server/db";
import { sessions, oauthAccounts } from "@/server/db/schema";

/**
 * Handle Google OAuth redirect callback
 *
 * Google sends:
 * - code: authorization code
 * - state: CSRF protection state
 */
export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  try {
    // Check if Google OAuth is enabled
    if (!isGoogleOAuthEnabled()) {
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
    let googleResult;
    try {
      googleResult = await validateGoogleCallback(code, state);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Invalid or expired OAuth state")) {
          return NextResponse.redirect(`${appUrl}/login?error=invalid_state`);
        }
      }
      console.error("Google OAuth callback validation failed:", error);
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    const { userInfo, tokens, scopes, mode, returnUrl } = googleResult;
    const now = new Date();

    // Handle save/link/extension-save modes - user is already logged in, just update OAuth account
    if (mode === "save" || mode === "link" || mode === "extension-save") {
      // Find existing OAuth account for this Google user
      const existingOAuthAccount = await db
        .select({ id: oauthAccounts.id, userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "google"),
            eq(oauthAccounts.providerAccountId, userInfo.sub)
          )
        )
        .limit(1);

      if (existingOAuthAccount.length === 0) {
        // This shouldn't happen for save/extension-save mode (user must have Google linked)
        // For link mode, this is also unexpected since we check before starting the flow
        console.error("OAuth account not found for save/link/extension-save mode");
        let errorRedirect: string;
        if (mode === "extension-save" && returnUrl) {
          // Add error to the return URL
          const url = new URL(returnUrl, appUrl);
          url.searchParams.set("error", "callback_failed");
          errorRedirect = url.pathname + url.search;
        } else if (mode === "save") {
          errorRedirect = "/save?error=callback_failed";
        } else {
          errorRedirect = "/settings?link_error=callback_failed";
        }
        return NextResponse.redirect(`${appUrl}${errorRedirect}`);
      }

      // Update OAuth account with new tokens and scopes
      await db
        .update(oauthAccounts)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          scopes,
        })
        .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));

      // Redirect based on mode (no session cookie needed - user already logged in)
      if (mode === "extension-save" && returnUrl) {
        // Redirect back to the extension save page with the original URL
        return NextResponse.redirect(`${appUrl}${returnUrl}`);
      } else if (mode === "save") {
        return NextResponse.redirect(`${appUrl}/save`);
      } else {
        return NextResponse.redirect(`${appUrl}/settings?linked=google`);
      }
    }

    // Login mode - normal OAuth login/signup flow
    // Process OAuth callback - handles existing accounts, linking, and new user creation
    // Note: inviteToken is passed through from Redis PKCE data
    const oauthResult = await processOAuthCallback({
      provider: "google",
      providerAccountId: userInfo.sub,
      email: userInfo.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes,
      inviteToken: googleResult.inviteToken,
    });

    // Create session
    const sessionId = generateUuidv7();
    const { token, tokenHash } = generateSessionToken();
    const expiresAt = getSessionExpiry();

    // Get client info from headers
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      request.headers.get("x-real-ip") ??
      undefined;

    await db.insert(sessions).values({
      id: sessionId,
      userId: oauthResult.userId,
      tokenHash,
      userAgent,
      ipAddress,
      expiresAt,
      createdAt: now,
      lastActiveAt: now,
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
    console.error("Google OAuth callback error:", error);

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
