/**
 * Entry processing module.
 * Handles storing entries from parsed feeds, detecting new vs updated entries,
 * and content hash generation for change detection.
 *
 * Publishes Redis events for new and updated entries to enable real-time updates.
 */

import { createHash } from "crypto";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { db } from "../db";
import {
  entries,
  subscriptions,
  userEntries,
  type Entry,
  type NewEntry,
} from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishNewEntry, publishEntryUpdated } from "../redis/pubsub";
import type { ParsedEntry, ParsedFeed } from "./types";
import {
  cleanContent,
  generateCleanedSummary,
  absolutizeUrls,
  type CleanedContent,
} from "./content-cleaner";
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
  /** Details of each processed entry */
  entries: ProcessedEntry[];
}

/**
 * Options for processing entries.
 */
export interface ProcessEntriesOptions {
  /** Current timestamp to use for fetchedAt (defaults to now) */
  fetchedAt?: Date;
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
 * Truncates a string to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Strips HTML tags from a string for use in summaries.
 * Uses linkedom for lightweight HTML parsing and text extraction,
 * which handles edge cases like nested tags and malformed HTML.
 */
function stripHtml(html: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

  // Remove script and style elements before extracting text
  document.querySelectorAll("script, style").forEach((el) => el.remove());

  // Get text content - this naturally strips all HTML tags
  return (document.body.textContent ?? "").trim();
}

/**
 * Generates a summary from entry content.
 * Strips HTML and truncates to 300 characters.
 *
 * @param entry - The parsed entry
 * @returns Summary string
 */
export function generateSummary(entry: ParsedEntry): string {
  const content = entry.content ?? entry.summary ?? "";
  const stripped = stripHtml(content);
  return truncate(stripped, 300);
}

/**
 * Content cleaning result for an entry.
 */
interface EntryCleaningResult {
  /** The original content (unchanged) */
  contentOriginal: string | null;
  /** The cleaned content (Readability output) or null if cleaning failed */
  contentCleaned: string | null;
  /** The summary generated from cleaned content or original */
  summary: string;
}

/**
 * Cleans entry content using Readability and generates a summary.
 *
 * @param parsedEntry - The parsed entry from the feed
 * @param entryUrl - The URL of the entry (used as base URL for Readability)
 * @returns Cleaning result with original, cleaned content, and summary
 */
export function cleanEntryContent(
  parsedEntry: ParsedEntry,
  entryUrl?: string
): EntryCleaningResult {
  const originalContent = parsedEntry.content ?? parsedEntry.summary ?? null;

  // If no content, return early
  if (!originalContent) {
    return {
      contentOriginal: null,
      contentCleaned: null,
      summary: "",
    };
  }

  // Attempt to clean the content with Readability
  let cleaned: CleanedContent | null = null;

  try {
    cleaned = cleanContent(originalContent, { url: entryUrl });
  } catch (error) {
    // Log but don't fail - we'll use the original content
    logger.warn("Content cleaning failed", {
      url: entryUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Generate summary from cleaned content if available, otherwise from original
  let summary: string;
  if (cleaned) {
    summary = generateCleanedSummary(cleaned, 300);
  } else {
    // Fall back to simple HTML stripping for summary
    summary = truncate(stripHtml(originalContent), 300);
  }

  // Absolutize relative URLs in original content if we have a base URL
  // (cleaned content is already absolutized in cleanContent)
  const absolutizedOriginal = entryUrl
    ? absolutizeUrls(originalContent, entryUrl)
    : originalContent;

  return {
    contentOriginal: absolutizedOriginal,
    contentCleaned: cleaned?.content ?? null,
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
 * @param parsedEntry - The parsed entry from the feed
 * @param contentHash - Pre-computed content hash
 * @param fetchedAt - Timestamp when the entry was fetched
 * @returns The created entry
 */
export async function createEntry(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  contentHash: string,
  fetchedAt: Date
): Promise<Entry> {
  const guid = deriveGuid(parsedEntry);

  // Clean the content using Readability
  const cleaningResult = cleanEntryContent(parsedEntry, parsedEntry.link ?? undefined);

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
 * @returns The updated entry
 */
export async function updateEntryContent(
  entryId: string,
  parsedEntry: ParsedEntry,
  contentHash: string
): Promise<Entry> {
  // Clean the content using Readability
  const cleaningResult = cleanEntryContent(parsedEntry, parsedEntry.link ?? undefined);

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
 * @param parsedEntry - The parsed entry from the feed
 * @param fetchedAt - Timestamp when the entry was fetched
 * @returns Processing result for this entry
 */
export async function processEntry(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  fetchedAt: Date
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const contentHash = generateContentHash(parsedEntry);

  // Check if entry already exists
  const existing = await findEntryByGuid(feedId, guid);

  if (!existing) {
    // New entry - create it
    const entry = await createEntry(feedId, feedType, parsedEntry, contentHash, fetchedAt);

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
    const entry = await updateEntryContent(existing.id, parsedEntry, contentHash);

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
 * @returns Processing result for this entry
 */
async function processEntryWithCache(
  feedId: string,
  feedType: "rss" | "atom" | "json" | "email" | "saved",
  parsedEntry: ParsedEntry,
  fetchedAt: Date,
  existingEntriesMap: Map<string, CachedEntryInfo>
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const contentHash = generateContentHash(parsedEntry);

  // Use cached lookup instead of database query
  const existing = existingEntriesMap.get(guid);

  if (!existing) {
    // New entry - create it
    const entry = await createEntry(feedId, feedType, parsedEntry, contentHash, fetchedAt);

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
    const entry = await updateEntryContent(existing.id, parsedEntry, contentHash);

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
  const { fetchedAt = new Date() } = options;

  // Derive GUIDs from all items first, so we only query for entries we need
  const guidsToCheck: string[] = [];
  for (const item of feed.items) {
    try {
      guidsToCheck.push(deriveGuid(item));
    } catch {
      // Invalid entry without GUID - will be skipped during processing
    }
  }

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
        existingEntriesMap
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

  const allEntryIds = results.map((r) => r.id);

  // Update lastSeenAt for all entries in this fetch (rss/atom/json only)
  // This enables subscribing to existing feeds without re-fetching
  const isFetchedType = feedType === "rss" || feedType === "atom" || feedType === "json";
  if (isFetchedType) {
    await updateEntriesLastSeenAt(allEntryIds, fetchedAt);
  }

  // Create user_entries for all processed entries
  // This makes entries visible to all currently-subscribed users
  await createUserEntriesForFeed(feedId, allEntryIds);

  return {
    newCount,
    updatedCount,
    unchangedCount,
    entries: results,
  };
}
