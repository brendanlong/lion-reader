/**
 * Google OAuth Callback Route
 *
 * Google OAuth uses standard redirect with query parameters.
 * This route handles the browser redirect from Google after authentication.
 *
 * This route handles the modes stored in Redis with the PKCE data:
 * - "login": Normal OAuth login/signup flow — creates or links the user account,
 *   creates a session and sets the session cookie.
 * - "link": the settings page's "Link" button — attaches this Google account to
 *   whoever the session cookie says is signed in.
 * - "save" / "extension-save": incremental authorization for Google Docs. The
 *   user is already logged in, so these only refresh the existing OAuth account's
 *   tokens and scopes — no new session.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { validateGoogleCallback, isGoogleOAuthEnabled } from "@/server/auth/oauth/google";
import { processOAuthCallback } from "@/server/auth/oauth/callback";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import {
  createSessionResponse,
  createErrorRedirect,
  createLinkResponse,
  handleSignupError,
} from "@/server/auth/oauth/callback-helpers";
import {
  readOAuthStateCookie,
  oauthStateCookieMatches,
  clearOAuthStateCookie,
} from "@/server/auth/oauth/state-cookie";

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
      return createErrorRedirect(appUrl, "provider_not_configured");
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const state = searchParams.get("state");

    // Validate required fields
    if (!code || !state) {
      return createErrorRedirect(appUrl);
    }

    // Validate the OAuth callback
    let googleResult;
    try {
      googleResult = await validateGoogleCallback(code, state);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid or expired OAuth state")) {
        return createErrorRedirect(appUrl, "invalid_state");
      }
      console.error("Google OAuth callback validation failed:", error);
      return createErrorRedirect(appUrl);
    }

    const { userInfo, tokens, scopes, mode, returnUrl } = googleResult;

    // Bind the callback to the browser that started the flow (login CSRF, issue #1263):
    // the state cookie set when the auth URL was generated must match the returned state.
    // `extension-save` is exempt because its auth URL is generated in a Server Component
    // (src/app/extension/save/page.tsx), which Next.js forbids from setting cookies — that
    // flow re-authorizes an already-logged-in user's own account rather than logging anyone
    // in, so it isn't the login-CSRF vector. Every other mode is generated on the tRPC path
    // (via setOAuthStateCookie) and is enforced. The `mode` is known only after the Redis
    // state is consumed above, so this check necessarily runs post-validation.
    if (
      mode !== "extension-save" &&
      !oauthStateCookieMatches(readOAuthStateCookie(request), state)
    ) {
      return createErrorRedirect(appUrl, "invalid_state");
    }

    // Settings "Link" — the account comes from the session, not from this
    // Google account's email (#1603)
    if (mode === "link") {
      return createLinkResponse(request, appUrl, {
        provider: "google",
        providerAccountId: userInfo.sub,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes,
      });
    }

    // Incremental authorization - user is already logged in, just update OAuth account
    if (mode === "save" || mode === "extension-save") {
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
        // Shouldn't happen: both modes require the user to have Google linked.
        console.error("OAuth account not found for save/extension-save mode");
        let errorRedirect: string;
        if (mode === "extension-save" && returnUrl) {
          // Add error to the return URL
          const url = new URL(returnUrl, appUrl);
          url.searchParams.set("error", "callback_failed");
          errorRedirect = url.pathname + url.search;
        } else {
          errorRedirect = "/save?error=callback_failed";
        }
        const response = NextResponse.redirect(`${appUrl}${errorRedirect}`);
        clearOAuthStateCookie(response);
        return response;
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
      const response =
        mode === "extension-save" && returnUrl
          ? // Redirect back to the extension save page with the original URL
            NextResponse.redirect(`${appUrl}${returnUrl}`)
          : NextResponse.redirect(`${appUrl}/save`);
      // Clear the one-time state binding cookie (issue #1263).
      clearOAuthStateCookie(response);
      return response;
    }

    // Login mode - normal OAuth login/signup flow
    // Process OAuth callback - handles existing accounts, linking, and new user creation
    // Note: inviteToken is passed through from Redis PKCE data
    const oauthResult = await processOAuthCallback({
      provider: "google",
      providerAccountId: userInfo.sub,
      email: userInfo.email,
      emailVerified: userInfo.email_verified === true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes,
      inviteToken: googleResult.inviteToken,
    });

    return createSessionResponse(oauthResult.userId, request, appUrl, {
      isNewUser: oauthResult.isNewUser,
    });
  } catch (error) {
    console.error("Google OAuth callback error:", error);

    // Check for invite-related errors
    const inviteErrorResponse = handleSignupError(error, appUrl);
    if (inviteErrorResponse) {
      return inviteErrorResponse;
    }

    return createErrorRedirect(appUrl);
  }
}
