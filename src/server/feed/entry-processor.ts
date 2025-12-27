/**
 * Entry processing module.
 * Handles storing entries from parsed feeds, detecting new vs updated entries,
 * and content hash generation for change detection.
 *
 * Publishes Redis events for new and updated entries to enable real-time updates.
 */

import { createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { entries, type Entry, type NewEntry } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishNewEntry, publishEntryUpdated } from "../redis/pubsub";
import type { ParsedEntry, ParsedFeed } from "./types";
import { cleanContent, generateCleanedSummary, type CleanedContent } from "./content-cleaner";
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
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
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

  return {
    contentOriginal: originalContent,
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
  parsedEntry: ParsedEntry,
  contentHash: string,
  fetchedAt: Date
): Promise<Entry> {
  const guid = deriveGuid(parsedEntry);

  // Clean the content using Readability
  const cleaningResult = cleanEntryContent(parsedEntry, parsedEntry.link ?? undefined);

  const newEntry: NewEntry = {
    id: generateUuidv7(),
    feedId,
    guid,
    url: parsedEntry.link ?? null,
    title: parsedEntry.title ?? null,
    author: parsedEntry.author ?? null,
    contentOriginal: cleaningResult.contentOriginal,
    contentCleaned: cleaningResult.contentCleaned,
    summary: cleaningResult.summary,
    publishedAt: parsedEntry.pubDate ?? null,
    fetchedAt,
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
  parsedEntry: ParsedEntry,
  fetchedAt: Date
): Promise<ProcessedEntry> {
  const guid = deriveGuid(parsedEntry);
  const contentHash = generateContentHash(parsedEntry);

  // Check if entry already exists
  const existing = await findEntryByGuid(feedId, guid);

  if (!existing) {
    // New entry - create it
    const entry = await createEntry(feedId, parsedEntry, contentHash, fetchedAt);

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
 * Processes all entries from a parsed feed.
 * Creates new entries, updates existing ones with changed content,
 * and tracks statistics.
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
  const { fetchedAt = new Date() } = options;

  const results: ProcessedEntry[] = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const item of feed.items) {
    try {
      const result = await processEntry(feedId, item, fetchedAt);
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

  return {
    newCount,
    updatedCount,
    unchangedCount,
    entries: results,
  };
}
