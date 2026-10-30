/**
 * Integration tests for the unified upload → save pipeline.
 *
 * File uploads (`uploadFile`) and Markdown uploads (`uploadArticle`)
 * run their content through the same `buildArticleFields` pipeline as a URL save,
 * so this covers the upload-specific behavior that pipeline adds: title/author
 * precedence, the filename fallback, relative-URL handling against the dummy
 * upload base, and Open Graph metadata extraction.
 */

import { describe, it, expect, afterAll } from "vitest";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries, userEntries } from "../../src/server/db/schema";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { uploadArticle, uploadFile } from "../../src/server/services/saved";
import { createCollection } from "../../src/server/services/collections";
import { getSavedSubscriptionId } from "../../src/server/services/subscriptions";
import { buildMinimalDocx } from "../utils/docx";
import { buildPdf, textPage } from "../utils/pdf";
import { waitForMessage } from "../utils/pubsub";
import { createTestUser } from "./helpers";

const createdUserIds: string[] = [];

/** Creates a user and registers it for `afterAll` cleanup. */
async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "upload" });
  createdUserIds.push(userId);
  return userId;
}

async function upload(userId: string, file: Buffer, filename: string, title?: string) {
  return (await uploadFile(db, userId, { content: file.toString("base64"), filename, title }))
    .article;
}

