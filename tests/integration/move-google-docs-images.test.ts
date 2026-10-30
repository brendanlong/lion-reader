/**
 * The one-off move of `google-docs/` images under their entries' prefixes
 * (#2107, `scripts/move-google-docs-images.ts`), against the fake S3.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries } from "../../src/server/db/schema";
import { entryObjectsPrefix } from "../../src/server/services/stored-objects";
import { getPublicObjectUrl, uploadObject } from "../../src/server/storage/s3";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  deleteUnlinkedGoogleDocsImages,
  rewriteGoogleDocsLinks,
} from "../../scripts/move-google-docs-images";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import {
  createTestEmailSubscription,
  createTestEntry,
  createTestFeed,
  createTestUser,
  holdTransaction,
  waitForLockWaiter,
} from "./helpers";

const BUCKET = "test-public";

function png(filler: number): Buffer {
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(300, filler)]);
}

function legacyKey(): string {
  return `google-docs/doc_${generateUuidv7().slice(0, 8)}/${generateUuidv7()}.png`;
}

/** Stores `data` as an old Google Docs save did, returning its link. */
async function storeLegacyImage(data: Buffer, contentType: string): Promise<string> {
  const key = legacyKey();
  await uploadObject(key, data, contentType);
  return getPublicObjectUrl(key)!;
}

function stored(s3: FakeS3, url: string): Buffer | undefined {
  const key = url.slice(getPublicObjectUrl("")!.length);
  return s3.objects.get(`${BUCKET}/${key}`)?.body;
}

