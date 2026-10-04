/**
 * Wallabag tags are collections (#1822): the tag routes and the entry routes'
 * `tags` (filter, add, remove, report) all read and write collection
 * membership.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { collectionEntries, entries, subscriptions, users } from "../../src/server/db/schema";
import { createTokens } from "../../src/server/oauth/service";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { GET as listTags } from "../../src/app/api/wallabag/api/tags/route";
import { DELETE as deleteTag } from "../../src/app/api/wallabag/api/tags/[tag]/route";
import { GET as listEntries } from "../../src/app/api/wallabag/api/entries/route";
import { PATCH as patchEntry } from "../../src/app/api/wallabag/api/entries/[entry]/route";
import {
  GET as listEntryTags,
  POST as addEntryTags,
} from "../../src/app/api/wallabag/api/entries/[entry]/tags/route";
import { DELETE as removeEntryTag } from "../../src/app/api/wallabag/api/entries/[entry]/tags/[tag]/route";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

interface WallabagTagJson {
  id: number;
  label: string;
  slug: string;
}

interface TestUser {
  id: string;
  token: string;
  savedFeedId: string;
}

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createUser(): Promise<TestUser> {
  const id = await createTestUser({ emailPrefix: "wallabag-tags" });
  createdUserIds.push(id);
  const { accessToken } = await createTokens({
    clientId: "wallabag",
    userId: id,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  const savedFeedId = await createTestFeed({ type: "saved", userId: id, url: null });
  return { id, token: accessToken, savedFeedId };
}

/** A saved article; returns its UUID and Wallabag id. */
async function createSaved(user: TestUser): Promise<{ id: string; wallabagId: number }> {
  const id = await createTestEntry(user.savedFeedId, { type: "saved", userIds: [user.id] });
  const [row] = await db
    .select({ serial: entries.greaderItemId })
    .from(entries)
    .where(eq(entries.id, id));
  return { id, wallabagId: Number(row.serial) };
}

async function createCollectionTag(
  user: TestUser,
  name: string,
  entryIds: string[] = []
): Promise<{ subscriptionId: string; tagId: number }> {
  const { subscription } = await createCollection(db, user.id, name);
  if (entryIds.length > 0) {
    await addEntriesToCollection(db, user.id, subscription.id, entryIds);
  }
  const [row] = await db
    .select({ serial: subscriptions.greaderStreamId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscription.id));
  return { subscriptionId: subscription.id, tagId: Number(row.serial) };
}

function request(user: TestUser, path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.com/api/wallabag/api/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${user.token}`, ...init.headers },
  });
}

function formRequest(user: TestUser, path: string, method: string, form: string): Request {
  return request(user, path, {
    method,
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function listedIds(user: TestUser, query: string): Promise<number[]> {
  const res = await listEntries(request(user, `entries?detail=metadata&${query}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { _embedded: { items: Array<{ id: number }> } };
  return body._embedded.items.map((item) => item.id).sort();
}

async function memberIds(subscriptionId: string): Promise<string[]> {
  const rows = await db
    .select({ entryId: collectionEntries.entryId })
    .from(collectionEntries)
    .where(eq(collectionEntries.subscriptionId, subscriptionId));
  return rows.map((row) => row.entryId);
}

describe("GET /api/tags", () => {
  it("lists the user's own collections with their stream serials as ids", async () => {
    const user = await createUser();
    const other = await createUser();
    const reading = await createCollectionTag(user, "To Read");
    await createCollectionTag(other, "Someone else's");

    const res = await listTags(request(user, "tags"));

    expect(await res.json()).toEqual([{ id: reading.tagId, label: "To Read", slug: "to-read" }]);
  });
});

