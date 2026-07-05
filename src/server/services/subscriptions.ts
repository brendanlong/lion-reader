/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
  tags,
  subscriptionTags,
  userFeeds,
  visibleEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { ensureFeedJob } from "@/server/jobs/queue";
import { publishSubscriptionCreated } from "@/server/redis/pubsub";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import { errors } from "@/server/trpc/errors";

// ============================================================================
// Types
// ============================================================================

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export interface Subscription {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  originalTitle: string | null;
  description: string | null;
  siteUrl: string | null;
  subscribedAt: Date;
  unreadCount: number;
  tags: Tag[];
  fetchFullContent: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Builds the base query for fetching subscriptions using the user_feeds view.
 * Includes unread counts and tags.
 */
export function buildSubscriptionBaseQuery(db: typeof dbType, userId: string) {
  // Subquery to get unread counts per subscription.
  // Counts through visible_entries (grouped by subscription_id) rather than by
  // entries.feed_id: a subscription can own entries under multiple feed_ids via
  // the subscription_feeds junction (feed redirect/merge history), and matching
  // only on the current feed_id would undercount those. The view encapsulates
  // that mapping plus the visibility rule, so this stays correct by construction.
  // Filtering read=false in WHERE (not a FILTER aggregate) lets the partial
  // idx_user_entries_unread index drive the scan.
  const unreadCountsSubquery = db
    .select({
      subscriptionId: visibleEntries.subscriptionId,
      unreadCount: sql<number>`count(*)::int`.as("unread_count"),
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.read, false)))
    .groupBy(visibleEntries.subscriptionId)
    .as("unread_counts");

  return db
    .select({
      // From user_feeds view - subscription fields
      id: userFeeds.id,
      subscribedAt: userFeeds.subscribedAt,
      feedId: userFeeds.feedId, // internal use only
      fetchFullContent: userFeeds.fetchFullContent,
      // From user_feeds view - feed fields (already merged)
      type: userFeeds.type,
      url: userFeeds.url,
      title: userFeeds.title, // already resolved (COALESCE of customTitle and original)
      originalTitle: userFeeds.originalTitle,
      description: userFeeds.description,
      siteUrl: userFeeds.siteUrl,
      // Unread count from subquery
      unreadCount: sql<number>`COALESCE(${unreadCountsSubquery.unreadCount}, 0)`,
      // Tags aggregated as JSON array
      tags: sql<Array<{ id: string; name: string; color: string | null }>>`
        COALESCE(
          json_agg(
            json_build_object('id', ${tags.id}, 'name', ${tags.name}, 'color', ${tags.color})
          ) FILTER (WHERE ${tags.id} IS NOT NULL),
          '[]'::json
        )
      `,
    })
    .from(userFeeds)
    .leftJoin(unreadCountsSubquery, eq(unreadCountsSubquery.subscriptionId, userFeeds.id))
    .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, userFeeds.id))
    .leftJoin(tags, eq(tags.id, subscriptionTags.tagId))
    .groupBy(
      userFeeds.id,
      userFeeds.subscribedAt,
      userFeeds.feedId,
      userFeeds.fetchFullContent,
      userFeeds.type,
      userFeeds.url,
      userFeeds.title,
      userFeeds.originalTitle,
      userFeeds.description,
      userFeeds.siteUrl,
      unreadCountsSubquery.unreadCount
    );
}

/**
 * Type for a row returned by buildSubscriptionBaseQuery.
 */
export type SubscriptionQueryRow = Awaited<ReturnType<typeof buildSubscriptionBaseQuery>>[number];

/**
 * Transforms a subscription query row into the output format.
 */
export function formatSubscriptionRow(row: SubscriptionQueryRow): Subscription {
  return {
    id: row.id,
    type: row.type,
    url: row.url,
    title: row.title,
    originalTitle: row.originalTitle,
    description: row.description,
    siteUrl: row.siteUrl,
    subscribedAt: row.subscribedAt,
    unreadCount: row.unreadCount,
    tags: row.tags,
    fetchFullContent: row.fetchFullContent,
  };
}

// ============================================================================
// Service Functions
// ============================================================================

export interface ListSubscriptionsParams {
  userId: string;
  query?: string; // Case-insensitive title search
  tagId?: string; // Filter by tag
  uncategorized?: boolean; // Only show subscriptions with no tags
  unreadOnly?: boolean; // Only show feeds with unread items
  cursor?: string; // Pagination cursor (base64-encoded JSON: {title, id})
  limit?: number; // Max results per page
}

export interface ListSubscriptionsResult {
  subscriptions: Subscription[];
  nextCursor?: string;
}

