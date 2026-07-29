/**
 * Getting Started Article Service
 *
 * Inserts the onboarding article (issue #1397) as a starred saved article, once
 * per user. Called fire-and-forget from the signup paths and, for users who
 * predate the feature, from the `backfill_getting_started` job.
 *
 * The article goes in through the ordinary Markdown upload path, so it is a
 * completely normal saved article afterwards: the user can unstar it, mark it
 * read, or delete it. `users.getting_started_at` is what stops us re-adding it
 * (issue #1383) — it records that we inserted the article, not that the article
 * still exists.
 */

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";

import type { Database } from "@/server/db";
import { users } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { uploadArticle } from "@/server/services/saved";
import { updateEntryStarred } from "@/server/services/entries";
import {
  GETTING_STARTED_EXCERPT,
  GETTING_STARTED_MARKDOWN,
  GETTING_STARTED_TITLE,
} from "@/server/services/getting-started-content";

/**
 * Inserts the Getting Started article for a user, unless they already got one.
 *
 * The flag is claimed *before* the insert (`UPDATE ... WHERE
 * getting_started_at IS NULL RETURNING`), so a signup racing the backfill job
 * can't produce two copies.
 *
 * The claim is released only when the **insert itself** fails — i.e. only while
 * there is definitely no article — so a retry can never add a second copy. Once
 * the article exists the claim stands, which makes starring best-effort: an
 * unstarred article is a much better failure than a duplicate one, and the user
 * can star it themselves.
 *
 * Deliberately biased that way at the other end too: the claim commits on its
 * own, so a process that dies between the claim and the insert leaves that one
 * user with no article and nothing to retry it. Losing an onboarding article
 * beats showing someone two of them.
 *
 * @returns the new entry's id, or null if this user already had one.
 */
export async function createGettingStartedArticle(
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

  let article;
  try {
    article = await uploadArticle(db, userId, {
      content: GETTING_STARTED_MARKDOWN,
      title: GETTING_STARTED_TITLE,
      excerpt: GETTING_STARTED_EXCERPT,
    });
  } catch (err) {
    // Nothing was inserted, so hand the user back to the backfill.
    await db
      .update(users)
      .set({ gettingStartedAt: null })
      .where(eq(users.id, userId))
      .catch(() => {
        // Nothing left to do — the user just won't get the article.
      });
    throw err;
  }

  // Starred so it stays easy to find after it scrolls out of the timeline. A
  // separate call rather than an insert-time flag, so it emits the same
  // `entry_state_changed` event a hand-star does and open tabs update live.
  try {
    await updateEntryStarred(db, userId, article.id, true);
  } catch (err) {
    logger.error("Created Getting Started article but failed to star it", {
      userId,
      entryId: article.id,
      err,
    });
  }

  logger.info("Created Getting Started article", { userId, entryId: article.id });
  return article.id;
}

/**
 * Same, but never throws — for the fire-and-forget signup callers, where
 * failing to add an onboarding article must not fail the signup.
 */
export async function tryCreateGettingStartedArticle(db: Database, userId: string): Promise<void> {
  try {
    await createGettingStartedArticle(db, userId);
  } catch (err) {
    logger.error("Failed to create Getting Started article", { userId, err });
    Sentry.captureException(err, {
      tags: { source: "getting-started-article" },
      extra: { userId },
    });
  }
}

/** Result of one {@link backfillGettingStartedArticles} pass. */
export interface GettingStartedBackfillResult {
  /** Users we attempted in this pass (the batch size, until the tail). */
  attempted: number;
  /** Users who got an article. */
  created: number;
  /** Users whose insert failed; their claim was released, so they're retried. */
  failed: number;
}

/**
 * Inserts the article for up to `limit` users who don't have one yet.
 *
 * One user at a time: this runs on the worker with no deadline, and rendering
 * plus two inserts per user is cheap, so there's no reason to add concurrency
 * (and every reason not to compete with feed fetching for the pool).
 */
export async function backfillGettingStartedArticles(
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
      if (await createGettingStartedArticle(db, user.id)) {
        created++;
      }
    } catch (err) {
      failed++;
      logger.error("Getting Started backfill failed for user", { userId: user.id, err });
    }
  }

  return { attempted: pending.length, created, failed };
}
