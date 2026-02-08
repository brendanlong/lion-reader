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

import { NextRequest } from "next/server";
import { validateDiscordCallback, isDiscordOAuthEnabled } from "@/server/auth/oauth/discord";
import { processOAuthCallback } from "@/server/auth/oauth/callback";
import {
  createSessionResponse,
  createErrorRedirect,
  handleInviteError,
} from "@/server/auth/oauth/callback-helpers";

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

    return createSessionResponse(oauthResult.userId, request, appUrl);
  } catch (error) {
    console.error("Discord OAuth callback error:", error);

    // Check for invite-related errors
    const inviteErrorResponse = handleInviteError(error, appUrl);
    if (inviteErrorResponse) {
      return inviteErrorResponse;
    }

    return createErrorRedirect(appUrl);
  }
}
