/**
 * Shared OAuth Callback Handler
 *
 * Centralizes the logic for handling OAuth callbacks from all providers.
 * This ensures consistent behavior for:
 * - Existing OAuth account login
 * - Linking OAuth to existing user by email
 * - New user creation with invite validation
 *
 * Called by the shared callback flow (`callback-helpers.ts`) for sign-in flows.
 */

import { eq, and } from "drizzle-orm";

import { db } from "@/server/db";
import { users, oauthAccounts } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { createUser, runPostSignupTasks } from "@/server/auth/signup";
import type { OAuthProviderName } from "@/server/auth/oauth/config";
import { oauthTokenColumns, type ProviderIdentity } from "@/server/auth/oauth/token-exchange";
import { attachOAuthAccount } from "@/server/services/oauth-accounts";

/**
 * Parameters for processing an OAuth callback.
 *
 * `email` is required for new accounts and optional for returning users (Apple only
 * sends it on first auth; they're matched by `providerAccountId`). OAuth sign-in is
 * the only way an email gets verified in this app, so linking by email or creating
 * an account with it requires `emailVerified === true`.
 */
export interface ProcessOAuthCallbackParams extends ProviderIdentity {
  provider: OAuthProviderName;
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
  const { provider, providerAccountId, email: rawEmail, emailVerified, inviteToken } = params;
  const tokenColumns = oauthTokenColumns(params);

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

    // Keep the stored refresh token when the provider sends none: a returning
    // sign-in usually doesn't, and the stored one still works (#1803).
    await db
      .update(oauthAccounts)
      .set(tokenColumns)
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

  // From here on we trust the email (to link into an existing account or to create a
  // new one). Refuse to do so unless the provider says it's verified — otherwise an
  // attacker with an unverified provider account bearing a victim's address could be
  // linked into the victim's account (account takeover).
  if (!emailVerified) {
    throw new Error(
      "Your email address is not verified with this provider. Please verify it and try again."
    );
  }

  const email = rawEmail.toLowerCase();

  // Check if email matches existing user
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existingUser.length > 0) {
    // Link OAuth to existing user account.
    //
    // This adds a way to sign in, which SECURITY.md §4 would otherwise have
    // revoke the user's other sessions — `linkOAuthAccount` does exactly that
    // for a link from the settings page (which identifies the account by
    // session instead). It deliberately doesn't here: this branch *is* an
    // ordinary first social sign-in, so revoking would log every device out of
    // an account whose owner just proved control of its verified email address
    // and is signing in on this one. The link itself is the same one-per-provider
    // attach, so a user who already linked another account of this provider is
    // refused rather than given a second one.
    const userId = existingUser[0].id;
    await attachOAuthAccount(db, { ...params, userId });

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
  const newUser = await db.transaction(async (tx) => {
    // Create user (handles invite validation and provider restriction atomically)
    const user = await createUser(tx, {
      email,
      passwordHash: null,
      emailVerified: true, // OAuth provider verified the email
      inviteToken,
      provider,
    });

    // Create OAuth account
    await tx.insert(oauthAccounts).values({
      id: generateUuidv7(),
      userId: user.userId,
      provider,
      providerAccountId,
      ...tokenColumns,
      createdAt: user.createdAt,
    });

    return user;
  });

  // Announcement-feed subscription + Getting Started article (fire-and-forget)
  void runPostSignupTasks(db, newUser.userId);

  return {
    userId: newUser.userId,
    email: newUser.email,
    createdAt: newUser.createdAt,
    isNewUser: true,
  };
}
