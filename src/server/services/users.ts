/**
 * Users Service
 *
 * Business logic for user account operations, shared across
 * tRPC routers, MCP server, and background jobs.
 */

import { eq, sql } from "drizzle-orm";
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
 * - Web feeds with no remaining subscriptions from other users
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
    // Step 1: Find web feeds that will become orphaned after this user is deleted.
    // A feed is orphaned if:
    // - It has no subscriptions from other users
    // - It has no user_entries from other users
    // Email and saved feeds are user-specific and cascade automatically.
    const orphanedFeedIds = await tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(
        sql`${feeds.type} = 'web'
          AND ${feeds.id} IN (
            SELECT ${subscriptions.feedId} FROM ${subscriptions}
            WHERE ${subscriptions.userId} = ${userId}
          )
          AND ${feeds.id} NOT IN (
            SELECT ${subscriptions.feedId} FROM ${subscriptions}
            WHERE ${subscriptions.userId} != ${userId}
          )
          AND ${feeds.id} NOT IN (
            SELECT DISTINCT ${entries.feedId} FROM ${entries}
            INNER JOIN ${userEntries} ON ${userEntries.entryId} = ${entries.id}
            WHERE ${userEntries.userId} != ${userId}
          )`
      );

    // Step 2: Delete the user. This cascades to:
    // - sessions, api_tokens, oauth_accounts
    // - oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens, oauth_consent_grants
    // - subscriptions (which cascades to subscription_tags)
    // - user_entries, tags
    // - ingest_addresses, blocked_senders, opml_imports
    // - user_score_models, entry_score_predictions, entry_summaries
    // - email/saved feeds (user_id FK with cascade)
    // - invites.used_by_user_id is set to NULL
    await tx.delete(users).where(eq(users.id, userId));

    // Step 3: Delete orphaned web feeds (and their entries via cascade)
    if (orphanedFeedIds.length > 0) {
      const ids = orphanedFeedIds.map((f) => f.id);
      await tx.delete(feeds).where(sql`${feeds.id} = ANY(${ids})`);
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
