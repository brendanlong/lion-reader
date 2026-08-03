/**
 * Imports Service
 *
 * Both halves of the OPML-import flow:
 *
 * - {@link importOpml} (request path): parse OPML, deduplicate feeds, create the
 *   `opml_imports` tracking record, and queue the background job. Used by the
 *   tRPC `subscriptions.import` mutation and the Google Reader
 *   `subscription/import` compat endpoint (issue #1059).
 * - {@link processOpmlImport} (worker): subscribe to each recorded feed,
 *   publishing progress as it goes. Driven by the `process_opml_import` job
 *   handler.
 */

import { eq, and, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  opmlImports,
  subscriptions,
  subscriptionTags,
  tags,
  type OpmlImportFeedData,
  type OpmlImportFeedResult,
} from "@/server/db/schema";
import { parseOpmlAsync } from "@/server/feed/opml";
import { createJob } from "@/server/jobs/queue";
import {
  publishImportProgress,
  publishImportCompleted,
  publishSubscriptionUpdated,
} from "@/server/redis/pubsub";
import { createSubscription } from "@/server/services/subscriptions";
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
 * Throws `OpmlParseError` (from {@link parseOpmlAsync}) if the content is not valid
 * OPML; callers translate that into their own error format.
 */
export async function importOpml(
  db: typeof dbType,
  userId: string,
  opml: string
): Promise<ImportOpmlResult> {
  // Step 1: Parse the OPML content (throws OpmlParseError on malformed input).
  // Async: this runs on the app-server request path (tRPC / Google Reader
  // import), so the XML parse happens on the libuv thread pool.
  const opmlFeeds = await parseOpmlAsync(opml);

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

/**
 * How many feeds we process between writes of the running progress counters.
 * Writing after every feed freezes large imports on database load; Redis
 * progress events still fire per feed, so the UI stays real-time regardless.
 */
const OPML_IMPORT_DB_BATCH_SIZE = 10;

/** Tag identity needed to publish a `subscription_updated` event. */
interface ImportTagInfo {
  id: string;
  name: string;
  color: string | null;
}

/** Running totals of an in-progress or finished import. */
export interface OpmlImportCounts {
  imported: number;
  skipped: number;
  failed: number;
  total: number;
}

/**
 * Outcome of {@link processOpmlImport}. The job handler maps these to a job
 * result; the import's own state is already persisted either way.
 */
export type ProcessOpmlImportResult =
  | { status: "not_found" }
  /** A previous run already finished this import (completed or failed). */
  | { status: "already_finished" }
  | {
      status: "completed";
      counts: OpmlImportCounts;
      /**
       * True when a previous run had processed every feed but died before it
       * could record completion — this run only wrote the final status.
       */
      recovered: boolean;
    }
  | { status: "failed"; error: string };

/**
 * Resolves every category name used by the import to a tag row, creating the
 * missing ones in a single batch insert (rather than a query per feed).
 */
async function ensureImportTags(
  db: typeof dbType,
  userId: string,
  feedsData: OpmlImportFeedData[]
): Promise<Map<string, ImportTagInfo>> {
  const tagNames = new Set<string>();
  for (const feed of feedsData) {
    for (const categoryName of feed.category ?? []) {
      tagNames.add(categoryName);
    }
  }

  const tagNameToInfo = new Map<string, ImportTagInfo>();
  if (tagNames.size === 0) {
    return tagNameToInfo;
  }

  const existingTags = await db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.userId, userId));

  for (const existingTag of existingTags) {
    if (tagNames.has(existingTag.name)) {
      tagNameToInfo.set(existingTag.name, {
        id: existingTag.id,
        name: existingTag.name,
        color: existingTag.color,
      });
    }
  }

  const now = new Date();
  const tagsToCreate = Array.from(tagNames)
    .filter((tagName) => !tagNameToInfo.has(tagName))
    .map((tagName) => ({
      id: generateUuidv7(),
      userId,
      name: tagName,
      createdAt: now,
    }));

  if (tagsToCreate.length > 0) {
    await db.insert(tags).values(tagsToCreate);
    for (const tag of tagsToCreate) {
      tagNameToInfo.set(tag.name, { id: tag.id, name: tag.name, color: null });
    }
    logger.debug("OPML import: created tags", {
      count: tagsToCreate.length,
      tagNames: tagsToCreate.map((t) => t.name),
      userId,
    });
  }

  return tagNameToInfo;
}

