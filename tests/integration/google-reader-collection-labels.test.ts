/**
 * Google Reader exposes collections as item labels (#1821): listed in
 * tag/list, on items' categories, as label streams and unread-count lines, and
 * filled through edit-tag.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  entries,
  subscriptionEntries,
  subscriptions,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { COLLECTION_NAME_MAX_LENGTH } from "../../src/lib/collections";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { GET as unreadCount } from "../../src/app/api/greader.php/reader/api/0/unread-count/route";
import { GET as streamContents } from "../../src/app/api/greader.php/reader/api/0/stream/contents/[[...streamId]]/route";
import { POST as editTag } from "../../src/app/api/greader.php/reader/api/0/edit-tag/route";
import { POST as renameTag } from "../../src/app/api/greader.php/reader/api/0/rename-tag/route";
import { POST as markAllAsRead } from "../../src/app/api/greader.php/reader/api/0/mark-all-as-read/route";
import { POST as disableTag } from "../../src/app/api/greader.php/reader/api/0/disable-tag/route";
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

async function readerWithEntry() {
  const userId = await createTestUser({ emailPrefix: "greader-collections" });
  createdUserIds.push(userId);
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  const feedId = await createTestFeed();
  await createTestSubscription(userId, feedId);
  const entryId = await createTestEntry(feedId, { userIds: [userId] });
  const [{ itemId }] = await db
    .select({ itemId: entries.greaderItemId })
    .from(entries)
    .where(eq(entries.id, entryId));
  return { userId, token, feedId, entryId, itemId: itemId.toString() };
}

function get(path: string, token: string): Request {
  return new Request(`${API}/${path}`, {
    headers: { authorization: `GoogleLogin auth=${token}` },
  });
}

function post(path: string, token: string, form: Array<[string, string]>): Request {
  return new Request(`${API}/${path}`, {
    method: "POST",
    headers: {
      authorization: `GoogleLogin auth=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
}

async function collectionMembers(subscriptionId: string): Promise<string[]> {
  const rows = await db
    .select({ entryId: subscriptionEntries.entryId })
    .from(subscriptionEntries)
    .where(eq(subscriptionEntries.subscriptionId, subscriptionId));
  return rows.map((row) => row.entryId);
}

async function activeCollectionNames(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: subscriptions.customTitle })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.type, "collection"),
        isNull(subscriptions.unsubscribedAt)
      )
    );
  return rows.map((row) => row.name ?? "");
}

async function labelStream(token: string, name: string) {
  const streamId = `user/-/label/${name}`;
  const res = await streamContents(get(`stream/contents/${streamId}`, token), {
    params: Promise.resolve({ streamId: streamId.split("/") }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

describe("Google Reader collection labels", () => {
  it("serves a collection as a label stream whose items carry the label", async () => {
    const { userId, token, entryId } = await readerWithEntry();
    const { subscription } = await createCollection(db, userId, "Papers");
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);

    const { status, body } = await labelStream(token, "papers");

    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].categories).toContain("user/-/label/Papers");
  });

  it("marks a collection label's articles read, and only those", async () => {
    const { userId, token, entryId, feedId } = await readerWithEntry();
    const otherId = await createTestEntry(feedId, { userIds: [userId] });
    const { subscription } = await createCollection(db, userId, "Papers");
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);

    await markAllAsRead(post("mark-all-as-read", token, [["s", "user/-/label/Papers"]]));

    const states = await db
      .select({ entryId: userEntries.entryId, read: userEntries.read })
      .from(userEntries)
      .where(eq(userEntries.userId, userId));
    expect(new Map(states.map((row) => [row.entryId, row.read]))).toEqual(
      new Map([
        [entryId, true],
        [otherId, false],
      ])
    );
  });

  it("rejects an over-long new label before changing anything", async () => {
    const { userId, token, itemId, entryId } = await readerWithEntry();

    const res = await editTag(
      post("edit-tag", token, [
        ["i", itemId],
        ["a", "user/-/state/com.google/read"],
        ["a", `user/-/label/${"x".repeat(COLLECTION_NAME_MAX_LENGTH + 1)}`],
      ])
    );

    expect(res.status).toBe(400);
    const [{ read }] = await db
      .select({ read: userEntries.read })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
    expect(read).toBe(false);
    expect(await activeCollectionNames(userId)).toEqual([]);
  });

  it("reports a collection's unread count under its label, and its tag's including it", async () => {
    const { userId, token, entryId } = await readerWithEntry();
    const { subscription } = await createCollection(db, userId, "Papers");
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);
    await createTestTag(userId, { name: "Research", subscriptionIds: [subscription.id] });

    const { unreadcounts } = await (await unreadCount(get("unread-count", token))).json();
    const countById = new Map(
      unreadcounts.map((c: { id: string; count: number }) => [c.id, c.count])
    );

    expect(countById.get("user/-/label/Papers")).toBe(1);
    expect(countById.get("user/-/label/Research")).toBe(1);
    // One article, reached through its feed and the collection.
    expect(countById.get("user/-/state/com.google/reading-list")).toBe(1);
    const [{ publishedAt }] = await db
      .select({ publishedAt: entries.publishedAt })
      .from(entries)
      .where(eq(entries.id, entryId));
    const research = unreadcounts.find((c: { id: string }) => c.id === "user/-/label/Research");
    expect(research.newestItemTimestampUsec).toBe((publishedAt!.getTime() * 1000).toString());
    // Collections have no feed line; the source feed keeps its own.
    expect(
      unreadcounts
        .filter((c: { id: string }) => c.id.startsWith("feed/"))
        .map((c: { id: string }) => c.id)
    ).toHaveLength(1);
  });

  it("files items into a collection with edit-tag, creating it if needed, and takes them out", async () => {
    const { userId, token, itemId, entryId } = await readerWithEntry();

    expect(
      (
        await editTag(
          post("edit-tag", token, [
            ["i", itemId],
            ["a", "user/-/label/Later"],
          ])
        )
      ).status
    ).toBe(200);
    const [{ id: laterId }] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.customTitle, "Later")));
    expect(await collectionMembers(laterId)).toEqual([entryId]);

    await editTag(
      post("edit-tag", token, [
        ["i", itemId],
        ["r", "user/-/label/later"],
      ])
    );
    expect(await collectionMembers(laterId)).toEqual([]);
  });

  it("ignores edit-tag labels naming a tag, which holds feeds, not articles", async () => {
    const { userId, token, itemId } = await readerWithEntry();
    await createTestTag(userId, { name: "News" });

    const res = await editTag(
      post("edit-tag", token, [
        ["i", itemId],
        ["a", "user/-/label/news"],
      ])
    );

    expect(res.status).toBe(200);
    expect(await activeCollectionNames(userId)).toEqual([]);
  });

  it("renames and deletes a collection through its label, keeping its articles", async () => {
    const { userId, token, entryId } = await readerWithEntry();
    const { subscription } = await createCollection(db, userId, "Papers");
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);

    const renamed = await renameTag(
      post("rename-tag", token, [
        ["s", "user/-/label/Papers"],
        ["dest", "user/-/label/Reading"],
      ])
    );
    expect(renamed.status).toBe(200);
    expect(await activeCollectionNames(userId)).toEqual(["Reading"]);

    await disableTag(post("disable-tag", token, [["s", "user/-/label/Reading"]]));
    expect(await activeCollectionNames(userId)).toEqual([]);
    const { body } = await labelStream(token, "Reading");
    expect(body).toBeNull();
    const reading = await streamContents(get("stream/contents", token), {
      params: Promise.resolve({}),
    });
    expect((await reading.json()).items).toHaveLength(1);
  });
});
