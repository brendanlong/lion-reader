/**
 * Ebook imports (#1805): a book becomes a collection, and each of its chapters
 * an uploaded article in it, positioned in reading order.
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { db as dbType } from "@/server/db";
import { COLLECTION_NAME_MAX_LENGTH } from "@/lib/collections";
import { logger } from "@/lib/logger";
import { errors } from "@/server/errors";
import { openEpub, type Epub, type EpubChapter } from "@/server/file/epub";
import { titleFromFilename } from "@/server/file/process-upload";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import {
  addEntriesToCollection,
  createCollection,
  maxCollectionPosition,
} from "@/server/services/collections";
import { assertUploadSize, insertUploadedArticle } from "@/server/services/saved";
import { buildArticleFields } from "@/server/services/saved-content";
import type { Subscription } from "@/server/services/subscriptions";

export interface ImportEbookParams {
  /** The file's bytes, base64-encoded. */
  content: string;
  /** The original filename: the collection's name when the book has no title. */
  filename: string;
}

export interface ImportEbookResult {
  /** The book's collection, as it was before its chapters were added. */
  subscription: Subscription;
  /** False when the user already had an active collection with the book's name. */
  created: boolean;
  /** The chapters' articles, in reading order. */
  entryIds: string[];
  counts: BulkUnreadCounts;
}

async function openEbook(file: Buffer): Promise<Epub> {
  try {
    return await openEpub(file);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    throw errors.validation(`Failed to process ebook: ${message}`);
  }
}

/**
 * Imports an `.epub` into a collection named for the book (an existing active
 * collection with that name is reused, as `createCollection` does), with each
 * chapter as an article whose position is its place in the book.
 *
 * Each chapter joins the collection as it's saved, after anything already in
 * it, so a book that fails partway (a chapter too large, say) leaves the
 * chapters before it in order. Each chapter's guid is derived from the file's
 * hash and the chapter's index, so importing the same file again saves only
 * the chapters still missing, and those already in the collection keep their
 * places.
 */
export async function importEbook(
  db: typeof dbType,
  userId: string,
  params: ImportEbookParams
): Promise<ImportEbookResult> {
  const file = Buffer.from(params.content, "base64");
  assertUploadSize("Uploaded ebook", file.length);
  const book = await openEbook(file);
  const name = (book.title || titleFromFilename(params.filename) || "Untitled Ebook").slice(
    0,
    COLLECTION_NAME_MAX_LENGTH
  );
  const fileHash = createHash("sha256").update(file).digest("hex");

  // The collection waits for a first chapter, so a book with none doesn't
  // leave an empty one behind; the chapters wait for the collection, so one
  // the user can't create (the subscription cap) doesn't leave them in Saved.
  const chapters = book.chapters();
  const first = await chapters.next();
  if (first.done) {
    throw errors.validation("Failed to process ebook: it has no readable chapters");
  }
  const { subscription, created } = await createCollection(db, userId, name);
  const basePosition = await maxCollectionPosition(db, userId, subscription.id);

  const entryIds: string[] = [];
  let counts: BulkUnreadCounts | undefined;
  for (let next: IteratorResult<EpubChapter> = first; !next.done; next = await chapters.next()) {
    const chapter = next.value;
    const index = entryIds.length + 1;
    const fields = await buildArticleFields(
      {
        html: chapter.html,
        contentUrl: null,
        pluginContent: null,
        // Already clean content, so Readability is skipped.
        preCleanedContent: { title: chapter.title, summary: null, author: book.author },
      },
      { providedTitle: chapter.title ?? `${name} (${index})`, siteName: name }
    );
    const { article } = await insertUploadedArticle(
      db,
      userId,
      fields,
      `uploaded:epub:${fileHash}:${index}`
    );
    const added = await addEntriesToCollection(
      db,
      userId,
      subscription.id,
      [article.id],
      new Map([[article.id, basePosition + index]])
    );
    counts = added.counts ?? counts;
    entryIds.push(article.id);
  }

  logger.info("Imported ebook", {
    subscriptionId: subscription.id,
    chapters: entryIds.length,
  });

  return {
    subscription,
    created,
    entryIds,
    counts:
      counts ??
      (await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subscription.id }])),
  };
}
