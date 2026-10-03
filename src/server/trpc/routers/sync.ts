/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";
import { eq, and, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { ENTRY_TOMBSTONE_RETENTION_MS } from "@/server/services/entry-tombstones";
import {
  entries,
  feeds,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
  entryTombstones,
} from "@/server/db/schema";
import { syncTagSchema, serverSyncEventSchema } from "@/lib/events/schemas";
import { entryRowToSyncEvents } from "@/server/services/entry-sync-events";
import type { Database } from "@/server/db";
import { parseTimestamptz, parseTimestamptzOrNull } from "@/server/db/temporal";
import { getBulkEntryRelatedCounts } from "@/server/services/counts";
import { getSavedFeedId } from "@/server/feed/saved-feed";

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

const appProcedure = scopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS);

/**
 * Maximum number of entries to return in a single sync response.
 * Prevents extremely large responses for initial syncs.
 */
const MAX_ENTRIES = 500;

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Output schema for sync.events procedure.
 * Uses the shared server event schema (no defaults/transforms).
 */
const syncEventsOutputSchema = z.object({
  events: z.array(serverSyncEventSchema),
  hasMore: z.boolean(),
});

/**
 * Output schema for sync.changes (see the procedure).
 */
const syncChangesOutputSchema = z.object({
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
  resyncRequired: z.boolean(),
});

/**
 * Sync cursor schema.
 *
 * Uses a single cursor per entity type based on max(updated_at).
 * For entries, this combines entry metadata changes with read/starred state changes.
 * For subscriptions, this combines new subscriptions with unsubscribes (both update updated_at).
 */
