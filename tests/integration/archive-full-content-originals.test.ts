/**
 * Integration tests for scripts/archive-full-content-originals.ts (#2115).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { storageConfig } from "../../src/server/config/env";
import {
  clearArchivedOriginals,
  uploadFullContentOriginals,
} from "../../scripts/archive-full-content-originals";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestEntry, createTestFeed } from "./helpers";

const BUCKET = "test-archive";
const fetchedAt = new Date("2026-01-01T00:00:00Z");

let s3: FakeS3;
let dir: string;
let manifest: string;

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

/** The pages archived for an entry. */
function archived(entryId: string): string[] {
  const prefix = `${BUCKET}/full-content/${entryId}/`;
  return [...s3.objects]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, object]) => gunzipSync(object).toString("utf8"));
}

async function cleanup(): Promise<void> {
  await db.delete(entries);
  await db.delete(feeds);
}

beforeEach(async () => {
  await cleanup();
  s3 = await useFakeS3(BUCKET);
  dir = await mkdtemp(join(tmpdir(), "archive-manifest-"));
  manifest = join(dir, "manifest.jsonl");
});

afterEach(async () => {
  await s3.close();
  await rm(dir, { recursive: true, force: true });
});

async function manifestLines(): Promise<number> {
  const text = await readFile(manifest, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
}

afterAll(cleanup);

describe("archive-full-content-originals", () => {
  it("archives every page, then clears the column without changing what's shown", async () => {
    const feedId = await createTestFeed();
    const extracted = await createFetchedEntry(feedId, "<html>page</html>");
    // A plugin's article, stored only as the original before 4d18f516.
    const pluginArticle = await createFetchedEntry(feedId, "<article>plugin</article>", {
      fullContentCleaned: null,
    });
    const noPage = await createFetchedEntry(feedId, null);

    // Smaller than the row count, so the walk crosses batches.
    expect(await uploadFullContentOriginals(db, manifest, { batchSize: 1 })).toEqual({
      archived: 2,
      failedUploads: 0,
    });
    // Rerun, it resumes after what the manifest holds.
    expect(await uploadFullContentOriginals(db, manifest)).toEqual({
      archived: 0,
      failedUploads: 0,
    });
    expect(await manifestLines()).toBe(2);
    expect(archived(extracted)).toEqual(["<html>page</html>"]);
    expect(archived(pluginArticle)).toEqual(["<article>plugin</article>"]);
    expect(archived(noPage)).toEqual([]);
    expect((await readRow(extracted)).original).toBe("<html>page</html>");

    expect(await clearArchivedOriginals(db, manifest, { batchSize: 1, pauseMs: 0 })).toEqual({
      cleared: 2,
    });
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

  it("doesn't clear a page written after the upload read the row", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>old</html>");
    await uploadFullContentOriginals(db, manifest);
    // A machine still on the previous release refetches it.
    await db
      .update(entries)
      .set({ fullContentOriginal: "<html>new</html>", fullContentFetchedAt: new Date() })
      .where(eq(entries.id, entryId));

    expect(await clearArchivedOriginals(db, manifest, { pauseMs: 0 })).toEqual({ cleared: 0 });

    expect((await readRow(entryId)).original).toBe("<html>new</html>");
  });

  it("leaves a page whose upload failed for a later run", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    s3.failPutsWith = 503;

    expect(await uploadFullContentOriginals(db, manifest)).toEqual({
      archived: 0,
      failedUploads: 1,
    });
    await clearArchivedOriginals(db, manifest, { pauseMs: 0 });

    expect((await readRow(entryId)).original).toBe("<html>page</html>");
  });

  it("refuses to upload without the archive bucket", async () => {
    await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    storageConfig.archiveBucket = undefined;

    await expect(uploadFullContentOriginals(db, manifest)).rejects.toThrow();
    expect(await manifestLines()).toBe(0);
  });
});
