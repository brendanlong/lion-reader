/**
 * Read and star writes: marking entries (or whole lists) read, and starring.
 * Each returns the counts it moved and publishes its flips ("Row Written vs.
 * Value Flipped" in `src/server/CLAUDE.md`).
 */

import type { z } from "zod";
import { eq, and, exists, inArray, sql, isNull, lte, or, type SQL } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { entries, userEntries, subscriptions, visibleEntries } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { logger } from "@/lib/logger";
import { publishUserEvent } from "@/server/redis/pubsub";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "./counts";
import { publishMarkReadStateChanges, publishStarredStateChanges } from "./entry-events";
import {
  buildEntriesInSubscriptionsCondition,
  buildTaggedSubscriptionIdsSubquery,
  visibleUserEntrySql,
  verifySubscriptionOwnership,
  buildUncategorizedSubscriptionIdsSubquery,
  entryMemberships,
  entryOriginOn,
  inSavedSubscriptionSql,
  VISIBLE_MEMBERSHIPS,
  VISIBLE_ROW,
} from "./entry-filters";
import type { EntryType } from "@/lib/entry-types";
import { entryListItemSchema } from "./entries";
import { withTagLists } from "./entry-tag-lists";

// ============================================================================
// Types
// ============================================================================

/** An entry's state after a star write, for cache updates. */
export const entryStateSchema = entryListItemSchema.pick({
  id: true,
  read: true,
  starred: true,
  updatedAt: true,
});

export type EntryState = z.infer<typeof entryStateSchema>;

/**
 * A single entry to mark read/unread, with an optional per-entry timestamp for
 * offline sync scenarios where entries were marked at different times.
 */
export interface MarkReadEntry {
  id: string;
  changedAt?: Date;
}

/**
 * Final entry state returned after a bulk read or star write, including the
 * context fields needed for cache updates, count queries, and SSE publishing.
 */
export const markReadEntryStateSchema = entryListItemSchema.pick({
  id: true,
  subscriptionId: true,
  subscriptionIds: true,
  positions: true,
  tagLists: true,
  read: true,
  starred: true,
  score: true,
  type: true,
  updatedAt: true,
  readChangedAt: true,
});

export type MarkReadEntryState = z.infer<typeof markReadEntryStateSchema>;

/** The most entries one read or star write may name, on every surface. */
export const MAX_ENTRY_STATE_BATCH = 1000;

const USER_ROW = { userId: userEntries.userId, entryId: userEntries.entryId };
const USER_MEMBERSHIPS = entryMemberships(USER_ROW);

/**
 * Marks entries as read or unread.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * read_changed_at timestamp. This prevents stale updates from overwriting newer
 * state. Supports per-entry timestamps for offline sync.
 *
 * Returns the final state for all requested entries (with the context fields
 * callers need for cache updates) plus the absolute unread counts for every
 * affected list. Counts are computed once here and both returned and published,
 * so callers don't re-query them.
 *
 * A row being WRITTEN is not the same as the read value CHANGING (issue #1118):
 * re-asserting a state the entry already has (the common Google Reader/Wallabag
 * resync pattern) still writes the row to advance the `read_changed_at`
 * last-write-wins watermark — dropping that write would let an older conflicting
 * update win later — but nothing the user can see changed, so `changed` contains
 * only entries whose read value actually flipped, and the unread-count
 * aggregation (the dominant cost of this path) runs only when something flipped.
 * `counts` is undefined otherwise; callers treat "no counts" as "counts didn't
 * change".
 *
 * The two roles are carried by two columns (issue #1118 Part 2): `read_changed_at`
 * is the last-writer-wins watermark and advances on every accepted write, while
 * `updated_at` is the "meaningful change" timestamp that drives delta sync
 * (`sync.events`, Wallabag `since`, both through `user_entries.changed_at`) and
 * moves ONLY on a real flip. So a same-value re-assert advances the watermark but
 * leaves `updated_at` alone, and offline/polling clients don't re-fetch it.
 *
 * Publishes an `entry_state_changed` SSE event for each entry whose value
 * actually flipped, so a user's other tabs/devices stay in sync regardless of
 * which surface (tRPC, MCP, Google Reader, Wallabag) issued the mark. Publishing
 * lives here — not at each API boundary — so every current and future caller
 * notifies other tabs for free. Idempotent replays (an older `changedAt` losing
 * the `read_changed_at <= changedAt` guard) update no rows, and same-value
 * re-asserts flip nothing; neither publishes. Fire and forget.
 *
 * This reads counts and publishes after the (autocommitted) UPDATEs complete,
 * so it takes the global `db`. A caller running the write inside a transaction
 * uses `writeEntriesRead` and calls `finishEntriesRead` after the commit, so a
 * rolled-back mark can't emit a phantom event and counts are read (and
 * stamped) after the write they reflect.
 */
