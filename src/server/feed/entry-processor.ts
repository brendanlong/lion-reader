/**
 * Entry processing module.
 * Handles storing entries from parsed feeds, detecting new vs updated entries,
 * and content hash generation for change detection.
 *
 * Publishes Redis events for new and updated entries to enable real-time updates.
 */

import { createHash } from "crypto";
import { eq, and, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { entries, type Entry, type NewEntry } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishNewEntry, publishEntryUpdatedFromEntry } from "../redis/pubsub";
import type { NewEntryListDataSource } from "@/lib/events/schemas";
import { newEntryAnnouncement } from "@/server/services/entry-sync-events";
import { deriveEntryUrl, type ParsedEntry, type ParsedFeed } from "./types";
import { cleanEntryContent } from "./content-utils";
import { canonicalGuid, canonicalGuidSql, guidMatchCandidates } from "./guid-identity";
import { logger } from "@/lib/logger";

/**
 * Result of processing a single entry.
 */
export interface ProcessedEntry {
  /** The entry ID in the database */
  id: string;
  /** The entry GUID from the feed */
  guid: string;
  /** Whether this entry was newly created */
  isNew: boolean;
  /** Whether the entry content was updated */
  isUpdated: boolean;
  /**
   * Whether this entry is a backfill: a first sighting of an article published
   * long before our previous fetch of the feed. See `isBackfilledEntry`.
   */
  isBackfill: boolean;
  /**
   * The entry's database updated_at, used for event cursor tracking.
   * Present when isNew or isUpdated (unchanged entries aren't re-read).
   */
  updatedAt?: Date;
  /** What the new_entry event is built from. Present when isNew. */
  newEntryData?: NewEntryEventSource;
}

type NewEntryEventSource = NewEntryListDataSource & { isSpam: boolean; isBackfill: boolean };

/**
 * Result of processing all entries from a feed.
 */
export interface ProcessEntriesResult {
  /** Number of new entries created */
  newCount: number;
  /** Number of existing entries updated */
  updatedCount: number;
  /** Number of entries unchanged (content hash matched) */
  unchangedCount: number;
  /** Number of new entries classified as backfill (created, but not marked unread) */
  backfillCount: number;
  /** Number of entries that disappeared from the feed */
  disappearedCount: number;
  /** Whether any entries changed (new, updated, or disappeared) */
  hasChanges: boolean;
  /** Details of each processed entry */
  entries: ProcessedEntry[];
}

/**
 * Options for processing entries.
 */
export interface ProcessEntriesOptions {
  /** Current timestamp to use for fetchedAt (defaults to now) */
  fetchedAt?: Date;
  /** Previous lastEntriesUpdatedAt value, used to detect entries that disappeared from the feed */
  previousLastEntriesUpdatedAt?: Date | null;
  /**
   * `feeds.last_fetched_at` from *before* this fetch — the last time we pulled
   * the whole feed. Null/omitted on a feed's first fetch, which disables the
   * backfill guard (see `isBackfilledEntry`).
   */
  previousLastFetchedAt?: Date | null;
  /** The URL of the feed (for feed-specific content cleaning) */
  feedUrl?: string;
  /** The feed's title (feeds.title), carried on new_entry events for list display */
  feedTitle?: string | null;
  /**
   * Run the visibility bookkeeping (re-stamp `last_seen_at` for every entry in
   * this fetch + fan out `user_entries`) even when nothing changed. A normal
   * poll skips this on an unchanged fetch to avoid rewriting every row of the
   * largest table on every poll (issue #1084), so `last_seen_at` only advances
   * when entries actually change.
   *
   * The subscribe-time forced refresh (`handleFetchFeed`'s `forceReprocess`)
   * sets this so that ALL entries currently in the feed are re-stamped to this
   * fetch's timestamp, re-establishing a single visibility "generation". A new
   * subscriber is then populated via `last_seen_at >= last_entries_updated_at`
   * and sees exactly the current feed — including nothing a WebSub push left
   * stranded above the last poll's timestamp, and excluding anything a push
   * added and the publisher has since removed (it isn't re-stamped, so it falls
   * below the new generation). Only used on the rare subscribe path, so the
   * write churn is acceptable.
   */
  alwaysUpdateVisibility?: boolean;
}

