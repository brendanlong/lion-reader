/**
 * Sync Service
 *
 * Incremental sync for pull-based updates: the current cursors, and the
 * changes since a client's cursors as SSE-compatible events. Backs the web
 * client's catch-up when SSE is unavailable or after a disconnect, and the
 * native app's delta sync.
 */

import { z } from "zod";
import { eq, and, desc, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import { ENTRY_TOMBSTONE_RETENTION_MS } from "@/server/services/entry-tombstones";
import {
  subscriptionEntries,
  entries,
  feeds,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
  entryTombstones,
} from "@/server/db/schema";
import { legacyFeedId, syncTagSchema, serverSyncEventSchema } from "@/lib/events/schemas";
import {
  entryFeedTitleSql,
  entryMemberships,
  entryOriginOn,
  visibleUserEntrySql,
} from "@/server/services/entry-filters";
import { entryRowToSyncEvents } from "@/server/services/entry-sync-events";
import type { Database } from "@/server/db";
import { parseTimestamptz, parseTimestamptzOrNull } from "@/server/db/temporal";
import { getBulkEntryRelatedCounts } from "@/server/services/counts";
import { isCollectionSubscription, isListedSubscription } from "@/server/services/subscriptions";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Batch-fetch tags grouped by subscription ID.
 * Used by sync.events to avoid N+1 queries.
 */
async function fetchTagsBySubscriptionIds(
  db: Database,
  subscriptionIds: string[]
): Promise<Map<string, Array<z.infer<typeof syncTagSchema>>>> {
  const result = new Map<string, Array<z.infer<typeof syncTagSchema>>>();
  if (subscriptionIds.length === 0) return result;

  const rows = await db
    .select({
      subscriptionId: subscriptionTags.subscriptionId,
      tagId: tags.id,
      tagName: tags.name,
      tagColor: tags.color,
    })
    .from(subscriptionTags)
    .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
    .where(inArray(subscriptionTags.subscriptionId, subscriptionIds));

  for (const row of rows) {
    const existing = result.get(row.subscriptionId) ?? [];
    existing.push({ id: row.tagId, name: row.tagName, color: row.tagColor });
    result.set(row.subscriptionId, existing);
  }

  return result;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of entries to return in a single sync response.
 * Prevents extremely large responses for initial syncs.
 */
const MAX_ENTRIES = 500;

/**
 * Sync cursor schema.
 *
 * Uses a single cursor per entity type based on its newest change.
 * For subscriptions, this combines new subscriptions with unsubscribes (both update updated_at).
 */
export const syncCursorsSchema = z.object({
  /** Cursor for entries - max(user_entries.changed_at): content, state and membership changes */
  entries: z.string().datetime().nullable(),
  /**
   * Id tiebreaker for the entries cursor. Together `(entries, entriesAfterId)`
   * form a keyset so a catch-up can page within a group of entries sharing one
   * timestamp (e.g. a large mark-all-read) instead of losing the tied rows to a
   * strict `>` comparison. It is the id of the entry achieving the max entries
   * timestamp; null when there are no entries.
   */
  entriesAfterId: z.string().uuid().nullable(),
  /** Cursor for subscriptions - max(subscriptions.updated_at), covers both active and removed */
  subscriptions: z.string().datetime().nullable(),
  /** Cursor for tags - max(tags.updated_at), covers creates, updates, and soft deletes */
  tags: z.string().datetime().nullable(),
});

/**
 * The user's current sync cursors: the newest change of each entity type.
 */
export async function currentSyncCursors(
  db: Database,
  userId: string
): Promise<z.infer<typeof syncCursorsSchema>> {
  // Each is read as a full-precision Temporal.Instant: a JavaScript Date's
  // millisecond truncation broke cursor comparisons (#680, #683).
  const [entriesResult, subscriptionsResult, tagsResult] = await Promise.all([
    // The `(entries, entriesAfterId)` keyset of the newest change.
    db
      .select({ ts: userEntries.changedAt, id: userEntries.entryId })
      .from(userEntries)
      .where(eq(userEntries.userId, userId))
      .orderBy(desc(userEntries.changedAt), desc(userEntries.entryId))
      .limit(1),

    // Subscriptions: max(updated_at) from ALL listed subscriptions (active and
    // removed); updated_at is set when unsubscribing, so this covers both cases
    db
      .select({
        max: sql`MAX(${subscriptions.updatedAt})`.mapWith(parseTimestamptzOrNull),
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), isListedSubscription())),

    // Tags: max(updated_at) - captures creates, updates, and soft deletes
    db
      .select({
        max: sql`MAX(${tags.updatedAt})`.mapWith(parseTimestamptzOrNull),
      })
      .from(tags)
      .where(eq(tags.userId, userId)),
  ]);

  const entriesRow = entriesResult[0];

  return {
    entries: entriesRow?.ts.toString() ?? null,
    entriesAfterId: entriesRow?.id ?? null,
    subscriptions: subscriptionsResult[0]?.max?.toString() ?? null,
    tags: tagsResult[0]?.max?.toString() ?? null,
  };
}

/**
 * How far behind the database clock the deletions cursor stays, so a delete
 * transaction that started before the cursor but hadn't committed yet is still
 * reported on the next sync.
 */
const DELETIONS_CURSOR_MARGIN_MS = 60 * 1000;

async function databaseNow(db: Database): Promise<Temporal.Instant> {
  const result = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  return parseTimestamptz(result.rows[0].now);
}

/**
 * Each entry's (active) collections, empty for one in none. Membership is per-user
 * entry state (changing it moves `user_entries.updated_at`), so an offline
 * store replaces an entry's memberships whenever its state is re-delivered.
 */
async function listCollectionMemberships(
  db: Database,
  userId: string,
  entryIds: string[]
): Promise<Array<{ entryId: string; subscriptionIds: string[] }>> {
  if (entryIds.length === 0) return [];
  const rows = await db
    .select({
      entryId: subscriptionEntries.entryId,
      subscriptionId: subscriptionEntries.subscriptionId,
    })
    .from(subscriptionEntries)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
    .where(
      and(
        eq(subscriptionEntries.userId, userId),
        inArray(subscriptionEntries.entryId, entryIds),
        isNull(subscriptions.unsubscribedAt),
        isCollectionSubscription()
      )
    );
  const byEntry = new Map<string, string[]>(entryIds.map((id) => [id, []]));
  for (const row of rows) {
    byEntry.get(row.entryId)?.push(row.subscriptionId);
  }
  return [...byEntry].map(([entryId, subscriptionIds]) => ({ entryId, subscriptionIds }));
}

/** Per-entity-type cursors, as a client sends them back. */
interface SyncCursorsInput {
  entries?: string;
  /**
   * Id tiebreaker for the entries cursor (keyset pagination within a
   * tied-timestamp group). Optional for backward compatibility: when absent the
   * server falls back to a strict timestamp comparison.
   */
  entriesAfterId?: string;
  /**
   * The entries keyset the catch-up started from, held constant across its
   * pages (defaults to the page cursor). Pages are ordered by an entry's
   * latest change, so an entry whose earlier change (creation, content edit)
   * falls before a later page's cursor still has to be classified against the
   * catch-up's start, or that change is never reported (#1663).
   */
  entriesSince?: string;
  entriesSinceAfterId?: string;
  subscriptions?: string;
  tags?: string;
}

export const syncCursorsInputSchema = z.object({
  entries: z.string().datetime().optional(),
  entriesAfterId: z.string().uuid().optional(),
  entriesSince: z.string().datetime().optional(),
  entriesSinceAfterId: z.string().uuid().optional(),
  subscriptions: z.string().datetime().optional(),
  tags: z.string().datetime().optional(),
});

type SyncEvent = z.infer<typeof serverSyncEventSchema>;
/** An event with its full-precision sort time (a Date would collapse µs ties). */
type TimedEvent = SyncEvent & { _sortTime: Temporal.Instant };

/** `(col, id)` is past the keyset `(ts, afterId)`; without an id, `col` is past `ts`. */
function afterKeyset(col: SQLWrapper, id: SQLWrapper, ts: string, afterId: string | null): SQL {
  return afterId
    ? sql`(${col}, ${id}) > (${ts}::timestamptz, ${afterId}::uuid)`
    : sql`${col} > ${ts}::timestamptz`;
}

/**
 * One page of the user's entries changed past the entries cursor, as events,
 * in `(changed_at, entry_id)` order: a range scan of
 * `idx_user_entries_changed_at` picks the page, and only its rows are
 * decorated. Which events a row gets (new, updated, state changed) is
 * classified in SQL, at µs precision, against the catch-up's start
 * (`entriesSince`, #1663).
 */
async function collectEntryEvents(
  db: Database,
  userId: string,
  cursors: SyncCursorsInput & { entries: string },
  reportHidden: boolean
) {
  // Selection pages on the cursor; classification is against the catch-up's
  // start. OR-ing in the cursor keeps every selected row eventful even if a
  // client sends a start past it.
  // `id` is the entry id column of the query the comparison is in.
  const afterCursor = (col: SQLWrapper, id: SQLWrapper = userEntries.entryId): SQL =>
    afterKeyset(col, id, cursors.entries, cursors.entriesAfterId ?? null);
  const afterSince = (col: SQLWrapper, id: SQLWrapper = userEntries.entryId): SQL =>
    cursors.entriesSince
      ? sql`(${afterCursor(col, id)} OR ${afterKeyset(col, id, cursors.entriesSince, cursors.entriesSinceAfterId ?? null)})`
      : afterCursor(col, id);

  const page = db.$with("page").as(
    db
      .select({
        userId: userEntries.userId,
        entryId: userEntries.entryId,
        changedAt: userEntries.changedAt,
        read: userEntries.read,
        starred: userEntries.starred,
        readChangedAt: userEntries.readChangedAt,
        visible: sql<boolean>`${visibleUserEntrySql()}`.as("visible"),
        stateChanged: sql<boolean>`${afterSince(userEntries.updatedAt)}`.as("state_changed"),
        stateUpdatedAt: sql<string>`${userEntries.updatedAt}`.as("state_updated_at"),
      })
      .from(userEntries)
      .where(
        and(
          eq(userEntries.userId, userId),
          afterCursor(userEntries.changedAt),
          // A row a state change took out of view is a deletion, paged with
          // the rest so none is lost past a page's end.
          reportHidden
            ? sql`(${visibleUserEntrySql()} OR ${afterSince(userEntries.updatedAt)})`
            : visibleUserEntrySql()
        )
      )
      .orderBy(userEntries.changedAt, userEntries.entryId)
      .limit(MAX_ENTRIES + 1)
  );

  const PAGE_ROW = { userId: page.userId, entryId: page.entryId };
  const memberships = entryMemberships(PAGE_ROW);
  const rows = await db
    .with(page)
    .select({
      id: entries.id,
      title: entries.title,
      author: entries.author,
      summary: entries.summary,
      url: entries.url,
      publishedAt: entries.publishedAt,
      fetchedAt: entries.fetchedAt,
      siteName: entries.siteName,
      entryUpdatedAt: entries.updatedAt,
      isSpam: entries.isSpam,
      isBackfill: entries.isBackfill,
      read: page.read,
      starred: page.starred,
      readChangedAt: page.readChangedAt,
      subscriptionId: subscriptions.id,
      subscriptionIds: memberships.subscriptionIds,
      feedType: entries.type,
      feedTitle: entryFeedTitleSql(),
      visible: page.visible,
      metadataChanged: sql<boolean>`${afterSince(entries.updatedAt, entries.id)}`,
      stateChanged: page.stateChanged,
      isNew: sql<boolean>`${afterSince(entries.createdAt, entries.id)}`,
      changedAt: page.changedAt,
      stateUpdatedAt: sql`${page.stateUpdatedAt}`.mapWith(parseTimestamptz),
    })
    .from(page)
    .innerJoin(entries, eq(entries.id, page.entryId))
    .leftJoin(feeds, eq(feeds.id, entries.ownerFeedId))
    .leftJoinLateral(memberships, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(memberships, PAGE_ROW))
    .orderBy(page.changedAt, page.entryId);

  const hasMore = rows.length > MAX_ENTRIES;
  if (hasMore) rows.pop();

  const visibleRows = rows.filter((row) => row.visible);
  const hidden = rows
    .filter((row) => !row.visible)
    .map((row) => ({ entryId: row.id, deletedAt: row.stateUpdatedAt.toString() }));
  const stateChangedIds = visibleRows.filter((row) => row.stateChanged).map((row) => row.id);

  // One absolute-count snapshot for every count-bearing event (new_entry and
  // entry_state_changed): the client sets counts rather than applying deltas,
  // so the events stay idempotent across the live-SSE / catch-up overlap.
  const counted = visibleRows.filter(
    (row) => row.stateChanged || (row.metadataChanged && row.isNew)
  );
  const counts =
    counted.length > 0
      ? await getBulkEntryRelatedCounts(
          db,
          userId,
          counted.map((row) => ({ id: row.id, subscriptionId: row.subscriptionId }))
        )
      : undefined;

  const events: TimedEvent[] = visibleRows.flatMap((row) =>
    entryRowToSyncEvents(
      { ...row, updatedAt: row.changedAt.toString() },
      { newEntry: counts, stateChanged: counts }
    ).map((event) => ({ ...event, _sortTime: row.changedAt }))
  );

  const last = rows.at(-1);
  return {
    events,
    hasMore,
    next: last ? { entries: last.changedAt.toString(), entriesAfterId: last.id } : null,
    hidden,
    stateChangedIds,
  };
}

/** Subscriptions changed past the cursor, as events (never paged). */
async function collectSubscriptionEvents(db: Database, userId: string, cursor: string) {
  const subscriptionResults = await db
    .select({
      subscription: subscriptions,
      feed: feeds,
      updatedAtInstant: sql`${subscriptions.updatedAt}`.mapWith(parseTimestamptz),
    })
    .from(subscriptions)
    .leftJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isListedSubscription(),
        sql`${subscriptions.updatedAt} > ${cursor}::timestamptz`
      )
    )
    .orderBy(subscriptions.updatedAt);

  const tagsBySubscription = await fetchTagsBySubscriptionIds(
    db,
    subscriptionResults
      .filter(({ subscription }) => subscription.unsubscribedAt === null)
      .map(({ subscription }) => subscription.id)
  );

  const cursorDate = new Date(cursor);
  const events = subscriptionResults.map(({ subscription, feed, updatedAtInstant }): TimedEvent => {
    const stamps = {
      timestamp: updatedAtInstant.toString(),
      updatedAt: updatedAtInstant.toString(),
      _sortTime: updatedAtInstant,
    };
    if (subscription.unsubscribedAt !== null) {
      return { type: "subscription_deleted", subscriptionId: subscription.id, ...stamps };
    }
    // Subscribed after the cursor: new. Otherwise its properties changed.
    if (subscription.subscribedAt > cursorDate) {
      return {
        type: "subscription_created",
        subscriptionId: subscription.id,
        ...stamps,
        subscription: {
          id: subscription.id,
          feedId: legacyFeedId(subscription.id),
          customTitle: subscription.customTitle,
          subscribedAt: subscription.subscribedAt.toISOString(),
          unreadCount: subscription.unreadCount,
          tags: tagsBySubscription.get(subscription.id) ?? [],
        },
        // A subscription without a feed (#1846) has only its own name.
        feed: {
          id: legacyFeedId(subscription.id),
          type: subscription.type,
          url: feed?.url ?? null,
          title: feed?.title ?? subscription.customTitle,
          description: feed?.description ?? null,
          siteUrl: feed?.siteUrl ?? null,
        },
      };
    }
    return {
      type: "subscription_updated",
      subscriptionId: subscription.id,
      tags: tagsBySubscription.get(subscription.id) ?? [],
      customTitle: subscription.customTitle,
      fetchFullContent: subscription.fetchFullContent,
      ...stamps,
    };
  });
  return { events, next: subscriptionResults.at(-1)?.updatedAtInstant.toString() };
}