export async function markEntriesRead(
  db: typeof dbType,
  userId: string,
  entriesToMark: MarkReadEntry[],
  read: boolean
): Promise<{
  entries: MarkReadEntryState[];
  changed: MarkReadEntryState[];
  counts?: BulkUnreadCounts;
}> {
  const { entries, changed } = await writeEntriesRead(db, userId, entriesToMark, read);
  return { entries, changed, counts: await finishEntriesRead(db, userId, changed) };
}

/**
 * Reads the counts a committed `writeEntriesRead` moved and publishes its
 * flips. Returns undefined when nothing flipped.
 */
export async function finishEntriesRead(
  db: typeof dbType,
  userId: string,
  changed: MarkReadEntryState[]
): Promise<BulkUnreadCounts | undefined> {
  // Only when a value actually flipped: a batch of pure re-asserts changes no
  // count, so the aggregation would be wasted work (issue #1118). Counts cover
  // the flipped entries' lists, which are exactly the lists that moved.
  if (changed.length === 0) return undefined;
  const counts = await getBulkEntryRelatedCounts(db, userId, changed);
  // Fire and forget.
  publishMarkReadStateChanges(db, userId, changed, counts);
  return counts;
}

/**
 * Locks the user's rows for these entries sorted by entry id, as the lock order
 * in `src/server/CLAUDE.md` requires before a statement updates several: an
 * `UPDATE` locks rows in plan order, so two batches naming the same entries in
 * different orders would otherwise deadlock.
 */
export async function lockUserEntryRows(
  tx: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<void> {
  if (entryIds.length === 0) return;
  await tx
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)))
    .orderBy(userEntries.entryId)
    .for("no key update");
}

/**
 * `locked`, a CTE locking the user's rows for these entries sorted by entry id,
 * for a statement updating several of them to join first, so it takes its
 * locks in that order (see {@link lockUserEntryRows}) without a separate
 * round trip: the statement only ever locks a row this CTE has already
 * emitted, and it emits them in id order.
 */
export function lockedUserEntriesCte(userId: string, entryIds: string[]): SQL {
  return sql`locked AS MATERIALIZED (
    SELECT entry_id FROM user_entries
    WHERE user_id = ${userId}::uuid AND ${inArray(userEntries.entryId, entryIds)}
    ORDER BY entry_id
    FOR NO KEY UPDATE
  )`;
}

