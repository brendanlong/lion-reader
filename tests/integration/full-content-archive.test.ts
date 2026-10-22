/**
 * Integration tests for the full-content page archive (#2115): the fetched
 * page goes to the private archive bucket instead of the entry row, and the
 * daily sweep deletes pages whose entry is gone.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { persistFullContentResult } from "../../src/server/services/full-content";
import {
  deleteOrphanedFullContentArchives,
  fullContentArchiveKey,
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

function archived(entryId: string): string | undefined {
  const object = s3.objects.get(`${BUCKET}/${fullContentArchiveKey(entryId)}`);
  return object && gunzipSync(object).toString("utf8");
}

async function storedOriginal(entryId: string): Promise<string | null> {
  const result = await db.execute<{ original: string | null }>(
    sql`SELECT full_content_original AS original FROM entries WHERE id = ${entryId}`
  );
  return result.rows[0].original;
}

describe("persistFullContentResult", () => {
  it("archives the fetched page instead of storing it on the entry", async () => {
    const entryId = await createTestEntry(await createTestFeed());

    await persistFullContentResult(db, entryId, success);

    expect(archived(entryId)).toBe(PAGE);
    expect(await storedOriginal(entryId)).toBeNull();
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.fullContentCleaned).toBe("<p>Article</p>");
  });

  it("stores the article even when the archive refuses the page", async () => {
    const entryId = await createTestEntry(await createTestFeed());
    s3.failPutsWith = 503;

    expect(await persistFullContentResult(db, entryId, success)).not.toBeNull();

    expect(archived(entryId)).toBeUndefined();
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.fullContentCleaned).toBe("<p>Article</p>");
  });
});

describe("deleteOrphanedFullContentArchives", () => {
  it("deletes pages of deleted entries across list pages and keeps the rest", async () => {
    const feedId = await createTestFeed();
    const kept = [await createTestEntry(feedId), await createTestEntry(feedId)];
    const deleted = [generateUuidv7(), generateUuidv7(), generateUuidv7()];
    for (const id of [...kept, ...deleted]) {
      s3.objects.set(`${BUCKET}/${fullContentArchiveKey(id)}`, Buffer.from("x"));
    }
    const foreign = `${BUCKET}/full-content/not-an-entry.html.gz`;
    s3.objects.set(foreign, Buffer.from("x"));

    expect(await deleteOrphanedFullContentArchives(db)).toBe(deleted.length);

    expect([...s3.objects.keys()].sort()).toEqual(
      [...kept.map((id) => `${BUCKET}/${fullContentArchiveKey(id)}`), foreign].sort()
    );
  });
});