/**
 * Attaches an imported subscription to the tags named by its OPML categories
 * and tells open clients about it.
 */
async function applyImportTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  categories: string[],
  tagNameToInfo: Map<string, ImportTagInfo>
): Promise<void> {
  const tagInfos = categories
    .map((categoryName) => tagNameToInfo.get(categoryName))
    .filter((info): info is ImportTagInfo => info !== undefined);

  if (tagInfos.length === 0) {
    return;
  }

  // Clear first: the subscription may be a reactivation carrying old tags.
  await db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, subscriptionId));

  const now = new Date();
  await db.insert(subscriptionTags).values(
    tagInfos.map((tagInfo) => ({
      subscriptionId,
      tagId: tagInfo.id,
      createdAt: now,
    }))
  );

  // Fire-and-forget: a failed event must not fail the feed's import.
  publishSubscriptionUpdated(
    userId,
    subscriptionId,
    now,
    tagInfos,
    null // no custom title
  ).catch((err) => {
    logger.error("Failed to publish subscription_updated event", { err, userId, subscriptionId });
  });

  logger.debug("OPML import: associated subscription with tags", {
    subscriptionId,
    tagIds: tagInfos.map((t) => t.id),
  });
}

/**
 * Subscribes the importing user to every feed recorded on an `opml_imports`
 * row, publishing an `import_progress` event per feed and `import_completed` at
 * the end.
 *
 * Safe to call more than once for the same import: a finished import is a no-op,
 * and an import whose feeds were all processed by a run that died before writing
 * the final status is recovered from the stored per-feed results.
 */