/** The write half of `markEntriesRead`, safe inside a transaction. */
export async function writeEntriesRead(
  db: DbOrTx,
  userId: string,
  entriesToMark: MarkReadEntry[],
  read: boolean
): Promise<{ entries: MarkReadEntryState[]; changed: MarkReadEntryState[] }> {
  if (entriesToMark.length === 0) {
    return { entries: [], changed: [] };
  }

  if (entriesToMark.length > MAX_ENTRY_STATE_BATCH) {
    throw errors.validation(`Maximum ${MAX_ENTRY_STATE_BATCH} entries per request`);
  }

  const now = new Date();

  // Apply every entry's per-entry changedAt in a single UPDATE ... FROM
  // (VALUES ...). Offline sync can send a distinct timestamp per entry; the
  // previous code grouped by timestamp and issued one UPDATE per distinct value
  // — up to N sequential round-trips outside a transaction. One statement does
  // it atomically. The per-row `read_changed_at <= v.ts` guard preserves the
  // idempotent last-write-wins semantics.
  //
  // The self-join on `prev` captures each row's pre-update read value in the
  // same statement (RETURNING only sees new values before PG 18's `old.*`), so
  // we can tell a real flip from a same-value watermark bump without a separate
  // pre-SELECT and its wider TOCTOU window.
  const rows = entriesToMark.map(
    (entry) => sql`(${entry.id}::uuid, ${(entry.changedAt ?? now).toISOString()}::timestamptz)`
  );

  // `updated_at` is the "meaningful change" timestamp that drives delta sync
  // (`sync.events` and Wallabag `since`, both via `user_entries.changed_at`),
  // so it moves ONLY when the read value actually flips — a same-value re-assert must not re-deliver the entry to offline
  // clients (issue #1118 Part 2). The last-writer-wins watermark
  // (`read_changed_at`) is a SEPARATE column and still advances on every
  // accepted write, so cross-device conflict resolution is unchanged.
  const ids = entriesToMark.map((e) => e.id);
  const updated = await db.execute<{ entry_id: string; old_read: boolean }>(sql`
    WITH ${lockedUserEntriesCte(userId, ids)}
    UPDATE user_entries AS ue
    SET read = ${read},
        updated_at = CASE WHEN prev.read <> ${read} THEN ${now} ELSE ue.updated_at END,
        read_changed_at = v.ts
    FROM locked
    JOIN (VALUES ${sql.join(rows, sql`, `)}) AS v(entry_id, ts) ON v.entry_id = locked.entry_id
    JOIN user_entries AS prev
      ON prev.user_id = ${userId}::uuid
      AND prev.entry_id = v.entry_id
    WHERE ue.user_id = ${userId}::uuid
      AND ue.entry_id = v.entry_id
      AND (ue.read_changed_at IS NULL OR ue.read_changed_at <= v.ts)
    RETURNING ue.entry_id AS entry_id, prev.read AS old_read
  `);
  // Rows whose read value actually flipped — the only ones that warrant SSE
  // events and count recomputation. Same-value writes still advanced the
  // watermark above.
  const flippedIds = new Set(
    updated.rows.filter((row) => row.old_read !== read).map((row) => row.entry_id)
  );

  // Always resolve final state for all requested entries, including the context
  // fields callers need for cache updates and count queries.
  const entries = await selectEntryStates(db, userId, ids);

  return { entries, changed: entries.filter((entry) => flippedIds.has(entry.id)) };
}

/** The visible entries' state, with the context fields cache updates and counts need. */
async function selectEntryStates(
  db: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<MarkReadEntryState[]> {
  const rows = db
    .select({
      id: visibleEntries.id,
      subscriptionId: subscriptions.id,
      subscriptionIds: VISIBLE_MEMBERSHIPS.subscriptionIds,
      positions: VISIBLE_MEMBERSHIPS.positions,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      score: visibleEntries.score,
      type: visibleEntries.type,
      updatedAt: visibleEntries.updatedAt,
      readChangedAt: visibleEntries.readChangedAt,
    })
    .from(visibleEntries)
    .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
    .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, entryIds)));
  return withTagLists(db, userId, entryIds, rows);
}

/**
 * Publishes `entry_state_changed` for entries whose score or collection
 * positions changed (#2064), which travel with their state, so the user's
 * other tabs and devices pick them up. Fire and forget, after the write
 * commits.
 */
export function publishEntryStates(db: typeof dbType, userId: string, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  void (async () => {
    try {
      const states = await selectEntryStates(db, userId, entryIds);
      if (states.length === 0) return;
      publishStarredStateChanges(
        userId,
        states,
        await getBulkEntryRelatedCounts(db, userId, states)
      );
    } catch (error) {
      logger.warn("Failed to publish entry state changes", { userId, error: String(error) });
    }
  })();
}

/**
 * Marks all unread entries matching the given filters as read.
 *
 * Shared implementation used by both the tRPC markAllRead mutation and the
 * Google Reader API mark-all-as-read endpoint.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * read_changed_at timestamp (or if read_changed_at is NULL).
 *
 * @returns The entry IDs that were marked as read.
 */