describe("entry tags", () => {
  it("adds to an existing collection case-insensitively and creates missing ones", async () => {
    const user = await createUser();
    const article = await createSaved(user);
    const reading = await createCollectionTag(user, "Reading");

    const res = await addEntryTags(
      formRequest(user, `entries/${article.wallabagId}/tags`, "POST", "tags=reading,New%20One"),
      params({ entry: String(article.wallabagId) })
    );

    expect(res.status).toBe(200);
    const labels = ((await res.json()) as { tags: WallabagTagJson[] }).tags.map((t) => t.label);
    expect(labels).toEqual(["New One", "Reading"]);
    expect(await memberIds(reading.subscriptionId)).toEqual([article.id]);
    const tagsRes = await listEntryTags(
      request(user, `entries/${article.wallabagId}/tags`),
      params({ entry: String(article.wallabagId) })
    );
    expect(((await tagsRes.json()) as WallabagTagJson[]).map((t) => t.label)).toEqual([
      "New One",
      "Reading",
    ]);
  });

  it("adds tags through PATCH", async () => {
    const user = await createUser();
    const article = await createSaved(user);
    const reading = await createCollectionTag(user, "Reading");

    const res = await patchEntry(
      formRequest(user, `entries/${article.wallabagId}`, "PATCH", "tags=Reading"),
      params({ entry: String(article.wallabagId) })
    );

    expect(res.status).toBe(200);
    expect(await memberIds(reading.subscriptionId)).toEqual([article.id]);
  });

  it("removes a tag by id, and won't resolve another user's tag", async () => {
    const user = await createUser();
    const other = await createUser();
    const article = await createSaved(user);
    const reading = await createCollectionTag(user, "Reading", [article.id]);
    const foreign = await createCollectionTag(other, "Theirs");
    const entry = String(article.wallabagId);

    const foreignRes = await removeEntryTag(
      request(user, `entries/${entry}/tags/${foreign.tagId}`, { method: "DELETE" }),
      params({ entry, tag: String(foreign.tagId) })
    );
    expect(foreignRes.status).toBe(404);

    const res = await removeEntryTag(
      request(user, `entries/${entry}/tags/${reading.tagId}.json`, { method: "DELETE" }),
      params({ entry, tag: `${reading.tagId}.json` })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tags: WallabagTagJson[] }).tags).toEqual([]);
    expect(await memberIds(reading.subscriptionId)).toEqual([]);
  });
});

describe("GET /api/entries?tags=", () => {
  it("matches entries carrying every listed tag", async () => {
    const user = await createUser();
    const both = await createSaved(user);
    const onlyA = await createSaved(user);
    await createSaved(user);
    await createCollectionTag(user, "A", [both.id, onlyA.id]);
    await createCollectionTag(user, "B", [both.id]);

    expect(await listedIds(user, "tags=a")).toEqual([both.wallabagId, onlyA.wallabagId].sort());
    expect(await listedIds(user, "tags=A,B")).toEqual([both.wallabagId]);
    expect(await listedIds(user, "tags=A,missing")).toEqual([]);
  });

  it("reports each entry's tags in the list", async () => {
    const user = await createUser();
    const article = await createSaved(user);
    await createCollectionTag(user, "Reading", [article.id]);

    const res = await listEntries(request(user, "entries?detail=metadata"));
    const body = (await res.json()) as {
      _embedded: { items: Array<{ id: number; tags: WallabagTagJson[] }> };
    };

    expect(body._embedded.items.map((item) => item.tags.map((t) => t.label))).toEqual([
      ["Reading"],
    ]);
  });
});

describe("DELETE /api/tags/{tag}", () => {
  async function isActive(subscriptionId: string): Promise<boolean> {
    const [row] = await db
      .select({ unsubscribedAt: subscriptions.unsubscribedAt })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, subscriptionId)));
    return row.unsubscribedAt === null;
  }

  it("deletes a collection that held only saved articles", async () => {
    const user = await createUser();
    const article = await createSaved(user);
    const reading = await createCollectionTag(user, "Reading", [article.id]);

    const res = await deleteTag(
      request(user, `tags/${reading.tagId}`, { method: "DELETE" }),
      params({ tag: String(reading.tagId) })
    );

    expect(await res.json()).toEqual({ id: reading.tagId, label: "Reading", slug: "reading" });
    expect(await isActive(reading.subscriptionId)).toBe(false);
  });

  it("keeps a collection's feed articles, which Wallabag clients never see", async () => {
    const user = await createUser();
    const article = await createSaved(user);
    const feedId = await createTestFeed();
    await createTestSubscription(user.id, feedId);
    const feedEntry = await createTestEntry(feedId, { userIds: [user.id] });
    const mixed = await createCollectionTag(user, "Mixed", [article.id, feedEntry]);

    await deleteTag(
      request(user, `tags/${mixed.tagId}`, { method: "DELETE" }),
      params({ tag: String(mixed.tagId) })
    );

    expect(await isActive(mixed.subscriptionId)).toBe(true);
    expect(await memberIds(mixed.subscriptionId)).toEqual([feedEntry]);
  });

  it("returns 404 for another user's tag", async () => {
    const user = await createUser();
    const other = await createUser();
    const foreign = await createCollectionTag(other, "Theirs");

    const res = await deleteTag(
      request(user, `tags/${foreign.tagId}`, { method: "DELETE" }),
      params({ tag: String(foreign.tagId) })
    );

    expect(res.status).toBe(404);
    expect(await isActive(foreign.subscriptionId)).toBe(true);
  });
});
