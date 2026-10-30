/**
 * Integration tests for the full-content page archive (#2115): the fetched
 * page goes to the private archive bucket instead of the entry row, and
 * hard-deleting an entry queues deletion of its pages.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, jobs, users } from "../../src/server/db/schema";
import { getJobPayload } from "../../src/server/jobs/queue";
import { handleDeleteFullContentArchives } from "../../src/server/jobs/handlers/delete-full-content-archives";
import { persistFullContentResult } from "../../src/server/services/full-content";
import { archiveFullContentOriginal } from "../../src/server/services/full-content-archive";
import { deleteSavedArticle } from "../../src/server/services/saved";
import { deleteUser } from "../../src/server/services/users";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import {
  createTestEmailSubscription,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const BUCKET = "test-archive";
const PAGE = "<html><body><nav>menu</nav><article><p>Article</p></article></body></html>";
const success = { success: true, contentOriginal: PAGE, contentCleaned: "<p>Article</p>" };

let s3: FakeS3;

const createdUsers: string[] = [];

async function cleanup(): Promise<void> {
  await db.delete(entries);
  await db.delete(feeds);
  await db.delete(jobs).where(eq(jobs.type, "delete_full_content_archives"));
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.id, createdUsers));
}

async function user(): Promise<string> {
  const id = await createTestUser({ emailPrefix: "archive" });
  createdUsers.push(id);
  return id;
}

/** An entry whose full content was fetched, with two archived pages (a refetch). */
async function fetchedEntry(owner: string, options: Parameters<typeof createTestEntry>[1] = {}) {
  const entryId = await createTestEntry(owner, { fullContentFetchedAt: new Date(), ...options });
  await archiveFullContentOriginal(entryId, "<html>first</html>");
  await archiveFullContentOriginal(entryId, "<html>second</html>");
  return entryId;
}

/** Runs the queued archive deletions as the worker would. */
async function runDeletionJobs(): Promise<void> {
  const queued = await db.select().from(jobs).where(eq(jobs.type, "delete_full_content_archives"));
  for (const job of queued) {
    await handleDeleteFullContentArchives(getJobPayload(job, "delete_full_content_archives"));
  }
}

beforeEach(async () => {
  await cleanup();
  s3 = await useFakeS3({ archiveBucket: BUCKET });
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
    .map(([, object]) => gunzipSync(object.body).toString("utf8"));
}

describe("persistFullContentResult", () => {
  it("archives the fetched page", async () => {
    const entryId = await createTestEntry(await createTestFeed());

    await persistFullContentResult(db, entryId, success);

    expect(archived(entryId)).toEqual([PAGE]);
    const [row] = await db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.fullContentCleaned).toBe("<p>Article</p>");
  });

  it("leaves no page behind for an entry deleted during the fetch", async () => {
    const entryId = await createTestEntry(await createTestFeed());
    await db.delete(entries).where(eq(entries.id, entryId));

    await persistFullContentResult(db, entryId, success);

    expect(archived(entryId)).toEqual([]);
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

describe("deleting entries", () => {
  it("deletes a deleted saved article's pages and keeps the others'", async () => {
    const userId = await user();
    const deleted = await fetchedEntry(userId, { type: "saved", userIds: [userId] });
    const kept = await fetchedEntry(userId, { type: "saved", userIds: [userId] });

    await deleteSavedArticle(db, userId, deleted);
    await runDeletionJobs();

    expect(archived(deleted)).toEqual([]);
    expect(archived(kept)).toHaveLength(2);
  });

  it("deletes the pages of every entry an account deletion removes", async () => {
    const leaving = await user();
    const staying = await user();
    const saved = await fetchedEntry(leaving, { type: "saved", userIds: [leaving] });
    const email = await fetchedEntry(await createTestEmailSubscription(leaving), {
      type: "email",
      userIds: [leaving],
    });
    const onlyMine = await createTestFeed();
    await createTestSubscription(leaving, onlyMine);
    const orphaned = await fetchedEntry(onlyMine, { userIds: [leaving] });
    const shared = await createTestFeed();
    await createTestSubscription(leaving, shared);
    await createTestSubscription(staying, shared);
    const stillHeld = await fetchedEntry(shared, { userIds: [leaving, staying] });

    await deleteUser(db, leaving);
    await runDeletionJobs();

    expect(archived(saved)).toEqual([]);
    expect(archived(email)).toEqual([]);
    expect(archived(orphaned)).toEqual([]);
    expect(archived(stillHeld)).toHaveLength(2);
  });
});
