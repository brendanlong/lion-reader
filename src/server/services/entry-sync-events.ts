/**
 * The rules for which entry events a change produces and what they carry,
 * shared by the live path (the publishers in `@/server/redis/pubsub` and their
 * callers) and the `sync` catch-up, so a client that reconnects ends up where
 * one that stayed connected would. Pure: no DB, no Redis.
 */

import type { z } from "zod";
import {
  toNewEntryListData,
  type entryMetadataSchema,
  type NewEntryListData,
  type NewEntryListDataSource,
  type serverSyncEventSchema,
  type unreadCountsSchema,
} from "@/lib/events/schemas";

type ServerSyncEvent = z.infer<typeof serverSyncEventSchema>;
type UnreadCounts = z.infer<typeof unreadCountsSchema>;
type FeedType = "web" | "email" | "saved";

/** An entry_updated event's metadata. */
export function toEntryMetadata(entry: {
  title: string | null;
  author: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: Date | null;
}): z.infer<typeof entryMetadataSchema> {
  return {
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    url: entry.url,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
  };
}

/**
 * The list-item payload a client inserts an entry into its cached lists
 * from, or none for spam: the default entries.list filters it, so an insert
 * would show a row the server never returns.
 */
export function entryListPayload(
  entry: NewEntryListDataSource & { isSpam?: boolean },
  feedTitle: string | null,
  state?: Parameters<typeof toNewEntryListData>[2]
): NewEntryListData | undefined {
  return entry.isSpam ? undefined : toNewEntryListData(entry, feedTitle, state);
}

/**
 * What an entry that just became visible announces with new_entry: its list
 * payload, if it has one (see {@link entryListPayload}), or null for no
 * new_entry at all. A backfill (see "Backfill Guard" in
 * `src/server/feed/CLAUDE.md`) announces nothing: it arrives already read, so
 * there's nothing new to insert or count.
 */
export function newEntryAnnouncement(
  entry: NewEntryListDataSource & { isSpam: boolean; isBackfill: boolean },
  feedTitle: string | null,
  state?: Parameters<typeof toNewEntryListData>[2]
): { entry?: NewEntryListData } | null {
  if (entry.isBackfill) return null;
  const payload = entryListPayload(entry, feedTitle, state);
  return payload ? { entry: payload } : {};
}

/** A user's entry that changed since a catch-up's start, as `sync` reads it. */
export interface ChangedEntryRow extends NewEntryListDataSource {
  id: string;
  title: string | null;
  author: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: Date | null;
  isSpam: boolean;
  isBackfill: boolean;
  read: boolean;
  starred: boolean;
  readChangedAt: Date | null;
  subscriptionId: string | null;
  /** Every active subscription holding the entry (#1846). */
  subscriptionIds: string[];
  feedType: FeedType;
  feedTitle: string | null;
  /** The entry's content changed (or it was created) since the catch-up's start. */
  metadataChanged: boolean;
  /** The user's read/starred state changed (or the row was created) since then. */
  stateChanged: boolean;
  /** The entry was created since then. */
  isNew: boolean;
  /** When it last changed: the event's timestamp, and the cursor past it. */
  updatedAt: string;
}

/**
 * The events a catch-up reports for one changed entry: what the live path
 * would have sent for the changes since the catch-up's start. A new entry's
 * payload carries its current read/starred state, since it may have changed
 * on another device since; an entry_state_changed carries a list payload only
 * when it's unread, as the live path's does.
 */
export function entryRowToSyncEvents(
  row: ChangedEntryRow,
  counts: { newEntry?: UnreadCounts; stateChanged?: UnreadCounts }
): ServerSyncEvent[] {
  const events: ServerSyncEvent[] = [];
  const stamps = { timestamp: row.updatedAt, updatedAt: row.updatedAt };

  if (row.metadataChanged && row.isNew) {
    const announcement = newEntryAnnouncement(row, row.feedTitle, {
      read: row.read,
      starred: row.starred,
      readChangedAt: row.readChangedAt,
    });
    if (announcement) {
      events.push({
        type: "new_entry",
        subscriptionId: row.subscriptionId,
        subscriptionIds: row.subscriptionIds,
        entryId: row.id,
        ...stamps,
        feedType: row.feedType,
        ...announcement,
        ...(counts.newEntry && { counts: counts.newEntry }),
      });
    }
  } else if (row.metadataChanged) {
    events.push({
      type: "entry_updated",
      subscriptionId: row.subscriptionId,
      entryId: row.id,
      ...stamps,
      metadata: toEntryMetadata(row),
    });
  }

  if (row.stateChanged && counts.stateChanged) {
    const payload = row.read ? undefined : entryListPayload(row, row.feedTitle);
    events.push({
      type: "entry_state_changed",
      entryId: row.id,
      read: row.read,
      starred: row.starred,
      readChangedAt: row.readChangedAt?.toISOString() ?? null,
      counts: counts.stateChanged,
      subscriptionIds: row.subscriptionIds,
      ...stamps,
      ...(payload
        ? {
            subscriptionId: row.subscriptionId,
            feedType: row.feedType,
            entry: payload,
          }
        : {}),
    });
  }

  return events;
}