const syncCursorsSchema = z.object({
  /** Cursor for entries - max of GREATEST(entries.updated_at, user_entries.updated_at) */
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
async function currentSyncCursors(
  db: Database,
  userId: string
): Promise<z.infer<typeof syncCursorsSchema>> {
  // Run all max queries in parallel for efficiency.
  // The pool returns Postgres's raw microsecond string for timestamptz, which
  // parseTimestamptzOrNull / mapWith decodes to a full-precision
  // Temporal.Instant — avoiding the JavaScript Date truncation that caused
  // cursor comparison bugs (#680, #683).
  const [entriesResult, subscriptionsResult, tagsResult] = await Promise.all([
    // ── Entries cursor: argmax of GREATEST(entries.updated_at,
    //    user_entries.updated_at) over the user's entries, plus the id
    //    achieving it — the `(entries, entriesAfterId)` keyset. ─────────────
    //
    // GREATEST(e, ue) spans two tables, so no index can serve an ORDER BY on
    // it: the naive `user_entries ⨝ entries ORDER BY GREATEST(...) DESC LIMIT
    // 1` had to materialize the value for EVERY one of the user's entries
    // (nested-loop PK lookup into entries per row) and top-N sort the lot —
    // O(user's entire history), on every SSR and every SSE (re)connect. For a
    // heavy user that measured ~125 ms / ~200k buffers. This is the same class
    // of problem #1105 fixed for the sibling sync.events delta; the argmax was
    // left on the old shape.
    //
    // The fix uses the identity  max_i GREATEST(a_i, b_i) = GREATEST(max_i a_i,
    // max_i b_i)  to split into index-served arms, each returning its own
    // top (ts, id); the outer `ORDER BY ts DESC, id DESC LIMIT 1` then picks
    // the overall argmax:
    //   arm_ue  — max user_entries.updated_at (state changes + new entries, since
    //             fanout stamps ue.updated_at = now()), via
    //             idx_user_entries_updated_at.
    //   arm_sub — max entries.updated_at (content refetches that bump the entry
    //             but not the ue row) over the user's feeds, driven from
    //             subscriptions into idx_entries_feed_updated_at per feed.
    //   arm_saved — same, for the saved-articles feed (no subscription row).
    // The two entry arms are bounded to updated_at >= arm_ue's max (the `bound`
    // CTE): an entry only changes the answer when its content update is at least
    // as new as the newest state change, so this keeps the per-feed index seeks
    // near-empty in the common case (user activity is newest) while still
    // catching — and correctly id-tiebreaking, `>=` includes the tied boundary —
    // the rare case where a content update is the most recent change. Joining
    // user_entries in both arms preserves the old query's set (entries the user
    // actually has a row for). Driving arm_sub from ALL subscriptions (active
    // and unsubscribed) covers starred orphans, whose subscription row survives
    // unsubscribe. Measured ~1.3 ms / ~1.1k buffers on the same heavy user.
    db.execute<{ ts: string | null; id: string | null }>(sql`
      WITH arm_ue AS (
        SELECT ue.updated_at AS ts, ue.entry_id AS id
        FROM user_entries ue
        WHERE ue.user_id = ${userId}::uuid
        ORDER BY ue.updated_at DESC, ue.entry_id DESC
        LIMIT 1
      ),
      bound AS (
        SELECT COALESCE((SELECT ts FROM arm_ue), '-infinity'::timestamptz) AS ts
      ),
      arm_sub AS (
        SELECT e.updated_at AS ts, e.id
        FROM subscriptions s
        JOIN entries e
          ON e.feed_id = s.feed_id
          AND e.updated_at >= (SELECT ts FROM bound)
        JOIN user_entries ue2
          ON ue2.entry_id = e.id AND ue2.user_id = ${userId}::uuid
        WHERE s.user_id = ${userId}::uuid
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT 1
      ),
      arm_saved AS (
        SELECT e.updated_at AS ts, e.id
        FROM entries e
        JOIN user_entries ue2
          ON ue2.entry_id = e.id AND ue2.user_id = ${userId}::uuid
        WHERE e.feed_id = (
            SELECT id FROM feeds WHERE user_id = ${userId}::uuid AND type = 'saved'
          )
          AND e.updated_at >= (SELECT ts FROM bound)
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT 1
      )
      SELECT ts, id FROM (
        SELECT ts, id FROM arm_ue
        UNION ALL SELECT ts, id FROM arm_sub
        UNION ALL SELECT ts, id FROM arm_saved
      ) c
      WHERE ts IS NOT NULL
      ORDER BY ts DESC, id DESC
      LIMIT 1
    `),

    // Subscriptions: max(updated_at) from ALL subscriptions (active and removed)
    // updated_at is set when unsubscribing, so this covers both cases
    db
      .select({
        max: sql`MAX(${subscriptions.updatedAt})`.mapWith(parseTimestamptzOrNull),
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId)),

    // Tags: max(updated_at) - captures creates, updates, and soft deletes
    db
      .select({
        max: sql`MAX(${tags.updatedAt})`.mapWith(parseTimestamptzOrNull),
      })
      .from(tags)
      .where(eq(tags.userId, userId)),
  ]);

  const entriesRow = entriesResult.rows[0];

  return {
    entries: parseTimestamptzOrNull(entriesRow?.ts)?.toString() ?? null,
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
 * The `visible_entries` predicate, over `user_entries` joined to `entries`
 * and left-joined to `subscriptions` on the stamped subscription id. It is
 * fail-closed: an orphaned row's NULL subscription is hidden unless starred
 * or saved (#1080).
 */
function visibleEntrySql(): SQL {
  return sql`((${subscriptions.id} IS NOT NULL AND ${subscriptions.unsubscribedAt} IS NULL) OR ${userEntries.starred} = true OR ${entries.type} = 'saved')`;
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

const syncCursorsInputSchema = z.object({
  entries: z.string().datetime().optional(),
  entriesAfterId: z.string().uuid().optional(),
  entriesSince: z.string().datetime().optional(),
  entriesSinceAfterId: z.string().uuid().optional(),
  subscriptions: z.string().datetime().optional(),
  tags: z.string().datetime().optional(),
});

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
async function collectSyncEvents(
  db: Database,
  userId: string,
  cursors: SyncCursorsInput,
  options: { reportHidden?: boolean } = {}
): Promise<{
  events: z.infer<typeof serverSyncEventSchema>[];
  hasMore: boolean;
  next: SyncCursorsInput;
  hidden: Array<{ entryId: string; deletedAt: string }>;
}> {
  // Keep cursors as strings to preserve Postgres µs precision (#680)
  const entriesCursor = cursors.entries ?? null;
  const subscriptionsCursor = cursors.subscriptions ?? null;
  const tagsCursor = cursors.tags ?? null;

  // If no cursors provided, return empty events (initial cursor establishment
  // is handled by sync.cursors endpoint)
  const next: SyncCursorsInput = {
    entries: cursors.entries,
    entriesAfterId: cursors.entriesAfterId,
    subscriptions: cursors.subscriptions,
    tags: cursors.tags,
  };
  const hidden: Array<{ entryId: string; deletedAt: string }> = [];
  if (!entriesCursor && !subscriptionsCursor && !tagsCursor) {
    return { events: [], hasMore: false, next, hidden };
  }

  // Collect all events with their timestamps for sorting. _sortTime is a
  // full-precision Temporal.Instant so tied-timestamp events sort correctly
  // (a JS Date would collapse sub-millisecond differences).
  const allEvents: Array<z.infer<typeof serverSyncEventSchema> & { _sortTime: Temporal.Instant }> =
    [];

  // Track if we hit any limits
  let hasMore = false;

  // ========================================================================
  // Entry changes (metadata and/or state) - combined query using GREATEST
  // Uses GREATEST(entries.updated_at, user_entries.updated_at) > cursor
  // to catch all changes with a single cursor, avoiding missed updates
  // when one timestamp advances past the other (see #738).
  //
  // Keyset pagination on (GREATEST(...), entry_id): markAllEntriesRead (and
  // the subscribe-time insert) stamp one identical timestamp onto hundreds
  // of rows, so a strict timestamp `>` cursor would drop every tied row past
  // the MAX_ENTRIES boundary permanently. Carrying the entry id as a
  // tiebreaker (same pattern as listEntries) lets the client page within a
  // tied-timestamp group. See #1080.
  //
  // The metadata/state/new booleans are computed in SQL against (ts, id)
  // keysets — not with JavaScript Date math —
  // because new Date() truncates Postgres µs to ms, which could select a row
  // by µs precision yet then emit no event (leaving the cursor stuck). #1080
  // ========================================================================
  if (entriesCursor) {
    const entriesAfterId = cursors.entriesAfterId ?? null;

    // `col` is "after" the keyset cursor when it is past the timestamp, or at
    // the timestamp with a larger entry id. Without an id tiebreaker (legacy
    // clients / first sync) fall back to a strict timestamp comparison.
    const afterKeyset = (col: SQLWrapper, ts: string, afterId: string | null): SQL =>
      afterId
        ? sql`(${col} > ${ts}::timestamptz OR (${col} = ${ts}::timestamptz AND ${entries.id} > ${afterId}::uuid))`
        : sql`${col} > ${ts}::timestamptz`;
    const afterCursor = (col: SQLWrapper): SQL => afterKeyset(col, entriesCursor, entriesAfterId);
    // Selection pages on the cursor; categorization is against the catch-up's
    // start (see SyncCursorsInput.entriesSince). OR-ing in the cursor keeps
    // every selected row eventful even if a client sends a start past it.
    const afterSince = (col: SQLWrapper): SQL =>
      cursors.entriesSince
        ? sql`(${afterCursor(col)} OR ${afterKeyset(col, cursors.entriesSince, cursors.entriesSinceAfterId ?? null)})`
        : afterCursor(col);

    const greatest = sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`;

    // ── Index-driven candidate set (issue #1105) ──────────────────────────
    // The delta filters and sorts on GREATEST(entries.updated_at,
    // user_entries.updated_at). That value spans two tables, so no index can
    // serve it: the old query scanned + sorted the user's ENTIRE history on
    // every call (LIMIT gave no help — the sort must see every row first).
    // This is the SSE-down polling fallback, so a Redis outage turned every
    // open tab into a repeating full-timeline scan.
    //
    // Since GREATEST(e, ue) > cursor  ⟺  e.updated_at > cursor OR
    // ue.updated_at > cursor, generate candidates from index-driven arms,
    // UNION them, then decorate + keyset the (now bounded) result:
    //
    //   Arm A  — user_entries.updated_at (idx_user_entries_updated_at). Covers
    //            every state change (read/star flips, mark-all-read) AND new
    //            entries: the feed fanout inserts user_entries rows with
    //            updated_at = now(), so new entries ride this arm too.
    //   Arm B1 — entries.updated_at for the user's SUBSCRIBED feeds. Catches
    //            content refetches that bump entries.updated_at WITHOUT
    //            touching the user_entries row (updateEntryContent) — the case
    //            Arm A misses. Drives from the user's subscriptions
    //            (uq_subscriptions_user_feed) into idx_entries_feed_updated_at
    //            per feed, seeking (feed_id, updated_at >= cursor) directly.
    //            NOTE: we deliberately do NOT pre-filter on
    //            feeds.last_entries_updated_at. It is stamped from the poll's
    //            start-time `now`, while each changed entry's updated_at is a
    //            later wall-clock read (createEntry/updateEntryContent write
    //            after the fetch+parse), so entry.updated_at > the feed's
    //            last_entries_updated_at by the fetch duration. A
    //            `last_entries_updated_at >= cursor` pre-filter would then
    //            wrongly prune a feed once the cursor advances past
    //            last_entries_updated_at but not past the entries — silently
    //            and permanently dropping the tail of a >MAX_ENTRIES same-poll
    //            content burst from the delta. The per-feed index seek already
    //            bounds the work; no pre-filter is needed.
    //   Arm B2 — same, for the user's saved-articles feed (no subscription
    //            row; saved feeds are never polled), keyed by the feed id.
    //
    // Arms compare with `>=` so a tied-timestamp boundary row is still a
    // candidate; the outer query re-applies the exact `(GREATEST, id)` keyset
    // (afterCursor) so pagination within a tied group stays correct (#1080).
    // Driving Arm B1 from subscriptions can surface an entry from an
    // unsubscribed feed, but the outer visibility predicate drops it unless
    // it is starred — matching visible_entries.
    const cursorTs = sql`${entriesCursor}::timestamptz`;

    const stateChangedCandidates = db
      .select({ entryId: userEntries.entryId })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), sql`${userEntries.updatedAt} >= ${cursorTs}`));

    const subscribedEntryCandidates = db
      .select({ entryId: userEntries.entryId })
      .from(subscriptions)
      .innerJoin(
        entries,
        and(eq(entries.feedId, subscriptions.feedId), sql`${entries.updatedAt} >= ${cursorTs}`)
      )
      .innerJoin(
        userEntries,
        and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, subscriptions.userId))
      )
      .where(eq(subscriptions.userId, userId));

    // Saved-articles arm: keyed by the saved feed id (no subscription row,
    // and last_entries_updated_at is never set on saved feeds).
    const savedFeedId = await getSavedFeedId(db, userId);
    const savedEntryCandidates = savedFeedId
      ? db
          .select({ entryId: userEntries.entryId })
          .from(userEntries)
          .innerJoin(
            entries,
            and(
              eq(entries.id, userEntries.entryId),
              eq(entries.feedId, savedFeedId),
              sql`${entries.updatedAt} >= ${cursorTs}`
            )
          )
          .where(eq(userEntries.userId, userId))
      : null;

    const candidates = savedEntryCandidates
      ? stateChangedCandidates.union(subscribedEntryCandidates).union(savedEntryCandidates)
      : stateChangedCandidates.union(subscribedEntryCandidates);

    const changed = db.$with("changed_entries").as(candidates);

    const changedEntryResults = await db
      .with(changed)
      .select({
        id: entries.id,
        title: entries.title,
        author: entries.author,
        summary: entries.summary,
        url: entries.url,
        publishedAt: entries.publishedAt,
        fetchedAt: entries.fetchedAt,
        siteName: entries.siteName,
        isSpam: entries.isSpam,
        isBackfill: entries.isBackfill,
        read: userEntries.read,
        starred: userEntries.starred,
        readChangedAt: userEntries.readChangedAt,
        subscriptionId: subscriptions.id,
        feedId: entries.feedId,
        feedType: feeds.type,
        feedTitle: feeds.title,
        visible: sql<boolean>`${visibleEntrySql()}`,
        // Categorization booleans, computed in SQL at µs precision so a row
        // selected past the cursor always gets at least one event.
        metadataChanged: sql<boolean>`${afterSince(entries.updatedAt)}`,
        stateChanged: sql<boolean>`${afterSince(userEntries.updatedAt)}`,
        isNew: sql<boolean>`${afterSince(entries.createdAt)}`,
        // Full-precision Temporal.Instant for cursor/timestamp output (both
        // updatedAt columns are NOT NULL, so GREATEST is never null here).
        maxUpdatedAt: sql`${greatest}`.mapWith(parseTimestamptz),
        stateUpdatedAt: sql`${userEntries.updatedAt}`.mapWith(parseTimestamptz),
      })
      .from(changed)
      .innerJoin(
        userEntries,
        and(eq(userEntries.userId, userId), eq(userEntries.entryId, changed.entryId))
      )
      .innerJoin(entries, eq(entries.id, userEntries.entryId))
      .innerJoin(feeds, eq(feeds.id, entries.feedId))
      .leftJoin(subscriptions, eq(subscriptions.id, userEntries.subscriptionId))
      .where(
        and(
          afterCursor(greatest),
          // A row a state change took out of view is a deletion, paged with
          // the rest so none is lost past a page's end.
          options.reportHidden
            ? sql`(${visibleEntrySql()} OR ${afterSince(userEntries.updatedAt)})`
            : visibleEntrySql()
        )
      )
      // Direct join on the stamped user_entries.subscription_id — one
      // subscription per row by construction, so no fan-out is possible.
      .orderBy(greatest, entries.id)
      .limit(MAX_ENTRIES + 1);

    if (changedEntryResults.length > MAX_ENTRIES) {
      hasMore = true;
      changedEntryResults.pop();
    }

    const lastEntry = changedEntryResults.at(-1);
    if (lastEntry) {
      next.entries = lastEntry.maxUpdatedAt.toString();
      next.entriesAfterId = lastEntry.id;
    }

    const visibleRows = changedEntryResults.filter((row) => row.visible);
    for (const row of changedEntryResults) {
      if (!row.visible) {
        hidden.push({ entryId: row.id, deletedAt: row.stateUpdatedAt.toString() });
      }
    }

    // Collect entries with state changes for batch count computation
    const stateChangedEntries = visibleRows.filter((row) => row.stateChanged);

    // Entries created after the catch-up's start emit new_entry events. Compute one
    // absolute-count snapshot covering all of them so each new_entry event
    // carries server-authoritative counts (the client sets them directly
    // rather than applying a +1 delta, making the events idempotent across
    // the live-SSE / catch-up-sync overlap).
    const newEntries = visibleRows.filter((row) => row.metadataChanged && row.isNew);
    const newEntryCounts =
      newEntries.length > 0
        ? await getBulkEntryRelatedCounts(
            db,
            userId,
            newEntries.map((row) => ({
              subscriptionId: row.subscriptionId,
              type: row.feedType,
            }))
          )
        : undefined;

    // Compute absolute unread counts once for all state-changed entries.
    // All entry_state_changed events share the same counts snapshot since
    // they reflect the current server state at query time.
    const stateChangedCounts =
      stateChangedEntries.length > 0
        ? await getBulkEntryRelatedCounts(
            db,
            userId,
            stateChangedEntries.map((row) => ({
              subscriptionId: row.subscriptionId,
              type: row.feedType,
            }))
          )
        : undefined;

    for (const row of visibleRows) {
      const events = entryRowToSyncEvents(
        { ...row, updatedAt: row.maxUpdatedAt.toString() },
        { newEntry: newEntryCounts, stateChanged: stateChangedCounts }
      );
      for (const event of events) {
        allEvents.push({ ...event, _sortTime: row.maxUpdatedAt });
      }
    }
  }

  // ========================================================================
  // Subscription changes
  // ========================================================================
  if (subscriptionsCursor) {
    const subscriptionResults = await db
      .select({
        subscription: subscriptions,
        feed: feeds,
        updatedAtInstant: sql`${subscriptions.updatedAt}`.mapWith(parseTimestamptz),
      })
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(
        and(
          eq(subscriptions.userId, userId),
          sql`${subscriptions.updatedAt} > ${subscriptionsCursor}::timestamptz`
        )
      )
      .orderBy(subscriptions.updatedAt);

    // Collect active subscription IDs for batch tag fetching
    const activeSubscriptions = subscriptionResults.filter(
      ({ subscription }) => subscription.unsubscribedAt === null
    );

    // Batch-fetch tags for all active subscriptions in one query
    const tagsBySubscription = await fetchTagsBySubscriptionIds(
      db,
      activeSubscriptions.map(({ subscription }) => subscription.id)
    );

    const lastSubscription = subscriptionResults.at(-1);
    if (lastSubscription) {
      next.subscriptions = lastSubscription.updatedAtInstant.toString();
    }

    const subscriptionsCursorDate = new Date(subscriptionsCursor);
    for (const { subscription, feed, updatedAtInstant } of subscriptionResults) {
      const updatedAtIso = updatedAtInstant.toString();
      if (subscription.unsubscribedAt === null) {
        // Distinguish new subscriptions from updated ones:
        // If subscribedAt is after the cursor, it's a new subscription.
        // Otherwise, it's an existing subscription whose properties changed.
        const isNew = subscription.subscribedAt > subscriptionsCursorDate;
        if (isNew) {
          allEvents.push({
            type: "subscription_created" as const,
            subscriptionId: subscription.id,
            feedId: subscription.feedId,
            timestamp: updatedAtIso,
            updatedAt: updatedAtIso,
            subscription: {
              id: subscription.id,
              feedId: subscription.feedId,
              customTitle: subscription.customTitle,
              subscribedAt: subscription.subscribedAt.toISOString(),
              unreadCount: subscription.unreadCount,
              tags: tagsBySubscription.get(subscription.id) ?? [],
            },
            feed: {
              id: feed.id,
              type: feed.type,
              url: feed.url,
              title: feed.title,
              description: feed.description,
              siteUrl: feed.siteUrl,
            },
            _sortTime: updatedAtInstant,
          });
        } else {
          allEvents.push({
            type: "subscription_updated" as const,
            subscriptionId: subscription.id,
            tags: tagsBySubscription.get(subscription.id) ?? [],
            customTitle: subscription.customTitle,
            timestamp: updatedAtIso,
            updatedAt: updatedAtIso,
            _sortTime: updatedAtInstant,
          });
        }
      } else {
        allEvents.push({
          type: "subscription_deleted" as const,
          subscriptionId: subscription.id,
          timestamp: updatedAtIso,
          updatedAt: updatedAtIso,
          _sortTime: updatedAtInstant,
        });
      }
    }
  }

  // ========================================================================
  // Tag changes
  // ========================================================================
  if (tagsCursor) {
    // Date version for the JavaScript created-vs-updated comparison below;
    // the query itself keeps the string cursor for µs precision (#680).
    const tagsCursorDate = new Date(tagsCursor);
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
      .where(and(eq(tags.userId, userId), sql`${tags.updatedAt} > ${tagsCursor}::timestamptz`))
      .orderBy(tags.updatedAt);

    const lastTag = tagResults.at(-1);
    if (lastTag) {
      next.tags = lastTag.updatedAtInstant.toString();
    }

    for (const row of tagResults) {
      const updatedAtIso = row.updatedAtInstant.toString();
      if (row.deletedAt !== null) {
        allEvents.push({
          type: "tag_deleted" as const,
          tagId: row.id,
          timestamp: updatedAtIso,
          updatedAt: updatedAtIso,
          _sortTime: row.updatedAtInstant,
        });
      } else if (row.createdAt > tagsCursorDate) {
        allEvents.push({
          type: "tag_created" as const,
          tag: {
            id: row.id,
            name: row.name,
            color: row.color,
          },
          timestamp: updatedAtIso,
          updatedAt: updatedAtIso,
          _sortTime: row.updatedAtInstant,
        });
      } else {
        allEvents.push({
          type: "tag_updated" as const,
          tag: {
            id: row.id,
            name: row.name,
            color: row.color,
          },
          timestamp: updatedAtIso,
          updatedAt: updatedAtIso,
          _sortTime: row.updatedAtInstant,
        });
      }
    }
  }

  // Sort all events by timestamp (µs-precise via Temporal.Instant.compare)
  allEvents.sort((a, b) => Temporal.Instant.compare(a._sortTime, b._sortTime));

  // Remove _sortTime from events before returning
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const events = allEvents.map(({ _sortTime, ...event }) => event) as z.infer<
    typeof serverSyncEventSchema
  >[];

  return { events, hasMore, next, hidden };
}

// ============================================================================
// Router
// ============================================================================

export const syncRouter = createTRPCRouter({
  /**
   * Get current sync cursors without fetching any data.
   *
   * This is an efficient way to establish cursors for real-time updates
   * without the overhead of a full sync. Used during SSR to get initial
   * cursors for the client-side SSE connection.
   *
   * @returns Cursors for each entity type based on max(updated_at)
   */
  cursors: protectedProcedure
    .output(syncCursorsSchema)
    .query(({ ctx }) => currentSyncCursors(ctx.db, ctx.session.user.id)),

  /**
   * Get changes since cursors as individual events (SSE-compatible format).
   *
   * This endpoint returns events in the same format as SSE, allowing the client
   * to use identical event handlers for both SSE and sync. Events are sorted
   * by timestamp and can be processed in order.
   *
   * Uses three separate cursors (one per entity type) for correct incremental sync,
   * matching the cursor tracking used in the SSE path.
   *
   * @param cursors - Per-entity-type cursors (entries, subscriptions, tags)
   * @returns Array of events with hasMore flag
   */
  events: protectedProcedure
    .input(z.object({ cursors: syncCursorsInputSchema.optional() }))
    .output(syncEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { events, hasMore } = await collectSyncEvents(
        ctx.db,
        ctx.session.user.id,
        input.cursors ?? {}
      );
      return { events, hasMore };
    }),
  /**
   * The native app's delta sync (`sync.events` over REST, plus what an offline
   * store needs that the web client doesn't): server-computed next cursors,
   * `deletions` (entries the user can no longer see: tombstones of hard-deleted
   * saved articles, and entries that left their view through a state change),
   * and `resyncRequired` when the deletions cursor predates the tombstone
   * retention window.
   *
   * Called with no cursors, it returns no changes and the cursors to start
   * from — take them before downloading the initial window so nothing that
   * changes during the download is missed (replaying an overlap is harmless).
   * Page until `hasMore` is false, sending the first page's `entries` /
   * `entriesAfterId` as `entriesSince` / `entriesSinceAfterId` on every page
   * so changes an entry had before a later page's cursor are still reported.
   */
  changes: appProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/sync/changes",
        tags: ["Sync"],
        summary: "Changes since cursors",
      },
    })
    .input(syncCursorsInputSchema.extend({ deletions: z.string().datetime().optional() }))
    .output(syncChangesOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { deletions: deletionsCursor, ...cursors } = input;
      // Deletions are stamped by the database clock (tombstones' DEFAULT
      // now(), which is also their transaction's start), so the deletions
      // cursor is read from it too, backed off by a margin that covers a
      // delete transaction still in flight. Re-reporting a deletion is harmless.
      const dbNow = await databaseNow(ctx.db);
      const safeDeletionsCursor = dbNow.subtract({ milliseconds: DELETIONS_CURSOR_MARGIN_MS });

      if (!deletionsCursor && !cursors.entries && !cursors.subscriptions && !cursors.tags) {
        const current = await currentSyncCursors(ctx.db, userId);
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
            deletions: safeDeletionsCursor.toString(),
          },
          deletions: [],
          resyncRequired: false,
        };
      }

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
          resyncRequired: true,
        };
      }

      const { events, hasMore, next, hidden } = await collectSyncEvents(ctx.db, userId, cursors, {
        reportHidden: true,
      });

      const tombstones = deletionsCursor
        ? await ctx.db
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
        : [];
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
        resyncRequired: false,
      };
    }),
});
