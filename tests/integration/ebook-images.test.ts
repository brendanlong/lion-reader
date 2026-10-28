/**
 * Ebook images in object storage (#1805): each chapter's images are stored
 * under its entry (or the import fails), and deleting the chapter or the
 * account deletes them through a `delete_stored_objects` job.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, jobs, users } from "../../src/server/db/schema";
import { importEbook } from "../../src/server/services/ebooks";
import { deleteSavedArticle } from "../../src/server/services/saved";
import { deleteUser } from "../../src/server/services/users";
import {
  entryObjectsPrefix,
  storeEntryImage,
  userObjectsPrefix,
} from "../../src/server/services/stored-objects";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { getAppErrorCode } from "../../src/server/errors";
import type { JobPayloads } from "../../src/server/jobs/queue";
import { getPublicObjectUrl } from "../../src/server/storage/s3";
import { handleDeleteStoredObjects } from "../../src/server/jobs/handlers/delete-stored-objects";
import { buildEpub, chapterXhtml } from "../utils/epub";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestUser } from "./helpers";

const BUCKET = "test-public";
let s3: FakeS3;
const createdUserIds: string[] = [];

beforeAll(async () => {
  s3 = await useFakeS3({ bucket: BUCKET });
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

/** The public bucket's keys under `prefix`. */
function keysUnder(prefix: string): string[] {
  return [...s3.objects.keys()]
    .filter((key) => key.startsWith(`${BUCKET}/${prefix}`))
    .map((key) => key.slice(BUCKET.length + 1));
}

/** Runs the one queued `delete_stored_objects` job for `prefix`, as the worker would. */
async function runQueuedJob(prefix: string): Promise<void> {
  const queued = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(
      and(eq(jobs.type, "delete_stored_objects"), sql`${jobs.payload}->>'prefix' = ${prefix}`)
    );
  expect(queued).toHaveLength(1);
  await handleDeleteStoredObjects(queued[0].payload as JobPayloads["delete_stored_objects"]);
}

describe("ebook images in storage", () => {
  it("stores each chapter's images under its entry and links them from its content", async () => {
    const { userId, entryIds } = await importBook();

    for (const entryId of entryIds) {
      const [key] = keysUnder(entryObjectsPrefix(userId, entryId));
      expect(s3.objects.get(`${BUCKET}/${key}`)).toEqual({ body: PNG, contentType: "image/png" });
      const [row] = await db
        .select({ content: entries.contentOriginal })
        .from(entries)
        .where(eq(entries.id, entryId));
      expect(row.content).toContain(`<img src="${getPublicObjectUrl(key)}">`);
    }
  });

  it("keys an image by its hash, so storing it for the entry again is one object", async () => {
    const userId = await createTestUser({ emailPrefix: "ebook-images" });
    createdUserIds.push(userId);
    const entryId = generateUuidv7();
    const image = { data: PNG, mediaType: "image/png", extension: ".png" };

    const first = await storeEntryImage(userId, entryId, image);
    const again = await storeEntryImage(userId, entryId, image);

    expect(again).toBe(first);
    expect(keysUnder(entryObjectsPrefix(userId, entryId))).toEqual([
      `${entryObjectsPrefix(userId, entryId)}${createHash("sha256").update(PNG).digest("hex")}.png`,
    ]);
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
    await runQueuedJob(entryObjectsPrefix(userId, deleted));

    expect(keysUnder(entryObjectsPrefix(userId, deleted))).toEqual([]);
    expect(keysUnder(entryObjectsPrefix(userId, kept))).toHaveLength(1);
  });

  it("fails the import when storage refuses an image, keeping the chapters before it", async () => {
    const userId = await createTestUser({ emailPrefix: "ebook-images" });
    createdUserIds.push(userId);
    const book = buildEpub({
      title: "Refused",
      spine: [
        { path: "one.xhtml", xhtml: chapterXhtml("<h1>One</h1><p>No pictures.</p>") },
        { path: "two.xhtml", xhtml: chapterXhtml('<h1>Two</h1><p><img src="pic.png"/></p>') },
      ],
      files: { "OEBPS/pic.png": PNG },
      manifest: { "pic.png": "image/png" },
    });

    s3.failPutsWith = 503;
    try {
      await expect(
        importEbook(db, userId, { content: book.toString("base64"), filename: "r.epub" })
      ).rejects.toSatisfy((error) => getAppErrorCode(error) === "STORAGE_FAILED");
    } finally {
      s3.failPutsWith = null;
    }
    const titles = await db
      .select({ title: entries.title })
      .from(entries)
      .where(eq(entries.ownerUserId, userId));
    expect(titles).toEqual([{ title: "One" }]);
  });

  it("fails a deletion storage refuses, so the job is retried", async () => {
    const { userId, entryIds } = await importBook();
    const prefix = entryObjectsPrefix(userId, entryIds[0]);
    s3.failDeletesWith = 503;
    try {
      await expect(handleDeleteStoredObjects({ prefix })).rejects.toThrow();
    } finally {
      s3.failDeletesWith = null;
    }
    expect(keysUnder(prefix)).toHaveLength(1);
  });

  it("deletes every image the user stored with their account", async () => {
    const { userId } = await importBook();

    await deleteUser(db, userId);
    await runQueuedJob(userObjectsPrefix(userId));

    expect(keysUnder(userObjectsPrefix(userId))).toEqual([]);
  });
});
