/**
 * Integration tests for persistFullContentResult: which full-content writes
 * bump entries.updated_at, which sync reports as entry_updated (#1850).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { persistFullContentResult } from "../../src/server/services/full-content";
import { createTestEntry, createTestFeed } from "./helpers";

const created = new Date("2026-01-01T00:00:00Z");
const success = { success: true, contentCleaned: "<p>Article</p>" };
const failure = { success: false, error: "HTTP 500: Internal Server Error" };

async function cleanup(): Promise<void> {
  await db.delete(entries);
  await db.delete(feeds);
}

async function updatedAt(entryId: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: entries.updatedAt })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row.updatedAt;
}

describe("persistFullContentResult updated_at (#1850)", () => {
  let entryId: string;

  beforeEach(async () => {
    await cleanup();
    entryId = await createTestEntry(await createTestFeed(), { fetchedAt: created });
  });

  afterAll(cleanup);

  it("bumps on the first successful fetch", async () => {
    const at = new Date("2026-01-02T00:00:00Z");
    await persistFullContentResult(db, entryId, success, at);
    expect(await updatedAt(entryId)).toEqual(at);
  });

  it("doesn't bump when a refetch returns the same content", async () => {
    const first = new Date("2026-01-02T00:00:00Z");
    await persistFullContentResult(db, entryId, success, first);
    await persistFullContentResult(db, entryId, success, new Date("2026-01-03T00:00:00Z"));
    expect(await updatedAt(entryId)).toEqual(first);
  });

  it("bumps when a refetch returns different content", async () => {
    await persistFullContentResult(db, entryId, success, new Date("2026-01-02T00:00:00Z"));
    const at = new Date("2026-01-03T00:00:00Z");
    await persistFullContentResult(
      db,
      entryId,
      { success: true, contentCleaned: "<p>Revised</p>" },
      at
    );
    expect(await updatedAt(entryId)).toEqual(at);
  });

  it("doesn't bump when a never-fetched entry's fetch fails, and records the error", async () => {
    const at = new Date("2026-01-02T00:00:00Z");
    await persistFullContentResult(db, entryId, failure, at);
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.updatedAt).toEqual(created);
    expect(row.fullContentError).toBe(failure.error);
    expect(row.fullContentFetchedAt).toEqual(at);
  });

  it("doesn't bump when a failed entry fails again", async () => {
    await persistFullContentResult(db, entryId, success, new Date("2026-01-02T00:00:00Z"));
    const failedAt = new Date("2026-01-03T00:00:00Z");
    await persistFullContentResult(db, entryId, failure, failedAt);
    await persistFullContentResult(
      db,
      entryId,
      { success: false, error: "Request timed out" },
      new Date("2026-01-04T00:00:00Z")
    );
    expect(await updatedAt(entryId)).toEqual(failedAt);
  });

  it("bumps when a failure replaces shown content, and when a success clears the error", async () => {
    await persistFullContentResult(db, entryId, success, new Date("2026-01-02T00:00:00Z"));
    const failedAt = new Date("2026-01-03T00:00:00Z");
    await persistFullContentResult(db, entryId, failure, failedAt);
    expect(await updatedAt(entryId)).toEqual(failedAt);

    const recoveredAt = new Date("2026-01-04T00:00:00Z");
    await persistFullContentResult(db, entryId, success, recoveredAt);
    expect(await updatedAt(entryId)).toEqual(recoveredAt);
  });
});
