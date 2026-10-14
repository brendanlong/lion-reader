/**
 * Subscriptions Service
 *
 * Business logic for subscription operations. Used by both tRPC routers and MCP server.
 */

import { z } from "zod";
import { eq, and, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { db as dbType, DbOrTx } from "@/server/db";
import {
  blockedSenders,
  subscriptionEntries,
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
import { feedDefaultsToFullContent, getFeedHooks } from "@/server/plugins";
import {
  publishSubscriptionCreated,
  publishSubscriptionDeleted,
  publishSubscriptionUpdated,
} from "@/server/redis/pubsub";
import { attemptUnsubscribe, getLatestUnsubscribeMailto } from "@/server/email/unsubscribe";
import {
  countsAsOfColumn,
  countsAsOfNow,
  formatCountsAsOf,
  getBulkEntryRelatedCounts,
  getSubscriptionDeletionCounts,
  getUserUnreadCounts,
  type BulkUnreadCounts,
} from "@/server/services/counts";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";
import {
  holdsRedirectTwin,
  insertUserEntriesWithMemberships,
} from "@/server/services/subscription-entries";
import { errors } from "@/server/errors";
import { isUniqueViolation } from "@/server/db/errors";
import { generateOpml, type OpmlSubscription } from "@/server/feed/opml";
import { fetchUrl, isHtmlContent } from "@/server/http/fetch";
import { parseFeedAsync } from "@/server/feed/parser";
import { discoverFeeds } from "@/server/feed/discovery";
import { getDomainFromUrl } from "@/server/feed/types";

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
  /** When `unreadCount` was read (`countsAsOfSchema`). */
  unreadCountAsOf: string;
  tags: Tag[];
  fetchFullContent: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Matches `subscriptions` rows that are collections. */
export function isCollectionSubscription(): SQL {
  return eq(subscriptions.type, "collection");
}

/**
 * What clearing one of the user's active subscriptions' custom title stores,
 * or null if it can't be cleared. A subscription without a feed has only its
 * own name (#1846): an active collection's is required, and an email
 * subscription's falls back to the sender's address. Anything else clears to
 * its feed's title.
 */
export async function clearedCustomTitle(
  db: DbOrTx,
  userId: string,
  subscriptionId: string
): Promise<{ customTitle: string | null } | null> {
  const [row] = await db
    .select({ type: subscriptions.type, emailSender: subscriptions.emailSender })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .limit(1);
  if (row?.type === "collection") return null;
  if (row?.type === "email") return { customTitle: row.emailSender };
  return { customTitle: null };
}

/** Matches `subscriptions` rows to web feeds, the only feeds shared between users. */
export function isWebSubscription(): SQL {
  return eq(subscriptions.type, "web");
}

/**
 * Matches the subscriptions users and clients can see and manage: every type
 * but `saved`. The database gives each user one saved subscription to hold the
 * Saved list's memberships (#1846). It stays hidden, can't be tagged and can't
 * be unsubscribed, so installed apps never list Saved as a feed; the Saved list
 * is reached through `type: "saved"` filters instead. Pass `user_feeds.type`
 * when querying the view.
 */
export function isListedSubscription(
  type: typeof subscriptions.type | typeof userFeeds.type = subscriptions.type
): SQL {
  return ne(type, "saved");
}

/**
 * Builds the base query for fetching subscriptions using the user_feeds view,
 * limited to `where` and to listed subscriptions (`isListedSubscription`).
 * Includes unread counts and tags.
 *
 * The unread count is the trigger-maintained `subscriptions.unread_count`
 * counter (migration 0092, exposed through the view in migration 0093) — a
 * free column read, so there is no opt-out (the old `includeUnreadCounts`
 * option existed because the count was a scan over visible_entries that
 * scaled with the unread backlog, issue #1074). Spam never counts.
 */
function buildSubscriptionBaseQuery(db: typeof dbType, where: SQL | undefined) {
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
      // Google Reader's stream serial, kept off `Subscription` (a bigint
      // doesn't serialize): see listAllSubscriptionsWithStreamIds.
      greaderStreamId: userFeeds.greaderStreamId,
      unreadCountAsOf: countsAsOfColumn(),
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
    .where(and(where, isListedSubscription(userFeeds.type)))
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
      userFeeds.unreadCount,
      userFeeds.greaderStreamId
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
  const { feedId, greaderStreamId, unreadCountAsOf, ...subscription } = row;
  return { ...subscription, unreadCountAsOf: formatCountsAsOf(unreadCountAsOf) };
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

/** The user's saved subscription's id (#1846), or null before their first save. */
export async function getSavedSubscriptionId(db: DbOrTx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "saved")))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Counts the user's active subscriptions (collections included, the hidden
 * saved one not) for the cap check, first taking a transaction-scoped lock that serializes concurrent
 * subscription creation for the user, so two callers can't both pass the
 * check and both insert past the limit (issue #952).
 */
export async function lockAndCountActiveSubscriptions(tx: DbOrTx, userId: string): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
  const [{ activeCount }] = await tx
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isListedSubscription()
      )
    );
  return activeCount;
}

