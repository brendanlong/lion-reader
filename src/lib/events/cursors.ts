/**
 * Sync Cursor Bookkeeping
 *
 * Pure helpers for tracking per-entity-type sync cursors as SSE/sync events
 * arrive. Cursors are ISO8601 timestamps based on max(updated_at) per entity
 * type, and are sent to the sync.events endpoint to catch up on missed changes.
 *
 * The entries cursor is a keyset: a `(timestamp, entryId)` pair rather than a
 * bare timestamp. `markAllEntriesRead` (and the subscribe-time insert) stamp one
 * identical timestamp onto every affected `user_entries` row, so a catch-up over
 * a large mark-all-read produces hundreds of rows sharing that exact timestamp.
 * A timestamp-only cursor advanced past that group with a strict `>` would drop
 * every remaining tied row permanently; carrying the entry id lets the sync page
 * *within* a tied-timestamp group (keyset pagination, same as `listEntries`).
 */

import { Temporal } from "temporal-polyfill";

import type { SyncEvent } from "./schemas";

/**
 * Compares two ISO-8601 cursor timestamps as instants: -1, 0, or 1. Both come
 * from the server (`Temporal.Instant.toString()`, microsecond precision). A
 * `new Date()` comparison would truncate to milliseconds and miss sub-ms
 * differences, so a newer event sharing a millisecond with the cursor would fail
 * to advance it (#683). Comparing instants (not strings) is also robust across
 * the format change: a legacy `to_char` cursor (always 6 fractional digits) and
 * a Temporal cursor (trailing zeros trimmed) for the same moment compare equal.
 */
function compareTimestamps(a: string, b: string): number {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b));
}

/**
 * Largest possible UUID. Used as the entries id tiebreaker for `mark_all_read`,
 * which carries no single entry id: advancing past `(T, MAX_UUID)` skips every
 * entry tied at timestamp T (they were all just marked read), so a catch-up
 * doesn't re-deliver them one by one.
 *
 * Known limitation (pre-existing, not introduced by the keyset): if an unrelated
 * new entry is inserted at the *exact* same microsecond timestamp T as the
 * mark-all-read and its live `new_entry` is missed, this sentinel makes a
 * later catch-up skip it (`GREATEST = T AND id > MAX_UUID` is false). The old
 * timestamp-only strict-`>` cursor had the identical blind spot. Collisions at
 * µs precision are vanishingly rare, and `mark_all_read` already invalidates the
 * entry lists, so the entry reappears on the next list refresh regardless.
 */
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/**
 * Sync cursors for each entity type.
 * Each cursor is an ISO8601 timestamp based on max(updated_at) for the entity type.
 */
export interface SyncCursors {
  entries: string | null;
  /**
   * Id tiebreaker for the entries cursor: the entry id of the newest processed
   * entry change at the `entries` timestamp. Together `(entries, entriesAfterId)`
   * form a keyset so the sync can page within a group of entries sharing one
   * timestamp (e.g. a large mark-all-read). Null until the first entry change.
   */
  entriesAfterId: string | null;
  subscriptions: string | null;
  tags: string | null;
}

/**
 * Returns which cursor an event advances, or null for events that don't
 * affect cursors (e.g. import progress events).
 */
export function cursorTypeForEvent(event: SyncEvent): keyof SyncCursors | null {
  switch (event.type) {
    case "new_entry":
    case "entry_updated":
    case "entry_state_changed":
    case "mark_all_read":
      // mark_all_read carries the mark-all-read timestamp; advancing the entries
      // cursor past it stops a reconnect catch-up from re-delivering every
      // entry it marked read as an individual entry_state_changed.
      return "entries";
    case "subscription_created":
    case "subscription_updated":
    case "subscription_deleted":
      return "subscriptions";
    case "tag_created":
    case "tag_updated":
    case "tag_deleted":
      return "tags";
    default:
      return null;
  }
}

/**
 * The entries-cursor id tiebreaker an event advances to. Per-entry events carry
 * their own id; mark_all_read has none and advances past the whole tied group.
 */
function entryEventAfterId(event: SyncEvent): string {
  switch (event.type) {
    case "new_entry":
    case "entry_updated":
    case "entry_state_changed":
      return event.entryId;
    default:
      // mark_all_read (the only other event mapped to the entries cursor).
      return MAX_UUID;
  }
}

/**
 * Advances the entries keyset cursor `(entries, entriesAfterId)` for an entry
 * event. Moves forward on a newer timestamp, and within the same timestamp moves
 * the id tiebreaker forward — so paging through a tied-timestamp group never
 * loses or re-delivers rows. Returns the same object reference when unchanged.
 */
function advanceEntriesCursor(cursors: SyncCursors, event: SyncEvent): SyncCursors {
  const updatedAt = event.updatedAt;
  const afterId = entryEventAfterId(event);
  const current = cursors.entries;

  const cmp = current ? compareTimestamps(updatedAt, current) : 1;
  if (cmp > 0) {
    // Newer timestamp: reset the keyset to this event.
    return { ...cursors, entries: updatedAt, entriesAfterId: afterId };
  }
  if (cmp === 0) {
    // Same timestamp group: advance the id tiebreaker forward only.
    // UUIDs are lowercase, so string ordering matches Postgres uuid ordering.
    if (!cursors.entriesAfterId || afterId > cursors.entriesAfterId) {
      return { ...cursors, entriesAfterId: afterId };
    }
  }
  return cursors;
}

/**
 * Advances the appropriate cursor for an event. Only moves a cursor forward:
 * events older than the current cursor leave it unchanged. Returns the same
 * object reference when nothing changed.
 */
export function advanceCursors(cursors: SyncCursors, event: SyncEvent): SyncCursors {
  const cursorType = cursorTypeForEvent(event);
  if (!cursorType) {
    return cursors;
  }

  if (cursorType === "entries") {
    return advanceEntriesCursor(cursors, event);
  }

  const currentCursor = cursors[cursorType];
  if (!currentCursor || compareTimestamps(event.updatedAt, currentCursor) > 0) {
    return { ...cursors, [cursorType]: event.updatedAt };
  }
  return cursors;
}
