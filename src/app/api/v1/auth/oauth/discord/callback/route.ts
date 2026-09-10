/**
 * Discord OAuth Callback Route
 *
 * Discord OAuth uses standard redirect with query parameters.
 * This route handles the browser redirect from Discord after authentication. A
 * link flow attaches this Discord account to the account that started it (see
 * `OAuthLinkTarget`) and returns to settings; otherwise it creates or signs in
 * the account matching the Discord email, sets the session cookie and redirects
 * to /all.
 */

import { NextRequest } from "next/server";
import { validateDiscordCallback, isDiscordOAuthEnabled } from "@/server/auth/oauth/discord";
import { processOAuthCallback } from "@/server/auth/oauth/callback";
import {
  createSessionResponse,
  createErrorRedirect,
  createLinkResponse,
  handleSignupError,
} from "@/server/auth/oauth/callback-helpers";
import { readOAuthStateCookie, oauthStateCookieMatches } from "@/server/auth/oauth/state-cookie";

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

    // Bind the callback to the browser that started the flow (login CSRF, issue #1263):
    // the state cookie set when the auth URL was generated must match the returned state.
    if (!oauthStateCookieMatches(readOAuthStateCookie(request), state)) {
      return createErrorRedirect(appUrl, "invalid_state");
    }

    // Validate the OAuth callback
    let discordResult;
    try {
      discordResult = await validateDiscordCallback(code, state);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid or expired OAuth state")) {
        return createErrorRedirect(appUrl, "invalid_state");
      }
      console.error("Discord OAuth callback validation failed:", error);
      return createErrorRedirect(appUrl);
    }

    const { userInfo, tokens, inviteToken, link } = discordResult;

    // Settings "Link" — the account comes from the flow, not from this Discord
    // account's email (#1603)
    if (link) {
      return createLinkResponse(appUrl, link, {
        provider: "discord",
        providerAccountId: userInfo.id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      });
    }

    // Process OAuth callback - handles existing accounts, linking, and new user creation
    const oauthResult = await processOAuthCallback({
      provider: "discord",
      providerAccountId: userInfo.id,
      email: userInfo.email,
      emailVerified: userInfo.verified === true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      inviteToken,
    });

    return createSessionResponse(oauthResult.userId, request, appUrl, {
      isNewUser: oauthResult.isNewUser,
    });
  } catch (error) {
    console.error("Discord OAuth callback error:", error);

    // Check for invite-related errors
    const inviteErrorResponse = handleSignupError(error, appUrl);
    if (inviteErrorResponse) {
      return inviteErrorResponse;
    }

    return createErrorRedirect(appUrl);
  }
}
