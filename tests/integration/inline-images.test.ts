/**
 * Inlined images moved to storage (#2109): every path that writes a user's
 * entry's content stores its `data:` URI images under the entry's objects
 * prefix and links them from both stored copies, or fails the write. Feed
 * entries keep theirs inline.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, users } from "../../src/server/db/schema";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import { createEntry, generateContentHash } from "../../src/server/feed/entry-processor";
import type { ParsedEntry } from "../../src/server/feed/types";
import { getAppErrorCode } from "../../src/server/errors";
import { usageLimitsConfig } from "../../src/server/config/env";
import { pluginRegistry } from "../../src/server/plugins";
import { fetchAndStoreFullContent, fetchFullContent } from "../../src/server/services/full-content";
import { saveArticle, uploadArticle, uploadFile } from "../../src/server/services/saved";
import { entryObjectsPrefix } from "../../src/server/services/stored-objects";
import { getPublicObjectUrl } from "../../src/server/storage/s3";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { buildPdf, drawImage, textPage } from "../utils/pdf";
import {
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const BUCKET = "test-public";

/** A PNG signature plus filler: long enough that moving it shrinks the HTML. */
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(300, 7)]);
const DATA_URI = `data:image/png;base64,${PNG.toString("base64")}`;
const PNG_NAME = `${createHash("sha256").update(PNG).digest("hex")}.png`;

const ARTICLE_PAGE = `<html><head><title>Pictures</title></head><body>
<nav><a href="/">Home</a></nav>
<article><h1>Pictures</h1>
${Array.from({ length: 5 }, (_, i) => `<p>Paragraph ${i} of an article long enough for Readability to keep it as the body.</p>`).join("\n")}
<p><img src="${DATA_URI}" alt="figure"></p>
</article></body></html>`;

/** An image whose `data:` URI alone is over the saved-article limit. */
const BIG_PNG = Buffer.concat([
  PNG.subarray(0, 8),
  Buffer.alloc(usageLimitsConfig.maxSavedArticleSizeBytes, 7),
]);

// Hands back its images inlined, as the Google Docs plugin does.
pluginRegistry.register({
  name: "fixture-inlined-images",
  hosts: ["127.0.0.1"],
  matchUrl: (url) => url.pathname === "/plugin-images",
  capabilities: {
    savedArticle: {
      async fetchContent() {
        const src = `data:image/png;base64,${BIG_PNG.toString("base64")}`;
        return { html: `<p>A document with a big picture.</p><img src="${src}">` };
      },
      skipReadability: true,
    },
  },
});

const FIGURE_PDF = buildPdf(
  [
    Buffer.concat([
      textPage(["A PDF with a figure in it, long enough to be an article body."]),
      Buffer.from("\n"),
      drawImage(72, 450, 200, 200),
    ]),
  ],
  {
    image: {
      width: 40,
      height: 40,
      // Noise, so the PNG is big enough to be worth moving.
      rgb: Buffer.from(Array.from({ length: 40 * 40 * 3 }, (_, i) => (i * i * 31) % 251)),
    },
  }
);

let s3: FakeS3;
let server: Server;
let baseUrl: string;
const createdUserIds: string[] = [];
const createdFeedIds: string[] = [];