/**
 * Generates a SHA-256 content hash for an entry.
 *
 * The hash covers title, content, author, and URL — the fields that
 * `updateEntryContent` actually rewrites when the hash changes. Previously only
 * title+content were hashed, so a feed correcting an entry's URL or author
 * without touching its text was silently ignored (see `processEntryWithCache`,
 * which only updates on a hash change).
 *
 * The URL is hashed with its http/https scheme canonicalized (`canonicalGuid`):
 * a feed that flips the scheme of its links between polls and hub pushes
 * (issue #1535) would otherwise register an update — and re-stamp the whole
 * feed, bump `updated_at` and re-ship `entry_updated` — on every fetch. A pure
 * scheme flip therefore leaves the stored URL as first seen; any other URL
 * change still propagates.
 *
 * `pubDate` is deliberately NOT hashed: `updateEntryContent` never rewrites
 * `published_at` because it is denormalized into `user_entries.published_or_fetched_at`
 * (the frozen timeline sort key, see src/server/CLAUDE.md), so propagating a date change on
 * update would require a cross-table update over every subscriber row. Hashing
 * `pubDate` would therefore only trigger updates that can't take effect. Future
 * dates are instead clamped once at insert time (see `clampPublishedAt`).
 *
 * @param entry - The parsed entry from the feed
 * @returns Hexadecimal SHA-256 hash string
 */
