/**
 * Ebook images in object storage (#1805): each chapter's images are stored
 * under its entry, and deleting the chapter or the account deletes them
 * through a `delete_stored_objects` job.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, jobs, users } from "../../src/server/db/schema";
import { importEbook } from "../../src/server/services/ebooks";
import { deleteSavedArticle } from "../../src/server/services/saved";
import { deleteUser } from "../../src/server/services/users";
import {
  entryObjectsPrefix,
  guardUnsavedEntryObjects,
  storeEntryImage,
  userObjectsPrefix,
} from "../../src/server/services/stored-objects";
import type { JobPayloads } from "../../src/server/jobs/queue";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { deleteObjectsWithPrefix, uploadObject } from "../../src/server/storage/s3";
import { handleDeleteStoredObjects } from "../../src/server/jobs/handlers/delete-stored-objects";
import { buildEpub, chapterXhtml } from "../utils/epub";
import { startFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestUser } from "./helpers";

let s3: FakeS3;
const createdUserIds: string[] = [];

beforeAll(async () => {
  s3 = await startFakeS3();
});

afterAll(async () => {
  await s3.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
    await db.delete(jobs).where(sql`${jobs.payload}->>'prefix' LIKE ${`uploads/${id}/%`}`);
  }
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const BOOK = buildEpub({
  title: "Pictures",
  spine: [
    { path: "one.xhtml", xhtml: chapterXhtml('<h1>One</h1><p><img src="pic.png"/></p>') },
    { path: "two.xhtml", xhtml: chapterXhtml('<h1>Two</h1><p><img src="pic.png"/></p>') },
  ],
  files: { "OEBPS/pic.png": PNG },
  manifest: { "pic.png": "image/png" },
});

async function importBook(): Promise<{ userId: string; entryIds: string[] }> {
  const userId = await createTestUser({ emailPrefix: "ebook-images" });
  createdUserIds.push(userId);
  const { entryIds } = await importEbook(db, userId, {
    content: BOOK.toString("base64"),
    filename: "pictures.epub",
  });
  return { userId, entryIds };
}

function keysUnder(prefix: string): string[] {
  return [...s3.objects.keys()].filter((key) => key.startsWith(prefix));
}

/**
 * Runs the one queued `delete_stored_objects` job for `prefix` (the guard of an
 * unsaved entry's objects, or a deletion), as the worker would.
 */
async function runQueuedJob(prefix: string, kind: "guard" | "deletion"): Promise<void> {
  const queued = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "delete_stored_objects"),
        sql`${jobs.payload}->>'prefix' = ${prefix}`,
        kind === "guard"
          ? sql`${jobs.payload} ? 'unlessEntryExists'`
          : sql`NOT ${jobs.payload} ? 'unlessEntryExists'`
      )
    );
  expect(queued).toHaveLength(1);
  await handleDeleteStoredObjects(queued[0].payload as JobPayloads["delete_stored_objects"]);
}

describe("ebook images in storage", () => {
  it("stores each chapter's images under its entry and links them from its content", async () => {
    const { userId, entryIds } = await importBook();

    for (const entryId of entryIds) {
      const [key] = keysUnder(entryObjectsPrefix(userId, entryId));
      expect(s3.objects.get(key)).toEqual({ body: PNG, contentType: "image/png" });
      const [row] = await db
        .select({ content: entries.contentOriginal })
        .from(entries)
        .where(eq(entries.id, entryId));
      expect(row.content).toContain(`<img src="https://test-bucket.storage.test/${key}">`);
    }
  });

  it("stores nothing again when the same book is imported twice", async () => {
    const { userId } = await importBook();
    const before = keysUnder(userObjectsPrefix(userId));

    await importEbook(db, userId, { content: BOOK.toString("base64"), filename: "p.epub" });

    expect(keysUnder(userObjectsPrefix(userId))).toEqual(before);
  });

  it("deletes a chapter's images with the chapter", async () => {
    const { userId, entryIds } = await importBook();
    const [deleted, kept] = entryIds;

    await deleteSavedArticle(db, userId, deleted);
    await runQueuedJob(entryObjectsPrefix(userId, deleted), "deletion");

    expect(keysUnder(entryObjectsPrefix(userId, deleted))).toEqual([]);
    expect(keysUnder(entryObjectsPrefix(userId, kept))).toHaveLength(1);
  });

  it("keeps a saved chapter's images when its guard runs", async () => {
    const { userId, entryIds } = await importBook();

    for (const entryId of entryIds) {
      await runQueuedJob(entryObjectsPrefix(userId, entryId), "guard");
      expect(keysUnder(entryObjectsPrefix(userId, entryId))).toHaveLength(1);
    }
  });

  it("deletes images stored for an entry that was never saved", async () => {
    const userId = await createTestUser({ emailPrefix: "ebook-images" });
    createdUserIds.push(userId);
    const entryId = generateUuidv7();
    await guardUnsavedEntryObjects(db, userId, entryId);
    await storeEntryImage(userId, entryId, {
      data: PNG,
      mediaType: "image/png",
      extension: ".png",
    });

    await runQueuedJob(entryObjectsPrefix(userId, entryId), "guard");

    expect(keysUnder(entryObjectsPrefix(userId, entryId))).toEqual([]);
  });

  it("inlines an image storage refuses", async () => {
    s3.failPuts = true;
    try {
      const { entryIds } = await importBook();
      const [row] = await db
        .select({ content: entries.contentOriginal })
        .from(entries)
        .where(eq(entries.id, entryIds[0]));
      expect(row.content).toContain(`<img src="data:image/png;base64,${PNG.toString("base64")}">`);
    } finally {
      s3.failPuts = false;
    }
  });

  it("fails a deletion storage refuses, so the job is retried", async () => {
    const prefix = "uploads/refused/";
    await uploadObject(`${prefix}a.png`, PNG, "image/png");
    s3.failDeletes = true;
    try {
      await expect(deleteObjectsWithPrefix(prefix)).rejects.toThrow(/refused/);
    } finally {
      s3.failDeletes = false;
    }
    expect(keysUnder(prefix)).toHaveLength(1);
  });

  it("deletes more objects than one listing returns", async () => {
    const prefix = "uploads/many/";
    for (let i = 0; i <= 1000; i++) {
      await uploadObject(`${prefix}${i}&<'.png`, PNG, "image/png");
    }

    expect(await deleteObjectsWithPrefix(prefix)).toBe(1001);
    expect(keysUnder(prefix)).toEqual([]);
  });

  it("deletes every image the user stored with their account", async () => {
    const { userId } = await importBook();

    await deleteUser(db, userId);
    await runQueuedJob(userObjectsPrefix(userId), "deletion");

    expect(keysUnder(userObjectsPrefix(userId))).toEqual([]);
  });
});
