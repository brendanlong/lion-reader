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
import { eq, and } from "drizzle-orm";
import { validateAppleCallback, isAppleOAuthEnabled } from "@/server/auth/oauth/apple";
import { generateSessionToken, getSessionExpiry } from "@/server/auth/session";
import { generateUuidv7 } from "@/lib/uuidv7";
import { db } from "@/server/db";
import { users, sessions, oauthAccounts } from "@/server/db/schema";

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
      return NextResponse.redirect(`${appUrl}/login?error=provider_not_configured`);
    }

    // Parse the form data
    const formData = await request.formData();
    const code = formData.get("code") as string | null;
    const state = formData.get("state") as string | null;
    const userDataRaw = formData.get("user") as string | null;

    // Validate required fields
    if (!code) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    if (!state) {
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
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
          return NextResponse.redirect(`${appUrl}/login?error=invalid_state`);
        }
      }
      console.error("Apple OAuth callback validation failed:", error);
      return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
    }

    const { userInfo, firstAuthData, tokens } = appleResult;
    const now = new Date();

    // Get email from JWT or first-auth data
    let email = userInfo.email ?? firstAuthData?.email;

    // Check if OAuth account already exists
    const existingOAuthAccount = await db
      .select({
        id: oauthAccounts.id,
        userId: oauthAccounts.userId,
      })
      .from(oauthAccounts)
      .where(
        and(eq(oauthAccounts.provider, "apple"), eq(oauthAccounts.providerAccountId, userInfo.sub))
      )
      .limit(1);

    let userId: string;
    let userEmail: string;

    if (existingOAuthAccount.length > 0) {
      // OAuth account exists - log in as that user
      userId = existingOAuthAccount[0].userId;

      // Get user details
      const userResult = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      if (userResult.length === 0) {
        console.error("Orphaned OAuth account found");
        return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
      }

      userEmail = userResult[0].email;

      // Update OAuth tokens
      await db
        .update(oauthAccounts)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
        })
        .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));
    } else {
      // OAuth account doesn't exist
      // Apple only sends email on first auth - it MUST be present for new accounts
      if (!email) {
        return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
      }

      // Normalize email
      email = email.toLowerCase();

      // Check if email matches existing user
      const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

      if (existingUser.length > 0) {
        // Link OAuth to existing user account
        userId = existingUser[0].id;
        userEmail = existingUser[0].email;

        // Create OAuth account link
        await db.insert(oauthAccounts).values({
          id: generateUuidv7(),
          userId,
          provider: "apple",
          providerAccountId: userInfo.sub,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
          createdAt: now,
        });

        // Mark email as verified if not already
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
        userEmail = email;

        // Create user
        await db.insert(users).values({
          id: userId,
          email: userEmail,
          emailVerifiedAt: now,
          passwordHash: null,
          createdAt: now,
          updatedAt: now,
        });

        // Create OAuth account
        await db.insert(oauthAccounts).values({
          id: generateUuidv7(),
          userId,
          provider: "apple",
          providerAccountId: userInfo.sub,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          expiresAt: tokens.expiresAt ?? null,
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
    console.error("Apple OAuth callback error:", error);
    return NextResponse.redirect(`${appUrl}/login?error=callback_failed`);
  }
}