/** Tags changed past the cursor, as events (never paged). */
async function collectTagEvents(db: Database, userId: string, cursor: string) {
  const tagResults = await db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      deletedAt: tags.deletedAt,
      updatedAtInstant: sql`${tags.updatedAt}`.mapWith(parseTimestamptz),
    })
    .from(tags)
    .where(and(eq(tags.userId, userId), sql`${tags.updatedAt} > ${cursor}::timestamptz`))
    .orderBy(tags.updatedAt);

  // The query keeps the string cursor for µs precision (#680); telling created
  // from updated only needs a Date.
  const cursorDate = new Date(cursor);
  const events = tagResults.map((row): TimedEvent => {
    const stamps = {
      timestamp: row.updatedAtInstant.toString(),
      updatedAt: row.updatedAtInstant.toString(),
      _sortTime: row.updatedAtInstant,
    };
    if (row.deletedAt !== null) return { type: "tag_deleted", tagId: row.id, ...stamps };
    const tag = { id: row.id, name: row.name, color: row.color };
    return row.createdAt > cursorDate
      ? { type: "tag_created", tag, ...stamps }
      : { type: "tag_updated", tag, ...stamps };
  });
  return { events, next: tagResults.at(-1)?.updatedAtInstant.toString() };
}

/**
 * Changes since the given cursors as individual events (SSE-compatible format),
 * sorted by timestamp, plus the cursors to send next time.
 *
 * Uses three separate cursors (one per entity type) for correct incremental
 * sync, matching the cursor tracking used in the SSE path. Only entries are
 * paged (`hasMore`); the next entries cursor is the last returned row's keyset,
 * so a paged catch-up never skips rows.
 *
 * With `reportHidden`, entries a state change took out of the user's view
 * since the catch-up's start (today, unstarring an entry of an unsubscribed
 * feed) come back as `hidden`, in the same pages: an offline store would
 * otherwise keep them (starred) forever. Only for a caller that takes the
 * returned cursors — a page of nothing but hidden rows has no events for a
 * client to advance its own cursor from.
 */