/**
 * Locks the user_entries rows of the articles in the user's subscriptions
 * matching `where`, sorted. (Un)subscribing moves each member's
 * `active_memberships` (#1846), so a transaction that changes whether a
 * subscription is active takes these locks first, as the lock order in
 * `src/server/CLAUDE.md` requires.
 */
export async function lockSubscriptionMembers(
  tx: DbOrTx,
  userId: string,
  where: SQL | undefined
): Promise<void> {
  await tx
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .innerJoin(
      subscriptionEntries,
      and(
        eq(subscriptionEntries.userId, userEntries.userId),
        eq(subscriptionEntries.entryId, userEntries.entryId)
      )
    )
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
    .where(and(eq(userEntries.userId, userId), eq(subscriptions.userId, userId), where))
    .orderBy(userEntries.entryId)
    .for("no key update", { of: userEntries });
}

/**
 * Locks one of the user's subscription rows for the rest of the transaction,
 * so a change to its tags or state takes locks in the order `src/server/CLAUDE.md`
 * requires, returning the locked row's fields a subscription_updated event
 * carries. Unsubscribing moves its members'
 * user_entries rows, so `members` locks those first.
 */
async function lockSubscriptionRow(
  tx: DbOrTx,
  userId: string,
  subscriptionId: string,
  { members = false }: { members?: boolean } = {}
): Promise<{ customTitle: string | null; fetchFullContent: boolean } | undefined> {
  if (members) {
    await lockSubscriptionMembers(tx, userId, eq(subscriptions.id, subscriptionId));
  }
  const [row] = await tx
    .select({
      customTitle: subscriptions.customTitle,
      fetchFullContent: subscriptions.fetchFullContent,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
    .for("update");
  return row;
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
  // Skips an entry whose twin from another feed the subscription already
  // holds, as the fetch-time fanout does (`holdsRedirectTwin`): a redirect
  // merge copies the old feed's entries into the subscription, and the new
  // feed usually republishes the same articles.
  await insertUserEntriesWithMemberships(
    tx,
    sql`
      SELECT ${subscriptionId}::uuid AS subscription_id, ${userId}::uuid AS user_id, e.id AS entry_id,
             COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
             e.is_spam, e.is_backfill AS read
      FROM entries e
      JOIN feeds f ON f.id = e.owner_feed_id
      WHERE e.owner_feed_id = ${feedId}
        AND e.type = 'web' -- lets the partial idx_entries_owner_feed_last_seen serve the range
        AND f.last_entries_updated_at IS NOT NULL
        AND e.last_seen_at >= f.last_entries_updated_at
        AND NOT ${holdsRedirectTwin(sql`${subscriptionId}::uuid`, "e")}
    `
  );
}

// ============================================================================
// Service Functions
// ============================================================================

/** The most subscriptions one page of the list returns, on every surface. */
export const MAX_SUBSCRIPTIONS_PAGE_SIZE = 100;

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

  const effectiveLimit = Math.min(limit, MAX_SUBSCRIPTIONS_PAGE_SIZE);

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
  const results = await buildSubscriptionBaseQuery(db, and(...conditions))
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
  return (await selectAllSubscriptionRows(db, userId)).map(formatSubscriptionRow);
}

/**
 * {@link listAllSubscriptions} with each subscription's Google Reader stream
 * serial (`subscriptions.greader_stream_id`), for the Google Reader layer.
 */
export async function listAllSubscriptionsWithStreamIds(
  db: typeof dbType,
  userId: string
): Promise<Array<Subscription & { greaderStreamId: bigint }>> {
  return (await selectAllSubscriptionRows(db, userId)).map((row) => ({
    ...formatSubscriptionRow(row),
    greaderStreamId: row.greaderStreamId,
  }));
}

function selectAllSubscriptionRows(db: typeof dbType, userId: string) {
  return buildSubscriptionBaseQuery(db, eq(userFeeds.userId, userId)).orderBy(
    sql`COALESCE(${userFeeds.title}, '') ASC`,
    userFeeds.id
  );
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
  const results = await buildSubscriptionBaseQuery(
    db,
    and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId))
  ).limit(1);

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
  /** When `unreadCount` was read (`countsAsOfSchema`) */
  unreadCountAsOf: string;
  /** True if the subscription already existed and was active (idempotent return) */
  alreadyActive: boolean;
  /** User's custom title for this subscription (null = use feed title) */
  customTitle: string | null;
  /** Whether to fetch full article content from URL */
  fetchFullContent: boolean;
  /** Feed data (from existing or newly created feed) */
  feed: {
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
    type: "web" as const,
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
    // Reactivating moves the members' rows, which come first in the lock order.
    await lockSubscriptionMembers(
      tx,
      userId,
      and(eq(subscriptions.feedId, feedId), isNotNull(subscriptions.unsubscribedAt))
    );

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
      INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, fetch_full_content)
      VALUES (${newSubscriptionId}, ${userId}, ${feedId}, 'web', ${subscribedAt}, ${subscribedAt}, ${subscribedAt}, ${defaultFullContent})
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
        throw new Error("Active subscription vanished after upsert conflict");
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
    const viewResults = await buildSubscriptionBaseQuery(
      db,
      and(eq(userFeeds.id, txResult.subscriptionId), eq(userFeeds.userId, userId))
    ).limit(1);

    return {
      subscriptionId: txResult.subscriptionId,
      subscribedAt: txResult.subscribedAt,
      unreadCount: viewResults.length > 0 ? viewResults[0].unreadCount : 0,
      unreadCountAsOf: formatCountsAsOf(
        viewResults.length > 0 ? viewResults[0].unreadCountAsOf : await countsAsOfNow(db)
      ),
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
      customTitle,
      subscribedAt: subscribedAt.toISOString(),
      unreadCount,
      tags: [],
    },
    feedData,
    counts
  );

  return {
    subscriptionId,
    subscribedAt,
    unreadCount,
    unreadCountAsOf: counts.asOf,
    alreadyActive: false,
    customTitle,
    fetchFullContent,
    feed: feedData,
    counts,
  };
}

