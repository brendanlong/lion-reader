/**
 * The account export zip (#1785), read back with an independent zip reader.
 */

import JSZip from "jszip";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";
import { EXPORT_PAGE_SIZE, streamLibraryExport } from "../../src/server/services/library-export";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

async function readExport(userId: string): Promise<JSZip> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamLibraryExport(db, userId)) chunks.push(chunk);
  return JSZip.loadAsync(Buffer.concat(chunks));
}

async function readText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`${path} missing from export`);
  return file.async("string");
}

async function star(userId: string, entryId: string): Promise<void> {
  await db
    .update(userEntries)
    .set({ starred: true })
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
}

interface ExportedEntry {
  id: string;
  kind: string;
  url: string | null;
  starred: boolean;
  file: string;
}

describe("streamLibraryExport", () => {
  async function cleanup(): Promise<void> {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it("exports saved, uploaded, newsletter and starred entries, and nothing else", async () => {
    const userId = await createTestUser();
    const otherUserId = await createTestUser();

    const webFeedId = await createTestFeed({ url: "https://blog.example/feed.xml" });
    await createTestSubscription(userId, webFeedId);
    const plainEntryId = await createTestEntry(webFeedId, { userIds: [userId] });
    const starredEntryId = await createTestEntry(webFeedId, {
      url: "https://blog.example/starred",
      userIds: [userId],
    });
    await star(userId, starredEntryId);

    const savedFeedId = await getOrCreateSavedFeed(db, userId);
    const savedId = await createTestEntry(savedFeedId, {
      type: "saved",
      url: "https://news.example/article",
      title: "Saved <one>",
      contentCleaned: '<p onclick="evil()">saved body<script>alert(1)</script></p>',
      userIds: [userId],
    });
    const uploadId = await createTestEntry(savedFeedId, {
      type: "saved",
      url: null,
      contentCleaned: "<p>uploaded body</p>",
      userIds: [userId],
    });

    const emailFeedId = await createTestFeed({ type: "email", userId });
    await createTestSubscription(userId, emailFeedId);
    const newsletterId = await createTestEntry(emailFeedId, { type: "email", userIds: [userId] });
    const spamId = await createTestEntry(emailFeedId, {
      type: "email",
      isSpam: true,
      userIds: [userId],
    });

    const otherSavedFeedId = await getOrCreateSavedFeed(db, otherUserId);
    const otherUsersId = await createTestEntry(otherSavedFeedId, {
      type: "saved",
      url: "https://other.example/private",
      userIds: [otherUserId],
    });

    const zip = await readExport(userId);

    const exported: ExportedEntry[] = JSON.parse(await readText(zip, "entries.json"));
    expect(Object.fromEntries(exported.map((entry) => [entry.id, entry.kind]))).toEqual({
      [starredEntryId]: "feed",
      [savedId]: "saved",
      [uploadId]: "upload",
      [newsletterId]: "newsletter",
    });
    for (const excluded of [plainEntryId, spamId, otherUsersId]) {
      expect(zip.file(`articles/${excluded}.html`)).toBeNull();
    }

    const savedPage = await readText(zip, `articles/${savedId}.html`);
    expect(savedPage).toContain("saved body");
    expect(savedPage).toContain("Saved &lt;one&gt;");
    expect(savedPage).not.toContain("<script>");
    expect(savedPage).not.toContain("onclick");

    const index = await readText(zip, "index.html");
    for (const entry of exported) expect(index).toContain(`href="${entry.file}"`);

    const bookmarks = await readText(zip, "bookmarks.html");
    expect(bookmarks).toMatch(/^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
    expect(bookmarks).toContain('HREF="https://news.example/article"');
    expect(bookmarks).toContain('HREF="https://blog.example/starred"');
    expect(bookmarks).not.toContain("other.example");

    expect(await readText(zip, "subscriptions.opml")).toContain(
      'xmlUrl="https://blog.example/feed.xml"'
    );
  });

  it("never writes a non-http URL as a link", async () => {
    const userId = await createTestUser();
    const savedFeedId = await getOrCreateSavedFeed(db, userId);
    const id = await createTestEntry(savedFeedId, {
      type: "saved",
      url: "javascript:alert(1)",
      userIds: [userId],
    });

    const zip = await readExport(userId);

    expect(await readText(zip, `articles/${id}.html`)).not.toContain("javascript:");
    expect(await readText(zip, "bookmarks.html")).not.toContain("javascript:");
  });

  it("pages through libraries larger than one query page", async () => {
    const userId = await createTestUser();
    const savedFeedId = await getOrCreateSavedFeed(db, userId);
    const ids: string[] = [];
    for (let i = 0; i < EXPORT_PAGE_SIZE + 1; i++) {
      ids.push(
        await createTestEntry(savedFeedId, {
          type: "saved",
          url: `https://example.com/${i}`,
          userIds: [userId],
        })
      );
    }

    const zip = await readExport(userId);

    const exported: ExportedEntry[] = JSON.parse(await readText(zip, "entries.json"));
    expect(exported.map((entry) => entry.id).sort()).toEqual([...ids].sort());
  });
});
