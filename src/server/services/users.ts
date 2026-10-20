/**
 * Users Service
 *
 * Business logic for user account operations, shared across
 * tRPC routers, MCP server, and background jobs.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "@/server/db/schema";
import { logger } from "@/lib/logger";

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
 * @param db - Database instance
 * @param userId - The user ID to delete
 */
export async function deleteUser(db: Database, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Step 1: The web feeds the user subscribes to may become orphaned.
    const candidates = await tx
      .select({ id: feeds.id })
      .from(subscriptions)
      .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
      .where(eq(subscriptions.userId, userId));

    // Step 2: Take the locks the cascade will, in the order every other write
    // takes them (src/server/CLAUDE.md, "Unread Counts"), or a mark-read, star
    // or fan-out for this user deadlocks against the deletion (#2092).
    await tx
      .select({ entryId: userEntries.entryId })
      .from(userEntries)
      .where(eq(userEntries.userId, userId))
      .orderBy(userEntries.entryId)
      .for("update");
    await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(subscriptions.id)
      .for("update");
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");

    // Step 3: Delete the user. This cascades to:
    // - sessions, api_tokens, oauth_accounts
    // - oauth_authorization_codes, oauth_consent_grants, oauth_token_grants (and their tokens)
    // - subscriptions (which cascades to subscription_tags)
    // - user_entries, tags
    // - ingest_addresses, blocked_senders, opml_imports
    // - entry_summaries
    // - emails (owned by its subscriptions) and saved articles (owned by it)
    // - invites.used_by_user_id is set to NULL
    await tx.delete(users).where(eq(users.id, userId));

    // Step 4: Delete the candidates nobody else subscribes to or has entries
    // from (e.g. starred after unsubscribing), and their entries by cascade.
    // Checking in the DELETE itself, after the user's own rows are gone, means
    // only a subscribe still uncommitted when it runs can be lost (cascaded).
    if (candidates.length > 0) {
      await tx.delete(feeds).where(
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
      );
    }
  });

  logger.info("User account deleted", { userId });
}
