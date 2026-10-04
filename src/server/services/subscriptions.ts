/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers and MCP server.
 */

import { z } from "zod";
import { eq, and, gt, inArray, isNull, sql } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import {
  blockedSenders,
  collectionEntries,
  feeds,
  subscriptions,
  tags,
  subscriptionTags,
  userEntries,
  userFeeds,
  type Feed,
  type FeedType,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { ensureFeedJob, scheduleFeedRefreshNow } from "@/server/jobs/queue";
import { shouldRefetchOnSubscribe } from "@/server/feed/scheduling";
import { canonicalGuidSql } from "@/server/feed/guid-identity";
import { feedDefaultsToFullContent } from "@/server/plugins";
import {
  publishSubscriptionCreated,
  publishSubscriptionDeleted,
  publishSubscriptionUpdated,
} from "@/server/redis/pubsub";
import { attemptUnsubscribe, getLatestUnsubscribeMailto } from "@/server/email/unsubscribe";
import {
  getBulkEntryRelatedCounts,
  getSubscriptionDeletionCounts,
  getUserUnreadCounts,
  type BulkUnreadCounts,
} from "@/server/services/counts";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";
import { errors } from "@/server/trpc/errors";
import { generateOpml, type OpmlSubscription } from "@/server/feed/opml";

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
  type: FeedType;
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
 *
 * The unread count is the trigger-maintained `subscriptions.unread_count`
 * counter (migration 0092, exposed through the view in migration 0093) — a
 * free column read, so there is no opt-out (the old `includeUnreadCounts`
 * option existed because the count was a scan over visible_entries that
 * scaled with the unread backlog, issue #1074). Spam never counts.
 */
function buildSubscriptionBaseQuery(db: typeof dbType) {
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
      // Trigger-maintained unread counter (spam excluded)
      unreadCount: userFeeds.unreadCount,
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
    .$dynamic()
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
      userFeeds.unreadCount
    );
}

/**
 * Type for a row returned by buildSubscriptionBaseQuery.
 */
export type SubscriptionQueryRow = Awaited<ReturnType<typeof buildSubscriptionBaseQuery>>[number];

/**
 * Transforms a subscription query row into the output format.
 */
function formatSubscriptionRow(row: SubscriptionQueryRow): Subscription {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { feedId, ...subscription } = row;
  return subscription;
}

// ============================================================================
// Cursor Helpers
// ============================================================================

/** Keyset cursor for the alphabetical subscription list. NULL titles sort first. */
const subscriptionCursor = createCursorCodec(
  z.object({
    title: z.string().nullable(),
    id: cursorUuid,
  })
);

/**
 * Counts the user's active subscriptions (collections included) for the cap
 * check, first taking a transaction-scoped lock that serializes concurrent
 * subscription creation for the user, so two callers can't both pass the
 * check and both insert past the limit (issue #952).
 */
export async function lockAndCountActiveSubscriptions(tx: DbOrTx, userId: string): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
  const [{ activeCount }] = await tx
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));
  return activeCount;
}

/**
 * Locks one of the user's subscription rows for the rest of the transaction,
 * so a change to its tags or state takes locks in the order `src/server/CLAUDE.md`
 * requires. Unsubscribing a collection also touches its members' user_entries
 * rows (the trigger empties it), so `members` locks those first.
 */
async function lockSubscriptionRow(
  tx: DbOrTx,
  userId: string,
  subscriptionId: string,
  { members = false }: { members?: boolean } = {}
): Promise<void> {
  if (members) {
    await tx
      .select({ entryId: userEntries.entryId })
      .from(userEntries)
      .innerJoin(
        collectionEntries,
        and(
          eq(collectionEntries.userId, userEntries.userId),
          eq(collectionEntries.entryId, userEntries.entryId)
        )
      )
      .where(
        and(
          eq(collectionEntries.subscriptionId, subscriptionId),
          eq(collectionEntries.userId, userId)
        )
      )
      .orderBy(userEntries.entryId)
      .for("no key update", { of: userEntries });
  }
  await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
    .for("update");
}

