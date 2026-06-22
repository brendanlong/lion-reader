/**
 * User Signup Helper
 *
 * Centralizes the logic for creating new user accounts, including:
 * - Invite token validation (just-do-it pattern)
 * - User creation
 * - Atomic transaction handling
 *
 * Used by email/password registration and OAuth signup flows.
 */

import { and, eq, gte, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";

import { users, invites } from "@/server/db/schema";
import { signupConfig, announcementFeedConfig, type SignupProvider } from "@/server/config/env";
import { resolveSignupProviderAccess } from "@/server/auth/signup-providers";
import { generateUuidv7 } from "@/lib/uuidv7";
import { errors } from "@/server/trpc/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/server/db";

/**
 * Parameters for creating a new user
 */
export interface CreateUserParams {
  /** User's email address (should already be lowercase) */
  email: string;
  /** Password hash (null for OAuth users) */
  passwordHash: string | null;
  /** Whether the email is already verified (true for OAuth) */
  emailVerified: boolean;
  /** Optional invite token for invite-only signups */
  inviteToken?: string;
  /** The signup provider being used (for allowed provider enforcement) */
  provider: SignupProvider;
}

/**
 * Result of creating a new user
 */
export interface CreateUserResult {
  userId: string;
  email: string;
  createdAt: Date;
}

/**
 * Transaction type - accepts both db and transaction contexts
 */
type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Creates a new user account with invite validation.
 *
 * This function implements the "just-do-it" pattern for invite tokens:
 * - Atomically tries to claim the invite (UPDATE WHERE conditions RETURNING)
 * - Only queries for error details if the claim fails
 *
 * Should be called within a transaction to ensure atomicity.
 *
 * @param tx - Database or transaction context
 * @param params - User creation parameters
 * @returns The created user info
 * @throws INVITE_REQUIRED if invite is needed but not provided
 * @throws INVITE_INVALID if invite token doesn't exist
 * @throws INVITE_ALREADY_USED if invite was already claimed
 * @throws INVITE_EXPIRED if invite has expired
 */
export async function createUser(tx: DbOrTx, params: CreateUserParams): Promise<CreateUserResult> {
  const { email, passwordHash, emailVerified, inviteToken, provider } = params;
  const now = new Date();
  const userId = generateUuidv7();

  let claimedInviteId: string | undefined;

  // Determine how this provider may sign up: publicly, only with an invite, or
  // not at all. Public providers skip the invite requirement entirely.
  const access = resolveSignupProviderAccess(provider, signupConfig);
  if (access === "denied") {
    throw errors.signupProviderNotAllowed(provider);
  }

  // Invite-only providers must present and claim a valid invite atomically.
  if (access === "invite-only") {
    if (!inviteToken) {
      throw errors.inviteRequired();
    }

    // Just-do-it: try to mark invite as used in one atomic operation
    const claimed = await tx
      .update(invites)
      .set({
        usedAt: now,
        usedByUserId: userId,
      })
      .where(
        and(eq(invites.token, inviteToken), isNull(invites.usedAt), gte(invites.expiresAt, now))
      )
      .returning({ id: invites.id });

    if (claimed.length === 0) {
      // Invite claim failed - figure out why for the error message
      const invite = await tx
        .select({
          usedAt: invites.usedAt,
          expiresAt: invites.expiresAt,
        })
        .from(invites)
        .where(eq(invites.token, inviteToken))
        .limit(1);

      if (invite.length === 0) {
        throw errors.inviteInvalid();
      }
      if (invite[0].usedAt) {
        throw errors.inviteAlreadyUsed();
      }
      if (invite[0].expiresAt < now) {
        throw errors.inviteExpired();
      }
      // Shouldn't reach here, but just in case
      throw errors.inviteInvalid();
    }

    claimedInviteId = claimed[0].id;
  }

  // Create user
  await tx.insert(users).values({
    id: userId,
    email,
    passwordHash,
    emailVerifiedAt: emailVerified ? now : null,
    inviteId: claimedInviteId,
    createdAt: now,
    updatedAt: now,
  });

  return {
    userId,
    email,
    createdAt: now,
  };
}

/**
 * Subscribe a newly created user to the announcement feed.
 * Runs async and catches all errors — must never interfere with signup.
 */
export async function subscribeToAnnouncementFeed(db: Database, userId: string): Promise<void> {
  const feedUrl = announcementFeedConfig.url;
  if (!feedUrl) return;

  try {
    // Dynamic import to avoid circular dependency (subscriptions imports db schema)
    const { createSubscription } = await import("@/server/services/subscriptions");
    await createSubscription(db, userId, { url: feedUrl });
    logger.info("Auto-subscribed user to announcement feed", { userId, feedUrl });
  } catch (err) {
    logger.error("Failed to auto-subscribe user to announcement feed", {
      userId,
      feedUrl,
      err,
    });
    Sentry.captureException(err, {
      tags: { source: "announcement-feed-subscription" },
      extra: { userId, feedUrl },
    });
  }
}