/**
 * Lists active subscriptions for a user with optional filtering and pagination.
 *
 * Supports:
 * - Case-insensitive title search
 * - Tag filtering
 * - Uncategorized filtering (subscriptions with no tags)
 * - Unread-only filtering
 * - Cursor-based pagination
 */
export async function listSubscriptions(
  db: typeof dbType,
  params: ListSubscriptionsParams
): Promise<ListSubscriptionsResult> {
  const { userId, query, tagId, uncategorized, unreadOnly, cursor, limit = 50 } = params;

  // Cap limit at 100
  const effectiveLimit = Math.min(limit, 100);

  // Apply filters
  const conditions = [eq(userFeeds.userId, userId)];

  // Title search (case-insensitive)
  if (query && query.length > 0) {
    const likePattern = `%${query}%`;
    conditions.push(sql`COALESCE(${userFeeds.title}, '') ILIKE ${likePattern}`);
  }

  // Tag filter
  if (tagId) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${subscriptionTags}
      WHERE ${subscriptionTags.subscriptionId} = ${userFeeds.id}
        AND ${subscriptionTags.tagId} = ${tagId}
    )`);
  }

  // Uncategorized filter (subscriptions with no tags)
  if (uncategorized) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${subscriptionTags}
      WHERE ${subscriptionTags.subscriptionId} = ${userFeeds.id}
    )`);
  }

  // Unread filter — push into SQL so LIMIT applies to already-filtered rows
  // (filtering in-memory after LIMIT breaks pagination: hasMore ends up false
  // even when more unread subs exist past the first page).
  if (unreadOnly) {
    // Match the per-subscription count: an entry counts as unread for this
    // subscription if visible_entries maps it here (via subscription_feeds),
    // not merely if its feed_id equals the subscription's current feed_id.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${visibleEntries} ve
      WHERE ve.subscription_id = ${userFeeds.id}
        AND ve.user_id = ${userId}
        AND ve.read = false
    )`);
  }

  // Cursor pagination using (title, id) keyset for alphabetical ordering
  if (cursor) {
    // Invalid cursors are a validation error, matching the entries service —
    // silently restarting from page one would hide client bugs.
    let decoded: { title: string | null; id: string };
    try {
      decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
        title: string | null;
        id: string;
      };
      // The id is interpolated into a uuid comparison — reject non-UUID
      // values here so they surface as a validation error, not a Postgres
      // "invalid input syntax for type uuid" 500.
      if (
        typeof decoded.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)
      ) {
        throw new Error("Invalid cursor structure");
      }
    } catch {
      throw errors.validation("Invalid cursor format");
    }
    // Keyset pagination: (title, id) > (cursor.title, cursor.id)
    // NULL titles sort first (COALESCE to empty string)
    conditions.push(sql`(
      COALESCE(${userFeeds.title}, '') > COALESCE(${decoded.title}::text, '')
      OR (
        COALESCE(${userFeeds.title}, '') = COALESCE(${decoded.title}::text, '')
        AND ${userFeeds.id} > ${decoded.id}
      )
    )`);
  }

  // Build and execute query, sorted alphabetically by title then by id as tiebreaker
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(and(...conditions))
    .orderBy(sql`COALESCE(${userFeeds.title}, '') ASC`, userFeeds.id)
    .limit(effectiveLimit + 1);

  // Format results
  let subscriptions = results.map(formatSubscriptionRow);

  // Check if there are more results
  const hasMore = subscriptions.length > effectiveLimit;
  if (hasMore) {
    subscriptions = subscriptions.slice(0, effectiveLimit);
  }

  // Encode cursor as base64url JSON with title and id for keyset pagination
  let nextCursor: string | undefined;
  if (hasMore) {
    const lastSub = subscriptions[subscriptions.length - 1];
    nextCursor = Buffer.from(JSON.stringify({ title: lastSub.title, id: lastSub.id })).toString(
      "base64url"
    );
  }

  return {
    subscriptions,
    nextCursor,
  };
}

/**
 * Gets a single subscription by ID.
 */
export async function getSubscription(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<Subscription> {
  const results = await buildSubscriptionBaseQuery(db, userId)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  if (results.length === 0) {
    throw errors.subscriptionNotFound();
  }

  return formatSubscriptionRow(results[0]);
}

// ============================================================================
// Subscription Creation
// ============================================================================

/**
 * Feed data for creating a subscription. For existing feeds, only `url` is required.
 * Other fields are used when creating new feed records.
 */
export interface CreateSubscriptionFeedInput {
  url: string;
  title?: string | null;
  description?: string | null;
  siteUrl?: string | null;
}

/**
 * Result of creating a subscription.
 */
export interface CreateSubscriptionResult {
  /** Subscription ID */
  subscriptionId: string;
  /** When the subscription was created */
  subscribedAt: Date;
  /** Number of unread entries populated */
  unreadCount: number;
  /** True if the subscription already existed and was active (idempotent return) */
  alreadyActive: boolean;
  /** User's custom title for this subscription (null = use feed title) */
  customTitle: string | null;
  /** Whether to fetch full article content from URL */
  fetchFullContent: boolean;
  /** Feed data (from existing or newly created feed) */
  feed: {
    id: string;
    type: "web" | "email" | "saved";
    url: string | null;
    title: string | null;
    description: string | null;
    siteUrl: string | null;
  };
  /**
   * Absolute unread counts for the lists affected by this subscription (All
   * Articles, Uncategorized, and the subscription itself). Present only when a
   * subscription was actually created or reactivated; omitted for the
   * idempotent already-active return (nothing changed).
   */
  counts?: BulkUnreadCounts;
}

/**
 * Creates a new subscription to a feed. Handles the full flow:
 * 1. Upserts the feed record (creates if new, uses existing otherwise)
 * 2. Ensures a background fetch job exists for the feed
 * 3. Checks subscription cap (with idempotent return if already subscribed)
 * 4. Upserts the subscription (creates new or reactivates soft-deleted)
 * 5. Populates initial user_entries so the user sees current feed content
 *
 * Idempotent: if the user already has an active subscription, returns it.
 */
export async function createSubscription(
  db: typeof dbType,
  userId: string,
  feed: CreateSubscriptionFeedInput
): Promise<CreateSubscriptionResult> {
  // 1. Upsert feed — insert if new, otherwise use existing
  const newFeedId = generateUuidv7();
  const now = new Date();
  await db
    .insert(feeds)
    .values({
      id: newFeedId,
      type: "web",
      url: feed.url,
      title: feed.title ?? null,
      description: feed.description ?? null,
      siteUrl: feed.siteUrl ?? null,
      nextFetchAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: feeds.url });

  const [feedRecord] = await db.select().from(feeds).where(eq(feeds.url, feed.url)).limit(1);
  if (!feedRecord) {
    throw new Error(`Feed disappeared after upsert: ${feed.url}`);
  }

  const feedId = feedRecord.id;
  const feedData = {
    id: feedId,
    type: feedRecord.type,
    url: feedRecord.url,
    title: feedRecord.title,
    description: feedRecord.description,
    siteUrl: feedRecord.siteUrl,
  };

  // 2. Ensure background fetch job exists
  await ensureFeedJob(feedId);

  // 3–6. Cap check + subscription upsert + subscription_feeds + user_entries
  //       populate, all in ONE transaction. Previously these were separate
  //       statements: a crash between them could leave an active subscription
  //       with no subscription_feeds row (so its entries were unqueryable), and
  //       the cap count → insert was check-then-act. The advisory lock
  //       serializes concurrent subscribes for this user so two callers can't
  //       both pass the cap check and both insert past the limit; it releases
  //       automatically at commit/rollback (issue #952).
  const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;

  type TxResult =
    | {
        kind: "alreadyActive";
        subscriptionId: string;
        subscribedAt: Date;
        customTitle: string | null;
        fetchFullContent: boolean;
      }
    | {
        kind: "created";
        subscriptionId: string;
        subscribedAt: Date;
        unreadCount: number;
        customTitle: string | null;
        fetchFullContent: boolean;
      };

  const txResult: TxResult = await db.transaction(async (tx) => {
    // Serialize concurrent subscribes for this user (fixes the cap race).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    // 3. Check subscription cap; if at cap, return existing or throw
    const [{ activeCount }] = await tx
      .select({ activeCount: sql<number>`count(*)::int` })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

    if (activeCount >= maxSubs) {
      // Over cap — check if we're already subscribed to this specific feed
      const [existingSub] = await tx
        .select({
          id: subscriptions.id,
          subscribedAt: subscriptions.subscribedAt,
          customTitle: subscriptions.customTitle,
          fetchFullContent: subscriptions.fetchFullContent,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, feedId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existingSub) {
        return {
          kind: "alreadyActive",
          subscriptionId: existingSub.id,
          subscribedAt: existingSub.subscribedAt,
          customTitle: existingSub.customTitle,
          fetchFullContent: existingSub.fetchFullContent,
        };
      }

      throw errors.maxSubscriptionsReached(maxSubs);
    }

    // 4. Upsert subscription — insert new or reactivate soft-deleted
    //    RETURNING tells us if the row was actually inserted/updated.
    //    If the subscription is already active, the WHERE clause doesn't match,
    //    so neither insert nor update happens and RETURNING returns nothing.
    const newSubscriptionId = generateUuidv7();
    const subscribedAt = new Date();

    const upsertResult = await tx.execute<{
      id: string;
      subscribed_at: string;
      custom_title: string | null;
      fetch_full_content: boolean;
    }>(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at)
      VALUES (${newSubscriptionId}, ${userId}, ${feedId}, ${subscribedAt}, ${subscribedAt}, ${subscribedAt})
      ON CONFLICT (user_id, feed_id) DO UPDATE SET
        unsubscribed_at = NULL,
        subscribed_at = ${subscribedAt},
        updated_at = ${subscribedAt}
      WHERE subscriptions.unsubscribed_at IS NOT NULL
      RETURNING id, subscribed_at, custom_title, fetch_full_content
    `);

    if (upsertResult.rows.length === 0) {
      // Subscription was already active — idempotent return (unread computed below)
      const [sub] = await tx
        .select({
          id: subscriptions.id,
          subscribedAt: subscriptions.subscribedAt,
          customTitle: subscriptions.customTitle,
          fetchFullContent: subscriptions.fetchFullContent,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
        .limit(1);

      return {
        kind: "alreadyActive",
        subscriptionId: sub.id,
        subscribedAt: sub.subscribedAt,
        customTitle: sub.customTitle,
        fetchFullContent: sub.fetchFullContent,
      };
    }

    const upsertedRow = upsertResult.rows[0];
    const subscriptionId = upsertedRow.id;
    const customTitle = upsertedRow.custom_title;
    const fetchFullContent = upsertedRow.fetch_full_content;

    // 5. Upsert subscription_feeds
    await tx
      .insert(subscriptionFeeds)
      .values({ subscriptionId, feedId, userId })
      .onConflictDoNothing();

    // 6. Populate user_entries using INSERT...SELECT and count unread.
    //    Re-read feeds.last_entries_updated_at inside the INSERT (via the JOIN)
    //    rather than using the value captured in feedRecord earlier: a feed fetch
    //    completing between that read and here bumps last_entries_updated_at, so
    //    a stale captured value would match zero rows and the new subscriber
    //    would see an empty feed until the next new entry (issue #952). The JOIN
    //    reads the current value atomically within this statement.
    await tx.execute(sql`
      INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at)
      SELECT ${userId}, e.id, COALESCE(e.published_at, e.fetched_at)
      FROM entries e
      JOIN feeds f ON f.id = e.feed_id
      WHERE e.feed_id = ${feedId}
        AND f.last_entries_updated_at IS NOT NULL
        AND e.last_seen_at = f.last_entries_updated_at
      ON CONFLICT DO NOTHING
    `);

    // Count unread entries (rowCount may be 0 for reactivations where entries already exist)
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userEntries)
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
      .where(
        and(eq(userEntries.userId, userId), eq(entries.feedId, feedId), eq(userEntries.read, false))
      );

    return {
      kind: "created",
      subscriptionId,
      subscribedAt,
      unreadCount: count,
      customTitle,
      fetchFullContent,
    };
  });

  // Idempotent already-active return: compute the real unread count from the
  // view now that the transaction has committed.
  if (txResult.kind === "alreadyActive") {
    const viewResults = await buildSubscriptionBaseQuery(db, userId)
      .where(eq(userFeeds.id, txResult.subscriptionId))
      .limit(1);

    return {
      subscriptionId: txResult.subscriptionId,
      subscribedAt: txResult.subscribedAt,
      unreadCount: viewResults.length > 0 ? viewResults[0].unreadCount : 0,
      alreadyActive: true,
      customTitle: txResult.customTitle,
      fetchFullContent: txResult.fetchFullContent,
      feed: feedData,
    };
  }

  const { subscriptionId, subscribedAt, unreadCount, customTitle, fetchFullContent } = txResult;

  logger.debug("Populated initial user entries via lastSeenAt", {
    userId,
    feedId,
    entryCount: unreadCount,
  });

  // 7. Compute absolute unread counts for the affected lists. A newly created
  // or reactivated subscription is untagged, so it only moves All Articles and
  // Uncategorized (plus its own count). The client sets these directly.
  const counts = await getBulkEntryRelatedCounts(db, userId, [
    { subscriptionId, type: feedData.type },
  ]);

  // 8. Publish SSE event for new/reactivated subscriptions
  publishSubscriptionCreated(
    userId,
    feedId,
    subscriptionId,
    subscribedAt,
    {
      id: subscriptionId,
      feedId,
      customTitle,
      subscribedAt: subscribedAt.toISOString(),
      unreadCount,
      tags: [],
    },
    feedData,
    counts
  ).catch((err) => {
    logger.error("Failed to publish subscription_created event", { err, userId, feedId });
  });

  return {
    subscriptionId,
    subscribedAt,
    unreadCount,
    alreadyActive: false,
    customTitle,
    fetchFullContent,
    feed: feedData,
    counts,
  };
}