export async function markAllEntriesRead(
  db: typeof dbType,
  params: {
    userId: string;
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    starredOnly?: boolean;
    type?: EntryType;
    before?: Date;
    changedAt?: Date;
    /**
     * Whether to include spam entries, matching the user's preference. When
     * false (the default), only entries visible via `visible_entries` with
     * `is_spam = false` are marked — otherwise "mark all read" would also flip
     * hidden spam and unsubscribed-orphan `user_entries` rows the user never
     * saw, which would surface as already-read if they later enable showSpam.
     */
    showSpam: boolean;
  }
): Promise<{ entryIds: string[]; counts?: BulkUnreadCounts }> {
  const changedAt = params.changedAt ?? new Date();

  const conditions: SQL[] = [
    eq(userEntries.userId, params.userId),
    sql`NOT ${userEntries.read}`,
    or(isNull(userEntries.readChangedAt), lte(userEntries.readChangedAt, changedAt))!,
  ];

  // Only mark entries the user can actually see, matching listEntries
  // (visible_entries' predicate, on the row being updated). This excludes
  // hidden spam (unless showSpam) and unsubscribed-feed orphans that aren't
  // starred/saved.
  conditions.push(visibleUserEntrySql());
  if (!params.showSpam) {
    conditions.push(sql`NOT ${userEntries.isSpam}`);
  }

  // Filter by subscriptionId: a foreign or unsubscribed subscription matches
  // nothing. (Scoping checks query the subscriptions table, never the
  // display-only user_feeds view.)
  const columns = { userId: userEntries.userId, entryId: userEntries.entryId };
  if (params.subscriptionId) {
    if (!(await verifySubscriptionOwnership(db, params.subscriptionId, params.userId))) {
      return { entryIds: [] };
    }
    conditions.push(buildEntriesInSubscriptionsCondition([params.subscriptionId], columns));
  }

  // Filter by tag: a foreign or deleted tag matches nothing (the shared
  // subquery joins only the user's live tags).
  if (params.tagId) {
    conditions.push(
      buildEntriesInSubscriptionsCondition(
        buildTaggedSubscriptionIdsSubquery(db, params.tagId, params.userId),
        columns
      )
    );
  }

  // Filter by uncategorized (no tags). Reuse the shared subquery builder so this
  // stays in sync with buildEntrySubscriptionFilter (listEntries).
  if (params.uncategorized) {
    conditions.push(
      buildEntriesInSubscriptionsCondition(
        buildUncategorizedSubscriptionIdsSubquery(db, params.userId),
        columns
      )
    );
  }

  // Filter by starred only
  if (params.starredOnly) {
    conditions.push(eq(userEntries.starred, true));
  }

  // Filter by feed type; Saved is the saved subscription's list, as for listEntries.
  if (params.type === "saved") {
    conditions.push(
      inSavedSubscriptionSql({ userId: userEntries.userId, entryId: userEntries.entryId })
    );
  }

  // The type and before filters read the row's entry (one primary-key probe
  // per row), never every entry of that type or age.
  const entryConditions = [
    params.type && params.type !== "saved" ? eq(entries.type, params.type) : undefined,
    params.before ? lte(entries.fetchedAt, params.before) : undefined,
  ].filter((condition) => condition !== undefined);
  if (entryConditions.length > 0) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(entries)
          .where(and(eq(entries.id, userEntries.entryId), ...entryConditions))
      )
    );
  }

  const updatedAt = new Date();
  const result = await db
    .update(userEntries)
    .set({
      read: true,
      readChangedAt: changedAt,
      updatedAt,
    })
    .where(and(...conditions))
    .returning({ id: userEntries.entryId });

  const entryIds = result.map((r) => r.id);
  if (entryIds.length === 0) return { entryIds };
  // Absolute counts for every list the marked entries reached, so clients
  // set them rather than refetching and guessing which lists went to zero.
  const counts = await getBulkEntryRelatedCounts(
    db,
    params.userId,
    entryIds.map((id) => ({ id, subscriptionId: null }))
  );

  // Notify the user's other tabs/devices. Mark-all-read is unbounded, so rather
  // than emitting a per-entry event (or shipping every affected id), we publish
  // one signal with the counts and let each connection invalidate its entry
  // lists — the same thing the acting tab already does on success. Published
  // here (not in the router) so every caller — the tRPC mutation and the Google
  // Reader mark-all-as-read route — notifies other tabs. Fire and forget.
  //
  // This publishes after the (autocommitted) UPDATE above completes. Today's
  // callers pass the global `db`, so that's always post-commit. If a future
  // caller runs this inside a transaction, move the publish to after the commit
  // so a rolled-back mark-all-read can't emit a phantom event.
  //
  // The largest marked entry id rides along so the client's entries keyset
  // cursor lands exactly past the marked rows rather than past the whole
  // tied-timestamp group: an unrelated entry written in the same millisecond
  // as `updatedAt` has a UUIDv7 id above every earlier-created marked entry
  // (the ordering comes from the UUIDv7 ms-timestamp prefix; marked entries
  // exist before the mark-all-read), so a catch-up sync can still deliver it
  // if its live event was missed (#1102). UUIDs are lowercase, so string
  // comparison matches Postgres uuid ordering.
  const maxEntryId = entryIds.reduce((max, id) => (id > max ? id : max));
  publishUserEvent({
    type: "mark_all_read",
    userId: params.userId,
    updatedAt,
    entryId: maxEntryId,
    counts,
  });

  return { entryIds, counts };
}

