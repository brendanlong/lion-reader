/**
 * Integration tests for the unified upload → save pipeline.
 *
 * File uploads (`createSavedFromUpload`) and Markdown uploads (`uploadArticle`)
 * run their content through the same `buildArticleFields` pipeline as a URL save,
 * so this covers the upload-specific behavior that pipeline adds: title/author
 * precedence, the filename fallback, relative-URL handling against the dummy
 * upload base, and Open Graph metadata extraction.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createSavedFromUpload, uploadArticle } from "../../src/server/services/saved";
import { convertUploadedFile } from "../../src/server/file/process-upload";
import { buildMinimalDocx } from "../utils/docx";

const createdUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `upload-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
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

describe("createSavedFromUpload (HTML)", () => {
  it("stores a null URL and an uploaded: guid", async () => {
    const userId = await createTestUser();
    const converted = await convertUploadedFile(
      `<html><head><title>Doc Title</title></head><body>${ARTICLE_BODY}</body></html>`,
      "notes.html"
    );
    const article = await createSavedFromUpload(db, userId, { converted });

    expect(article.url).toBeNull();
    const stored = await readStored(article.id);
    expect(stored.url).toBeNull();
    expect(stored.guid.startsWith("uploaded:")).toBe(true);
  });

  it("prefers a provided title over the document title", async () => {
    const userId = await createTestUser();
    const converted = await convertUploadedFile(
      `<html><head><title>Document Title</title></head><body>${ARTICLE_BODY}</body></html>`,
      "notes.html"
    );
    const article = await createSavedFromUpload(db, userId, { converted, title: "Caller Title" });
    expect(article.title).toBe("Caller Title");
  });

  it("falls back to the filename-derived title when content has none", async () => {
    const userId = await createTestUser();
    // No <title> and no heading Readability would pick up as a title.
    const converted = await convertUploadedFile(
      `<html><body>${ARTICLE_BODY}</body></html>`,
      "My_Great-Notes.html"
    );
    const article = await createSavedFromUpload(db, userId, { converted });
    expect(article.title).toBe("My Great Notes");
  });

  it("rewrites relative URLs against the dummy upload base (not Lion Reader)", async () => {
    const userId = await createTestUser();
    const converted = await convertUploadedFile(
      `<html><body>${ARTICLE_BODY}</body></html>`,
      "notes.html"
    );
    const article = await createSavedFromUpload(db, userId, { converted });

    const stored = await readStored(article.id);
    expect(stored.contentCleaned).toBeTruthy();
    // Relative link/image resolved against uploaded.invalid, so nothing points
    // back into the app.
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/relative/link");
    expect(stored.contentCleaned).toContain("https://uploaded.invalid/images/pic.png");
    expect(stored.contentCleaned).not.toContain('href="/relative/link"');
  });

  it("keeps the raw original when Readability fails (contentCleaned null, still readable)", async () => {
    const userId = await createTestUser();
    // Too short for Readability to extract → cleaned is null. Matches how a URL
    // save behaves on a page Readability can't parse: store the original, serve
    // `cleaned ?? original` on read.
    const converted = await convertUploadedFile(
      "<html><body><p>Too short.</p></body></html>",
      "tiny.html"
    );
    const article = await createSavedFromUpload(db, userId, { converted });

    expect(article.contentCleaned).toBeNull();
    const stored = await readStored(article.id);
    expect(stored.contentCleaned).toBeNull();
    // The raw body survives as the original, so the read path still renders it.
    expect(stored.contentOriginal).toContain("Too short.");
  });

  it("extracts Open Graph metadata (author, image) from uploaded HTML", async () => {
    const userId = await createTestUser();
    const html =
      "<html><head>" +
      '<meta property="og:image" content="https://cdn.example.com/cover.jpg">' +
      '<meta name="author" content="Ada Lovelace">' +
      "<title>OG Doc</title></head>" +
      `<body>${ARTICLE_BODY}</body></html>`;
    const converted = await convertUploadedFile(html, "og.html");
    const article = await createSavedFromUpload(db, userId, { converted });

    expect(article.author).toBe("Ada Lovelace");
    const stored = await readStored(article.id);
    expect(stored.imageUrl).toBe("https://cdn.example.com/cover.jpg");
  });
});

describe("createSavedFromUpload (.docx)", () => {
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
    const userId = await createTestUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: {
        title: "The Real Core.xml Title",
        creator: "Ada Lovelace",
        description: "A concise summary taken straight from the document properties.",
      },
    });
    const converted = await convertUploadedFile(docx, "some-file-name.docx");
    const article = await createSavedFromUpload(db, userId, { converted });

    expect(article.title).toBe("The Real Core.xml Title");
    expect(article.author).toBe("Ada Lovelace");
    expect(article.excerpt).toBe("A concise summary taken straight from the document properties.");
    expect(article.siteName).toBe("Uploaded Document");
    expect(article.url).toBeNull();
  });

  it("skips Readability: stores the mammoth body verbatim as cleaned content", async () => {
    const userId = await createTestUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { title: "Skip Readability Doc" },
    });
    const converted = await convertUploadedFile(docx, "notes.docx");
    const article = await createSavedFromUpload(db, userId, { converted });

    const stored = await readStored(article.id);
    // The full mammoth output is preserved (not run through Readability, which
    // could promote the first paragraph as a title or drop content).
    expect(stored.contentCleaned).toContain("opening paragraph of an uploaded Word document");
    expect(stored.contentCleaned).toContain("second paragraph");
  });

  it("falls back to the filename-derived title when core.xml has no title", async () => {
    const userId = await createTestUser();
    // core.xml present but with only an author — no dc:title.
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { creator: "Grace Hopper" },
    });
    const converted = await convertUploadedFile(docx, "My_Weekly-Report.docx");
    const article = await createSavedFromUpload(db, userId, { converted });

    expect(article.title).toBe("My Weekly Report");
    expect(article.author).toBe("Grace Hopper");
  });

  it("prefers a caller-provided title over the core.xml title", async () => {
    const userId = await createTestUser();
    const docx = buildMinimalDocx({
      paragraphs: DOCX_PARAGRAPHS,
      core: { title: "Core.xml Title" },
    });
    const converted = await convertUploadedFile(docx, "notes.docx");
    const article = await createSavedFromUpload(db, userId, {
      converted,
      title: "Caller Title",
    });

    expect(article.title).toBe("Caller Title");
  });
});

describe("uploadArticle (Markdown)", () => {
  it("uses frontmatter title/summary/author", async () => {
    const userId = await createTestUser();
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
    const userId = await createTestUser();
    const md = ["---", "title: Frontmatter Title", "---", "", "Body text here."].join("\n");
    const article = await uploadArticle(db, userId, { content: md, title: "Explicit Title" });
    expect(article.title).toBe("Explicit Title");
  });
});
