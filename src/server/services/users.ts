/**
 * Users Service
 *
 * Business logic for user account operations, shared across
 * tRPC routers, MCP server, and background jobs.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { users, feeds, entries, subscriptions, userEntries, sessions } from "@/server/db/schema";
import { getRedisClient } from "@/server/redis";
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
 * - Email/saved feeds are always user-specific and cascade automatically
 *
 * @param db - Database instance
 * @param userId - The user ID to delete
 */
export async function deleteUser(db: Database, userId: string): Promise<void> {
  // Fetch session token hashes before deletion — CASCADE will remove sessions
  // from the DB when the user is deleted, so we need these for Redis cleanup.
  const sessionHashes = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.userId, userId));

  await db.transaction(async (tx) => {
    // Step 1: The web feeds the user subscribes to may become orphaned.
    // Email and saved feeds are user-specific and cascade automatically.
    const candidates = await tx
      .select({ id: feeds.id })
      .from(subscriptions)
      .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
      .where(and(eq(subscriptions.userId, userId), eq(feeds.type, "web")));

    // Step 2: Delete the user. This cascades to:
    // - sessions, api_tokens, oauth_accounts
    // - oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens, oauth_consent_grants
    // - subscriptions (which cascades to subscription_tags)
    // - user_entries, tags
    // - ingest_addresses, blocked_senders, opml_imports
    // - entry_summaries
    // - email/saved feeds (user_id FK with cascade)
    // - invites.used_by_user_id is set to NULL
    await tx.delete(users).where(eq(users.id, userId));

    // Step 3: Delete the candidates nobody else subscribes to or has entries
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
            WHERE ${entries.feedId} = ${feeds.id}
          )`
        )
      );
    }
  });

  // Step 4: Invalidate Redis session caches using pre-fetched token hashes
  const redis = getRedisClient();
  if (redis && sessionHashes.length > 0) {
    try {
      const pipeline = redis.pipeline();
      for (const session of sessionHashes) {
        pipeline.del(`session:${session.tokenHash}`);
      }
      await pipeline.exec();
    } catch (err) {
      // Non-critical: sessions will fail validation anyway since user is deleted
      logger.warn("Failed to invalidate session caches during account deletion", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clean up user-specific Redis keys
  if (redis) {
    try {
      await redis.del(`user:${userId}:events`);
    } catch (err) {
      logger.warn("Failed to clean up Redis keys during account deletion", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("User account deleted", { userId });
}