beforeAll(async () => {
  s3 = await useFakeS3({ bucket: BUCKET });
  server = createServer((req, res) => {
    if (req.url === "/figure.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(FIGURE_PDF);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ARTICLE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await s3.close();
  if (createdFeedIds.length > 0) {
    await db.delete(entries).where(inArray(entries.ownerFeedId, createdFeedIds));
    await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  }
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function user(): Promise<string> {
  const id = await createTestUser({ emailPrefix: "inline-images" });
  createdUserIds.push(id);
  return id;
}

async function feed(): Promise<string> {
  const id = await createTestFeed();
  createdFeedIds.push(id);
  return id;
}

/** The image's object under `prefix`, and that it's the only one there. */
function expectStoredImage(prefix: string): string {
  const keys = [...s3.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/${prefix}`));
  expect(keys).toEqual([`${BUCKET}/${prefix}${PNG_NAME}`]);
  expect(s3.objects.get(keys[0])).toEqual({ body: PNG, contentType: "image/png" });
  return getPublicObjectUrl(`${prefix}${PNG_NAME}`)!;
}

async function storedContent(entryId: string) {
  const [row] = await db
    .select({
      original: entries.contentOriginal,
      cleaned: entries.contentCleaned,
      fullCleaned: entries.fullContentCleaned,
    })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row;
}

describe("inlined images", () => {
  it("moves a Markdown upload's image out of both copies, under its entry", async () => {
    const userId = await user();
    const article = await uploadArticle(db, userId, {
      title: "Upload",
      content: `Some text.\n\n![figure](${DATA_URI})\n`,
    });

    const url = expectStoredImage(entryObjectsPrefix(userId, article.id));
    const { original, cleaned } = await storedContent(article.id);
    for (const html of [original, cleaned]) {
      expect(html).toContain(`src="${url}"`);
      expect(html).not.toContain("data:image");
    }
  });

  it("stores an uploaded PDF's images", async () => {
    const userId = await user();
    const { article } = await uploadFile(db, userId, {
      content: FIGURE_PDF.toString("base64"),
      filename: "figure.pdf",
    });

    const prefix = entryObjectsPrefix(userId, article.id);
    const keys = [...s3.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/${prefix}`));
    expect(keys).toHaveLength(1);
    expect(s3.objects.get(keys[0])?.contentType).toBe("image/png");
    const { cleaned } = await storedContent(article.id);
    expect(cleaned).toContain(getPublicObjectUrl(keys[0].slice(BUCKET.length + 1)));
    expect(cleaned).not.toContain("data:image");
  });

  it("moves a saved page's image out before Readability, so its extraction links it too", async () => {
    const userId = await user();
    const article = await saveArticle(db, userId, {
      url: `${baseUrl}/pictures`,
      html: ARTICLE_PAGE,
    });

    const url = expectStoredImage(entryObjectsPrefix(userId, article.id));
    const { original, cleaned } = await storedContent(article.id);
    expect(cleaned).not.toBe(original);
    for (const html of [original, cleaned]) {
      expect(html).toContain(url);
      expect(html).not.toContain("data:image");
    }
  });

  it("moves an image Readability surfaces from a <noscript> fallback", async () => {
    const userId = await user();
    const page = ARTICLE_PAGE.replace(
      `<img src="${DATA_URI}" alt="figure">`,
      `<img src="https://example.com/placeholder.jpg"><noscript><img src="${DATA_URI}"></noscript>`
    );
    const article = await saveArticle(db, userId, { url: `${baseUrl}/noscript`, html: page });

    const url = expectStoredImage(entryObjectsPrefix(userId, article.id));
    const { cleaned } = await storedContent(article.id);
    expect(cleaned).toContain(url);
    expect(cleaned).not.toContain("data:image");
  });

  it("keeps a feed entry's images inline until feeds have storage limits (#2188)", async () => {
    const feedId = await feed();
    const parsed: ParsedEntry = {
      guid: `guid-${generateUuidv7()}`,
      title: "Feed entry",
      link: "https://example.com/post",
      content: `<p>Text</p><img src="${DATA_URI}">`,
    };
    const storedBefore = s3.objects.size;

    const entry = await createEntry(db, feedId, parsed, generateContentHash(parsed), new Date());

    expect(entry!.contentOriginal).toContain(`src="${DATA_URI}"`);
    expect(s3.objects.size).toBe(storedBefore);
  });

  it("stores a newsletter's images under its recipient", async () => {
    const userId = await user();
    const token = `token-${generateUuidv7()}`;
    await createTestIngestAddress(userId, { token });

    const result = await processInboundEmail(db, {
      to: `${token}@ingest.lionreader.com`,
      from: { address: `news-${generateUuidv7()}@example.com`, name: "News" },
      subject: "Pictures",
      messageId: `<${generateUuidv7()}@example.com>`,
      html: `<p>Hello</p><img src="${DATA_URI}">`,
      headers: {},
    });

    const url = expectStoredImage(entryObjectsPrefix(userId, result.entryId!));
    expect((await storedContent(result.entryId!)).original).toContain(`src="${url}"`);
  });

  it("stores a saved article's fetched full content's images under its user", async () => {
    const userId = await user();
    const entryId = await createTestEntry(userId, {
      type: "saved",
      url: `${baseUrl}/pictures`,
      userIds: [userId],
    });

    const result = await fetchAndStoreFullContent(db, userId, entryId);

    expect(result.success).toBe(true);
    const url = expectStoredImage(entryObjectsPrefix(userId, entryId));
    expect((await storedContent(entryId)).fullCleaned).toContain(url);
  });

  it("keeps a feed entry's fetched full content's images inline", async () => {
    const userId = await user();
    const feedId = await feed();
    await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId, {
      url: `${baseUrl}/pictures`,
      userIds: [userId],
    });
    const storedBefore = s3.objects.size;

    const result = await fetchAndStoreFullContent(db, userId, entryId);

    expect(result.success).toBe(true);
    expect((await storedContent(entryId)).fullCleaned).toContain(DATA_URI);
    expect(s3.objects.size).toBe(storedBefore);
  });

  it("drops a PDF's images from a feed entry's full content", async () => {
    const storedBefore = s3.objects.size;

    const result = await fetchFullContent(`${baseUrl}/figure.pdf`, { objectsPrefix: null });

    expect(result.success).toBe(true);
    expect(result.contentCleaned).toContain("A PDF with a figure in it");
    expect(result.contentCleaned).not.toContain("<img");
    expect(s3.objects.size).toBe(storedBefore);
  });

  it("stores a plugin's inlined images, however far over the limit they'd put it", async () => {
    const userId = await user();
    const article = await saveArticle(db, userId, { url: `${baseUrl}/plugin-images` });

    const prefix = entryObjectsPrefix(userId, article.id);
    const keys = [...s3.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/${prefix}`));
    expect(keys).toHaveLength(1);
    expect((await storedContent(article.id)).original).not.toContain("data:image");
  });

  it("fails content its inline images put over the limit", async () => {
    const result = await fetchFullContent(`${baseUrl}/plugin-images`, { objectsPrefix: null });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds the maximum size/);
  });

  it("fails an upload storage refuses, saving nothing", async () => {
    const userId = await user();
    s3.failPutsWith = 503;
    try {
      await expect(
        uploadArticle(db, userId, { title: "Refused", content: `![figure](${DATA_URI})\n` })
      ).rejects.toSatisfy((error) => getAppErrorCode(error) === "STORAGE_FAILED");
    } finally {
      s3.failPutsWith = null;
    }
    expect(
      await db.select({ id: entries.id }).from(entries).where(eq(entries.ownerUserId, userId))
    ).toEqual([]);
  });
});
