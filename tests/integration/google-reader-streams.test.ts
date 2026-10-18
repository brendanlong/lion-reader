/**
 * stream/contents, stream/items/ids and mark-all-as-read translate a stream
 * request into entry filters the same way (`google-reader/stream-filters.ts`).
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userEntries, users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { GET as streamContents } from "../../src/app/api/greader.php/reader/api/0/stream/contents/[[...streamId]]/route";
import { GET as streamItemIds } from "../../src/app/api/greader.php/reader/api/0/stream/items/ids/route";
import { POST as markAllAsRead } from "../../src/app/api/greader.php/reader/api/0/mark-all-as-read/route";
import {
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

const API = "https://example.com/api/greader.php/reader/api/0";
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createReader(): Promise<{ userId: string; token: string }> {
  const userId = await createTestUser({ emailPrefix: "greader-streams" });
  createdUserIds.push(userId);
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  return { userId, token };
}

function get(token: string, path: string): Request {
  return new Request(`${API}/${path}`, {
    headers: { authorization: `GoogleLogin auth=${token}` },
  });
}

function markAll(token: string, form: Record<string, string>): Promise<Response> {
  return markAllAsRead(
    new Request(`${API}/mark-all-as-read`, {
      method: "POST",
      headers: {
        authorization: `GoogleLogin auth=${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    })
  );
}

function contents(token: string, streamId: string, query = ""): Promise<Response> {
  return streamContents(get(token, `stream/contents/${streamId}${query}`), {
    params: Promise.resolve({ streamId: streamId.split("/") }),
  });
}

async function unreadEntryIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.read, false)));
  return rows.map((r) => r.entryId).sort();
}

/** A subscription with one unread entry, tagged `tagName` if given. */
async function subscribedEntry(userId: string, tagName?: string): Promise<string> {
  const feedId = await createTestFeed();
  const subscriptionId = await createTestSubscription(userId, feedId);
  if (tagName) await createTestTag(userId, { name: tagName, subscriptionIds: [subscriptionId] });
  return createTestEntry(feedId, { userIds: [userId] });
}

describe("Google Reader stream filters", () => {
  it("narrows stream/contents with an include target", async () => {
    const { userId, token } = await createReader();
    const feedId = await createTestFeed();
    await createTestSubscription(userId, feedId);
    const starred = await createTestEntry(feedId, { userIds: [userId], starredBy: [userId] });
    await createTestEntry(feedId, { userIds: [userId] });

    const res = await contents(
      token,
      "user/-/state/com.google/reading-list",
      "?it=user/-/state/com.google/starred"
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { title: string }[] };
    expect(body.items.map((item) => item.title)).toEqual([`Entry ${starred}`]);
  });

  it.each([
    { stream: "feed/999999999999", what: "feed" },
    { stream: "user/-/label/Missing", what: "label" },
  ])(
    "answers an unknown $what with 404 on reads and OK on mark-all-as-read",
    async ({ stream }) => {
      const { token } = await createReader();

      expect((await contents(token, stream)).status).toBe(404);
      expect(
        (await streamItemIds(get(token, `stream/items/ids?s=${encodeURIComponent(stream)}`))).status
      ).toBe(404);
      const marked = await markAll(token, { s: stream });
      expect(marked.status).toBe(200);
      expect(await marked.text()).toBe("OK");
    }
  );

  it("marks only a label's entries read", async () => {
    const { userId, token } = await createReader();
    await subscribedEntry(userId, "News");
    const untagged = await subscribedEntry(userId);

    const res = await markAll(token, { s: "user/-/label/News" });

    expect(res.status).toBe(200);
    expect(await unreadEntryIds(userId)).toEqual([untagged]);
  });

  it("accepts the read stream on mark-all-as-read, changing nothing", async () => {
    const { userId, token } = await createReader();
    const entry = await subscribedEntry(userId);

    const res = await markAll(token, { s: "user/-/state/com.google/read" });

    expect(res.status).toBe(200);
    expect(await unreadEntryIds(userId)).toEqual([entry]);
  });

  it("ignores an unparseable mark-all-as-read timestamp", async () => {
    const { userId, token } = await createReader();
    await subscribedEntry(userId);

    const res = await markAll(token, { s: "user/-/state/com.google/reading-list", ts: "soon" });

    expect(res.status).toBe(200);
    expect(await unreadEntryIds(userId)).toEqual([]);
  });
});