/**
 * Gives a new or reactivated subscriber the entries currently in the feed
 * ("Entry Visibility" in `src/server/CLAUDE.md`). Only for a fresh feed: a
 * stale feed's cached entries may include ones the publisher has since removed,
 * so callers schedule a forced refresh (`scheduleFeedRefreshNow`) instead, whose
 * fanout populates the subscriber from ground truth.
 */
async function populateInitialUserEntries(
  tx: DbOrTx,
  userId: string,
  subscriptionId: string,
  feedId: string
): Promise<void> {
  // feeds.last_entries_updated_at is read inside the INSERT (via the JOIN), not
  // passed in: a feed fetch completing after the caller read the feed bumps it,
  // so a stale captured value would match zero rows and the new subscriber
  // would see an empty feed until the next new entry (issue #952).
  //
  // `last_seen_at >= last_entries_updated_at` (not `=`) grants visibility to
  // entries currently in the feed. A forced refresh re-stamps every current
  // entry to a single generation, so there `>=` behaves like `=`. The `>` arm
  // covers entries a WebSub hub pushed *since* the last poll: a push stamps
  // last_seen_at = pushTime but leaves last_entries_updated_at at the last
  // poll, so those entries would be invisible under strict equality (issue
  // #1078). Disappeared entries (not re-stamped by a later poll) fall below
  // last_entries_updated_at and stay excluded.
  //
  // An entry stamped `is_backfill` is granted already read, matching the
  // fetch-time fanout: a WebSub push leaves `last_entries_updated_at` where it
  // was, so an archive replay sits inside the current generation until the next
  // backup poll and would otherwise reach a subscriber who joins in that window
  // as hundreds of unread articles (issue #1500).
  //
  // Skips an entry the subscription already has under another feed by GUID, as
  // the fetch-time fanout (`createUserEntriesForFeed`) does: a redirect merge
  // re-attributes the old feed's entries to the subscription, and the new feed
  // usually republishes the same articles.
  await tx.execute(sql`
    INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, subscription_id, is_spam, read)
    SELECT ${userId}, e.id, COALESCE(e.published_at, e.fetched_at), ${subscriptionId}, e.is_spam, e.is_backfill
    FROM entries e
    JOIN feeds f ON f.id = e.feed_id
    WHERE e.feed_id = ${feedId}
      AND f.last_entries_updated_at IS NOT NULL
      AND e.last_seen_at >= f.last_entries_updated_at
      AND NOT EXISTS (
        SELECT 1
        FROM user_entries ue_existing
        JOIN entries e_prev ON ue_existing.entry_id = e_prev.id
        WHERE ue_existing.user_id = ${userId}
          AND ue_existing.subscription_id = ${subscriptionId}
          AND e_prev.feed_id != e.feed_id
          AND ${sql.raw(canonicalGuidSql("e_prev.guid"))} = ${sql.raw(canonicalGuidSql("e.guid"))}
      )
    ON CONFLICT DO NOTHING
  `);
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
  type?: FeedType; // Only show subscriptions of this type (e.g. collections)
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
  const { userId, query, tagId, uncategorized, unreadOnly, type, cursor, limit = 50 } = params;

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

  if (type) {
    conditions.push(eq(userFeeds.type, type));
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
    // Match the per-subscription badge exactly: the trigger-maintained
    // counter (spam excluded) is what the row's unreadCount reports.
    conditions.push(gt(userFeeds.unreadCount, 0));
  }

  // Cursor pagination using (title, id) keyset for alphabetical ordering
  if (cursor) {
    // Invalid cursors are a validation error — silently restarting from page one
    // would hide client bugs.
    const decoded = subscriptionCursor.decode(cursor);
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
  const results = await buildSubscriptionBaseQuery(db)
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

  let nextCursor: string | undefined;
  if (hasMore) {
    const lastSub = subscriptions[subscriptions.length - 1];
    nextCursor = subscriptionCursor.encode({ title: lastSub.title, id: lastSub.id });
  }

  return {
    subscriptions,
    nextCursor,
  };
}

/**
 * Lists ALL active subscriptions for a user in a single query (no pagination).
 *
 * The Google Reader `subscription/list` and `unread-count` endpoints need the
 * user's entire subscription set at once. Paging through `listSubscriptions`
 * (capped at 100/page) issues ⌈N/100⌉ sequential round-trips; this runs the same
 * base query (per-subscription unread counts + tags) unbounded instead. Ordered
 * alphabetically to match `listSubscriptions`. Callers already hold the whole
 * list in memory, so there is no extra memory cost — only fewer round-trips.
 *
 * This is deliberately separate from `listSubscriptions` rather than an
 * unbounded `limit`: the 100 cap is a safety valve for the paginated UI/MCP/tRPC
 * callers and stays intact for them.
 */
export async function listAllSubscriptions(
  db: typeof dbType,
  userId: string
): Promise<Subscription[]> {
  const results = await buildSubscriptionBaseQuery(db)
    .where(eq(userFeeds.userId, userId))
    .orderBy(sql`COALESCE(${userFeeds.title}, '') ASC`, userFeeds.id);
  return results.map(formatSubscriptionRow);
}

/**
 * The user's subscriptions as OPML. Feeds without a URL (saved articles,
 * newsletters) have nothing to subscribe to elsewhere, so they're left out.
 */
export async function exportSubscriptionsOpml(
  db: typeof dbType,
  userId: string
): Promise<{ opml: string; feedCount: number }> {
  const opmlSubscriptions: OpmlSubscription[] = (await listAllSubscriptions(db, userId)).flatMap(
    (row) =>
      row.url === null
        ? []
        : [
            {
              title: row.title || row.url,
              xmlUrl: row.url,
              htmlUrl: row.siteUrl ?? undefined,
              tags: row.tags.length > 0 ? row.tags.map((tag) => tag.name) : undefined,
            },
          ]
  );

  return {
    opml: generateOpml(opmlSubscriptions, { title: "Lion Reader Subscriptions" }),
    feedCount: opmlSubscriptions.length,
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
  const results = await buildSubscriptionBaseQuery(db)
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
  /** Unread count for the subscription (trigger-maintained counter, spam excluded) */
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
    type: FeedType;
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
 * Options for {@link createSubscription}.
 */
export interface CreateSubscriptionOptions {
  /**
   * Skip the synchronous initial `user_entries` populate. The interactive
   * subscribe path sets this when it has determined the feed is **stale** and is
   * scheduling an immediate forced background refresh (`scheduleFeedRefreshNow`)
   * instead: for a stale feed we can't know which entries are actually current
   * without re-fetching, so populating from the cached entries could grant a new
   * subscriber an entry the publisher has since removed. The forced fetch's
   * fanout (`createUserEntriesForFeed`) populates the subscriber from ground
   * truth a moment later, exactly as a brand-new feed's first fetch does.
   */
  skipInitialPopulate?: boolean;
}

/**
 * Creates a new subscription to a feed. Handles the full flow:
 * 1. Upserts the feed record (creates if new, uses existing otherwise)
 * 2. Ensures a background fetch job exists for the feed
 * 3. Checks subscription cap (with idempotent return if already subscribed)
 * 4. Upserts the subscription (creates new or reactivates soft-deleted)
 * 5. Populates initial user_entries so the user sees current feed content
 *    (unless `skipInitialPopulate` — see {@link CreateSubscriptionOptions})
 *
 * Idempotent: if the user already has an active subscription, returns it.
 */
export async function createSubscription(
  db: typeof dbType,
  userId: string,
  feed: CreateSubscriptionFeedInput,
  options: CreateSubscriptionOptions = {}
): Promise<CreateSubscriptionResult> {
  const { skipInitialPopulate = false } = options;
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

  // A plugin may opt a source into full-content-by-default (e.g. Bluesky, whose
  // RSS drops embedded content). Applied only to a fresh subscribe below; a
  // resubscribe keeps the user's stored preference.
  const defaultFullContent = feedDefaultsToFullContent(feed.url);

  // 3–5. Cap check + subscription upsert + user_entries populate, all in ONE
  //       transaction, so a crash can't leave a half-created subscription;
  //       lockAndCountActiveSubscriptions serializes the cap check (#952).
  const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;

  interface TxResult {
    kind: "alreadyActive" | "created";
    subscriptionId: string;
    subscribedAt: Date;
    customTitle: string | null;
    fetchFullContent: boolean;
  }

  const txResult: TxResult = await db.transaction(async (tx) => {
    const selectActiveSubscription = () =>
      tx
        .select({
          subscriptionId: subscriptions.id,
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

    // 3. Check subscription cap; if at cap, return existing or throw
    const activeCount = await lockAndCountActiveSubscriptions(tx, userId);

    if (activeCount >= maxSubs) {
      // Over cap — check if we're already subscribed to this specific feed
      const [existingSub] = await selectActiveSubscription();
      if (existingSub) {
        return { kind: "alreadyActive", ...existingSub };
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
      INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at, fetch_full_content)
      VALUES (${newSubscriptionId}, ${userId}, ${feedId}, ${subscribedAt}, ${subscribedAt}, ${subscribedAt}, ${defaultFullContent})
      ON CONFLICT (user_id, feed_id) DO UPDATE SET
        unsubscribed_at = NULL,
        subscribed_at = ${subscribedAt},
        updated_at = ${subscribedAt}
      WHERE subscriptions.unsubscribed_at IS NOT NULL
      RETURNING id, subscribed_at, custom_title, fetch_full_content
    `);

    if (upsertResult.rows.length === 0) {
      // Subscription was already active — idempotent return (unread computed
      // below). The ON CONFLICT row lock keeps it active for this transaction.
      const [sub] = await selectActiveSubscription();
      if (!sub) {
        throw new Error(`Active subscription vanished after upsert conflict: ${feedId}`);
      }
      return { kind: "alreadyActive", ...sub };
    }

    const upsertedRow = upsertResult.rows[0];
    const subscriptionId = upsertedRow.id;
    const customTitle = upsertedRow.custom_title;
    const fetchFullContent = upsertedRow.fetch_full_content;

    // 5. Populate user_entries (skipped for a stale feed; see
    //    CreateSubscriptionOptions).
    if (!skipInitialPopulate) {
      await populateInitialUserEntries(tx, userId, subscriptionId, feedId);
    }

    return {
      kind: "created",
      subscriptionId,
      subscribedAt,
      customTitle,
      fetchFullContent,
    };
  });

  // Idempotent already-active return: compute the real unread count from the
  // view now that the transaction has committed.
  if (txResult.kind === "alreadyActive") {
    const viewResults = await buildSubscriptionBaseQuery(db)
      .where(and(eq(userFeeds.id, txResult.subscriptionId), eq(userFeeds.userId, userId)))
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

  const { subscriptionId, subscribedAt, customTitle, fetchFullContent } = txResult;

  // 7. Compute absolute unread counts for the affected lists. A newly created
  // or reactivated subscription is untagged, so it only moves All Articles and
  // Uncategorized (plus its own count). The client sets these directly.
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId }]);

  // The subscription's own badge is the trigger-maintained counter this bulk
  // read already returned (spam excluded), never a scan — see "Unread Counts"
  // in `src/server/CLAUDE.md`. `getBulkEntryRelatedCounts` zero-fills every
  // requested subscription, so the entry for ours is always present.
  const unreadCount = counts.subscriptions.find((s) => s.id === subscriptionId)?.unread ?? 0;

  logger.debug("Populated initial user entries via lastSeenAt", {
    userId,
    feedId,
    entryCount: unreadCount,
  });

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

/**
 * Replaces a subscription's tags (an empty list makes it uncategorized).
 * Publishes subscription_updated and bumps updated_at only on a real change.
 */
export async function setSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  tagIds: string[]
): Promise<void> {
  tagIds = [...new Set(tagIds)];
  // Verify the subscription exists and belongs to the user
  const existingSubscription = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .limit(1);

  if (existingSubscription.length === 0) {
    throw errors.subscriptionNotFound();
  }

  const now = new Date();

  // Verify all tag IDs belong to the current user, are not soft-deleted, and
  // get tag details. Excluding tombstoned tags prevents assigning a tag that
  // is invisible in listTags (which would silently drop the subscription
  // from "Uncategorized").
  const userTags =
    tagIds.length === 0
      ? []
      : await db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .where(and(eq(tags.userId, userId), inArray(tags.id, tagIds), isNull(tags.deletedAt)));

  const validTagIds = new Set(userTags.map((t) => t.id));
  const invalidTagIds = tagIds.filter((id) => !validTagIds.has(id));

  if (invalidTagIds.length > 0) {
    throw errors.validation("One or more tag IDs are invalid or do not belong to you");
  }

  // Replace (or clear) tags atomically: delete-then-insert (+updated_at bump)
  // must be one unit, or a crash/concurrent call between them could leave the
  // subscription untagged or with a partial tag set (issue #952).
  const changed = await db.transaction(async (tx) => {
    // Subscription row first: the counter triggers lock subscriptions, then
    // users, then tags, and the tag changes below reach users and tags.
    await lockSubscriptionRow(tx, userId, subscriptionId);

    // Delete all existing tags for the subscription. The RETURNING captures
    // the prior tag set race-free (no pre-SELECT TOCTOU window) so we can
    // tell a real change from a re-apply of the identical set (issue #1160).
    const deleted = await tx
      .delete(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId))
      .returning({ tagId: subscriptionTags.tagId });

    if (tagIds.length > 0) {
      await tx.insert(subscriptionTags).values(
        tagIds.map((tagId) => ({
          subscriptionId: subscriptionId,
          tagId,
          createdAt: now,
        }))
      );
    }

    // Re-applying the identical tag set (including clearing an already-empty
    // one) is not a meaningful change: skip the updated_at bump so the
    // delta-sync cursor doesn't move (and skip the publish below).
    const previousTagIds = new Set(deleted.map((d) => d.tagId));
    if (previousTagIds.size === validTagIds.size && tagIds.every((id) => previousTagIds.has(id))) {
      return false;
    }

    // Update subscription's updated_at for sync cursor tracking
    await tx
      .update(subscriptions)
      .set({ updatedAt: now })
      .where(eq(subscriptions.id, subscriptionId));
    return true;
  });

  // Publish SSE event with new tags
  if (changed) {
    publishSubscriptionUpdated(
      userId,
      subscriptionId,
      now,
      userTags,
      existingSubscription[0].customTitle
    ).catch((err) => {
      logger.error("Failed to publish subscription_updated event", {
        err,
        userId,
        subscriptionId: subscriptionId,
      });
    });
  }
}

/**
 * Unsubscribes (soft-deletes) one of the user's active subscriptions, returning
 * the affected lists' post-delete absolute counts, or null if there is no such
 * active subscription. Every unsubscribe path goes through here so they all do
 * the same thing: for an email feed, send the sender's list-unsubscribe request
 * and block the sender; then remove its tags, soft-delete it, and publish
 * subscription_deleted.
 */
export async function unsubscribe(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<{ counts: BulkUnreadCounts } | null> {
  const [existing] = await db
    .select({ feed: feeds })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  const { feed } = existing;
  const now = new Date();

  // The unsubscribe request and mailto lookup are network/side-effecting work,
  // so they run BEFORE the transaction; only the blocked_senders row is written
  // inside it.
  let blockedSenderValues: typeof blockedSenders.$inferInsert | null = null;
  if (feed.type === "email" && feed.emailSenderPattern) {
    const unsubscribeResult = await attemptUnsubscribe(feed.id);

    logger.info("Email unsubscribe attempt completed", {
      feedId: feed.id,
      userId,
      senderEmail: feed.emailSenderPattern,
      sent: unsubscribeResult.sent,
      method: unsubscribeResult.method,
    });

    blockedSenderValues = {
      id: generateUuidv7(),
      userId,
      senderEmail: feed.emailSenderPattern,
      blockedAt: now,
      listUnsubscribeMailto: await getLatestUnsubscribeMailto(feed.id),
      unsubscribeSentAt: unsubscribeResult.sent ? now : null,
    };
  }

  // One transaction so a crash can't half-apply the unsubscribe (e.g. tags
  // removed but the subscription still active) (issue #952).
  const formerTagIds = await db.transaction(async (tx) => {
    await lockSubscriptionRow(tx, userId, subscriptionId, { members: true });

    // Re-checked under the lock: a concurrent unsubscribe may have finished
    // since the check above.
    const softDeleted = await tx
      .update(subscriptions)
      .set({ unsubscribedAt: now, updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .returning({ id: subscriptions.id });
    if (softDeleted.length === 0) {
      return null;
    }

    if (blockedSenderValues) {
      await tx.insert(blockedSenders).values(blockedSenderValues).onConflictDoNothing();
      logger.info("Added sender to blocked list", {
        userId,
        senderEmail: feed.emailSenderPattern,
      });
    }

    // Remove the tag associations so resubscribing starts fresh. RETURNING
    // captures the former tags for the post-delete counts (an empty list means
    // the subscription was uncategorized).
    const formerTagRows = await tx
      .delete(subscriptionTags)
      .where(
        inArray(
          subscriptionTags.subscriptionId,
          tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
        )
      )
      .returning({ tagId: subscriptionTags.tagId });

    return formerTagRows.map((r) => r.tagId);
  });

  if (!formerTagIds) {
    return null;
  }

  // Computed after the soft-delete so they reflect the removal. The client sets
  // these directly (the sync.events catch-up path can't recompute the former
  // tags, so it omits counts and the client invalidates instead).
  const counts = await getSubscriptionDeletionCounts(db, userId, formerTagIds);

  publishSubscriptionDeleted(userId, feed.id, subscriptionId, now, counts).catch((err) => {
    logger.error("Failed to publish subscription_deleted event", {
      err,
      userId,
      feedId: feed.id,
    });
  });

  return { counts };
}

/**
 * Moves one of the user's subscriptions onto another feed, for a permanent
 * redirect onto a feed that already exists. The user ends up actively
 * subscribed to `newFeed` (the "survivor": their existing subscription to it,
 * reactivated or created as needed) with the old subscription's tags, and the
 * old feed's entries re-attributed to it, so read/starred state carries over.
 * A survivor that wasn't already active also takes the old subscription's
 * title and full-content setting, and gets the feed's current entries like a
 * fresh subscribe (a stale feed gets a forced refresh instead).
 *
 * There's no subscription cap check: a merge never raises the user's number of
 * active subscriptions. Returns false if the old subscription is no longer
 * active.
 */
export async function mergeSubscriptionIntoFeed(
  db: typeof dbType,
  userId: string,
  oldSubscriptionId: string,
  newFeed: Feed
): Promise<boolean> {
  const populate = !shouldRefetchOnSubscribe(newFeed);
  const defaultFullContent = newFeed.url !== null && feedDefaultsToFullContent(newFeed.url);
  const now = new Date();

  const merged = await db.transaction(async (tx) => {
    // Lock order: the user_entries rows the re-stamp moves, then the
    // subscription rows (see "Unread Counts" in src/server/CLAUDE.md).
    await tx
      .select({ entryId: userEntries.entryId })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), eq(userEntries.subscriptionId, oldSubscriptionId)))
      .orderBy(userEntries.entryId)
      .for("no key update");

    const [old] = await tx
      .select({
        feedId: subscriptions.feedId,
        customTitle: subscriptions.customTitle,
        fetchFullContent: subscriptions.fetchFullContent,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, oldSubscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .for("update");
    if (!old) {
      return null;
    }

    // Insert or reactivate the survivor. An already-active survivor keeps its
    // own settings; the ON CONFLICT row lock holds it for this transaction.
    const upserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at, custom_title, fetch_full_content)
      VALUES (${generateUuidv7()}, ${userId}, ${newFeed.id}, ${now}, ${now}, ${now}, ${old.customTitle}, ${old.fetchFullContent || defaultFullContent})
      ON CONFLICT (user_id, feed_id) DO UPDATE SET
        unsubscribed_at = NULL,
        subscribed_at = EXCLUDED.subscribed_at,
        updated_at = EXCLUDED.updated_at,
        custom_title = EXCLUDED.custom_title,
        fetch_full_content = EXCLUDED.fetch_full_content
      WHERE subscriptions.unsubscribed_at IS NOT NULL
      RETURNING id
    `);
    const survivorWasActive = upserted.rows.length === 0;
    const [survivor] = await tx
      .select({
        id: subscriptions.id,
        subscribedAt: subscriptions.subscribedAt,
        customTitle: subscriptions.customTitle,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeed.id)));

    // Deliberately leaves user_entries.updated_at alone: nothing about the
    // entries changes, and bumping it would flood the user's delta sync.
    await tx
      .update(userEntries)
      .set({ subscriptionId: survivor.id })
      .where(
        and(eq(userEntries.userId, userId), eq(userEntries.subscriptionId, oldSubscriptionId))
      );

    if (!survivorWasActive) {
      // Tags left on an inactive subscription are stale (unsubscribing clears them).
      await tx.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, survivor.id));
      // After the re-stamp, so the populate's GUID check sees the old feed's entries.
      if (populate) {
        await populateInitialUserEntries(tx, userId, survivor.id, newFeed.id);
      }
    }

    const movedTags = await tx
      .delete(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, oldSubscriptionId))
      .returning({ tagId: subscriptionTags.tagId });
    const addedTags =
      movedTags.length === 0
        ? []
        : await tx
            .insert(subscriptionTags)
            .values(movedTags.map(({ tagId }) => ({ subscriptionId: survivor.id, tagId })))
            .onConflictDoNothing()
            .returning({ tagId: subscriptionTags.tagId });
    if (survivorWasActive && addedTags.length > 0) {
      await tx
        .update(subscriptions)
        .set({ updatedAt: now })
        .where(eq(subscriptions.id, survivor.id));
    }

    await tx
      .update(subscriptions)
      .set({ unsubscribedAt: now, updatedAt: now })
      .where(eq(subscriptions.id, oldSubscriptionId));

    const survivorTags = await tx
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(subscriptionTags)
      .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
      .where(eq(subscriptionTags.subscriptionId, survivor.id));

    return {
      oldFeedId: old.feedId,
      oldWasUncategorized: movedTags.length === 0,
      survivor,
      survivorWasActive,
      survivorTagsChanged: addedTags.length > 0,
      survivorTags,
    };
  });

  if (!merged) {
    return false;
  }
  const { oldFeedId, oldWasUncategorized, survivor, survivorWasActive, survivorTags } = merged;

  // Unconditional, not just for a new survivor: retention deletes the job of a
  // feed with no active subscriber, so a merge can be what brings the feed back.
  if (!survivorWasActive && !populate) {
    await scheduleFeedRefreshNow(newFeed.id);
  } else {
    await ensureFeedJob(newFeed.id);
  }

  // The survivor's tags include the old subscription's, so its counts cover
  // every list the merge moved except Uncategorized when only the old one was.
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: survivor.id }]);
  if (oldWasUncategorized && !counts.uncategorized) {
    counts.uncategorized = { unread: (await getUserUnreadCounts(db, userId)).uncategorizedUnread };
  }
  const onPublishError = (err: unknown) => {
    logger.error("Failed to publish subscription merge event", { err, userId, oldSubscriptionId });
  };

  publishSubscriptionDeleted(userId, oldFeedId, oldSubscriptionId, now, counts).catch(
    onPublishError
  );
  if (!survivorWasActive) {
    publishSubscriptionCreated(
      userId,
      newFeed.id,
      survivor.id,
      now,
      {
        id: survivor.id,
        feedId: newFeed.id,
        customTitle: survivor.customTitle,
        subscribedAt: survivor.subscribedAt.toISOString(),
        unreadCount: counts.subscriptions.find((s) => s.id === survivor.id)?.unread ?? 0,
        tags: survivorTags,
      },
      {
        id: newFeed.id,
        type: newFeed.type,
        url: newFeed.url,
        title: newFeed.title,
        description: newFeed.description,
        siteUrl: newFeed.siteUrl,
      },
      counts
    ).catch(onPublishError);
  } else if (merged.survivorTagsChanged) {
    publishSubscriptionUpdated(userId, survivor.id, now, survivorTags, survivor.customTitle).catch(
      onPublishError
    );
  }

  return true;
}