/** Reads the stored raw columns for a saved entry (bypassing the read-path sanitize). */
async function readStored(entryId: string) {
  const [row] = await db
    .select({
      contentOriginal: entries.contentOriginal,
      contentCleaned: entries.contentCleaned,
      title: entries.title,
      author: entries.author,
      siteName: entries.siteName,
      summary: entries.summary,
      imageUrl: entries.imageUrl,
      url: entries.url,
      guid: entries.guid,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1);
  return row;
}

// A substantial HTML article so Readability extracts a real body.
const ARTICLE_BODY =
  "<p>This is the opening paragraph of a genuinely substantial uploaded article. " +
  "It has enough prose that the readability extractor treats it as real content " +
  "rather than a boilerplate shell, so the cleaned body is produced.</p>" +
  '<p>Here is a <a href="/relative/link">relative link</a> and an ' +
  '<img src="images/pic.png" alt="pic"> relative image that should be rewritten.</p>' +
  "<p>And a closing paragraph with still more text to comfortably clear the " +
  "minimum content length thresholds the extractor enforces.</p>";

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("uploadFile's list item", () => {
  it("is the one its new_entry event carries, in the user's saved subscription", async () => {
    const userId = await createUser();
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL must be set for integration tests");
    const subscriber = new Redis(redisUrl);
    try {
      const channel = getUserEventsChannel(userId);
      await subscriber.subscribe(channel);
      const published = waitForMessage(subscriber, channel);

      const { listItem } = await uploadFile(db, userId, {
        content: Buffer.from(`<html><body>${ARTICLE_BODY}</body></html>`).toString("base64"),
        filename: "notes.html",
      });

      const savedSubscriptionId = await getSavedSubscriptionId(db, userId);
      expect(listItem.subscriptionIds).toEqual([savedSubscriptionId]);
      expect(JSON.parse(await published)).toMatchObject({
        type: "new_entry",
        entryId: listItem.entryId,
        subscriptionId: savedSubscriptionId,
        updatedAt: listItem.updatedAt,
        entry: listItem.entry,
      });
    } finally {
      await subscriber.quit();
    }
  });

  it("names the collections it was filed into, as fresh as filing it", async () => {
    const userId = await createUser();
    const { subscription: collection } = await createCollection(db, userId, "Reading");

    const { listItem } = await uploadFile(db, userId, {
      content: Buffer.from("A note for the collection.").toString("base64"),
      filename: "note.md",
      collectionIds: [collection.id],
    });

    const [{ updatedAt }] = await db
      .select({ updatedAt: userEntries.updatedAt })
      .from(userEntries)
      .where(eq(userEntries.entryId, listItem.entryId));
    expect(listItem.subscriptionIds).toContain(collection.id);
    expect(listItem.updatedAt).toBe(updatedAt.toISOString());
  });
});

describe("uploadFile (HTML)", () => {
  it("stores a null URL and an uploaded: guid", async () => {
    const userId = await createUser();
    const article = await upload(
      userId,
      Buffer.from(`<html><head><title>Doc Title</title></head><body>${ARTICLE_BODY}</body></html>`),
      "notes.html"
    );

    expect(article.url).toBeNull();
    const stored = await readStored(article.id);
    expect(stored.url).toBeNull();
    expect(stored.guid.startsWith("uploaded:")).toBe(true);
  });

  it("prefers a provided title over the document title", async () => {
    const userId = await createUser();
    const article = await upload(
      userId,
      Buffer.from(
        `<html><head><title>Document Title</title></head><body>${ARTICLE_BODY}</body></html>`
      ),
      "notes.html",
      "Caller Title"
    );
    expect(article.title).toBe("Caller Title");
  });

  it("falls back to the filename-derived title when content has none", async () => {
    const userId = await createUser();
    // No <title> and no heading Readability would pick up as a title.
    const article = await upload(
      userId,
      Buffer.from(`<html><body>${ARTICLE_BODY}</body></html>`),
      "My_Great-Notes.html"
    );
    expect(article.title).toBe("My Great Notes");
  });

  it("rewrites relative URLs against the dummy upload base (not Lion Reader)", async () => {
    const userId = await createUser();
    const article = await upload(
      userId,
      Buffer.from(`<html><body>${ARTICLE_BODY}</body></html>`),
      "notes.html"
    );

    const stored = await readStored(article.id);
    expect(stored.contentCleaned).toBeTruthy();
    // Relative link/image resolved against uploaded.invalid, so nothing points
    // back into the app.
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/relative/link");
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/images/pic.png");
    expect(stored.contentCleaned).not.toContain('href="/relative/link"');
  });

  it("keeps the raw original when Readability fails (contentCleaned null, still readable)", async () => {
    const userId = await createUser();
    // Too short for Readability to extract → cleaned is null. Matches how a URL
    // save behaves on a page Readability can't parse: store the original, serve
    // `cleaned ?? original` on read.
    const article = await upload(
      userId,
      Buffer.from("<html><body><p>Too short.</p></body></html>"),
      "tiny.html"
    );

    expect(article.contentCleaned).toBeNull();
    const stored = await readStored(article.id);
    expect(stored.contentCleaned).toBeNull();
    // The raw body survives as the original, so the read path still renders it.
    expect(stored.contentOriginal).toContain("Too short.");
  });

  it("extracts Open Graph metadata (author, image) from uploaded HTML", async () => {
    const userId = await createUser();
    const html =
      "<html><head>" +
      '<meta property="og:image" content="https://cdn.example.com/cover.jpg">' +
      '<meta name="author" content="Ada Lovelace">' +
      "<title>OG Doc</title></head>" +
      `<body>${ARTICLE_BODY}</body></html>`;
    const article = await upload(userId, Buffer.from(html), "og.html");

    expect(article.author).toBe("Ada Lovelace");
    const stored = await readStored(article.id);
    expect(stored.imageUrl).toBe("https://cdn.example.com/cover.jpg");
  });
});

describe("uploadFile (.docx)", () => {
  // A body long enough that, if Readability *did* run, it would produce a cleaned
  // body — so the assertions below confirm we deliberately skip it and keep the
  // mammoth output as-is.
  const DOCX_PARAGRAPHS = [
    "This is the opening paragraph of an uploaded Word document. It has enough " +
      "prose to be treated as a real article body rather than boilerplate.",
    "A second paragraph with additional sentences so the content comfortably " +
      "clears any minimum-length thresholds a cleaner might enforce.",
  ];

  it("uses docProps/core.xml for title, author, and summary", async () => {
    const userId = await createUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: {
        title: "The Real Core.xml Title",
        creator: "Ada Lovelace",
        description: "A concise summary taken straight from the document properties.",
      },
    });
    const article = await upload(userId, docx, "some-file-name.docx");

    expect(article.title).toBe("The Real Core.xml Title");
    expect(article.author).toBe("Ada Lovelace");
    expect(article.excerpt).toBe("A concise summary taken straight from the document properties.");
    expect(article.siteName).toBe("Uploaded Document");
    expect(article.url).toBeNull();
  });

  it("skips Readability: stores the mammoth body verbatim as cleaned content", async () => {
    const userId = await createUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { title: "Skip Readability Doc" },
    });
    const article = await upload(userId, docx, "notes.docx");

    const stored = await readStored(article.id);
    // The full mammoth output is preserved (not run through Readability, which
    // could promote the first paragraph as a title or drop content).
    expect(stored.contentCleaned).toContain("opening paragraph of an uploaded Word document");
    expect(stored.contentCleaned).toContain("second paragraph");
  });

  it("falls back to the filename-derived title when core.xml has no title", async () => {
    const userId = await createUser();
    // core.xml present but with only an author — no dc:title.
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { creator: "Grace Hopper" },
    });
    const article = await upload(userId, docx, "My_Weekly-Report.docx");

    expect(article.title).toBe("My Weekly Report");
    expect(article.author).toBe("Grace Hopper");
  });

  it("prefers a caller-provided title over the core.xml title", async () => {
    const userId = await createUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { title: "Core.xml Title" },
    });
    const article = await upload(userId, docx, "notes.docx", "Caller Title");

    expect(article.title).toBe("Caller Title");
  });
});