export async function collectSyncEvents(
  db: Database,
  userId: string,
  cursors: SyncCursorsInput,
  options: { reportHidden?: boolean } = {}
): Promise<{
  events: SyncEvent[];
  hasMore: boolean;
  next: SyncCursorsInput;
  hidden: Array<{ entryId: string; deletedAt: string }>;
  /** Visible entries whose per-user state (collection membership included) changed. */
  stateChangedIds: string[];
}> {
  // Cursors stay strings to keep Postgres µs precision (#680). A type without
  // one has nothing to diff against (sync.cursors establishes them).
  const { entries: entriesCursor, subscriptions: subscriptionsCursor, tags: tagsCursor } = cursors;
  const [entryResult, subscriptionResult, tagResult] = await Promise.all([
    entriesCursor
      ? collectEntryEvents(
          db,
          userId,
          { ...cursors, entries: entriesCursor },
          options.reportHidden ?? false
        )
      : null,
    subscriptionsCursor ? collectSubscriptionEvents(db, userId, subscriptionsCursor) : null,
    tagsCursor ? collectTagEvents(db, userId, tagsCursor) : null,
  ]);

  const events = [
    ...(entryResult?.events ?? []),
    ...(subscriptionResult?.events ?? []),
    ...(tagResult?.events ?? []),
  ]
    .sort((a, b) => Temporal.Instant.compare(a._sortTime, b._sortTime))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _sortTime, ...event }) => event as SyncEvent);

  return {
    events,
    hasMore: entryResult?.hasMore ?? false,
    next: {
      entries: entryResult?.next?.entries ?? cursors.entries,
      entriesAfterId: entryResult?.next?.entriesAfterId ?? cursors.entriesAfterId,
      subscriptions: subscriptionResult?.next ?? cursors.subscriptions,
      tags: tagResult?.next ?? cursors.tags,
    },
    hidden: entryResult?.hidden ?? [],
    stateChangedIds: entryResult?.stateChangedIds ?? [],
  };
}