function googleDocsKeys(s3: FakeS3): string[] {
  return [...s3.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/google-docs/`));
}

async function readEntry(id: string) {
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  return row;
}

function storedUrl(userId: string, entryId: string, data: Buffer): string {
  const hash = createHash("sha256").update(data).digest("hex");
  return `${getPublicObjectUrl(entryObjectsPrefix(userId, entryId))}${hash}.png`;
}

describe("moving google-docs/ images", () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await useFakeS3({ bucket: BUCKET });
  });
  afterAll(async () => {
    await s3.close();
  });

  it("relinks every entry to its own copy and deletes only what nothing mentions", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const SHARED = png(1);
    const NEWSLETTER = png(2);
    const FEED = png(3);
    const sharedLink = await storeLegacyImage(SHARED, "image/png");
    const newsletterLink = await storeLegacyImage(NEWSLETTER, "image/png");
    const feedLink = await storeLegacyImage(FEED, "image/png");
    const orphanLink = await storeLegacyImage(png(4), "image/png");
    // Not a raster image, so a save today would keep it inline.
    const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(200)}</svg>`);
    const svgLink = await storeLegacyImage(SVG, "image/svg+xml");
    const missingLink = getPublicObjectUrl(`google-docs/doc/${generateUuidv7()}.png`)!;
    const publishersLink = await storeLegacyImage(png(6), "image/png");
    const imageUrlLink = await storeLegacyImage(png(7), "image/png");
    const encodedKey = legacyKey();
    await uploadObject(encodedKey, png(8), "image/png");
    // The same object as `sharedLink`, under a public URL base the bucket had before.
    const oldBaseLink = sharedLink.replace(getPublicObjectUrl("")!, "https://old.example/b/");

    const savedA = await createTestEntry(userA, {
      type: "saved",
      contentOriginal: `<p>A</p><img src="${sharedLink}"><img src="${svgLink}"><img src="${missingLink}">`,
      contentCleaned: `<p>A</p><img src="${sharedLink}">`,
    });
    const savedB = await createTestEntry(userB, {
      type: "saved",
      contentCleaned: `<img src="${sharedLink}"><img src="${oldBaseLink}">`,
    });
    const email = await createTestEntry(await createTestEmailSubscription(userA), {
      type: "email",
      contentCleaned: "<p>A newsletter linking a Doc</p>",
      fullContentCleaned: `<img src="${newsletterLink}">`,
      fullContentFetchedAt: new Date(),
      fullContentHash: "hash",
    });
    const feedEntry = await createTestEntry(await createTestFeed(), {
      contentCleaned: `<p>A feed entry hotlinking</p><img src="${publishersLink}">`,
      fullContentCleaned: `<p>The Doc</p><figure><img src="${feedLink}" alt="chart"></figure>`,
      fullContentFetchedAt: new Date(),
      fullContentHash: "hash",
    });
    // Mentions `rewrite` doesn't relink, which `delete` must still respect.
    await createTestEntry(userB, {
      type: "saved",
      imageUrl: imageUrlLink,
      summary: `see ${encodeURIComponent(encodedKey)}`,
    });
    const before = new Map(
      await Promise.all(
        [savedA, savedB, email, feedEntry].map(async (id) => [id, await readEntry(id)] as const)
      )
    );

    // Before the rewrite, only the image nothing mentions goes.
    expect(await deleteUnlinkedGoogleDocsImages(db)).toMatchObject({ kept: 7, deleted: 1 });
    expect(stored(s3, orphanLink)).toBeUndefined();
    expect(stored(s3, sharedLink)).toEqual(SHARED);

    const objectCount = s3.objects.size;
    expect(await rewriteGoogleDocsLinks(db, { dryRun: true })).toMatchObject({
      rewritten: 3,
      dropped: 1,
      missingLinks: 1,
    });
    expect(s3.objects.size).toBe(objectCount);
    expect(await readEntry(savedA)).toEqual(before.get(savedA));

    // Resuming after savedA leaves it for the full run below; one id per
    // batch crosses window boundaries.
    const resumed = await rewriteGoogleDocsLinks(db, { after: savedA, batchSize: 1 });
    expect(resumed).toMatchObject({ rewritten: 2, dropped: 1, missingLinks: 0 });
    expect((await readEntry(savedA)).contentOriginal).toBe(before.get(savedA)!.contentOriginal);

    const result = await rewriteGoogleDocsLinks(db, { batchSize: 1 });
    expect(result).toMatchObject({ rewritten: 1, dropped: 0, skipped: 0, missingLinks: 1 });

    const a = await readEntry(savedA);
    const aUrl = storedUrl(userA, savedA, SHARED);
    expect(a.contentOriginal).toBe(
      `<p>A</p><img src="${aUrl}"><img src="data:image/svg+xml;base64,${SVG.toString("base64")}"><img src="${missingLink}">`
    );
    expect(a.contentCleaned).toBe(`<p>A</p><img src="${aUrl}">`);
    expect(stored(s3, aUrl)).toEqual(SHARED);

    const bUrl = storedUrl(userB, savedB, SHARED);
    expect((await readEntry(savedB)).contentCleaned).toBe(`<img src="${bUrl}"><img src="${bUrl}">`);
    expect(stored(s3, bUrl)).toEqual(SHARED);

    const emailUrl = storedUrl(userA, email, NEWSLETTER);
    expect((await readEntry(email)).fullContentCleaned).toBe(`<img src="${emailUrl}">`);
    expect(stored(s3, emailUrl)).toEqual(NEWSLETTER);

    expect(await readEntry(feedEntry)).toMatchObject({
      contentCleaned: before.get(feedEntry)!.contentCleaned,
      fullContentCleaned: "<p>The Doc</p><figure></figure>",
      fullContentFetchedAt: before.get(feedEntry)!.fullContentFetchedAt,
    });

    for (const id of [savedA, savedB, email, feedEntry]) {
      expect((await readEntry(id)).updatedAt.getTime()).toBeGreaterThan(
        before.get(id)!.updatedAt.getTime()
      );
    }

    // Idempotent: nothing left to move, and nothing touched again.
    const updatedAt = (await readEntry(savedB)).updatedAt;
    expect(await rewriteGoogleDocsLinks(db)).toMatchObject({ rewritten: 0, dropped: 0 });
    expect((await readEntry(savedB)).updatedAt).toEqual(updatedAt);

    expect(await deleteUnlinkedGoogleDocsImages(db, { dryRun: true })).toMatchObject({
      kept: 3,
      deleted: 4,
    });
    expect(googleDocsKeys(s3)).toHaveLength(7);
    expect(await deleteUnlinkedGoogleDocsImages(db)).toMatchObject({ kept: 3, deleted: 4 });
    expect(googleDocsKeys(s3).sort()).toEqual(
      [publishersLink, imageUrlLink, getPublicObjectUrl(encodedKey)!]
        .map((link) => `${BUCKET}/${link.slice(getPublicObjectUrl("")!.length)}`)
        .sort()
    );
    expect(stored(s3, aUrl)).toEqual(SHARED);
  });

  it("skips an entry rewritten while its images were being moved", async () => {
    const userId = await createTestUser();
    const link = await storeLegacyImage(png(5), "image/png");
    const entryId = await createTestEntry(userId, {
      type: "saved",
      contentCleaned: `<img src="${link}">`,
    });

    const refetch = await holdTransaction((tx) =>
      tx.update(entries).set({ contentCleaned: "<p>Refetched</p>" }).where(eq(entries.id, entryId))
    );
    const rewrite = rewriteGoogleDocsLinks(db);
    await waitForLockWaiter("%UPDATE entries%SET content_original%");
    await refetch.commit();

    expect(await rewrite).toMatchObject({ rewritten: 0, skipped: 1 });
    expect((await readEntry(entryId)).contentCleaned).toBe("<p>Refetched</p>");
    // Nothing links it now, so it can go.
    expect(await deleteUnlinkedGoogleDocsImages(db)).toMatchObject({ deleted: 1 });
  });

  it("deletes the copies of an entry deleted while its images were being moved", async () => {
    const userId = await createTestUser();
    const link = await storeLegacyImage(png(9), "image/png");
    const entryId = await createTestEntry(userId, {
      type: "saved",
      contentCleaned: `<img src="${link}">`,
    });

    const deletion = await holdTransaction((tx) =>
      tx.delete(entries).where(eq(entries.id, entryId))
    );
    const rewrite = rewriteGoogleDocsLinks(db);
    await waitForLockWaiter("%UPDATE entries%SET content_original%");
    await deletion.commit();

    expect(await rewrite).toMatchObject({ skipped: 1 });
    const prefix = `${BUCKET}/${entryObjectsPrefix(userId, entryId)}`;
    expect([...s3.objects.keys()].filter((key) => key.startsWith(prefix))).toEqual([]);
  });
});
