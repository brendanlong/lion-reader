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
import { generateSessionToken, getSessionExpiry } from "@/server/auth/session";
import { generateUuidv7 } from "@/lib/uuidv7";
import { db } from "@/server/db";
import { users, sessions, oauthAccounts } from "@/server/db/schema";

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

    const { userInfo, tokens, scopes, mode } = googleResult;
    const now = new Date();

    // Handle save/link modes - user is already logged in, just update OAuth account
    if (mode === "save" || mode === "link") {
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
        // This shouldn't happen for save mode (user must have Google linked)
        // For link mode, this is also unexpected since we check before starting the flow
        console.error("OAuth account not found for save/link mode");
        const errorRedirect =
          mode === "save" ? "/save?error=callback_failed" : "/settings?link_error=callback_failed";
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
      if (mode === "save") {
        return NextResponse.redirect(`${appUrl}/save`);
      } else {
        return NextResponse.redirect(`${appUrl}/settings?linked=google`);
      }
    }

    // Login mode - normal OAuth login/signup flow
    // Check if OAuth account already exists
    const existingOAuthAccount = await db
      .select({
        id: oauthAccounts.id,
        userId: oauthAccounts.userId,
      })
      .from(oauthAccounts)
      .where(
        and(eq(oauthAccounts.provider, "google"), eq(oauthAccounts.providerAccountId, userInfo.sub))
      )
      .limit(1);

    let userId: string;

    if (existingOAuthAccount.length > 0) {
      // OAuth account exists - log in as that user
      userId = existingOAuthAccount[0].userId;

      // Get user details to verify account exists
      const userResult = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      if (userResult.length === 0) {
        console.error("Orphaned OAuth account found");
        return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
      }

      // Update OAuth tokens and scopes
      await db
        .update(oauthAccounts)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          scopes,
        })
        .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));
    } else {
      // OAuth account doesn't exist - check if email matches existing user
      const email = userInfo.email.toLowerCase();

      const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

      if (existingUser.length > 0) {
        // Link OAuth to existing user account
        userId = existingUser[0].id;

        // Create OAuth account link
        await db.insert(oauthAccounts).values({
          id: generateUuidv7(),
          userId,
          provider: "google",
          providerAccountId: userInfo.sub,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          scopes,
          createdAt: now,
        });

        // Mark email as verified if not already (Google verified it)
        if (!existingUser[0].emailVerifiedAt) {
          await db
            .update(users)
            .set({
              emailVerifiedAt: now,
              updatedAt: now,
            })
            .where(eq(users.id, userId));
        }
      } else {
        // Create new user and OAuth account
        userId = generateUuidv7();

        // Create user
        await db.insert(users).values({
          id: userId,
          email,
          emailVerifiedAt: now,
          passwordHash: null,
          createdAt: now,
          updatedAt: now,
        });

        // Create OAuth account
        await db.insert(oauthAccounts).values({
          id: generateUuidv7(),
          userId,
          provider: "google",
          providerAccountId: userInfo.sub,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          scopes,
          createdAt: now,
        });
      }
    }

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
      userId,
      tokenHash,
      userAgent,
      ipAddress,
      expiresAt,
      createdAt: now,
      lastActiveAt: now,
    });

    // Redirect to app with session cookie
    const response = NextResponse.redirect(`${appUrl}/all`);

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
    return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
  }
}
