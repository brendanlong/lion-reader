/**
 * Entry processing module.
 * Handles storing entries from parsed feeds, detecting new vs updated entries,
 * and content hash generation for change detection.
 *
 * Publishes Redis events for new and updated entries to enable real-time updates.
 */

import { createHash } from "crypto";
import { eq, and, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { db as dbType } from "../db";
import { entries, userEntries, type Entry, type NewEntry } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishFeedEvent, publishUserEvent } from "../redis/pubsub";
import type { NewEntryListDataSource } from "@/lib/events/schemas";
import { newEntryAnnouncement, toEntryMetadata } from "@/server/services/entry-sync-events";
import { entryMemberships } from "@/server/services/entry-filters";
import { deriveEntryUrl, type ParsedEntry, type ParsedFeed } from "./types";
import { cleanEntryContent } from "./content-utils";
import { canonicalGuid, guidMatchCandidates } from "./guid-identity";
import { replaceNul } from "../db/nul";
import {
  holdsRedirectTwin,
  insertUserEntriesWithMemberships,
} from "@/server/services/subscription-entries";
import { logger } from "@/lib/logger";
import { retryDeadlocks } from "../db/errors";

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
   * Whether this new entry is a backfill: an article published long before our
   * previous fetch of the feed. See `isBackfilledEntry`.
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

type NewEntryEventSource = NewEntryListDataSource & { isSpam: boolean };

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
  /**
   * The entries this fetch announced as news to some subscriber: its new
   * entries that aren't backfill, then any it linked to a subscriber unread
   * otherwise (see `announceLinkedEntries`). What the full-content fetch takes.
   */
  announcedEntryIds: string[];
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
   * backfill guard (see `isBackfilledEntry`). A poll also uses it to tell which
   * pushed entries were current (`currentEntryIdsSql`).
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
   * when the feed's current entries change.
   *
   * The subscribe-time forced refresh (`handleFetchFeed`'s `forceReprocess`)
   * sets this so the fanout reaches the new subscriber even when the feed is
   * unchanged. Only used on the rare subscribe path, so the write churn is
   * acceptable.
   */
  alwaysUpdateVisibility?: boolean;
  /**
   * The entries came from a WebSub push, not a poll. A push inserts, updates
   * and fans out to current subscribers like a poll, but stamps `pushed_at`
   * instead of `last_seen_at` on every entry it announces (one it inserts keeps
   * `last_seen_at` NULL), which keeps them current until the next poll
   * (`currentEntryIdsSql`). A push can't detect disappeared entries, so it never
   * passes `previousLastEntriesUpdatedAt`.
   */
  pushed?: boolean;
}

/**
 * The ids of a feed's current entries, the ones a new subscriber is granted
 * ("Entry Visibility" in src/server/CLAUDE.md): `last_seen_at >=
 * last_entries_updated_at` (the last poll that stamped the feed saw it) or
 * `pushed_at > last_fetched_at` (a WebSub hub announced it after the last
 * poll, which says it is in the feed until the next poll). An entry that poll
 * doesn't list, and no push announces again, stops being current. A push's
 * `pushed_at` and a poll's `last_fetched_at` both come from the database clock
 * (`databaseNow`), so the comparison holds across machines.
 *
 * One range scan per arm (`idx_entries_owner_feed_last_seen`,
 * `idx_entries_owner_feed_pushed`): written as an `OR`, the planner scans every
 * entry the feed ever had.
 *
 * @param feedId - The feed
 * @param feed - Its `last_entries_updated_at` and `last_fetched_at`, as values
 *   or as SQL reading them
 */
