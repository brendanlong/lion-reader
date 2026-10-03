/**
 * The account export zip (#1785), read back with an independent zip reader.
 */

import JSZip from "jszip";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";
import { createSession } from "../../src/server/auth/session";
import { RATE_LIMIT_CONFIGS } from "../../src/server/rate-limit";
import { GET } from "../../src/app/api/v1/export/route";
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
      starredBy: [userId],
    });

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

    await createTestSubscription(otherUserId, webFeedId);
    const starredByOtherId = await createTestEntry(webFeedId, {
      userIds: [userId, otherUserId],
      starredBy: [otherUserId],
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
    for (const excluded of [plainEntryId, spamId, starredByOtherId, otherUsersId]) {
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

  it("exports the body the entry view shows, which is full content only when the subscription asks for it", async () => {
    const userId = await createTestUser();
    const fullContent = {
      contentCleaned: "<p>feed excerpt</p>",
      fullContentCleaned: "<p>whole article</p>",
      fullContentFetchedAt: new Date(),
      starredBy: [userId],
      userIds: [userId],
    };

    const fullFeedId = await createTestFeed();
    await createTestSubscription(userId, fullFeedId, { fetchFullContent: true });
    const fullId = await createTestEntry(fullFeedId, fullContent);

    const excerptFeedId = await createTestFeed();
    await createTestSubscription(userId, excerptFeedId, { fetchFullContent: false });
    const excerptId = await createTestEntry(excerptFeedId, fullContent);

    const failedFeedId = await createTestFeed();
    await createTestSubscription(userId, failedFeedId, { fetchFullContent: true });
    const failedId = await createTestEntry(failedFeedId, {
      ...fullContent,
      fullContentError: "HTTP 500",
    });

    const zip = await readExport(userId);

    expect(await readText(zip, `articles/${fullId}.html`)).toContain("whole article");
    for (const id of [excerptId, failedId]) {
      const page = await readText(zip, `articles/${id}.html`);
      expect(page).toContain("feed excerpt");
      expect(page).not.toContain("whole article");
    }
  });
});

describe("GET /api/v1/export", () => {
  async function exportRequest(userId?: string): Promise<Response> {
    const headers = new Headers();
    if (userId) {
      const { token } = await createSession(db, { userId });
      headers.set("cookie", `session=${token}`);
    }
    return GET(new Request("http://localhost/api/v1/export", { headers }));
  }

  afterAll(async () => {
    await db.delete(users);
  });

  it("streams a zip download that no cache keeps", async () => {
    const response = await exportRequest(await createTestUser());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename=".+\.zip"$/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    expect(zip.file("index.html")).not.toBeNull();
  });

  it("refuses requests without a session, or from an unconfirmed account", async () => {
    expect((await exportRequest()).status).toBe(401);
    const unconfirmedId = await createTestUser({ tosAgreedAt: null, privacyPolicyAgreedAt: null });
    expect((await exportRequest(unconfirmedId)).status).toBe(403);
  });

  it("rate-limits repeated exports per user", async () => {
    const userId = await createTestUser();
    for (let i = 0; i < RATE_LIMIT_CONFIGS.libraryExport.capacity; i++) {
      const response = await exportRequest(userId);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
    expect((await exportRequest(userId)).status).toBe(429);
  });
});
