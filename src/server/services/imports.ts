/**
 * Imports Service
 *
 * Shared OPML-import business logic: parse OPML, deduplicate feeds, create the
 * `opml_imports` tracking record, and queue the background job that actually
 * subscribes to each feed. Used by the tRPC `subscriptions.import` mutation and
 * the Google Reader `subscription/import` compat endpoint (issue #1059).
 */

import type { db as dbType } from "@/server/db";
import { opmlImports, type OpmlImportFeedData } from "@/server/db/schema";
import { parseOpml } from "@/server/feed/opml";
import { createJob } from "@/server/jobs/queue";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";

/** Maximum OPML payload we accept (5 MB), shared by all callers. */
export const MAX_OPML_BYTES = 5 * 1024 * 1024;

/**
 * Result of queueing an OPML import.
 */
export interface ImportOpmlResult {
  importId: string;
  /** Number of unique feeds queued for import (after deduplication by URL). */
  totalFeeds: number;
}

/**
 * Parses OPML content, deduplicates feeds by URL (merging their tags), records
 * an `opml_imports` row, and queues a `process_opml_import` background job.
 *
 * Returns immediately — the feeds are subscribed asynchronously by the worker.
 * Throws `OpmlParseError` (from {@link parseOpml}) if the content is not valid
 * OPML; callers translate that into their own error format.
 */
export async function importOpml(
  db: typeof dbType,
  userId: string,
  opml: string
): Promise<ImportOpmlResult> {
  // Step 1: Parse the OPML content (throws OpmlParseError on malformed input).
  const opmlFeeds = parseOpml(opml);

  const importId = generateUuidv7();
  const now = new Date();

  if (opmlFeeds.length === 0) {
    // Record a completed import with no feeds — nothing to queue.
    await db.insert(opmlImports).values({
      id: importId,
      userId,
      status: "completed",
      totalFeeds: 0,
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      feedsData: [],
      results: [],
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return { importId, totalFeeds: 0 };
  }

  // Step 2: Deduplicate feeds by URL, merging categories. A feed listed under
  // five tags counts as one import, not five.
  const feedsByUrl = new Map<string, OpmlImportFeedData>();
  for (const feed of opmlFeeds) {
    const existing = feedsByUrl.get(feed.xmlUrl);
    if (existing) {
      // Merge categories (use first level of category path as tag).
      if (feed.category && feed.category.length > 0) {
        const tagName = feed.category[0];
        if (!existing.category) {
          existing.category = [tagName];
        } else if (!existing.category.includes(tagName)) {
          existing.category.push(tagName);
        }
      }
      // Keep the title from the first occurrence.
    } else {
      feedsByUrl.set(feed.xmlUrl, {
        xmlUrl: feed.xmlUrl,
        title: feed.title,
        htmlUrl: feed.htmlUrl,
        category: feed.category && feed.category.length > 0 ? [feed.category[0]] : undefined,
      });
    }
  }

  const feedsData = Array.from(feedsByUrl.values());

  // Step 3: Create the import tracking record.
  await db.insert(opmlImports).values({
    id: importId,
    userId,
    status: "pending",
    totalFeeds: feedsData.length, // deduplicated count
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    feedsData,
    results: [],
    createdAt: now,
    updatedAt: now,
  });

  // Step 4: Queue the background job that subscribes to each feed.
  await createJob({
    type: "process_opml_import",
    payload: { importId },
    nextRunAt: now, // run immediately
  });

  logger.info("OPML import queued", {
    importId,
    userId,
    totalFeeds: feedsData.length,
    originalCount: opmlFeeds.length, // log original for debugging
  });

  return { importId, totalFeeds: feedsData.length };
}
