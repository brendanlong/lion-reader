/**
 * Users Service
 *
 * Business logic for user account operations, shared across
 * tRPC routers, MCP server, and background jobs.
 */

import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { retryDeadlocks } from "@/server/db/errors";
import { enqueueFullContentArchiveDeletion } from "./full-content-archive";
import { enqueueStoredObjectsDeletion, userObjectsPrefix } from "./stored-objects";

/**
 * Deletes a user account and all associated data.
 *
 * Most user data is deleted automatically via CASCADE foreign keys when the
 * user row is deleted. This function also cleans up orphaned feeds and entries
 * that are no longer referenced by any other user.
 *
 * Orphan cleanup:
 * - Web feeds the user subscribed to that no other user subscribes to or
 *   has entries from
 * - Entries belonging to orphaned feeds (cascaded from feed deletion)
 * - The user's emails and saved articles cascade from their owners (#1846)
 *
 * Retried on deadlock (#2092): the cascade locks the users row before the
 * user's subscriptions and user_entries rows, the reverse of the order writes
 * lock them in, so a write in flight for this user can deadlock against it.
 * No order fixes that: a write that inserts a row referencing the user (a
 * saved article, a subscription) key-share locks the users row before touching
 * the user's other rows.
 *
 * @param db - Database instance
 * @param userId - The user ID to delete
 */
export async function deleteUser(db: Database, userId: string): Promise<void> {
  await retryDeadlocks(
    () => deleteUserOnce(db, userId),
    (attempt) => logger.warn("Account deletion lost a deadlock; retrying", { userId, attempt })
  );

  logger.info("User account deleted", { userId });
}

async function deleteUserOnce(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Step 1: The web feeds the user subscribes to may become orphaned.
    const candidates = await tx
      .select({ id: feeds.id })
      .from(subscriptions)
      .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
      .where(eq(subscriptions.userId, userId));

    // The archived pages of every entry this deletes (the user's own, and
    // those of the feeds step 3 deletes), read while the rows still exist.
    const ownedArchived = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(
          isNotNull(entries.fullContentFetchedAt),
          or(
            eq(entries.ownerUserId, userId),
            inArray(
              entries.ownerSubscriptionId,
              tx
                .select({ id: subscriptions.id })
                .from(subscriptions)
                .where(eq(subscriptions.userId, userId))
            )
          )
        )
      );
    const feedArchived =
      candidates.length > 0
        ? await tx
            .select({ id: entries.id, feedId: entries.ownerFeedId })
            .from(entries)
            .where(
              and(
                isNotNull(entries.fullContentFetchedAt),
                inArray(
                  entries.ownerFeedId,
                  candidates.map((f) => f.id)
                )
              )
            )
        : [];

    // Step 2: Delete the user. This cascades to:
    // - sessions, api_tokens, oauth_accounts
    // - oauth_authorization_codes, oauth_consent_grants, oauth_token_grants (and their tokens)
    // - subscriptions (which cascades to subscription_tags)
    // - user_entries, tags
    // - ingest_addresses, blocked_senders, opml_imports
    // - entry_summaries
    // - emails (owned by its subscriptions) and saved articles (owned by it)
    // - invites.used_by_user_id is set to NULL
    await tx.delete(users).where(eq(users.id, userId));

    // Step 3: Delete the candidates nobody else subscribes to or has entries
    // from (e.g. starred after unsubscribing), and their entries by cascade.
    // Checking in the DELETE itself, after the user's own rows are gone, means
    // only a subscribe still uncommitted when it runs can be lost (cascaded).
    let deletedFeedIds = new Set<string>();
    if (candidates.length > 0) {
      const deletedFeeds = await tx
        .delete(feeds)
        .where(
          and(
            inArray(
              feeds.id,
              candidates.map((f) => f.id)
            ),
            sql`NOT EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.feedId} = ${feeds.id})`,
            sql`NOT EXISTS (
            SELECT 1 FROM ${entries}
            INNER JOIN ${userEntries} ON ${userEntries.entryId} = ${entries.id}
            WHERE ${entries.ownerFeedId} = ${feeds.id}
          )`
          )
        )
        .returning({ id: feeds.id });
      deletedFeedIds = new Set(deletedFeeds.map((f) => f.id));
    }

    await enqueueStoredObjectsDeletion(tx, [userObjectsPrefix(userId)]);
    await enqueueFullContentArchiveDeletion(tx, [
      ...ownedArchived.map((e) => e.id),
      ...feedArchived.filter((e) => e.feedId && deletedFeedIds.has(e.feedId)).map((e) => e.id),
    ]);
  });
}