/**
 * Fetch a URL, discover feeds if HTML, parse the feed content,
 * and return metadata for subscription creation.
 */
async function fetchAndResolveFeed(inputUrl: string): Promise<CreateSubscriptionFeedInput> {
  const { text: content, contentType, finalUrl: initialFinalUrl } = await fetchUrl(inputUrl);

  let feedContent: string;
  let finalFeedUrl: string;

  if (isHtmlContent(contentType, content)) {
    const discoveredFeeds = discoverFeeds(content, initialFinalUrl);
    if (discoveredFeeds.length === 0) {
      throw errors.validation("No feeds found at this URL");
    }

    const discoveredFetch = await fetchUrl(discoveredFeeds[0].url);
    feedContent = discoveredFetch.text;
    finalFeedUrl = discoveredFetch.finalUrl;
  } else {
    feedContent = content;
    finalFeedUrl = initialFinalUrl;
  }

  let parsedFeed;
  try {
    parsedFeed = await parseFeedAsync(feedContent);
  } catch {
    throw errors.validation("Could not parse feed - make sure it's a valid RSS or Atom feed");
  }

  let feedTitle = parsedFeed.title || getDomainFromUrl(finalFeedUrl);
  if (feedTitle) {
    feedTitle = getFeedHooks(finalFeedUrl).transformFeedTitle(feedTitle, parsedFeed.items);
  }

  return {
    url: finalFeedUrl,
    title: feedTitle ?? null,
    description: parsedFeed.description || null,
    siteUrl: parsedFeed.siteUrl || null,
  };
}