describe("uploadFile (.pdf)", () => {
  const PDF_PAGE = textPage([
    "This is the opening paragraph of an uploaded PDF. It has enough prose to be",
    "treated as a real article body rather than boilerplate.",
  ]);

  it("uses the document info, skips Readability, and labels the source", async () => {
    const userId = await createUser();
    const pdf = buildPdf([PDF_PAGE], {
      info: { Title: "The Document Info Title", Author: "Ada Lovelace", Subject: "A summary." },
    });
    const article = await upload(userId, pdf, "some-file-name.pdf");

    expect(article.title).toBe("The Document Info Title");
    expect(article.author).toBe("Ada Lovelace");
    expect(article.excerpt).toBe("A summary.");
    expect(article.siteName).toBe("Uploaded PDF");
    const stored = await readStored(article.id);
    expect(stored.contentCleaned).toContain("opening paragraph of an uploaded PDF");
  });

  it("falls back to the filename-derived title when the PDF has none", async () => {
    const userId = await createUser();
    const article = await upload(userId, buildPdf([PDF_PAGE]), "My_Weekly-Report.pdf");

    expect(article.title).toBe("My Weekly Report");
  });
});

describe("uploadFile with an idempotency key", () => {
  const file = (text: string) => Buffer.from(text).toString("base64");

  it("returns the first upload's article, collections included, for a repeat", async () => {
    const userId = await createUser();
    const { subscription: collection } = await createCollection(db, userId, "Reading");
    const params = {
      content: file("A note saved from the phone."),
      filename: "note.md",
      idempotencyKey: "share-0123abcd",
      collectionIds: [collection.id],
    };

    const first = await uploadFile(db, userId, params);
    // The retry's content differs, so returning the first article proves it wasn't converted.
    const retry = await uploadFile(db, userId, { ...params, content: file("Something else.") });

    expect(retry.article.id).toBe(first.article.id);
    expect(retry.article.contentCleaned).toContain("A note saved from the phone.");
    expect(retry.listItem).toMatchObject({
      entryId: first.article.id,
      subscriptionId: first.listItem.subscriptionId,
      entry: { title: first.listItem.entry.title, read: false, starred: false },
    });
    // Filed into the collection after the first response was built.
    expect(retry.listItem.subscriptionIds.toSorted()).toEqual(
      [first.listItem.subscriptionId, collection.id].toSorted()
    );
    const rows = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.ownerUserId, userId));
    expect(rows).toHaveLength(1);
  });

  it("scopes keys to the user", async () => {
    const params = { content: file("Shared text."), filename: "a.txt", idempotencyKey: "same-key" };
    const mine = await uploadFile(db, await createUser(), params);
    const theirs = await uploadFile(db, await createUser(), params);

    expect(theirs.article.id).not.toBe(mine.article.id);
  });
});