export const syncChangesInputSchema = syncCursorsInputSchema.extend({
  deletions: z.string().datetime().optional(),
});

/**
 * Output schema for sync.changes (see the procedure).
 */
export const syncChangesOutputSchema = z.object({
  events: z.array(serverSyncEventSchema),
  hasMore: z.boolean(),
  cursors: z.object({
    entries: z.string().optional(),
    entriesAfterId: z.string().optional(),
    subscriptions: z.string().optional(),
    tags: z.string().optional(),
    deletions: z.string().optional(),
  }),
  deletions: z.array(z.object({ entryId: z.string(), deletedAt: z.string() })),
  collectionMemberships: z.array(
    z.object({ entryId: z.string(), subscriptionIds: z.array(z.string()) })
  ),
  resyncRequired: z.boolean(),
});

export type SyncChanges = z.infer<typeof syncChangesOutputSchema>;

/** The native app's delta sync; see the `sync.changes` procedure. */
export async function collectSyncChanges(
  db: Database,
  userId: string,
  input: z.infer<typeof syncChangesInputSchema>
): Promise<SyncChanges> {
  const { deletions: deletionsCursor, ...cursors } = input;
  // Deletions are stamped by the database clock (tombstones' DEFAULT
  // now(), which is also their transaction's start), so the deletions
  // cursor is read from it too, backed off by a margin that covers a
  // delete transaction still in flight. Re-reporting a deletion is harmless.
  const safeDeletionsCursorFrom = (now: Temporal.Instant) =>
    now.subtract({ milliseconds: DELETIONS_CURSOR_MARGIN_MS });

  if (!deletionsCursor && !cursors.entries && !cursors.subscriptions && !cursors.tags) {
    const [dbNow, current] = await Promise.all([databaseNow(db), currentSyncCursors(db, userId)]);
    // A null cursor means "nothing yet"; start from the epoch so the first
    // change still sorts after it.
    const epoch = new Date(0).toISOString();
    return {
      events: [],
      hasMore: false,
      cursors: {
        entries: current.entries ?? epoch,
        entriesAfterId: current.entriesAfterId ?? undefined,
        subscriptions: current.subscriptions ?? epoch,
        tags: current.tags ?? epoch,
        deletions: safeDeletionsCursorFrom(dbNow).toString(),
      },
      deletions: [],
      collectionMemberships: [],
      resyncRequired: false,
    };
  }

  // Independent reads, so in parallel; a deletions cursor past the retention
  // horizon discards the rest.
  const [dbNow, changes, tombstones] = await Promise.all([
    databaseNow(db),
    collectSyncEvents(db, userId, cursors, { reportHidden: true }),
    deletionsCursor
      ? db
          .select({
            entryId: entryTombstones.entryId,
            deletedAt: entryTombstones.deletedAt,
          })
          .from(entryTombstones)
          .where(
            and(
              eq(entryTombstones.userId, userId),
              sql`${entryTombstones.deletedAt} > ${deletionsCursor}::timestamptz`
            )
          )
          .orderBy(entryTombstones.deletedAt)
          .limit(MAX_ENTRIES + 1)
      : [],
  ]);
  const safeDeletionsCursor = safeDeletionsCursorFrom(dbNow);

  const horizon = dbNow.subtract({ milliseconds: ENTRY_TOMBSTONE_RETENTION_MS });
  if (
    deletionsCursor &&
    Temporal.Instant.compare(Temporal.Instant.from(deletionsCursor), horizon) < 0
  ) {
    return {
      events: [],
      hasMore: false,
      cursors: { ...cursors, deletions: deletionsCursor },
      deletions: [],
      collectionMemberships: [],
      resyncRequired: true,
    };
  }

  const { events, hasMore, next, hidden, stateChangedIds } = changes;
  const collectionMemberships = await listCollectionMemberships(db, userId, stateChangedIds);

  const moreTombstones = tombstones.length > MAX_ENTRIES;
  if (moreTombstones) {
    tombstones.pop();
  }

  // With every tombstone up to the safe point delivered, the cursor moves
  // to that point even when there were none, so a client with no deletions
  // doesn't drift past the retention horizon. It never moves backwards.
  let nextDeletions = tombstones.at(-1)?.deletedAt ?? null;
  if (!moreTombstones) {
    const floor = deletionsCursor ? Temporal.Instant.from(deletionsCursor) : null;
    nextDeletions = [nextDeletions, safeDeletionsCursor, floor]
      .filter((t): t is Temporal.Instant => t !== null)
      .reduce((a, b) => (Temporal.Instant.compare(a, b) >= 0 ? a : b));
  }

  return {
    events,
    hasMore: hasMore || moreTombstones,
    cursors: {
      ...next,
      deletions: nextDeletions?.toString() ?? deletionsCursor,
    },
    deletions: [
      ...tombstones.map((row) => ({
        entryId: row.entryId,
        deletedAt: row.deletedAt.toString(),
      })),
      ...hidden,
    ],
    collectionMemberships,
    resyncRequired: false,
  };
}