export async function processOpmlImport(
  db: typeof dbType,
  importId: string
): Promise<ProcessOpmlImportResult> {
  logger.info("Starting OPML import processing", { importId });

  const [importRecord] = await db
    .select()
    .from(opmlImports)
    .where(eq(opmlImports.id, importId))
    .limit(1);

  if (!importRecord) {
    logger.warn("Import record not found", { importId });
    return { status: "not_found" };
  }

  if (importRecord.status === "completed" || importRecord.status === "failed") {
    logger.info("Import already finished, skipping", { importId, status: importRecord.status });
    return { status: "already_finished" };
  }

  const userId = importRecord.userId;
  const total = importRecord.totalFeeds;

  // A previous run may have processed every feed and then crashed before
  // updating the status. Detect that from either the stored per-feed results
  // (most accurate) or the counters (for a run whose results array lagged).
  const processedByResults = importRecord.results.length === total;
  const processedByCounts =
    importRecord.importedCount + importRecord.skippedCount + importRecord.failedCount === total;

  if (importRecord.status === "processing" && (processedByResults || processedByCounts)) {
    const counts: OpmlImportCounts = {
      imported: processedByResults
        ? importRecord.results.filter((r) => r.status === "imported").length
        : importRecord.importedCount,
      skipped: processedByResults
        ? importRecord.results.filter((r) => r.status === "skipped").length
        : importRecord.skippedCount,
      failed: processedByResults
        ? importRecord.results.filter((r) => r.status === "failed").length
        : importRecord.failedCount,
      total,
    };

    logger.info("Recovering previously completed import", { importId, ...counts });

    await finishImport(db, importId, userId, counts);

    return { status: "completed", counts, recovered: true };
  }

  await db
    .update(opmlImports)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(opmlImports.id, importId));

  try {
    const existingSubscriptions = await db
      .select({ feedUrl: feeds.url })
      .from(subscriptions)
      .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
      .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

    const existingUrls = new Set(existingSubscriptions.map((s) => s.feedUrl));

    const tagNameToInfo = await ensureImportTags(db, userId, importRecord.feedsData);

    const results: OpmlImportFeedResult[] = [];
    const counts: OpmlImportCounts = { imported: 0, skipped: 0, failed: 0, total };
    let feedsProcessedSinceLastDbUpdate = 0;

    // Batched write of the running progress counters (see
    // OPML_IMPORT_DB_BATCH_SIZE); the per-feed Redis event is published separately.
    const flushProgressToDb = async () => {
      feedsProcessedSinceLastDbUpdate++;
      if (feedsProcessedSinceLastDbUpdate >= OPML_IMPORT_DB_BATCH_SIZE) {
        await db
          .update(opmlImports)
          .set({
            importedCount: counts.imported,
            skippedCount: counts.skipped,
            failedCount: counts.failed,
            results,
            updatedAt: new Date(),
          })
          .where(eq(opmlImports.id, importId));
        feedsProcessedSinceLastDbUpdate = 0;
      }
    };

    for (const opmlFeed of importRecord.feedsData) {
      const feedUrl = opmlFeed.xmlUrl;
      const feedTitle = opmlFeed.title ?? null;

      if (existingUrls.has(feedUrl)) {
        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "skipped",
          error: "Already subscribed",
        });
        counts.skipped++;

        await publishImportProgress(userId, importId, feedUrl, "skipped", counts);
        await flushProgressToDb();

        continue;
      }

      try {
        const subscriptionResult = await createSubscription(db, userId, {
          url: feedUrl,
          title: feedTitle,
          siteUrl: opmlFeed.htmlUrl ?? null,
        });

        const subscriptionId = subscriptionResult.subscriptionId;
        const feedId = subscriptionResult.feed.id;

        await applyImportTags(db, userId, subscriptionId, opmlFeed.category ?? [], tagNameToInfo);

        // Prevents a duplicate URL later in the same import from re-subscribing.
        existingUrls.add(feedUrl);

        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "imported",
          feedId,
          subscriptionId,
        });
        counts.imported++;

        await publishImportProgress(userId, importId, feedUrl, "imported", counts);
        await flushProgressToDb();

        logger.info("OPML import: feed imported", { feedUrl, userId, importId });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        results.push({
          url: feedUrl,
          title: feedTitle,
          status: "failed",
          error: errorMessage,
        });
        counts.failed++;

        await publishImportProgress(userId, importId, feedUrl, "failed", counts);
        await flushProgressToDb();

        logger.warn("OPML import: feed import failed", {
          feedUrl,
          userId,
          importId,
          error: errorMessage,
        });
      }
    }

    await finishImport(db, importId, userId, counts, results);

    logger.info("OPML import completed", { importId, userId, ...counts });

    return { status: "completed", counts, recovered: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await db
      .update(opmlImports)
      .set({
        status: "failed",
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(opmlImports.id, importId));

    logger.error("OPML import job failed", { importId, error: errorMessage });

    return { status: "failed", error: errorMessage };
  }
}

/**
 * Marks an import completed and tells the user's open clients.
 *
 * @param results - Per-feed results to store, omitted when recovering an import
 *   whose stored results are already final.
 */
async function finishImport(
  db: typeof dbType,
  importId: string,
  userId: string,
  counts: OpmlImportCounts,
  results?: OpmlImportFeedResult[]
): Promise<void> {
  const completedAt = new Date();
  await db
    .update(opmlImports)
    .set({
      status: "completed",
      importedCount: counts.imported,
      skippedCount: counts.skipped,
      failedCount: counts.failed,
      ...(results ? { results } : {}),
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(opmlImports.id, importId));

  await publishImportCompleted(userId, importId, counts);
}