export function currentEntryIdsSql(
  feedId: string,
  feed: {
    lastEntriesUpdatedAt: SQLWrapper | Date | null;
    lastFetchedAt: SQLWrapper | Date | null;
  }
): SQL {
  const stamped = sql`last_seen_at >= ${feed.lastEntriesUpdatedAt}`;
  return sql`
    SELECT id FROM entries
    WHERE owner_feed_id = ${feedId}::uuid AND type = 'web' AND ${stamped}
    UNION ALL
    SELECT id FROM entries
    WHERE owner_feed_id = ${feedId}::uuid AND type = 'web' AND pushed_at > ${feed.lastFetchedAt}
      AND (${stamped}) IS NOT TRUE`;
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
export const BACKFILL_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decides whether an article reaching a subscriber who was already watching
 * the feed is a **backfill**: something the publisher re-announced out of its
 * archive rather than news (issue #1500: one WordPress bulk edit put ~600
 * four-year-old articles into subscribers' unread counts). A replay can arrive
 * one WebSub push at a time, so the signal has to be per entry: an entry is a
 * backfill when it was published well before the feed's previous full fetch —
 * it was already old when we last saw the whole feed, and it wasn't there.
 * Backfilled entries are linked already read, but stay in lists and search.
 *
 * The verdict belongs to the link, not the entry (#2036), and only applies to
 * deliveries after a subscription's first grant ({@link linksReadSql}): what
 * a new subscriber is first given — by the subscribe populate or a forced
 * subscribe-time refresh — is all news to them, however old.
 *
 * The month threshold only has to clear ordinary syndication noise (stale CDN
 * copies, clock skew, mild backdating); archive replays miss it by years. The
 * guard is inert on a feed's first fetch and on entries with no date, and
 * never fires on articles published since the previous fetch. Accepted risk: a
 * feed whose dates are systematically wrong or old has every new article
 * linked read, visible only in the fetch's `backfilledEntries` metadata.
 *
 * Judged per fetch, this is the verdict for existing subscribers: a backfill
 * publishes no `new_entry`.
 *
 * @param publishedAt - The entry's (clamped) publication date, or null
 * @param previousLastFetchedAt - The feed's previous full fetch; null disables
 *   the guard
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
 * The `read` a fan-out links entry `e` to subscription `s` with: whether it is
 * a backfill ({@link isBackfilledEntry}) and `s` already had its first grant,
 * i.e. holds any entry. Never NULL. The date check goes first so the probe
 * only runs for old entries.
 *
 * Accepted imprecision, all rare: memberships outlive an unsubscribe and a
 * redirect merge copies them, so a returning or merged subscriber is judged
 * at once; a delivery landing between subscribe and the forced refresh
 * becomes the first grant; and a populate that grants nothing leaves the
 * next delivery exempt.
 */
function linksReadSql(previousLastFetchedAt: Date | null): SQL {
  return sql`COALESCE(
    e.published_at < ${previousLastFetchedAt}::timestamptz - ${BACKFILL_MIN_AGE_MS} * interval '1 millisecond'
      AND EXISTS (SELECT 1 FROM subscription_entries held WHERE held.subscription_id = s.id),
    false)`;
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
  const guid = entry.guid?.trim() || entry.link?.trim() || entry.title?.trim();
  if (guid) {
    // Matches the stored guid, which the pool's NulSafeClient rewrote.
    return replaceNul(guid);
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
 * @param pushed - Whether a WebSub push delivered it (`ProcessEntriesOptions.pushed`)
 * @returns The created entry, or null if the feed already has an entry with this
 *   guid (a concurrent run of the same feed inserted it first)
 */
export async function createEntry(
  db: typeof dbType,
  feedId: string,
  parsedEntry: ParsedEntry,
  contentHash: string,
  fetchedAt: Date,
  feedUrl?: string,
  pushed = false
): Promise<Entry | null> {
  const guid = deriveGuid(parsedEntry);
  const publishedAt = clampPublishedAt(parsedEntry.pubDate, fetchedAt);

  const newEntry: NewEntry = {
    id: generateUuidv7(),
    ownerFeedId: feedId,
    type: "web",
    guid,
    ...entryContentColumns(parsedEntry, contentHash, feedUrl),
    publishedAt,
    fetchedAt,
    // Tracks visibility on subscription (see processEntries)
    lastSeenAt: pushed ? null : fetchedAt,
    pushedAt: pushed ? fetchedAt : null,
  };

  const [entry] = await db.insert(entries).values(newEntry).onConflictDoNothing().returning();

  return entry ?? null;
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
  db: typeof dbType,
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
    type: entry.type,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    publishedAt: entry.publishedAt,
    fetchedAt: entry.fetchedAt,
    siteName: entry.siteName,
    isSpam: entry.isSpam,
  };
}

/**
 * Cached entry info for avoiding N+1 queries.
 */
interface CachedEntryInfo {
  id: string;
  guid: string;
  contentHash: string | null;
  lastSeenAt: Date | null;
}

const existingEntryColumns = {
  id: entries.id,
  guid: entries.guid,
  contentHash: entries.contentHash,
  lastSeenAt: entries.lastSeenAt,
};

async function loadExistingEntry(
  db: typeof dbType,
  feedId: string,
  guid: string
): Promise<CachedEntryInfo> {
  const [existing] = await db
    .select(existingEntryColumns)
    .from(entries)
    .where(and(eq(entries.ownerFeedId, feedId), inArray(entries.guid, guidMatchCandidates(guid))))
    .limit(1);
  if (!existing) {
    throw new Error(`Entry insert conflicted but no entry matches guid ${guid}`);
  }
  return existing;
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
  db: typeof dbType,
  feedId: string,
  parsedEntry: ParsedEntry,
  fetchedAt: Date,
  existingEntriesMap: Map<string, CachedEntryInfo>,
  feedUrl: string | undefined,
  previousLastFetchedAt: Date | null | undefined,
  pushed: boolean
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const guidKey = canonicalGuid(guid);
  const contentHash = generateContentHash(parsedEntry);

  // Use cached lookup instead of database query. Keyed on the canonical guid so
  // an http/https re-spelling of a known guid resolves to the existing row
  // (#1535); the row keeps whatever spelling it was created with.
  let existing = existingEntriesMap.get(guidKey);

  if (!existing) {
    // New entry - create it.
    // Note: the new_entry event is NOT published here — processEntries
    // publishes it after createUserEntriesForFeed so the SSE endpoint's
    // per-user count computation sees the entry in visible_entries.
    const entry = await createEntry(
      db,
      feedId,
      parsedEntry,
      contentHash,
      fetchedAt,
      feedUrl,
      pushed
    );

    if (entry) {
      // Add to cache so duplicate GUIDs in same feed don't create duplicates
      existingEntriesMap.set(guidKey, {
        id: entry.id,
        guid,
        contentHash,
        lastSeenAt: entry.lastSeenAt,
      });

      return {
        id: entry.id,
        guid,
        isNew: true,
        isUpdated: false,
        isBackfill: isBackfilledEntry(entry.publishedAt, previousLastFetchedAt),
        updatedAt: entry.updatedAt,
        newEntryData: toNewEntryData(entry),
      };
    }

    // A concurrent run of this feed (e.g. a push during a poll) created it
    // after we loaded the cache; carry on with that row as an existing entry.
    existing = await loadExistingEntry(db, feedId, guid);
    existingEntriesMap.set(guidKey, existing);
  }

  // Entry exists - check if content changed
  if (existing.contentHash !== contentHash) {
    // Content changed - update it
    const entry = await updateEntryContent(db, existing.id, parsedEntry, contentHash, feedUrl);

    // Update cache with new hash
    existingEntriesMap.set(guidKey, { ...existing, contentHash });

    // Publish entry_updated event for real-time updates (safe to publish here:
    // subscribers' user_entries rows already exist for a previously-seen entry).
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishFeedEvent({
      type: "entry_updated",
      feedId,
      entryId: entry.id,
      updatedAt: entry.updatedAt,
      metadata: toEntryMetadata(entry),
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
 * Stamps `last_seen_at` on the entries a poll saw, marking them the feed's
 * current entries for the subscribe populate. Only polls call this. Polls of a
 * feed rarely overlap, and when they do they only over-stamp until the next poll.
 *
 * Deliberately does NOT touch `updated_at`: that column is the "content changed"
 * signal (set only by createEntry/updateEntryContent) and drives every
 * subscriber's delta sync via visible_entries.updated_at (sync.events + the
 * Wallabag `since` query). Bumping it here — on every still-present entry of any
 * feed that gained a single item — would re-ship `entry_updated` payloads for
 * entries whose content never changed and rewrite every wide row on the largest
 * table (MVCC/WAL/index churn). `last_seen_at` alone is what visibility needs.
 *
 * @param entryIds - Array of entry IDs seen in this fetch
 * @param lastSeenAt - The poll's timestamp, which becomes `last_entries_updated_at`
 */
async function updateEntriesLastSeenAt(
  db: typeof dbType,
  entryIds: string[],
  lastSeenAt: Date
): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  // Batch update in chunks to avoid hitting query limits
  const BATCH_SIZE = 1000;
  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    await db.update(entries).set({ lastSeenAt }).where(inArray(entries.id, batch));
  }
}

/**
 * Stamps `pushed_at` on the existing entries a WebSub push announced, keeping
 * them current until the next poll (`currentEntryIdsSql`). Like
 * `updateEntriesLastSeenAt`, it leaves `updated_at` alone.
 */
async function updateEntriesPushedAt(
  db: typeof dbType,
  entryIds: string[],
  pushedAt: Date
): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }
  await db.update(entries).set({ pushedAt }).where(inArray(entries.id, entryIds));
}

/**
 * Gives a feed's active subscribers these entries: each subscriber's
 * user_entries row and its membership in their subscription
 * (`insertUserEntriesWithMemberships`), which make the entry visible.
 *
 * Idempotent: an entry a subscription already holds is skipped. Because it is
 * idempotent and driven purely by the entry IDs passed in (not by whether
 * an entry is "new"), callers can safely pass *every* entry in the current fetch
 * to self-heal entries orphaned by an earlier crash — see `processEntries`.
 *
 * A row's initial read state is judged at this link, per subscription
 * (`linksReadSql`), so an archive re-announcement never reaches an existing
 * subscriber's unread badge. `read_changed_at` stays NULL:
 * the user hasn't touched the entry, so any later explicit change of theirs wins
 * the last-writer-wins comparison.
 *
 * @param feedId - The feed's UUID
 * @param entryIds - Array of entry IDs to make visible
 * @param previousLastFetchedAt - The feed's previous full fetch, which the
 *   backfill guard judges against; null disables it
 * @returns The memberships it added
 */
export async function createUserEntriesForFeed(
  db: typeof dbType,
  feedId: string,
  entryIds: string[],
  previousLastFetchedAt: Date | null
): Promise<FanOutLink[]> {
  if (entryIds.length === 0) {
    return [];
  }

  // Format entry IDs as PostgreSQL array literal because node-postgres
  // doesn't auto-convert JS arrays to pg arrays in raw SQL.
  const entryIdsArray = `{${entryIds.join(",")}}`;

  // Each active subscriber gets every entry it doesn't hold yet (its row and
  // its membership), except an entry whose twin from another feed it already
  // holds (holdsRedirectTwin). Nearly every pair is already held, so the
  // MATERIALIZED fence drops held pairs before the twin check, which the
  // planner would otherwise run for every subscriber and entry first.
  const fanOut = () =>
    insertUserEntriesWithMemberships(
      db,
      sql`
      WITH missing AS MATERIALIZED (
        SELECT s.id AS subscription_id, s.user_id, e.id AS entry_id,
               COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
               e.is_spam, ${linksReadSql(previousLastFetchedAt)} AS read,
               e.guid, e.owner_feed_id
        FROM subscriptions s
        INNER JOIN entries e ON e.owner_feed_id = s.feed_id
        WHERE s.feed_id = ${feedId}::uuid
          AND s.unsubscribed_at IS NULL
          AND e.id = ANY(${entryIdsArray}::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM subscription_entries se
            WHERE se.subscription_id = s.id AND se.entry_id = e.id
          )
      )
      SELECT subscription_id, user_id, entry_id, published_or_fetched_at, is_spam, read
      FROM missing m
      WHERE NOT ${holdsRedirectTwin(sql`m.subscription_id`, "m")}
    `
    );
  // A WebSub push runs outside the feed's job, so two fan-outs of the same
  // entries can deadlock (they insert many rows each). Retry the loser: a poll
  // has already stamped last_seen_at, so an unchanged next poll wouldn't fan
  // these entries out again, and a push's subscribers would wait for a poll.
  const added = await retryDeadlocks(fanOut, (attempt) =>
    logger.warn("Fan-out lost a deadlock; retrying", { feedId, attempt })
  );

  logger.debug("Created user entries for feed", {
    feedId,
    entryCount: entryIds.length,
    membershipsAdded: added.length,
  });
  return added;
}

type FanOutLink = Awaited<ReturnType<typeof insertUserEntriesWithMemberships>>[number];

/**
 * Publishes new_entry, on each subscriber's own channel, for the links a
 * fan-out added that the feed's channel doesn't announce (#2062): anything
 * but the fetch's new entries that aren't backfill. That is a stale-feed
 * subscribe's first grant (archive entries included), an entry reappearing to
 * a subscriber who joined since, and a #952 heal. Each carries the user's
 * state and memberships, as the catch-up's does, and a link made already read
 * (a backfill) announces nothing, as there. Fire and forget, like the feed's.
 *
 * @returns The ids of the entries it announced to anyone
 */
async function announceLinkedEntries(
  db: typeof dbType,
  links: FanOutLink[],
  feedTitle: string | null
): Promise<Set<string>> {
  const announced = new Set<string>();
  if (links.length === 0) return announced;

  const linkRow = { userId: userEntries.userId, entryId: userEntries.entryId };
  const memberships = entryMemberships(linkRow);
  // Exact pairs, as two array parameters: a backfill re-announcement links
  // every existing subscriber, all read.
  const userIdsArray = `{${links.map((l) => l.userId).join(",")}}`;
  const entryIdsArray = `{${links.map((l) => l.entryId).join(",")}}`;
  const rows = await db
    .select({
      userId: userEntries.userId,
      entryId: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
      readChangedAt: userEntries.readChangedAt,
      changedAt: userEntries.changedAt,
      subscriptionIds: memberships.subscriptionIds,
      type: entries.type,
      url: entries.url,
      title: entries.title,
      author: entries.author,
      summary: entries.summary,
      publishedAt: entries.publishedAt,
      fetchedAt: entries.fetchedAt,
      siteName: entries.siteName,
      isSpam: entries.isSpam,
      entryUpdatedAt: entries.updatedAt,
    })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .leftJoinLateral(memberships, sql`true`)
    .where(
      and(
        sql`(${userEntries.userId}, ${userEntries.entryId}) IN (
          SELECT * FROM unnest(${userIdsArray}::uuid[], ${entryIdsArray}::uuid[]))`,
        // Linked read without the user touching it: a backfill.
        sql`NOT (${userEntries.read} AND ${userEntries.readChangedAt} IS NULL)`
      )
    );
  const rowsByLink = new Map(rows.map((r) => [`${r.userId}:${r.entryId}`, r]));

  for (const link of links) {
    const row = rowsByLink.get(`${link.userId}:${link.entryId}`);
    if (!row) continue;
    const announcement = newEntryAnnouncement({ ...row, isBackfill: false }, feedTitle, row);
    if (!announcement) continue;
    announced.add(link.entryId);
    publishUserEvent({
      type: "new_entry",
      userId: link.userId,
      subscriptionId: link.subscriptionId,
      subscriptionIds: row.subscriptionIds,
      feedType: "web",
      entryId: link.entryId,
      // What sync stamps it with; truncated to milliseconds, so a cursor
      // past it can only re-report, never skip.
      updatedAt: new Date(row.changedAt.epochMilliseconds),
      ...announcement,
    });
  }
  return announced;
}

/**
 * Processes all entries from a parsed feed.
 * Creates new entries, updates existing ones with changed content,
 * and tracks statistics. Also creates user_entries records
 * to make entries visible to all active subscribers.
 *
 * Detects entries that disappeared from the feed (current before this poll,
 * `currentEntryIdsSql`, but not in it), and entries this poll stamps that the
 * previous poll didn't (pushed since, or back after disappearing); either
 * changes the current set.
 *
 * Entries that are really an archive re-announcement rather than news are
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
 * const result = await processEntries(db, feedId, parsedFeed);
 * console.log(`New: ${result.newCount}, Updated: ${result.updatedCount}`);
 */
export async function processEntries(
  db: typeof dbType,
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
    pushed = false,
  } = options;

  // Derive GUIDs from all items first, so we only query for entries we need.
  // Matching is http/https-insensitive (#1535), so look up every spelling a
  // stored row might carry — exact values, so the (owner_feed_id, guid) unique index
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
          .select(existingEntryColumns)
          .from(entries)
          .where(and(eq(entries.ownerFeedId, feedId), inArray(entries.guid, [...guidsToCheck])))
      : [];

  // At most one row per key: uq_entries_owner_feed_guid_canonical enforces it.
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
        db,
        feedId,
        item,
        fetchedAt,
        existingEntriesMap,
        feedUrl,
        previousLastFetchedAt,
        pushed
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

  // Detect entries that disappeared from the feed: entries that were current
  // before this poll but whose guid is no longer in the current feed (compared
  // scheme-insensitively, so a feed that flips http/https between polls doesn't
  // report its whole contents gone).
  let disappearedCount = 0;

  if (!pushed && (previousLastEntriesUpdatedAt || previousLastFetchedAt)) {
    const previouslyCurrentEntries = await db
      .select({ guid: entries.guid })
      .from(entries)
      .where(
        sql`${entries.id} IN (${currentEntryIdsSql(feedId, {
          lastEntriesUpdatedAt: previousLastEntriesUpdatedAt ?? null,
          lastFetchedAt: previousLastFetchedAt ?? null,
        })})`
      );

    for (const entry of previouslyCurrentEntries) {
      if (!currentGuidKeys.has(canonicalGuid(entry.guid))) {
        disappearedCount++;
      }
    }
  }

  // An entry this poll stamps that the previous poll didn't: a pushed entry
  // (last_seen_at NULL) or one back after disappearing. Stamping it changes the
  // current set even though its content didn't change, and a pushed one stops
  // being current once this poll advances last_fetched_at unless it's stamped.
  const lastSeenBefore = new Map(existingEntries.map((e) => [e.id, e.lastSeenAt]));
  const stampedByPreviousPoll = (lastSeenAt: Date | null | undefined): boolean =>
    lastSeenAt != null &&
    previousLastEntriesUpdatedAt != null &&
    lastSeenAt.getTime() >= previousLastEntriesUpdatedAt.getTime();
  const stampsNewlyCurrent =
    !pushed && results.some((r) => !r.isNew && !stampedByPreviousPoll(lastSeenBefore.get(r.id)));

  const allEntryIds = results.map((r) => r.id);
  const hasChanges = newCount > 0 || updatedCount > 0 || disappearedCount > 0 || stampsNewlyCurrent;

  // The visibility bookkeeping (re-stamp last_seen_at + fan out user_entries)
  // normally runs only when the feed changed, so steady-state feeds pay nothing.
  // The subscribe-time forced refresh sets alwaysUpdateVisibility to run it on an
  // unchanged fetch too (see the option's doc comment).
  const shouldUpdateVisibility = hasChanges || alwaysUpdateVisibility;

  // Update lastSeenAt for all entries in this fetch
  // The timestamp used here should match feeds.lastEntriesUpdatedAt
  if (pushed) {
    await updateEntriesPushedAt(
      db,
      results.filter((r) => !r.isNew).map((r) => r.id),
      fetchedAt
    );
  } else if (shouldUpdateVisibility) {
    await updateEntriesLastSeenAt(db, allEntryIds, fetchedAt);
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
  const links = shouldUpdateVisibility
    ? await createUserEntriesForFeed(db, feedId, allEntryIds, previousLastFetchedAt ?? null)
    : [];

  const feedAnnouncedIds = results.filter((r) => r.isNew && !r.isBackfill).map((r) => r.id);
  if (feedAnnouncedIds.length > 0) {
    // Publish new_entry events AFTER the user_entries fanout: the SSE endpoint
    // computes each connected subscriber's absolute unread counts from
    // visible_entries when the event arrives, so the rows must exist first or
    // the counts would exclude these entries (leaving badges stale until the
    // next count-bearing event). Fire and forget — publishing failures must
    // not affect entry processing.
    for (const result of results) {
      const announcement =
        result.isNew && result.newEntryData
          ? newEntryAnnouncement(
              { ...result.newEntryData, isBackfill: result.isBackfill },
              feedTitle ?? null
            )
          : null;
      if (announcement && result.updatedAt) {
        publishFeedEvent({
          type: "new_entry",
          feedId,
          entryId: result.id,
          updatedAt: result.updatedAt,
          feedType: "web",
          ...(announcement.entry ? { entry: { ...announcement.entry, type: "web" } } : {}),
        });
      }
    }
  }

  const feedAnnounced = new Set(feedAnnouncedIds);
  let linkAnnounced = new Set<string>();
  try {
    linkAnnounced = await announceLinkedEntries(
      db,
      links.filter((link) => !feedAnnounced.has(link.entryId)),
      feedTitle ?? null
    );
  } catch (error) {
    // The links are made; their subscribers see them on the next refetch.
    logger.error("Failed to announce linked entries", {
      feedId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    newCount,
    updatedCount,
    unchangedCount,
    backfillCount,
    disappearedCount,
    announcedEntryIds: [...feedAnnouncedIds, ...linkAnnounced],
    hasChanges,
    entries: results,
  };
}
