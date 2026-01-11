/**
 * Shared OAuth Callback Handler
 *
 * Centralizes the logic for handling OAuth callbacks from all providers.
 * This ensures consistent behavior for:
 * - Existing OAuth account login
 * - Linking OAuth to existing user by email
 * - New user creation with invite validation
 *
 * Used by both tRPC endpoints and API routes.
 */

import { eq, and } from "drizzle-orm";

import { db, type Database } from "@/server/db";
import { users, oauthAccounts } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { createUser } from "@/server/auth/signup";

/**
 * OAuth provider type
 */
export type OAuthProvider = "google" | "apple";

/**
 * Parameters for processing an OAuth callback
 */
export interface ProcessOAuthCallbackParams {
  /** OAuth provider */
  provider: OAuthProvider;
  /** Provider's unique user ID (sub claim) */
  providerAccountId: string;
  /**
   * User's email from the provider.
   * Required for new accounts. Optional for returning users (e.g., Apple only
   * sends email on first auth, but we can look up the user by providerAccountId).
   */
  email?: string;
  /** OAuth access token */
  accessToken: string;
  /** OAuth refresh token (if provided) */
  refreshToken?: string;
  /** Token expiration time */
  expiresAt?: Date;
  /** OAuth scopes (for Google) */
  scopes?: string[];
  /** Invite token for new user registration */
  inviteToken?: string;
}

/**
 * Result of processing an OAuth callback
 */
export interface ProcessOAuthCallbackResult {
  /** User ID */
  userId: string;
  /** User's email */
  email: string;
  /** When the user was created */
  createdAt: Date;
  /** Whether this is a newly created user */
  isNewUser: boolean;
}

/**
 * Transaction type for database operations
 */
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Process an OAuth callback for login/signup.
 *
 * This function handles three scenarios:
 * 1. OAuth account exists → Log in as that user
 * 2. Email matches existing user → Link OAuth to that account
 * 3. Neither exists → Create new user (with invite validation)
 *
 * @param params - OAuth callback parameters
 * @returns The user info and whether they're new
 * @throws Various errors for invalid invites when creating new users
 */
export async function processOAuthCallback(
  params: ProcessOAuthCallbackParams
): Promise<ProcessOAuthCallbackResult> {
  const {
    provider,
    providerAccountId,
    email: rawEmail,
    accessToken,
    refreshToken,
    expiresAt,
    scopes,
    inviteToken,
  } = params;

  const now = new Date();

  // Check if OAuth account already exists
  const existingOAuthAccount = await db
    .select({
      id: oauthAccounts.id,
      userId: oauthAccounts.userId,
    })
    .from(oauthAccounts)
    .where(
      and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.providerAccountId, providerAccountId)
      )
    )
    .limit(1);

  if (existingOAuthAccount.length > 0) {
    // OAuth account exists - log in as that user
    const userId = existingOAuthAccount[0].userId;

    // Get user details to verify account exists
    const userResult = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (userResult.length === 0) {
      // Orphaned OAuth account - this shouldn't happen
      throw new Error("User account not found");
    }

    // Update OAuth tokens and scopes
    await db
      .update(oauthAccounts)
      .set({
        accessToken,
        refreshToken: refreshToken ?? null,
        expiresAt: expiresAt ?? null,
        ...(scopes !== undefined ? { scopes } : {}),
      })
      .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));

    return {
      userId,
      email: userResult[0].email,
      createdAt: userResult[0].createdAt,
      isNewUser: false,
    };
  }

  // OAuth account doesn't exist - email is required for linking or creating new account
  if (!rawEmail) {
    throw new Error("Email not provided. Please try signing in again and grant email permission.");
  }
  const email = rawEmail.toLowerCase();

  // Check if email matches existing user
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existingUser.length > 0) {
    // Link OAuth to existing user account
    const userId = existingUser[0].id;

    // Create OAuth account link
    await db.insert(oauthAccounts).values({
      id: generateUuidv7(),
      userId,
      provider,
      providerAccountId,
      accessToken,
      refreshToken: refreshToken ?? null,
      expiresAt: expiresAt ?? null,
      ...(scopes !== undefined ? { scopes } : {}),
      createdAt: now,
    });

    // Mark email as verified if not already (OAuth provider verified it)
    if (!existingUser[0].emailVerifiedAt) {
      await db
        .update(users)
        .set({
          emailVerifiedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
    }

    return {
      userId,
      email: existingUser[0].email,
      createdAt: existingUser[0].createdAt,
      isNewUser: false,
    };
  }

  // Create new user and OAuth account in a transaction
  const newUser = await db.transaction(async (tx: DbOrTx) => {
    // Create user (handles invite validation atomically)
    const user = await createUser(tx, {
      email,
      passwordHash: null,
      emailVerified: true, // OAuth provider verified the email
      inviteToken,
    });

    // Create OAuth account
    await tx.insert(oauthAccounts).values({
      id: generateUuidv7(),
      userId: user.userId,
      provider,
      providerAccountId,
      accessToken,
      refreshToken: refreshToken ?? null,
      expiresAt: expiresAt ?? null,
      ...(scopes !== undefined ? { scopes } : {}),
      createdAt: user.createdAt,
    });

    return user;
  });

  return {
    userId: newUser.userId,
    email: newUser.email,
    createdAt: newUser.createdAt,
    isNewUser: true,
  };
}
