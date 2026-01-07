/**
 * Entry processing module.
 * Handles storing entries from parsed feeds, detecting new vs updated entries,
 * and content hash generation for change detection.
 *
 * Publishes Redis events for new and updated entries to enable real-time updates.
 */

import { createHash } from "crypto";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { db } from "../db";
import { entries, subscriptions, userEntries, type Entry, type NewEntry } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishNewEntry, publishEntryUpdated } from "../redis/pubsub";
import type { ParsedEntry, ParsedFeed } from "./types";
import { absolutizeUrls, isLessWrongFeed, cleanLessWrongContent } from "./content-cleaner";
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
}

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
  /** The URL of the feed (for feed-specific content cleaning) */
  feedUrl?: string;
}

/**
 * Generates a SHA-256 content hash for an entry.
 * The hash is based on title and content to detect changes.
 *
 * @param entry - The parsed entry from the feed
 * @returns Hexadecimal SHA-256 hash string
 */
export function generateContentHash(entry: ParsedEntry): string {
  // Combine title and content for hashing
  // Use empty strings for null/undefined values to ensure consistent hashing
  const title = entry.title ?? "";
  const content = entry.content ?? entry.summary ?? "";

  const hashInput = `${title}\n${content}`;

  return createHash("sha256").update(hashInput, "utf8").digest("hex");
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
 * Block-level HTML elements that should have spacing after them.
 * When extracting text from HTML, we add a space after these elements
 * to prevent text from running together (e.g., "Title" + "Content" -> "Title Content").
 */
const BLOCK_ELEMENTS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "article",
  "section",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "table",
  "tr",
  "th",
  "td",
  "hr",
  "br",
  "figure",
  "figcaption",
]);

/**
 * Extracts text from HTML with proper spacing between block elements.
 *
 * Uses htmlparser2 for streaming SAX-style parsing, which is fast and handles
 * malformed HTML well. Adds spaces after block-level elements to prevent
 * headings and paragraphs from running together.
 *
 * @param html - The HTML content to extract text from
 * @param maxLength - Maximum characters to extract
 * @returns Plain text with proper spacing, truncated at word boundary with ellipsis if needed
 */