describe("uploadArticle (Markdown)", () => {
  it("uses frontmatter title/summary/author", async () => {
    const userId = await createUser();
    const md = [
      "---",
      "title: Frontmatter Title",
      "description: A concise frontmatter summary of the piece.",
      "author: Grace Hopper",
      "---",
      "",
      "# Body Heading",
      "",
      "Some markdown body content here that is long enough to be meaningful.",
    ].join("\n");

    const article = await uploadArticle(db, userId, { content: md, title: "" });
    expect(article.title).toBe("Frontmatter Title");
    expect(article.author).toBe("Grace Hopper");
    expect(article.excerpt).toBe("A concise frontmatter summary of the piece.");
    expect(article.url).toBeNull();
  });

  it("prefers the provided title over frontmatter", async () => {
    const userId = await createUser();
    const md = ["---", "title: Frontmatter Title", "---", "", "Body text here."].join("\n");
    const article = await uploadArticle(db, userId, { content: md, title: "Explicit Title" });
    expect(article.title).toBe("Explicit Title");
  });

  it("rewrites relative URLs against the dummy upload base (not Lion Reader)", async () => {
    const userId = await createUser();
    const md = [
      "# Uploaded Notes",
      "",
      "A paragraph with enough prose that the content is unambiguously an article.",
      "",
      "![A figure](img/fig.png)",
      "",
      "Go to [settings](/settings) or the [next note](notes/next.md).",
    ].join("\n");

    const article = await uploadArticle(db, userId, { content: md, title: "" });

    const stored = await readStored(article.id);
    // Readability is skipped for Markdown, so nothing downstream resolves these
    // — a root-relative link left as-is would point back into the Lion Reader
    // app, which is exactly what the deliberately-broken upload base prevents.
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/settings");
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/img/fig.png");
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/notes/next.md");
    expect(stored.contentCleaned).not.toContain('href="/settings"');
    expect(stored.contentCleaned).not.toContain('src="img/fig.png"');
  });

  it("prefers the provided author/excerpt over frontmatter", async () => {
    const userId = await createUser();
    const md = [
      "---",
      "title: Frontmatter Title",
      "description: A concise frontmatter summary of the piece.",
      "author: Grace Hopper",
      "---",
      "",
      "Some markdown body content here that is long enough to be meaningful.",
    ].join("\n");

    const article = await uploadArticle(db, userId, {
      content: md,
      title: "",
      author: "Ada Lovelace",
      excerpt: "An explicit summary override.",
    });
    expect(article.author).toBe("Ada Lovelace");
    expect(article.excerpt).toBe("An explicit summary override.");
  });

  it("returns the first article for a repeat with the same idempotency key", async () => {
    const userId = await createUser();
    const params = { content: "First body.", title: "Retried", idempotencyKey: "mcp-retry-1" };

    const first = await uploadArticle(db, userId, params);
    const retry = await uploadArticle(db, userId, { ...params, content: "Second body." });

    expect(retry.id).toBe(first.id);
    expect(retry.contentCleaned).toContain("First body.");
    const rows = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.ownerUserId, userId));
    expect(rows).toHaveLength(1);
  });
});
