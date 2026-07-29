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
import type { Database, Transaction } from "@/server/db";

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
 * Creates a new user account with invite validation.
 *
 * This function implements the "just-do-it" pattern for invite tokens:
 * - Atomically tries to claim the invite (UPDATE WHERE conditions RETURNING)
 * - Only queries for error details if the claim fails
 *
 * Requires a transaction: the user row is inserted before the invite is
 * claimed, so only a rollback undoes the user when the claim loses a race.
 *
 * @param tx - Transaction context
 * @param params - User creation parameters
 * @returns The created user info
 * @throws INVITE_REQUIRED if invite is needed but not provided
 * @throws INVITE_INVALID if invite token doesn't exist
 * @throws INVITE_ALREADY_USED if invite was already claimed
 * @throws INVITE_EXPIRED if invite has expired
 */
export async function createUser(
  tx: Transaction,
  params: CreateUserParams
): Promise<CreateUserResult> {
  const { email, passwordHash, emailVerified, inviteToken, provider } = params;
  const now = new Date();
  const userId = generateUuidv7();

  // Determine how this provider may sign up: publicly, only with an invite, or
  // not at all. Public providers skip the invite requirement entirely.
  const access = resolveSignupProviderAccess(provider, signupConfig);
  if (access === "denied") {
    throw errors.signupProviderNotAllowed(provider);
  }

  // Invite-only providers must present an invite; claiming it happens after the
  // user row exists (see below).
  if (access === "invite-only" && !inviteToken) {
    throw errors.inviteRequired();
  }

  // Create user. This must come before the invite claim: the claim writes
  // invites.used_by_user_id, whose FK to users(id) is non-deferrable and so is
  // checked at the end of that statement, not the transaction (#1447).
  await tx.insert(users).values({
    id: userId,
    email,
    passwordHash,
    emailVerifiedAt: emailVerified ? now : null,
    createdAt: now,
    updatedAt: now,
  });

  // Invite-only providers must claim a valid invite atomically. A failed claim
  // throws, which rolls back the user insert above.
  if (access === "invite-only" && inviteToken) {
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

    // users.invite_id is the other half of the circular FK, so it can only be
    // set once the invite row is known-claimed.
    await tx.update(users).set({ inviteId: claimed[0].id }).where(eq(users.id, userId));
  }

  return {
    userId,
    email,
    createdAt: now,
  };
}

/**
 * Everything we do for a brand-new account after the signup transaction has
 * committed. Every caller invokes this fire-and-forget (`void`), so this
 * function must be **total** — a rejection here has no `.catch()` anywhere and
 * would take the process down as an unhandled rejection. The individual tasks
 * already swallow their own errors; the outer catch covers everything around
 * them (notably the dynamic import).
 *
 * Adding an onboarding step? Put it here, not in the signup routes, so the
 * email/password and OAuth paths can't drift apart.
 */
export async function runPostSignupTasks(db: Database, userId: string): Promise<void> {
  try {
    // Dynamic import to keep the services graph out of the auth modules (see
    // subscribeToAnnouncementFeed).
    const { tryCreateGettingStartedArticle } = await import("@/server/services/getting-started");
    await Promise.all([
      subscribeToAnnouncementFeed(db, userId),
      tryCreateGettingStartedArticle(db, userId),
    ]);
  } catch (err) {
    logger.error("Post-signup tasks failed", { userId, err });
    Sentry.captureException(err, { tags: { source: "post-signup-tasks" }, extra: { userId } });
  }
}

/**
 * Subscribe a newly created user to the announcement feed.
 * Runs async and catches all errors — must never interfere with signup.
 */
async function subscribeToAnnouncementFeed(db: Database, userId: string): Promise<void> {
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