export function extractTextFromHtml(html: string, maxLength: number): string {
  let result = "";
  let lastWasSpace = true; // Start true to avoid leading spaces
  let skipDepth = 0; // Track depth inside script/style tags

  const parser = new Parser(
    {
      onopentagname(name) {
        if (name === "script" || name === "style") {
          skipDepth++;
        }
        // br/hr are void elements - add space on open
        if ((name === "br" || name === "hr") && !lastWasSpace) {
          result += " ";
          lastWasSpace = true;
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        // Normalize whitespace and append character by character with deduplication
        const normalized = text.replace(/\s+/g, " ");
        for (const char of normalized) {
          if (char === " ") {
            if (!lastWasSpace && result.length > 0) {
              result += " ";
              lastWasSpace = true;
            }
          } else {
            result += char;
            lastWasSpace = false;
          }
        }
      },
      onclosetag(name) {
        if (name === "script" || name === "style") {
          skipDepth--;
        }
        if (BLOCK_ELEMENTS.has(name) && !lastWasSpace) {
          result += " ";
          lastWasSpace = true;
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  const trimmed = result.trim();

  // If within limit, return as-is
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Truncate at word boundary: find last space before maxLength, drop partial word
  const truncateAt = maxLength - 3; // Reserve space for "..."
  const lastSpace = trimmed.lastIndexOf(" ", truncateAt);

  if (lastSpace > 0) {
    return trimmed.slice(0, lastSpace) + "...";
  }

  // No space found - single long word, just hard truncate
  return trimmed.slice(0, truncateAt) + "...";
}

/**
 * Generates a summary from raw HTML content.
 *
 * Extracts text with proper spacing between block elements and truncates
 * to 300 characters at a word boundary.
 *
 * @param html - The HTML content to summarize
 * @returns Summary string
 */
function generateSummaryFromHtml(html: string): string {
  return extractTextFromHtml(html, 300);
}

/**
 * Generates a summary from entry content.
 *
 * Prefers the feed-provided summary (from <description> or <summary> elements)
 * when available, as that's what the publisher intended as the excerpt.
 * Falls back to generating from full content if no summary is provided.
 *
 * Strips HTML and truncates to 300 characters.
 *
 * @param entry - The parsed entry
 * @returns Summary string
 */
export function generateSummary(entry: ParsedEntry): string {
  // Prefer explicit summary from feed, fall back to content
  const source = entry.summary ?? entry.content ?? "";
  return generateSummaryFromHtml(source);
}

/**
 * Content processing result for an entry.
 */
interface EntryContentResult {
  /** The original content with absolutized URLs */
  contentOriginal: string | null;
  /** Cleaned content (feed-specific cleaning applied), null if no cleaning needed */
  contentCleaned: string | null;
  /** The summary generated from original content */
  summary: string;
}

/**
 * Options for cleaning entry content.
 */
interface CleanEntryContentOptions {
  /** The URL of the entry (used as base URL for absolutizing) */
  entryUrl?: string;
  /** The URL of the feed (used to detect feed-specific cleaners) */
  feedUrl?: string;
}

/**
 * Processes entry content: absolutizes URLs, applies feed-specific cleaning, and generates a summary.
 *
 * Note: We don't run Readability on feed entries because RSS/Atom/JSON feeds
 * already provide clean content. Readability is only used for saved articles
 * where we're extracting content from full web pages.
 *
 * Feed-specific cleaners:
 * - LessWrong/LesserWrong: Strips "Published on [date]<br/><br/>" prefix
 *
 * @param parsedEntry - The parsed entry from the feed
 * @param options - Cleaning options
 * @returns Content result with original content, cleaned content (if applicable), and summary
 */
export function cleanEntryContent(
  parsedEntry: ParsedEntry,
  options: CleanEntryContentOptions = {}
): EntryContentResult {
  const { entryUrl, feedUrl } = options;
  const originalContent = parsedEntry.content ?? parsedEntry.summary ?? null;

  // If no content, return early
  if (!originalContent) {
    return {
      contentOriginal: null,
      contentCleaned: null,
      summary: "",
    };
  }

  // Absolutize relative URLs in original content if we have a base URL
  const absolutizedOriginal = entryUrl
    ? absolutizeUrls(originalContent, entryUrl)
    : originalContent;

  // Apply feed-specific content cleaning
  let contentCleaned: string | null = null;

  if (isLessWrongFeed(feedUrl)) {
    const cleaned = cleanLessWrongContent(absolutizedOriginal);
    // Only set contentCleaned if cleaning actually changed something
    if (cleaned !== absolutizedOriginal) {
      contentCleaned = cleaned;
    }
  }

  // Generate summary from cleaned content (if available) or original
  // This ensures feed-specific prefixes like LessWrong's "Published on..." don't appear in summaries
  const contentForSummary = contentCleaned ?? absolutizedOriginal;
  const summary = generateSummaryFromHtml(contentForSummary);

  return {
    contentOriginal: absolutizedOriginal,
    contentCleaned,
    summary,
  };
}

/**
 * Finds an existing entry by feed ID and GUID.
 *
 * @param feedId - The feed's UUID
 * @param guid - The entry's GUID
 * @returns The existing entry or null
 */
export async function findEntryByGuid(feedId: string, guid: string): Promise<Entry | null> {
  const [entry] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.feedId, feedId), eq(entries.guid, guid)))
    .limit(1);

  return entry ?? null;
}

/**
 * Creates a new entry in the database.
 *
 * @param feedId - The feed's UUID
 * @param feedType - The feed type
 * @param parsedEntry - The parsed entry from the feed
 * @param contentHash - Pre-computed content hash
 * @param fetchedAt - Timestamp when the entry was fetched
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @returns The created entry
 */
export async function createEntry(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  contentHash: string,
  fetchedAt: Date,
  feedUrl?: string
): Promise<Entry> {
  const guid = deriveGuid(parsedEntry);

  // Clean the content
  const cleaningResult = cleanEntryContent(parsedEntry, {
    entryUrl: parsedEntry.link ?? undefined,
    feedUrl,
  });

  // Only rss/atom/json entries track lastSeenAt (for visibility on subscription)
  const isFetchedType = feedType === "rss" || feedType === "atom" || feedType === "json";

  const newEntry: NewEntry = {
    id: generateUuidv7(),
    feedId,
    type: feedType,
    guid,
    url: parsedEntry.link ?? null,
    title: parsedEntry.title ?? null,
    author: parsedEntry.author ?? null,
    contentOriginal: cleaningResult.contentOriginal,
    contentCleaned: cleaningResult.contentCleaned,
    summary: cleaningResult.summary,
    publishedAt: parsedEntry.pubDate ?? null,
    fetchedAt,
    lastSeenAt: isFetchedType ? fetchedAt : null,
    contentHash,
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
  // Clean the content
  const cleaningResult = cleanEntryContent(parsedEntry, {
    entryUrl: parsedEntry.link ?? undefined,
    feedUrl,
  });

  const [entry] = await db
    .update(entries)
    .set({
      title: parsedEntry.title ?? null,
      author: parsedEntry.author ?? null,
      contentOriginal: cleaningResult.contentOriginal,
      contentCleaned: cleaningResult.contentCleaned,
      summary: cleaningResult.summary,
      contentHash,
      updatedAt: new Date(),
    })
    .where(eq(entries.id, entryId))
    .returning();

  return entry;
}

/**
 * Processes a single entry from a feed.
 * Creates new entries or updates existing ones based on content hash.
 *
 * @param feedId - The feed's UUID
 * @param feedType - The feed type
 * @param parsedEntry - The parsed entry from the feed
 * @param fetchedAt - Timestamp when the entry was fetched
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @returns Processing result for this entry
 */
export async function processEntry(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  fetchedAt: Date,
  feedUrl?: string
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const contentHash = generateContentHash(parsedEntry);

  // Check if entry already exists
  const existing = await findEntryByGuid(feedId, guid);

  if (!existing) {
    // New entry - create it
    const entry = await createEntry(feedId, feedType, parsedEntry, contentHash, fetchedAt, feedUrl);

    // Publish new_entry event for real-time updates
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishNewEntry(feedId, entry.id).catch((err) => {
      console.error("Failed to publish new_entry event:", err);
    });

    return {
      id: entry.id,
      guid,
      isNew: true,
      isUpdated: false,
    };
  }

  // Entry exists - check if content changed
  if (existing.contentHash !== contentHash) {
    // Content changed - update it
    const entry = await updateEntryContent(existing.id, parsedEntry, contentHash, feedUrl);

    // Publish entry_updated event for real-time updates
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishEntryUpdated(feedId, entry.id).catch((err) => {
      console.error("Failed to publish entry_updated event:", err);
    });

    return {
      id: entry.id,
      guid,
      isNew: false,
      isUpdated: true,
    };
  }

  // Content unchanged
  return {
    id: existing.id,
    guid,
    isNew: false,
    isUpdated: false,
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
 * @param feedType - The feed type
 * @param parsedEntry - The parsed entry from the feed
 * @param fetchedAt - Timestamp when the entry was fetched
 * @param existingEntriesMap - Map of GUID to existing entry info
 * @param feedUrl - The URL of the feed (for feed-specific cleaning)
 * @returns Processing result for this entry
 */
async function processEntryWithCache(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  fetchedAt: Date,
  existingEntriesMap: Map<string, CachedEntryInfo>,
  feedUrl?: string
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const contentHash = generateContentHash(parsedEntry);

  // Use cached lookup instead of database query
  const existing = existingEntriesMap.get(guid);

  if (!existing) {
    // New entry - create it
    const entry = await createEntry(feedId, feedType, parsedEntry, contentHash, fetchedAt, feedUrl);

    // Add to cache so duplicate GUIDs in same feed don't create duplicates
    existingEntriesMap.set(guid, { id: entry.id, guid, contentHash });

    // Publish new_entry event for real-time updates
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishNewEntry(feedId, entry.id).catch((err) => {
      console.error("Failed to publish new_entry event:", err);
    });

    return {
      id: entry.id,
      guid,
      isNew: true,
      isUpdated: false,
    };
  }

  // Entry exists - check if content changed
  if (existing.contentHash !== contentHash) {
    // Content changed - update it
    const entry = await updateEntryContent(existing.id, parsedEntry, contentHash, feedUrl);

    // Update cache with new hash
    existingEntriesMap.set(guid, { ...existing, contentHash });

    // Publish entry_updated event for real-time updates
    // Fire and forget - we don't want publishing failures to affect entry processing
    publishEntryUpdated(feedId, entry.id).catch((err) => {
      console.error("Failed to publish entry_updated event:", err);
    });

    return {
      id: entry.id,
      guid,
      isNew: false,
      isUpdated: true,
    };
  }

  // Content unchanged
  return {
    id: existing.id,
    guid,
    isNew: false,
    isUpdated: false,
  };
}

/**
 * Updates lastSeenAt for entries seen in the current fetch.
 * This is used to track which entries are currently in the feed,
 * enabling subscription without re-fetching.
 *
 * Only applies to rss/atom/json feeds - email/saved entries don't use lastSeenAt.
 *
 * @param entryIds - Array of entry IDs seen in this fetch
 * @param lastSeenAt - Timestamp to set (should match feed.lastFetchedAt)
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
      .set({ lastSeenAt, updatedAt: new Date() })
      .where(inArray(entries.id, batch));
  }
}

/**
 * Creates user_entries records for a feed's active subscribers.
 * This makes entries visible to all currently-subscribed users.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for efficiency and idempotency.
 *
 * @param feedId - The feed's UUID
 * @param entryIds - Array of entry IDs to make visible
 */
export async function createUserEntriesForFeed(feedId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  // Get all active subscriptions for this feed with their user IDs
  const activeSubscriptions = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, feedId), isNull(subscriptions.unsubscribedAt)));

  if (activeSubscriptions.length === 0) {
    return;
  }

  // Build all (user_id, entry_id) pairs
  const pairs: { userId: string; entryId: string }[] = [];
  for (const sub of activeSubscriptions) {
    for (const entryId of entryIds) {
      pairs.push({ userId: sub.userId, entryId });
    }
  }

  // Bulk insert with ON CONFLICT DO NOTHING
  // Process in batches to avoid hitting query limits
  const BATCH_SIZE = 1000;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    await db.insert(userEntries).values(batch).onConflictDoNothing();
  }

  logger.debug("Created user entries for feed", {
    feedId,
    entryCount: entryIds.length,
    userCount: activeSubscriptions.length,
    totalPairs: pairs.length,
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
 * @param feedId - The feed's UUID
 * @param feedType - The feed type (rss, atom, json, email, saved)
 * @param feed - The parsed feed containing entries
 * @param options - Processing options
 * @returns Processing result with counts and entry details
 *
 * @example
 * const result = await processEntries(feedId, 'rss', parsedFeed);
 * console.log(`New: ${result.newCount}, Updated: ${result.updatedCount}`);
 */
export async function processEntries(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  feed: ParsedFeed,
  options: ProcessEntriesOptions = {}
): Promise<ProcessEntriesResult> {
  const { fetchedAt = new Date(), previousLastEntriesUpdatedAt, feedUrl } = options;

  // Derive GUIDs from all items first, so we only query for entries we need
  const guidsToCheck: string[] = [];
  for (const item of feed.items) {
    try {
      guidsToCheck.push(deriveGuid(item));
    } catch {
      // Invalid entry without GUID - will be skipped during processing
    }
  }
  const currentGuidsSet = new Set(guidsToCheck);

  // Batch load only the entries we're looking for (by GUID) to avoid N+1 queries
  // This is much more efficient than querying per-entry, and doesn't load
  // thousands of historical entries we don't need
  const existingEntries =
    guidsToCheck.length > 0
      ? await db
          .select({
            id: entries.id,
            guid: entries.guid,
            contentHash: entries.contentHash,
          })
          .from(entries)
          .where(and(eq(entries.feedId, feedId), inArray(entries.guid, guidsToCheck)))
      : [];

  const existingEntriesMap = new Map(existingEntries.map((e) => [e.guid, e]));

  const results: ProcessedEntry[] = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const item of feed.items) {
    try {
      const result = await processEntryWithCache(
        feedId,
        feedType,
        item,
        fetchedAt,
        existingEntriesMap,
        feedUrl
      );
      results.push(result);

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
      console.error("Failed to process entry:", error);
    }
  }

  // Detect entries that disappeared from the feed (rss/atom/json only)
  // These are entries where lastSeenAt = previousLastEntriesUpdatedAt but guid not in current feed
  let disappearedCount = 0;
  const isFetchedType = feedType === "rss" || feedType === "atom" || feedType === "json";

  if (isFetchedType && previousLastEntriesUpdatedAt) {
    // Find entries that were previously "current" (lastSeenAt = previousLastEntriesUpdatedAt)
    // but are no longer in the feed
    const previouslyCurrentEntries = await db
      .select({ guid: entries.guid })
      .from(entries)
      .where(and(eq(entries.feedId, feedId), eq(entries.lastSeenAt, previousLastEntriesUpdatedAt)));

    for (const entry of previouslyCurrentEntries) {
      if (!currentGuidsSet.has(entry.guid)) {
        disappearedCount++;
      }
    }
  }

  const allEntryIds = results.map((r) => r.id);
  const newEntryIds = results.filter((r) => r.isNew).map((r) => r.id);
  const hasChanges = newCount > 0 || updatedCount > 0 || disappearedCount > 0;

  // Update lastSeenAt for all entries in this fetch (rss/atom/json only)
  // This happens when there are changes (new, updated, or disappeared entries)
  // The timestamp used here should match feeds.lastEntriesUpdatedAt
  if (isFetchedType && hasChanges) {
    await updateEntriesLastSeenAt(allEntryIds, fetchedAt);
  }

  // Create user_entries only for new entries
  // Existing subscribers already have user_entries records for existing entries
  // New subscribers get user_entries created at subscription time
  if (newEntryIds.length > 0) {
    await createUserEntriesForFeed(feedId, newEntryIds);
  }

  return {
    newCount,
    updatedCount,
    unchangedCount,
    disappearedCount,
    hasChanges,
    entries: results,
  };
}