/**
 * Subscribes the user to the feed at a URL the user gave us, which may be an
 * HTML page that advertises its feed. Every surface that subscribes by URL
 * (tRPC, Google Reader `quickadd`) goes through here, so they all validate the
 * feed, schedule its fetch and notify open clients the same way.
 */
export async function subscribeToUrl(
  db: typeof dbType,
  userId: string,
  feedUrl: string
): Promise<CreateSubscriptionResult> {
  const [existing] = await db
    .select({
      id: feeds.id,
      lastFetchedAt: feeds.lastFetchedAt,
      nextFetchAt: feeds.nextFetchAt,
      websubActive: feeds.websubActive,
    })
    .from(feeds)
    .where(eq(feeds.url, feedUrl))
    .limit(1);

  // A feed we've never fetched successfully (brand new, or a raw URL from an
  // OPML import that may really be an HTML page) is fetched and parsed here to
  // resolve the real feed URL and its metadata; its entries come from the
  // background fetch job, so it needs no forced refresh. An unreachable or
  // unparseable URL fails the subscribe.
  if (!existing || existing.lastFetchedAt === null) {
    return createSubscription(db, userId, await fetchAndResolveFeed(feedUrl));
  }

  // A known feed's cached entries may be stale (a WebSub feed whose last real
  // poll has aged out, or a feed past its poll cadence), and we can't know the
  // current set without re-fetching. Rather than fetch on the request path,
  // skip the synchronous populate and force a background refresh, whose fanout
  // populates this subscriber from ground truth, excluding anything the
  // publisher has since removed (#1078).
  const stale = shouldRefetchOnSubscribe(existing);
  const result = await createSubscription(
    db,
    userId,
    { url: feedUrl },
    {
      skipInitialPopulate: stale,
    }
  );
  // The job queue is single-flight per feed, so concurrent subscribes coalesce
  // into one fetch. An already-active subscription has nothing to populate.
  if (stale && !result.alreadyActive) {
    await scheduleFeedRefreshNow(existing.id);
  }
  return result;
}

function selectSubscriptionTags(db: DbOrTx, subscriptionId: string): Promise<Tag[]> {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(subscriptionTags)
    .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
    .where(eq(subscriptionTags.subscriptionId, subscriptionId));
}

export const CUSTOM_TITLE_MAX_LENGTH = 255;

export interface UpdateSubscriptionParams {
  /**
   * The new name, trimmed. Blank or null clears it: a feed falls back to its
   * own title, an email subscription to its sender, and a collection, which
   * must have a name, fails.
   */
  customTitle?: string | null;
  fetchFullContent?: boolean;
}

/**
 * Updates one of the user's listed subscriptions. A collection's name is
 * unique among the user's active collections ignoring case
 * (COLLECTION_NAME_TAKEN otherwise). Bumps `updated_at` and publishes
 * subscription_updated only when a value actually changes (#1160).
 */
