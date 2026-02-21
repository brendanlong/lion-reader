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

import { NextRequest } from "next/server";
import { validateAppleCallback, isAppleOAuthEnabled } from "@/server/auth/oauth/apple";
import { processOAuthCallback } from "@/server/auth/oauth/callback";
import {
  createSessionResponse,
  createErrorRedirect,
  handleSignupError,
} from "@/server/auth/oauth/callback-helpers";

// Apple uses POST with form_post response mode, so we need 303 status to convert POST to GET
const REDIRECT_STATUS = 303;

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
      return createErrorRedirect(appUrl, "provider_not_configured", REDIRECT_STATUS);
    }

    // Parse the form data
    const formData = await request.formData();
    const code = formData.get("code") as string | null;
    const state = formData.get("state") as string | null;
    const userDataRaw = formData.get("user") as string | null;

    // Validate required fields
    if (!code || !state) {
      return createErrorRedirect(appUrl, "callback_failed", REDIRECT_STATUS);
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
      if (error instanceof Error && error.message.includes("Invalid or expired OAuth state")) {
        return createErrorRedirect(appUrl, "invalid_state", REDIRECT_STATUS);
      }
      console.error("Apple OAuth callback validation failed:", error);
      return createErrorRedirect(appUrl, "callback_failed", REDIRECT_STATUS);
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

    return createSessionResponse(oauthResult.userId, request, appUrl, REDIRECT_STATUS);
  } catch (error) {
    console.error("Apple OAuth callback error:", error);

    // Check for invite-related errors
    const inviteErrorResponse = handleSignupError(error, appUrl, REDIRECT_STATUS);
    if (inviteErrorResponse) {
      return inviteErrorResponse;
    }

    return createErrorRedirect(appUrl, "callback_failed", REDIRECT_STATUS);
  }
}
