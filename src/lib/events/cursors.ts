/**
 * Sync Cursor Bookkeeping
 *
 * Pure helpers for tracking per-entity-type sync cursors as SSE/sync events
 * arrive. Cursors are ISO8601 timestamps based on max(updated_at) per entity
 * type, and are sent to the sync.events endpoint to catch up on missed changes.
 */

import type { SyncEvent } from "./schemas";

/**
 * Sync cursors for each entity type.
 * Each cursor is an ISO8601 timestamp based on max(updated_at) for the entity type.
 */
export interface SyncCursors {
  entries: string | null;
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
 * Advances the appropriate cursor for an event. Only moves a cursor forward:
 * events older than the current cursor leave it unchanged. Returns the same
 * object reference when nothing changed.
 */
export function advanceCursors(cursors: SyncCursors, event: SyncEvent): SyncCursors {
  const cursorType = cursorTypeForEvent(event);
  if (!cursorType) {
    return cursors;
  }

  const currentCursor = cursors[cursorType];
  if (!currentCursor || new Date(event.updatedAt) > new Date(currentCursor)) {
    return { ...cursors, [cursorType]: event.updatedAt };
  }
  return cursors;
}