export async function updateSubscription(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  params: UpdateSubscriptionParams
): Promise<Subscription> {
  const updateData: { customTitle?: string | null; fetchFullContent?: boolean } = {};

  if (params.customTitle !== undefined) {
    const title = params.customTitle?.trim() ?? "";
    if (title.length > CUSTOM_TITLE_MAX_LENGTH) {
      throw errors.validation(`Custom title must be at most ${CUSTOM_TITLE_MAX_LENGTH} characters`);
    }
    if (title) {
      updateData.customTitle = title;
    } else {
      // A subscription's type never changes, so checking first can't race.
      const cleared = await clearedCustomTitle(db, userId, subscriptionId);
      if (!cleared) {
        throw errors.validation("Collection name is required");
      }
      updateData.customTitle = cleared.customTitle;
    }
  }
  if (params.fetchFullContent !== undefined) {
    updateData.fetchFullContent = params.fetchFullContent;
  }

  // `updated_at` drives the subscription delta-sync cursor and gates the
  // publish, so it moves only when a value changes. The self-join on `prev`
  // captures the pre-update values in the UPDATE itself, so a concurrent
  // update can't slip into a pre-SELECT's window.
  const prev = alias(subscriptions, "prev");
  const changedFragments: SQL[] = [];
  if (updateData.customTitle !== undefined) {
    changedFragments.push(sql`${prev.customTitle} IS DISTINCT FROM ${updateData.customTitle}`);
  }
  if (updateData.fetchFullContent !== undefined) {
    changedFragments.push(sql`${prev.fetchFullContent} <> ${updateData.fetchFullContent}`);
  }
  const meaningfulChange =
    changedFragments.length > 0 ? sql`(${sql.join(changedFragments, sql` OR `)})` : sql`false`;

  const now = new Date();
  const [updated] = await db
    .update(subscriptions)
    .set({
      ...updateData,
      updatedAt: sql`CASE WHEN ${meaningfulChange} THEN ${now} ELSE ${prev.updatedAt} END`,
    })
    .from(prev)
    .where(
      and(
        eq(prev.id, subscriptions.id),
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isListedSubscription()
      )
    )
    .returning({
      customTitle: subscriptions.customTitle,
      fetchFullContent: subscriptions.fetchFullContent,
      changed: sql<boolean>`${meaningfulChange}`,
    })
    .catch((err: unknown) => {
      // Only custom_title can collide: with another active collection's name.
      throw isUniqueViolation(err) ? errors.collectionNameTaken() : err;
    });

  if (!updated) {
    throw errors.subscriptionNotFound();
  }

  if (updated.changed) {
    const currentTags = await selectSubscriptionTags(db, subscriptionId);
    publishSubscriptionUpdated(
      userId,
      subscriptionId,
      now,
      currentTags,
      updated.customTitle,
      updated.fetchFullContent
    );
  }

  return getSubscription(db, userId, subscriptionId);
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
  await changeSubscriptionTags(db, userId, subscriptionId, { set: tagIds });
}

/**
 * Adds and removes some of a subscription's tags, leaving the others, for
 * clients that edit tags one at a time (Google Reader). Same rules as
 * {@link setSubscriptionTags}.
 */
export async function editSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  change: { add: string[]; remove: string[] }
): Promise<void> {
  await changeSubscriptionTags(db, userId, subscriptionId, change);
}