/**
 * Reads back the post-update state of star-mutated entries from `user_entries`
 * rather than from `visible_entries`.
 *
 * A star write is the one entry mutation that can change an entry's own
 * **visibility**: `visible_entries` keeps a starred entry from an unsubscribed
 * subscription visible (the starred-orphan arm of its predicate), so unstarring
 * one drops it straight out of the view. Reading the result back through the
 * view therefore saw zero rows for a write that had just landed — the single
 * path raised `entryNotFound` and the bulk path silently returned nothing, so
 * in both cases the counts and the `entry_state_changed` publish were skipped
 * and the user's tabs kept a stale star and stale badges.
 *
 * The `user_entries` row is the durable record of visibility (see "Entry
 * Visibility" in `src/server/CLAUDE.md`), so its existence is the same
 * not-found signal, and it does not move when the star does. The `user_id`
 * predicate keeps the read scoped to the caller, so another user's entry id
 * still matches no row.
 *
 * The projected columns are what a read through the view gives: the view
 * emits `user_entries.changed_at` as `updated_at`, and the origin and memberships are looked up the same way.
 */
async function selectStarredEntryStates(
  db: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<MarkReadEntryState[]> {
  const rows = db
    .select({
      id: userEntries.entryId,
      subscriptionId: subscriptions.id,
      subscriptionIds: USER_MEMBERSHIPS.subscriptionIds,
      positions: USER_MEMBERSHIPS.positions,
      read: userEntries.read,
      starred: userEntries.starred,
      score: userEntries.score,
      type: entries.type,
      updatedAt: sql`${userEntries.changedAt}`.mapWith(userEntries.updatedAt),
      readChangedAt: userEntries.readChangedAt,
    })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .leftJoinLateral(USER_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(USER_MEMBERSHIPS, USER_ROW))
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)));
  return withTagLists(db, userId, entryIds, rows);
}

/**
 * Stars or unstars a single entry: {@link updateEntriesStarred} for one id,
 * returning its final state (`counts` absent unless the value flipped).
 *
 * @throws entryNotFound when the user has no such entry
 */
export async function updateEntryStarred(
  db: typeof dbType,
  userId: string,
  entryId: string,
  starred: boolean,
  changedAt: Date = new Date()
): Promise<{ entry: EntryState; counts?: BulkUnreadCounts }> {
  const result = await updateEntriesStarred(db, userId, [{ id: entryId, changedAt }], starred);
  const row = result.entries[0];
  if (!row) {
    throw errors.entryNotFound();
  }

  // Narrow to EntryState rather than passing the row through: the shared
  // read-back also carries `subscriptionId`/`type`, which this function's
  // callers (tRPC, MCP, Wallabag) serialize straight to the client.
  const entry: EntryState = {
    id: row.id,
    read: row.read,
    starred: row.starred,
    updatedAt: row.updatedAt,
  };
  return { entry, counts: result.counts };
}

