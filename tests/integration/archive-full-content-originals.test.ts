/**
 * Integration tests for scripts/archive-full-content-originals.ts (#2115).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { storageConfig } from "../../src/server/config/env";
import { fullContentArchiveKey } from "../../src/server/services/full-content-archive";
import { archiveFullContentOriginals } from "../../scripts/archive-full-content-originals";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestEntry, createTestFeed } from "./helpers";

const BUCKET = "test-archive";
const fetchedAt = new Date("2026-01-01T00:00:00Z");

let s3: FakeS3;

async function readRow(entryId: string) {
  const [row] = await db
    .select({
      original: entries.fullContentOriginal,
      cleaned: entries.fullContentCleaned,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row;
}

/** An entry as fetches stored it before #2115, with the page on the row. */
async function createFetchedEntry(
  feedId: string,
  page: string | null,
  fields: { fullContentCleaned?: string | null } = {}
): Promise<string> {
  return createTestEntry(feedId, {
    fetchedAt,
    fullContentFetchedAt: fetchedAt,
    fullContentHash: "hash",
    fullContentCleaned: "<p>Article</p>",
    fullContentOriginal: page,
    ...fields,
  });
}

function archived(entryId: string): string | undefined {
  const object = s3.objects.get(`${BUCKET}/${fullContentArchiveKey(entryId)}`);
  return object && gunzipSync(object).toString("utf8");
}

async function cleanup(): Promise<void> {
  await db.delete(entries);
  await db.delete(feeds);
}

beforeEach(async () => {
  await cleanup();
  s3 = await useFakeS3(BUCKET);
});

afterEach(async () => {
  await s3.close();
});

afterAll(cleanup);

describe("archiveFullContentOriginals", () => {
  it("archives every page and clears the column without changing what's shown", async () => {
    const feedId = await createTestFeed();
    const extracted = await createFetchedEntry(feedId, "<html>page</html>");
    // A plugin's article, stored only as the original before 4d18f516.
    const pluginArticle = await createFetchedEntry(feedId, "<article>plugin</article>", {
      fullContentCleaned: null,
    });
    const noPage = await createFetchedEntry(feedId, null);

    // Smaller than the row count, so the walk crosses batches.
    const result = await archiveFullContentOriginals(db, { batchSize: 1, pauseMs: 0 });

    expect(result).toEqual({ archived: 2, failedUploads: 0 });
    expect(archived(extracted)).toBe("<html>page</html>");
    expect(archived(pluginArticle)).toBe("<article>plugin</article>");
    expect(archived(noPage)).toBeUndefined();
    expect(await readRow(extracted)).toEqual({
      original: null,
      cleaned: "<p>Article</p>",
      updatedAt: fetchedAt,
    });
    expect(await readRow(pluginArticle)).toEqual({
      original: null,
      cleaned: "<article>plugin</article>",
      updatedAt: fetchedAt,
    });
  });

  it("keeps a page on the row when its upload fails", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    s3.failPutsWith = 503;

    const result = await archiveFullContentOriginals(db, { pauseMs: 0 });

    expect(result).toEqual({ archived: 0, failedUploads: 1 });
    expect((await readRow(entryId)).original).toBe("<html>page</html>");
  });

  it("refuses to run without the archive bucket", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    storageConfig.archiveBucket = undefined;

    await expect(archiveFullContentOriginals(db, { pauseMs: 0 })).rejects.toThrow();

    expect((await readRow(entryId)).original).toBe("<html>page</html>");
  });
});