async function changeSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  change: { set: string[] } | { add: string[]; remove: string[] }
): Promise<void> {
  const addedTagIds = [...new Set("set" in change ? change.set : change.add)];
  // The saved subscription can't be tagged (#1846): like any subscription the
  // user can't see, it's not found.
  const [existingSubscription] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isListedSubscription()
      )
    )
    .limit(1);

  if (!existingSubscription) {
    throw errors.subscriptionNotFound();
  }

  // Excluding tombstoned tags prevents assigning a tag that is invisible in
  // listTags (which would silently drop the subscription from "Uncategorized").
  const validTags =
    addedTagIds.length === 0
      ? []
      : await db
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(eq(tags.userId, userId), inArray(tags.id, addedTagIds), isNull(tags.deletedAt))
          );
  if (validTags.length !== addedTagIds.length) {
    throw errors.validation("One or more tag IDs are invalid or do not belong to you");
  }

  const now = new Date();

  // One transaction, or a crash or concurrent call between the delete and the
  // insert could leave a partial tag set (#952).
  const after = await db.transaction(async (tx) => {
    // Subscription row first: the counter triggers lock subscriptions, then
    // users, then tags, and the tag changes below reach users and tags. Its
    // title is read under the lock, so the event can't revert a concurrent
    // rename.
    const locked = await lockSubscriptionRow(tx, userId, subscriptionId);

    let changed: boolean;
    if ("set" in change) {
      // RETURNING captures the prior tag set race-free, to tell a real change
      // from a re-apply of the identical set (#1160).
      const deleted = await tx
        .delete(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subscriptionId))
        .returning({ tagId: subscriptionTags.tagId });
      if (addedTagIds.length > 0) {
        await tx
          .insert(subscriptionTags)
          .values(addedTagIds.map((tagId) => ({ subscriptionId, tagId, createdAt: now })));
      }
      const previousTagIds = new Set(deleted.map((d) => d.tagId));
      changed =
        previousTagIds.size !== addedTagIds.length ||
        !addedTagIds.every((id) => previousTagIds.has(id));
    } else {
      const removedTagIds = change.remove.filter((id) => !addedTagIds.includes(id));
      const deleted =
        removedTagIds.length === 0
          ? []
          : await tx
              .delete(subscriptionTags)
              .where(
                and(
                  eq(subscriptionTags.subscriptionId, subscriptionId),
                  inArray(subscriptionTags.tagId, removedTagIds)
                )
              )
              .returning({ tagId: subscriptionTags.tagId });
      const inserted =
        addedTagIds.length === 0
          ? []
          : await tx
              .insert(subscriptionTags)
              .values(addedTagIds.map((tagId) => ({ subscriptionId, tagId, createdAt: now })))
              .onConflictDoNothing()
              .returning({ tagId: subscriptionTags.tagId });
      changed = deleted.length > 0 || inserted.length > 0;
    }

    if (!changed) {
      return null;
    }
    // updated_at drives the subscription delta-sync cursor.
    await tx
      .update(subscriptions)
      .set({ updatedAt: now })
      .where(eq(subscriptions.id, subscriptionId));
    return {
      tags: await selectSubscriptionTags(tx, subscriptionId),
      customTitle: locked?.customTitle ?? null,
      fetchFullContent: locked?.fetchFullContent,
    };
  });

  if (after) {
    publishSubscriptionUpdated(
      userId,
      subscriptionId,
      now,
      after.tags,
      after.customTitle,
      after.fetchFullContent
    );
  }
}

/**
 * Unsubscribes (soft-deletes) one of the user's active subscriptions, returning
 * the affected lists' post-delete absolute counts, or null if there is no such
 * active subscription. Every unsubscribe path goes through here so they all do
 * the same thing: for an email subscription, send the sender's list-unsubscribe request
 * and block the sender; then remove its tags, soft-delete it, and publish
 * subscription_deleted.
 */
