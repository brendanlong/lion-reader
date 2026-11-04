/**
 * Getting Started Collection Service
 *
 * Gives each user, once, a "Getting Started" collection of short onboarding
 * articles in reading order (issue #1397). Called fire-and-forget from the
 * signup paths and, for a user whose signup-path insert failed, from the
 * `backfill_getting_started` job.
 *
 * The articles go in through the ordinary Markdown upload path and the
 * collection is an ordinary collection, so afterwards the user can read,
 * rearrange, or delete any of it. `users.getting_started_at` is what stops us
 * re-adding them (issue #1383) — it records that we inserted them, not that
 * they still exist. Accounts that got the single article this replaced
 * already have it set, so they don't get the collection.
 */

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";

import type { Database } from "@/server/db";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { uploadOnboardingArticle } from "@/server/services/saved";
import { addEntriesToCollection, createCollection } from "@/server/services/collections";
import {
  GETTING_STARTED_ARTICLES,
  GETTING_STARTED_COLLECTION_NAME,
} from "@/server/services/getting-started-content";

/**
 * Creates the Getting Started collection for a user, unless they already got
 * one.
 *
 * The flag is claimed *before* the inserts (`UPDATE ... WHERE
 * getting_started_at IS NULL RETURNING`), so a signup racing the backfill job
 * can't produce two copies. A failure releases the claim, and every step is
 * idempotent (each article by its upload key, the collection by name, the
 * filing by membership), so the retry finishes the job without duplicates.
 *
 * Deliberately biased toward missing over doubling: the claim commits on its
 * own, so a process that dies part-way leaves that one user with some of the
 * articles in Saved, maybe no collection, and nothing to retry it. Losing onboarding articles beats showing
 * someone two copies.
 *
 * @returns the collection's id, or null if this user already had one.
 */
export async function createGettingStartedCollection(
  db: Database,
  userId: string
): Promise<string | null> {
  const claimed = await db
    .update(users)
    .set({ gettingStartedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.gettingStartedAt)))
    .returning({ id: users.id });

  if (claimed.length === 0) {
    return null;
  }

  try {
    // Inserted last to first, so newest-first lists like All and Saved show
    // them in reading order too.
    const positions = new Map<string, number>();
    for (const [index, article] of [...GETTING_STARTED_ARTICLES.entries()].reverse()) {
      const saved = await uploadOnboardingArticle(db, userId, {
        content: article.markdown,
        title: article.title,
        excerpt: article.excerpt,
        // The colon keeps it out of the key space callers can use.
        idempotencyKey: `onboarding:getting-started:${article.key}`,
      });
      positions.set(saved.id, index + 1);
    }
    // Filed in one call after the uploads, so a retry files articles an
    // earlier attempt uploaded too, even into a new collection if the user
    // renamed or deleted a partial one.
    const { subscription } = await createCollection(db, userId, GETTING_STARTED_COLLECTION_NAME);
    await addEntriesToCollection(db, userId, subscription.id, [...positions.keys()], positions);
    logger.info("Created Getting Started collection", {
      userId,
      subscriptionId: subscription.id,
    });
    return subscription.id;
  } catch (err) {
    // Hand the user back to the backfill to finish.
    await db
      .update(users)
      .set({ gettingStartedAt: null })
      .where(eq(users.id, userId))
      .catch(() => {
        // Nothing left to do — the user just won't get the collection.
      });
    throw err;
  }
}

/**
 * Same, but never throws — for the fire-and-forget signup callers, where
 * failing to add onboarding articles must not fail the signup.
 */
export async function tryCreateGettingStartedCollection(
  db: Database,
  userId: string
): Promise<void> {
  try {
    await createGettingStartedCollection(db, userId);
  } catch (err) {
    logger.error("Failed to create Getting Started collection", { userId, err });
    Sentry.captureException(err, {
      tags: { source: "getting-started-collection" },
      extra: { userId },
    });
  }
}

/** Result of one {@link backfillGettingStartedCollections} pass. */
export interface GettingStartedBackfillResult {
  /** Users we attempted in this pass (the batch size, until the tail). */
  attempted: number;
  /** Users who got a collection. */
  created: number;
  /** Users whose insert failed; their claim was released, so they're retried. */
  failed: number;
}

/**
 * Creates the collection for up to `limit` users who don't have one yet.
 *
 * One user at a time: this runs on the worker with no deadline, so there's no
 * reason to add concurrency (and every reason not to compete with feed
 * fetching for the pool).
 */
export async function backfillGettingStartedCollections(
  db: Database,
  limit: number
): Promise<GettingStartedBackfillResult> {
  const pending = await db
    .select({ id: users.id })
    .from(users)
    .where(isNull(users.gettingStartedAt))
    .limit(limit);

  let created = 0;
  let failed = 0;

  for (const user of pending) {
    try {
      if (await createGettingStartedCollection(db, user.id)) {
        created++;
      }
    } catch (err) {
      failed++;
      logger.error("Getting Started backfill failed for user", { userId: user.id, err });
    }
  }

  return { attempted: pending.length, created, failed };
}