export function generateContentHash(entry: ParsedEntry): string {
  // Use empty strings for null/undefined values to ensure consistent hashing.
  // Use deriveEntryUrl so the hash tracks the URL we actually store (link, or a
  // URL-shaped guid), matching updateEntryContent's write.
  const title = entry.title ?? "";
  // mediaDescription is the content fallback for feeds that provide neither
  // content nor summary (YouTube), so hash it in that case — otherwise a
  // description edit would never propagate to the stored entry.
  const content = entry.content ?? entry.summary ?? entry.mediaDescription ?? "";
  const author = entry.author ?? "";
  const url = canonicalGuid(deriveEntryUrl(entry) ?? "");

  const hashInput = [title, content, author, url].join("\n");

  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

/**
 * Clamps an entry's publication date so it never sits in the future.
 *
 * Some feeds publish bogus future dates. Because the timeline sorts on
 * `COALESCE(published_at, fetched_at)`, a future date would pin the entry to the
 * top of the timeline indefinitely. We clamp anything after `fetchedAt` down to
 * `fetchedAt` (the moment we first saw it), which is the most honest lower bound
 * we have. Past dates and a missing date are left untouched.
 *
 * @param pubDate - The parsed publication date (may be undefined)
 * @param fetchedAt - The time the entry was fetched
 * @returns The clamped date, or null when no publication date was provided
 */
export function clampPublishedAt(pubDate: Date | undefined, fetchedAt: Date): Date | null {
  if (!pubDate) {
    return null;
  }
  return pubDate.getTime() > fetchedAt.getTime() ? fetchedAt : pubDate;
}

/** See {@link isBackfilledEntry}. */
const BACKFILL_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decides whether an article we are seeing for the first time is a **backfill**:
 * something the publisher re-announced out of its archive rather than news
 * (issue #1500: one WordPress bulk edit put ~600 four-year-old articles into
 * subscribers' unread counts). A replay can arrive one WebSub push at a time,
 * so the signal has to be per entry: a first sighting is a backfill when it was
 * published well before the previous full fetch — it was already old when we
 * last saw the whole feed, and it wasn't there. Backfilled entries are fanned
 * out already read and publish no `new_entry`, but stay in lists and search.
 *
 * The month threshold only has to clear ordinary syndication noise (stale CDN
 * copies, clock skew, mild backdating); archive replays miss it by years. The
 * guard is inert with no history to judge against: a feed's first fetch, a
 * subscribe-time forced refresh, a dormant feed polled again, and entries with
 * no date. Accepted risk: a feed whose dates are systematically wrong or old
 * has every first sighting marked read, visible only in the fetch's
 * `backfilledEntries` metadata.
 *
 * The verdict is persisted as `entries.is_backfill` at insert time, because the
 * paths that grant visibility later — the fetch fanout's #952 self-heal, the
 * subscribe-time populate — no longer have the context to re-derive it.
 *
 * @param publishedAt - The entry's (clamped) publication date, or null
 * @param previousLastFetchedAt - `feeds.last_fetched_at` from before this fetch;
 *   null disables the guard
 */
export function isBackfilledEntry(
  publishedAt: Date | null,
  previousLastFetchedAt: Date | null | undefined
): boolean {
  if (!publishedAt || !previousLastFetchedAt) {
    return false;
  }
  return publishedAt.getTime() < previousLastFetchedAt.getTime() - BACKFILL_MIN_AGE_MS;
}

/**
 * Derives a GUID for an entry using a fallback chain.
 * Priority: guid -> link -> title
 *
 * @param entry - The parsed entry from the feed
 * @returns A string to use as the entry's GUID
 * @throws Error if no suitable identifier can be derived
 */
export function deriveGuid(entry: ParsedEntry): string {
  // Use explicit GUID if available
  if (entry.guid && entry.guid.trim()) {
    return entry.guid.trim();
  }

  // Fall back to link
  if (entry.link && entry.link.trim()) {
    return entry.link.trim();
  }

  // Fall back to title
  if (entry.title && entry.title.trim()) {
    return entry.title.trim();
  }

  throw new Error("Cannot derive GUID: entry has no guid, link, or title");
}

/**
 * The content columns derived from a parsed entry, shared by insert and update.
 * Stores only the raw columns; the read path sanitizes per read (issue #1282).
 *
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 */
function entryContentColumns(parsedEntry: ParsedEntry, contentHash: string, feedUrl?: string) {
  const entryUrl = deriveEntryUrl(parsedEntry);
  const cleaningResult = cleanEntryContent(parsedEntry, { entryUrl, feedUrl });
  return {
    url: entryUrl ?? null,
    title: parsedEntry.title ?? null,
    author: parsedEntry.author ?? null,
    contentOriginal: cleaningResult.contentOriginal,
    contentCleaned: cleaningResult.contentCleaned,
    summary: cleaningResult.summary,
    contentHash,
  };
}

/**
 * Creates a new entry in the database.
 *
 * @param feedId - The (web) feed's UUID
 * @param parsedEntry - The parsed entry from the feed
 * @param contentHash - Pre-computed content hash
 * @param fetchedAt - Timestamp when the entry was fetched
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @param previousLastFetchedAt - `feeds.last_fetched_at` from before this fetch,
 *   used to stamp `is_backfill` (see `isBackfilledEntry`)
 * @returns The created entry
 */
export async function createEntry(
  feedId: string,
  parsedEntry: ParsedEntry,
  contentHash: string,
  fetchedAt: Date,
  feedUrl?: string,
  previousLastFetchedAt?: Date | null
): Promise<Entry> {
  const guid = deriveGuid(parsedEntry);
  const publishedAt = clampPublishedAt(parsedEntry.pubDate, fetchedAt);

  const newEntry: NewEntry = {
    id: generateUuidv7(),
    feedId,
    type: "web",
    guid,
    ...entryContentColumns(parsedEntry, contentHash, feedUrl),
    publishedAt,
    fetchedAt,
    // Tracks visibility on subscription (see processEntries)
    lastSeenAt: fetchedAt,
    isBackfill: isBackfilledEntry(publishedAt, previousLastFetchedAt),
  };

  const [entry] = await db.insert(entries).values(newEntry).returning();

  return entry;
}

/**
 * Updates an existing entry's content in the database.
 *
 * @param entryId - The entry's UUID
 * @param parsedEntry - The parsed entry from the feed
 * @param contentHash - New content hash
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @returns The updated entry
 */
export async function updateEntryContent(
  entryId: string,
  parsedEntry: ParsedEntry,
  contentHash: string,
  feedUrl?: string
): Promise<Entry> {
  const [entry] = await db
    .update(entries)
    .set({ ...entryContentColumns(parsedEntry, contentHash, feedUrl), updatedAt: new Date() })
    .where(eq(entries.id, entryId))
    .returning();

  return entry;
}

/**
 * Extracts the list-item metadata for new_entry events from an entry row.
 */
function toNewEntryData(entry: Entry): NewEntryEventSource {
  return {
    url: entry.url,
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    publishedAt: entry.publishedAt,
    fetchedAt: entry.fetchedAt,
    siteName: entry.siteName,
    isSpam: entry.isSpam,
    isBackfill: entry.isBackfill,
  };
}

/**
 * Cached entry info for avoiding N+1 queries.
 */
interface CachedEntryInfo {
  id: string;
  guid: string;
  contentHash: string | null;
}

/**
 * Processes a single entry using a pre-loaded cache of existing entries.
 * This avoids N+1 queries by using a Map lookup instead of a database query.
 *
 * @param feedId - The feed's UUID
 * @param parsedEntry - The parsed entry from the feed
 * @param fetchedAt - Timestamp when the entry was fetched
 * @param existingEntriesMap - Map of canonical GUID (`canonicalGuid`) to existing entry info
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @returns Processing result for this entry
 */
async function processEntryWithCache(
  feedId: string,
  parsedEntry: ParsedEntry,
  fetchedAt: Date,
  existingEntriesMap: Map<string, CachedEntryInfo>,
  feedUrl?: string,
  previousLastFetchedAt?: Date | null
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const guidKey = canonicalGuid(guid);
  const contentHash = generateContentHash(parsedEntry);

  // Use cached lookup instead of database query. Keyed on the canonical guid so
  // an http/https re-spelling of a known guid resolves to the existing row
  // (#1535); the row keeps whatever spelling it was created with.
  const existing = existingEntriesMap.get(guidKey);

  if (!existing) {
    // New entry - create it.
    // Note: the new_entry event is NOT published here — processEntries
    // publishes it after createUserEntriesForFeed so the SSE endpoint's
    // per-user count computation sees the entry in visible_entries.
    const entry = await createEntry(
      feedId,
      parsedEntry,
      contentHash,
      fetchedAt,
      feedUrl,
      previousLastFetchedAt
    );

    // Add to cache so duplicate GUIDs in same feed don't create duplicates
    existingEntriesMap.set(guidKey, { id: entry.id, guid, contentHash });

    return {
      id: entry.id,
      guid,
      isNew: true,
      isUpdated: false,
      isBackfill: entry.isBackfill,
      updatedAt: entry.updatedAt,
      newEntryData: toNewEntryData(entry),
    };
  }

  // Entry exists - check if content changed
  if (existing.contentHash !== contentHash) {
    // Content changed - update it
    const entry = await updateEntryContent(existing.id, parsedEntry, contentHash, feedUrl);

    // Update cache with new hash
    existingEntriesMap.set(guidKey, { ...existing, contentHash });

    // Publish entry_updated event for real-time updates (safe to publish here:
    // subscribers' user_entries rows already exist for a previously-seen entry).
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishEntryUpdatedFromEntry(feedId, entry).catch((err) => {
      logger.error("Failed to publish entry_updated event", {
        feedId,
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      id: entry.id,
      guid,
      isNew: false,
      isUpdated: true,
      isBackfill: false,
      updatedAt: entry.updatedAt,
    };
  }

  // Content unchanged
  return {
    id: existing.id,
    guid,
    isNew: false,
    isUpdated: false,
    isBackfill: false,
  };
}

/**
 * Updates lastSeenAt for entries seen in the current fetch.
 * This is used to track which entries are currently in the feed,
 * enabling subscription without re-fetching.
 *
 * Only applies to rss/atom/json feeds - email/saved entries don't use lastSeenAt.
 *
 * Deliberately does NOT touch `updated_at`: that column is the "content changed"
 * signal (set only by createEntry/updateEntryContent) and drives every
 * subscriber's delta sync via visible_entries.updated_at (sync.events + the
 * Wallabag `since` query). Bumping it here — on every still-present entry of any
 * feed that gained a single item — would re-ship `entry_updated` payloads for
 * entries whose content never changed and rewrite every wide row on the largest
 * table (MVCC/WAL/index churn). `last_seen_at` alone is what visibility needs.
 * The write is **monotonic** — it only advances `last_seen_at` forward
 * (`IS NULL OR < lastSeenAt`), never backward. That both preserves the #1084
 * optimization (an entry already at this timestamp isn't rewritten) and makes
 * the write safe under concurrency: a WebSub push (`ingestWebsubNotification`)
 * is processed in the hub's callback request, outside the job queue's per-feed
 * serialization, so it can run alongside a worker poll of the same feed. If an
 * earlier-timestamped writer could regress a stamp another writer already
 * advanced, entries could end up **below** the feed's `last_entries_updated_at`
 * (which only moves forward), making the `>=` subscribe populate match nothing —
 * the exact #1078 empty feed. Monotonic writes guarantee every current entry
 * ends at ≥ the max writer timestamp ≥ the final `last_entries_updated_at`.
 *
 * @param entryIds - Array of entry IDs seen in this fetch
 * @param lastSeenAt - Timestamp to set (only applied where it moves forward)
 */
async function updateEntriesLastSeenAt(entryIds: string[], lastSeenAt: Date): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  // Batch update in chunks to avoid hitting query limits
  const BATCH_SIZE = 1000;
  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    await db
      .update(entries)
      .set({ lastSeenAt })
      .where(
        and(
          inArray(entries.id, batch),
          // Parenthesized: AND binds tighter than OR in SQL, so without the
          // parens the id filter would only guard the first arm and the OR would
          // match every row in the table.
          sql`(${entries.lastSeenAt} IS NULL OR ${entries.lastSeenAt} < ${lastSeenAt})`
        )
      );
  }
}

/**
 * Creates user_entries records for a feed's active subscribers.
 * This makes entries visible to all currently-subscribed users.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for efficiency and idempotency. Because
 * it is idempotent and driven purely by the entry IDs passed in (not by whether
 * an entry is "new"), callers can safely pass *every* entry in the current fetch
 * to self-heal entries orphaned by an earlier crash — see `processEntries`.
 *
 * The row's initial read state is copied from `entries.is_backfill`, so an
 * archive re-announcement (see `isBackfilledEntry`) never reaches an unread
 * badge — including when this call is the #952 self-heal running fetches later,
 * which no longer has the classification context. `read_changed_at` stays NULL:
 * the user hasn't touched the entry, so any later explicit change of theirs wins
 * the last-writer-wins comparison.
 *
 * @param feedId - The feed's UUID
 * @param entryIds - Array of entry IDs to make visible
 */
export async function createUserEntriesForFeed(feedId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  // Format entry IDs as PostgreSQL array literal because node-postgres
  // doesn't auto-convert JS arrays to pg arrays in raw SQL.
  const entryIdsArray = `{${entryIds.join(",")}}`;

  // Single INSERT...SELECT query that:
  // 1. Joins subscriptions with entries for the given feed to get all (user, entry) pairs
  // 2. Excludes pairs where the user already has a user_entry for an entry
  //    with the same GUID from one of their previous feeds (redirect
  //    deduplication). "Previous feeds" = entries already attributed to this
  //    subscription (user_entries.subscription_id) under a different feed_id
  //    — re-stamped by `mergeSubscriptionIntoFeed` when the fetch-feed
  //    handler moves subscriptions off a redirected feed. GUIDs are
  //    compared scheme-insensitively (see guid-identity.ts): a feed that moved
  //    to https often re-spells its guids at the same time.
  //    The check starts from the entry's twins in other feeds, found through
  //    idx_entries_web_guid_canonical (normally none), then probes the
  //    subscriber's row by primary key. Starting from the subscription's
  //    history instead walks every entry it holds, per subscriber and entry
  //    (#1861). `type = 'web'` lets the partial index serve the lookup and
  //    drops nothing: only a merge re-stamps a row onto another feed's
  //    subscription, and only web subscriptions are merged.
  // 3. Uses ON CONFLICT DO NOTHING for idempotency
  // We use db.execute() with raw SQL because Drizzle's INSERT...SELECT always
  // generates column lists for all table columns. Since we only want to insert
  // the identity + denormalized columns and let the rest use defaults, we need
  // raw SQL to specify just those columns.
  // https://github.com/drizzle-team/drizzle-orm/issues/3608
  const result = await db.execute(sql`
      INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, subscription_id, is_spam, read)
      SELECT s.user_id, e.id, COALESCE(e.published_at, e.fetched_at), s.id, e.is_spam, e.is_backfill
      FROM subscriptions s
      INNER JOIN entries e ON e.feed_id = s.feed_id
      WHERE s.feed_id = ${feedId}::uuid
        AND s.unsubscribed_at IS NULL
        AND e.id = ANY(${entryIdsArray}::uuid[])
        AND NOT EXISTS (
          SELECT 1
          FROM entries e_prev
          JOIN user_entries ue_existing
            ON ue_existing.user_id = s.user_id AND ue_existing.entry_id = e_prev.id
          WHERE e_prev.type = 'web'
            AND ${sql.raw(canonicalGuidSql("e_prev.guid"))} = ${sql.raw(canonicalGuidSql("e.guid"))}
            AND e_prev.feed_id != s.feed_id
            AND ue_existing.subscription_id = s.id
        )
      ON CONFLICT DO NOTHING
    `);

  logger.debug("Created user entries for feed", {
    feedId,
    entryCount: entryIds.length,
    rowsInserted: result.rowCount,
  });
}

/**
 * Processes all entries from a parsed feed.
 * Creates new entries, updates existing ones with changed content,
 * and tracks statistics. Also creates user_entries records
 * to make entries visible to all active subscribers.
 *
 * Detects entries that disappeared from the feed (entries that had
 * lastSeenAt = previousLastEntriesUpdatedAt but aren't in the current feed).
 *
 * New entries that are really an archive re-announcement rather than news are
 * fanned out already-read — see `isBackfilledEntry` and `previousLastFetchedAt`.
 *
 * Only web feeds are fetched (polled or pushed via WebSub), so every entry
 * processed here is a web entry.
 *
 * @param feedId - The feed's UUID
 * @param feed - The parsed feed containing entries
 * @param options - Processing options
 * @returns Processing result with counts and entry details
 *
 * @example
 * const result = await processEntries(feedId, parsedFeed);
 * console.log(`New: ${result.newCount}, Updated: ${result.updatedCount}`);
 */
export async function processEntries(
  feedId: string,
  feed: ParsedFeed,
  options: ProcessEntriesOptions = {}
): Promise<ProcessEntriesResult> {
  const {
    fetchedAt = new Date(),
    previousLastEntriesUpdatedAt,
    previousLastFetchedAt,
    feedUrl,
    feedTitle,
    alwaysUpdateVisibility = false,
  } = options;

  // Derive GUIDs from all items first, so we only query for entries we need.
  // Matching is http/https-insensitive (#1535), so look up every spelling a
  // stored row might carry — exact values, so the (feed_id, guid) unique index
  // serves the query — and key the cache on the canonical form.
  const guidsToCheck = new Set<string>();
  const currentGuidKeys = new Set<string>();
  for (const item of feed.items) {
    try {
      const guid = deriveGuid(item);
      for (const candidate of guidMatchCandidates(guid)) {
        guidsToCheck.add(candidate);
      }
      currentGuidKeys.add(canonicalGuid(guid));
    } catch {
      // Invalid entry without GUID - will be skipped during processing
    }
  }

  // Batch load only the entries we're looking for (by GUID) to avoid N+1 queries
  // This is much more efficient than querying per-entry, and doesn't load
  // thousands of historical entries we don't need
  const existingEntries =
    guidsToCheck.size > 0
      ? await db
          .select({
            id: entries.id,
            guid: entries.guid,
            contentHash: entries.contentHash,
          })
          .from(entries)
          .where(and(eq(entries.feedId, feedId), inArray(entries.guid, [...guidsToCheck])))
      : [];

  // At most one row per key: uq_entries_feed_guid_canonical enforces it.
  const existingEntriesMap = new Map<string, CachedEntryInfo>(
    existingEntries.map((e) => [canonicalGuid(e.guid), e])
  );

  const results: ProcessedEntry[] = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let backfillCount = 0;

  for (const item of feed.items) {
    try {
      const result = await processEntryWithCache(
        feedId,
        item,
        fetchedAt,
        existingEntriesMap,
        feedUrl,
        previousLastFetchedAt
      );
      results.push(result);

      if (result.isBackfill) {
        backfillCount++;
      }
      if (result.isNew) {
        newCount++;
      } else if (result.isUpdated) {
        updatedCount++;
      } else {
        unchangedCount++;
      }
    } catch (error) {
      // Log error but continue processing other entries
      // Entry without valid GUID will be skipped
      logger.error("Failed to process entry", {
        feedId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Detect entries that disappeared from the feed: entries that
  // were visible (last_seen_at >= previousLastEntriesUpdatedAt) but whose guid is
  // no longer in the current feed (compared scheme-insensitively, so a feed that
  // flips http/https between polls doesn't report its whole contents gone).
  let disappearedCount = 0;

  if (previousLastEntriesUpdatedAt) {
    // `>=`, not `=`: an entry a WebSub hub pushed since the last poll sits ABOVE
    // previousLastEntriesUpdatedAt (last_seen_at = pushTime). Strict equality
    // missed those, so a poll that confirmed such an entry was gone never counted
    // it disappeared — leaving it stamped above the pointer and still granted to
    // new subscribers by the `>=` populate even though it's no longer in the feed
    // (issue #1078). With `>=` the poll counts it disappeared → hasChanges → the
    // generation (last_entries_updated_at) advances past it → it's excluded. For a
    // non-WebSub feed nothing is stamped above the pointer, so `>=` is exactly `=`.
    const previouslyCurrentEntries = await db
      .select({ guid: entries.guid })
      .from(entries)
      .where(
        and(eq(entries.feedId, feedId), gte(entries.lastSeenAt, previousLastEntriesUpdatedAt))
      );

    for (const entry of previouslyCurrentEntries) {
      if (!currentGuidKeys.has(canonicalGuid(entry.guid))) {
        disappearedCount++;
      }
    }
  }

  const allEntryIds = results.map((r) => r.id);
  const hasChanges = newCount > 0 || updatedCount > 0 || disappearedCount > 0;

  // The visibility bookkeeping (re-stamp last_seen_at + fan out user_entries)
  // normally runs only when the feed changed, so steady-state feeds pay nothing.
  // The subscribe-time forced refresh sets alwaysUpdateVisibility to run it on an
  // unchanged fetch too, re-stamping the whole current feed to this fetch's
  // timestamp (see the option's doc comment).
  const shouldUpdateVisibility = hasChanges || alwaysUpdateVisibility;

  // Update lastSeenAt for all entries in this fetch
  // The timestamp used here should match feeds.lastEntriesUpdatedAt
  if (shouldUpdateVisibility) {
    await updateEntriesLastSeenAt(allEntryIds, fetchedAt);
  }

  // Fan out user_entries for ALL entries in this fetch, not just the ones that
  // are new *this* time. The fanout is idempotent (ON CONFLICT DO NOTHING), so
  // re-processing an already-visible entry is a no-op — but making it
  // state-driven (all current entry IDs) rather than event-driven (only isNew)
  // means an entry that was inserted by a previous fetch which then crashed
  // *before* fanning out gets healed on the next fetch that touches the feed.
  // The old event-driven fanout lost such an entry permanently: on the retry it
  // matches by content_hash and is reported isNew:false, so it would never be
  // fanned out again and stayed invisible to every subscriber (issue #952).
  //
  // Runs whenever the feed changed (new/updated/disappeared), or on a forced
  // subscribe-time refresh (alwaysUpdateVisibility). Unchanged polls skip it, so
  // steady-state feeds pay nothing; a feed with any activity heals its orphans.
  // Existing subscribers already have rows for existing entries; new subscribers
  // get rows at subscription time.
  //
  // A backfilled entry (an archive re-announcement, see `isBackfilledEntry`)
  // needs no special handling here: the fanout copies its read state from
  // `entries.is_backfill`, so it arrives already read on this fetch and on every
  // later one that re-covers it.
  if (shouldUpdateVisibility) {
    await createUserEntriesForFeed(feedId, allEntryIds);
  }

  if (newCount > backfillCount) {
    // Publish new_entry events AFTER the user_entries fanout: the SSE endpoint
    // computes each connected subscriber's absolute unread counts from
    // visible_entries when the event arrives, so the rows must exist first or
    // the counts would exclude these entries (leaving badges stale until the
    // next count-bearing event). Fire and forget — publishing failures must
    // not affect entry processing.
    for (const result of results) {
      const announcement =
        result.isNew && result.newEntryData
          ? newEntryAnnouncement(result.newEntryData, feedTitle ?? null)
          : null;
      if (announcement && result.updatedAt) {
        publishNewEntry(feedId, result.id, result.updatedAt, announcement.entry).catch((err) => {
          logger.error("Failed to publish new_entry event", {
            feedId,
            entryId: result.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  return {
    newCount,
    updatedCount,
    unchangedCount,
    backfillCount,
    disappearedCount,
    hasChanges,
    entries: results,
  };
}