export async function unsubscribe(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<{ counts: BulkUnreadCounts } | null> {
  const [existing] = await db
    .select({
      feedId: subscriptions.feedId,
      type: subscriptions.type,
      emailSender: subscriptions.emailSender,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        // The saved subscription can't be unsubscribed (#1846).
        isListedSubscription()
      )
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  const now = new Date();

  // The unsubscribe request and mailto lookup are network/side-effecting work,
  // so they run BEFORE the transaction; only the blocked_senders row is written
  // inside it. Both read the emails the subscription owns (#1846).
  let blockedSenderValues: typeof blockedSenders.$inferInsert | null = null;
  if (existing.type === "email" && existing.emailSender) {
    const unsubscribeResult = await attemptUnsubscribe(subscriptionId);

    logger.info("Email unsubscribe attempt completed", {
      subscriptionId,
      userId,
      senderEmail: existing.emailSender,
      sent: unsubscribeResult.sent,
      method: unsubscribeResult.method,
    });

    blockedSenderValues = {
      id: generateUuidv7(),
      userId,
      senderEmail: existing.emailSender,
      blockedAt: now,
      listUnsubscribeMailto: await getLatestUnsubscribeMailto(subscriptionId),
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
      .returning({ id: subscriptions.id, type: subscriptions.type });
    if (softDeleted.length === 0) {
      return null;
    }
    if (softDeleted[0].type === "collection") {
      // Its members leave a collection, which is per-user entry state: move
      // their updated_at so delta sync re-delivers them (or reports them
      // hidden), as removing them one by one would. Their rows are locked.
      await tx
        .update(userEntries)
        .set({ updatedAt: now })
        .where(
          and(
            eq(userEntries.userId, userId),
            inArray(
              userEntries.entryId,
              tx
                .select({ id: subscriptionEntries.entryId })
                .from(subscriptionEntries)
                .where(eq(subscriptionEntries.subscriptionId, subscriptionId))
            )
          )
        );
    }

    if (blockedSenderValues) {
      await tx.insert(blockedSenders).values(blockedSenderValues).onConflictDoNothing();
      logger.info("Added sender to blocked list", {
        userId,
        senderEmail: blockedSenderValues.senderEmail,
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

  publishSubscriptionDeleted(userId, existing.feedId, subscriptionId, now, counts);

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
    // Lock order: the user_entries rows the re-stamp moves and the
    // (de)activations change (both subscriptions' members), then the
    // subscription rows (see "Unread Counts" in src/server/CLAUDE.md).
    await lockSubscriptionMembers(
      tx,
      userId,
      or(eq(subscriptions.id, oldSubscriptionId), eq(subscriptions.feedId, newFeed.id))
    );

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
      INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, custom_title, fetch_full_content)
      VALUES (${generateUuidv7()}, ${userId}, ${newFeed.id}, 'web', ${now}, ${now}, ${now}, ${old.customTitle}, ${old.fetchFullContent || defaultFullContent})
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

    // The survivor takes the old subscription's articles; the old one keeps
    // them, unsubscribed. Deliberately leaves user_entries.updated_at alone:
    // the articles stay visible, and bumping it would flood the user's delta
    // sync.
    await tx.execute(sql`
      INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
      SELECT ${survivor.id}::uuid, user_id, entry_id, published_or_fetched_at
      FROM subscription_entries
      WHERE subscription_id = ${oldSubscriptionId}
      ON CONFLICT DO NOTHING
    `);

    if (!survivorWasActive) {
      // Tags left on an inactive subscription are stale (unsubscribing clears them).
      await tx.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, survivor.id));
      // After the copy, so the populate's GUID check sees the old feed's entries.
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
  publishSubscriptionDeleted(userId, oldFeedId, oldSubscriptionId, now, counts);
  if (!survivorWasActive) {
    publishSubscriptionCreated(
      userId,
      newFeed.id,
      survivor.id,
      now,
      {
        customTitle: survivor.customTitle,
        subscribedAt: survivor.subscribedAt.toISOString(),
        unreadCount: counts.subscriptions.find((s) => s.id === survivor.id)?.unread ?? 0,
        tags: survivorTags,
      },
      {
        type: "web",
        url: newFeed.url,
        title: newFeed.title,
        description: newFeed.description,
        siteUrl: newFeed.siteUrl,
      },
      counts
    );
  } else if (merged.survivorTagsChanged) {
    publishSubscriptionUpdated(userId, survivor.id, now, survivorTags, survivor.customTitle);
  }

  return true;
}
