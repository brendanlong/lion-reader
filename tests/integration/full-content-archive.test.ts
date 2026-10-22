/**
 * Integration tests for the full-content page archive (#2115): the fetched
 * page goes to the private archive bucket instead of the entry row, and the
 * daily sweep deletes pages whose entry is gone.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { persistFullContentResult } from "../../src/server/services/full-content";
import {
  archiveFullContentOriginal,
  deleteOrphanedFullContentArchives,
} from "../../src/server/services/full-content-archive";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestEntry, createTestFeed } from "./helpers";

const BUCKET = "test-archive";
const PAGE = "<html><body><nav>menu</nav><article><p>Article</p></article></body></html>";
const success = { success: true, contentOriginal: PAGE, contentCleaned: "<p>Article</p>" };

let s3: FakeS3;

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

/** The pages archived for an entry. */
function archived(entryId: string): string[] {
  const prefix = `${BUCKET}/full-content/${entryId}/`;
  return [...s3.objects]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, object]) => gunzipSync(object).toString("utf8"));
}

async function storedOriginal(entryId: string): Promise<string | null> {
  const [row] = await db
    .select({ original: entries.fullContentOriginal })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row.original;
}

describe("persistFullContentResult", () => {
  it("archives the fetched page instead of storing it on the entry", async () => {
    const entryId = await createTestEntry(await createTestFeed());

    await persistFullContentResult(db, entryId, success);

    expect(archived(entryId)).toEqual([PAGE]);
    expect(await storedOriginal(entryId)).toBeNull();
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.fullContentCleaned).toBe("<p>Article</p>");
  });

  // Left on the row, the backfill would archive it over the newer page.
  it("clears a page an earlier fetch stored on the row", async () => {
    const entryId = await createTestEntry(await createTestFeed(), {
      fullContentOriginal: "<html>older page</html>",
    });

    await persistFullContentResult(db, entryId, success);

    expect(await storedOriginal(entryId)).toBeNull();
    expect(archived(entryId)).toEqual([PAGE]);
  });

  it("stores the article even when the archive refuses the page", async () => {
    const entryId = await createTestEntry(await createTestFeed());
    s3.failPutsWith = 503;

    expect(await persistFullContentResult(db, entryId, success)).not.toBeNull();

    expect(archived(entryId)).toEqual([]);
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.fullContentCleaned).toBe("<p>Article</p>");
  });
});

describe("deleteOrphanedFullContentArchives", () => {
  it("deletes every page of deleted entries across list pages and keeps the rest", async () => {
    const feedId = await createTestFeed();
    const kept = await createTestEntry(feedId);
    const deleted = [generateUuidv7(), generateUuidv7()];
    // A refetch archives its page beside the earlier one.
    for (const id of [kept, ...deleted]) {
      await archiveFullContentOriginal(id, "<html>first</html>");
      await archiveFullContentOriginal(id, "<html>second</html>");
    }
    // A request may spell an entry id in uppercase.
    const deletedUppercase = generateUuidv7();
    await archiveFullContentOriginal(deletedUppercase.toUpperCase(), "<html>page</html>");
    const foreign = `${BUCKET}/full-content/not-an-entry.html.gz`;
    s3.objects.set(foreign, Buffer.from("x"));

    expect(await deleteOrphanedFullContentArchives(db)).toBe(5);

    expect(archived(kept).sort()).toEqual(["<html>first</html>", "<html>second</html>"]);
    expect([...s3.objects.keys()].filter((key) => !key.includes(kept))).toEqual([foreign]);
  });
});
