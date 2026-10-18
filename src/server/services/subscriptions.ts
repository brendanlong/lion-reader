/**
 * Subscriptions Service
 *
 * Reading the user's subscriptions, the predicates every subscription query
 * shares, and the lock helpers transactions that move a subscription's
 * members take first. Subscribing (and redirect merges) is in `subscribe.ts`;
 * renames, tags and unsubscribing are in `subscription-updates.ts`.
 */

import { z } from "zod";
import { eq, and, gt, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import {
  subscriptionEntries,
  subscriptions,
  tags,
  subscriptionTags,
  userEntries,
  userFeeds,
  type FeedType,
} from "@/server/db/schema";
import { countsAsOfColumn, formatCountsAsOf } from "@/server/services/counts";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";
import { errors } from "@/server/errors";
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
 * Matches the subscriptions users manage themselves: every type but `saved`.
 * Each user's one saved subscription holds the Saved list's memberships
 * (#1846); a first save creates it. Subscription lists show it, but it can't
 * be tagged, renamed or unsubscribed (those treat it as not found), and it
 * isn't in Uncategorized, the subscription cap or sync's subscription deltas.
 * Pass `user_feeds.type` when querying the view.
 */
export function isUserManagedSubscription(
  type: typeof subscriptions.type | typeof userFeeds.type = subscriptions.type
): SQL {
  return ne(type, "saved");
}

/**
 * Builds the base query for fetching subscriptions using the user_feeds view,
 * limited to `where`. Includes unread counts and tags.
 *
 * The unread count is the trigger-maintained `subscriptions.unread_count`
 * counter (migration 0092, exposed through the view in migration 0093) — a
 * free column read, so there is no opt-out (the old `includeUnreadCounts`
 * option existed because the count was a scan over visible_entries that
 * scaled with the unread backlog, issue #1074). Spam never counts.
 */
export function buildSubscriptionBaseQuery(db: typeof dbType, where: SQL | undefined) {
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
    .where(where)
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
 * Counts the user's active subscriptions (collections included, the
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
        isUserManagedSubscription()
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

  // Uncategorized filter (subscriptions with no tags; never Saved)
  if (uncategorized) {
    conditions.push(isUserManagedSubscription(userFeeds.type));
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