/**
 * Stars or unstars entries, applying a single starred value to many entries in
 * one `UPDATE ... FROM` instead of issuing one statement per entry (the Google
 * Reader `edit-tag` endpoint can carry up to 1000 item ids in a single call,
 * issue #1266).
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * starred_changed_at timestamp. This prevents stale updates from overwriting
 * newer state.
 *
 * A row being written is not the same as the starred value changing (issue
 * #1118): re-asserting a state the entry already has still writes the row to
 * advance the `starred_changed_at` last-write-wins watermark — dropping that
 * write would let an older conflicting update win later — but the count
 * aggregation runs and the SSE event publishes only for entries whose value
 * actually flipped. `counts` is undefined when nothing flipped; callers treat
 * "no counts" as "counts didn't change". Mirrors {@link markEntriesRead}: a
 * self-join on `prev` captures each row's pre-update starred value in the same
 * statement (RETURNING only sees new values before PG 18's `old.*`), avoiding a
 * pre-SELECT's TOCTOU window; `updated_at` (the delta-sync "meaningful change"
 * timestamp) advances only on a real flip, so a same-value re-assert never
 * re-delivers the entry to offline/polling clients.
 *
 * Counts are computed once here and both returned and published, so callers
 * don't re-query them. Publishing `entry_state_changed` lives here — not at
 * each API boundary — so every surface (tRPC, MCP, Google Reader, Wallabag)
 * notifies the user's other tabs/devices for free. Fire and forget.
 *
 * This publishes after the (autocommitted) UPDATE completes. Today's callers
 * pass the global `db`, so that's always post-commit. If a future caller runs
 * this inside a transaction, move the publish to after the commit so a
 * rolled-back change can't emit a phantom event.
 *
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function updateEntriesStarred(
  db: typeof dbType,
  userId: string,
  entriesToStar: MarkReadEntry[],
  starred: boolean
): Promise<{
  entries: MarkReadEntryState[];
  changed: MarkReadEntryState[];
  counts?: BulkUnreadCounts;
}> {
  if (entriesToStar.length === 0) {
    return { entries: [], changed: [] };
  }

  if (entriesToStar.length > MAX_ENTRY_STATE_BATCH) {
    throw errors.validation(`Maximum ${MAX_ENTRY_STATE_BATCH} entries per request`);
  }

  const now = new Date();

  // Per-entry timestamps in one UPDATE ... FROM (VALUES ...), with the same
  // `prev` self-join and watermark semantics as markEntriesRead.
  const rows = entriesToStar.map(
    (entry) => sql`(${entry.id}::uuid, ${(entry.changedAt ?? now).toISOString()}::timestamptz)`
  );
  const ids = entriesToStar.map((entry) => entry.id);
  const updated = await db.execute<{ entry_id: string; old_starred: boolean }>(sql`
    WITH ${lockedUserEntriesCte(userId, ids)}
    UPDATE user_entries AS ue
    SET starred = ${starred},
        starred_changed_at = v.ts,
        updated_at = CASE WHEN prev.starred <> ${starred} THEN ${now} ELSE ue.updated_at END
    FROM locked
    JOIN (VALUES ${sql.join(rows, sql`, `)}) AS v(entry_id, ts) ON v.entry_id = locked.entry_id
    JOIN user_entries AS prev
      ON prev.user_id = ${userId}::uuid
      AND prev.entry_id = v.entry_id
    WHERE ue.user_id = ${userId}::uuid
      AND ue.entry_id = v.entry_id
      AND ue.starred_changed_at <= v.ts
    RETURNING ue.entry_id AS entry_id, prev.starred AS old_starred
  `);
  const flippedIds = new Set(
    updated.rows.filter((row) => row.old_starred !== starred).map((row) => row.entry_id)
  );

  // Resolved from `user_entries`, not `visible_entries`: unstarring an orphan
  // drops it out of the view, and a silently empty read-back here would skip
  // the counts and the SSE publish (see selectStarredEntryStates).
  const entriesState = await selectStarredEntryStates(db, userId, ids);

  // Only entries whose starred value actually flipped warrant SSE events and
  // count recomputation (issue #1118); a batch of pure re-asserts still
  // advanced the watermark above but changes no count.
  const changed = entriesState.filter((entry) => flippedIds.has(entry.id));
  const counts =
    changed.length > 0 ? await getBulkEntryRelatedCounts(db, userId, changed) : undefined;

  if (changed.length > 0 && counts) {
    publishStarredStateChanges(userId, changed, counts);
  }

  return { entries: entriesState, changed, counts };
}
