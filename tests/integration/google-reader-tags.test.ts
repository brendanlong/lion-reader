/**
 * Google Reader label and subscription edits go through the same services as
 * the app (#1935): label names match tags ignoring case, like tag uniqueness,
 * and share the tag-name limits, and edits notify other clients.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../src/server/db";
import { subscriptions, subscriptionTags, tags, users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { TAG_NAME_MAX_LENGTH } from "../../src/server/services/tags";
import { POST as editSubscription } from "../../src/app/api/greader.php/reader/api/0/subscription/edit/route";
import { POST as renameTag } from "../../src/app/api/greader.php/reader/api/0/rename-tag/route";
import { expectNoMessage, waitForMessage } from "../utils/pubsub";
import { createTestFeed, createTestSubscription, createTestTag, createTestUser } from "./helpers";

const createdUserIds: string[] = [];
let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL must be set for integration tests");
  subscriber = new Redis(redisUrl);
});

afterAll(async () => {
  await subscriber.quit();
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createReader(): Promise<{ userId: string; token: string }> {
  const userId = await createTestUser({ emailPrefix: "greader-tags" });
  createdUserIds.push(userId);
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  return { userId, token };
}

function formPost(path: string, token: string, form: Record<string, string>): Request {
  return new Request(`https://example.com/api/greader.php/reader/api/0/${path}`, {
    method: "POST",
    headers: {
      authorization: `GoogleLogin auth=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
}

const SUBSCRIPTION_UPDATED_AT = new Date("2024-01-01T00:00:00Z");

async function createSubscriptionStream(
  userId: string
): Promise<{ subscriptionId: string; stream: string }> {
  const subscriptionId = await createTestSubscription(userId, await createTestFeed(), {
    updatedAt: SUBSCRIPTION_UPDATED_AT,
  });
  const [{ streamId }] = await db
    .select({ streamId: subscriptions.greaderStreamId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return { subscriptionId, stream: `feed/${streamId}` };
}

async function subscriptionUpdatedAt(subscriptionId: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: subscriptions.updatedAt })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row.updatedAt;
}

describe("Google Reader subscription/edit", () => {
  it.each<{ edit: string; form: Record<string, string>; expected: Record<string, unknown> }>([
    {
      edit: "a rename",
      form: { t: "Renamed" },
      expected: { customTitle: "Renamed", tags: [{ name: "Tech" }] },
    },
    {
      edit: "an added label",
      form: { a: "user/-/label/News" },
      expected: { tags: expect.arrayContaining([{ name: "News" }, { name: "Tech" }]) },
    },
    { edit: "a removed label", form: { r: "user/-/label/Tech" }, expected: { tags: [] } },
  ])("publishes $edit and moves the sync cursor", async ({ form, expected }) => {
    const { userId, token } = await createReader();
    const { subscriptionId, stream } = await createSubscriptionStream(userId);
    await createTestTag(userId, { name: "News" });
    const techId = await createTestTag(userId, { name: "Tech" });
    await db.insert(subscriptionTags).values({ subscriptionId, tagId: techId });
    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const updated = waitForMessage(subscriber, channel);

    const res = await editSubscription(
      formPost("subscription/edit", token, { ac: "edit", s: stream, ...form })
    );

    expect(res.status).toBe(200);
    const event = JSON.parse(await updated);
    expect({
      ...event,
      tags: event.tags.map((t: { name: string }) => ({ name: t.name })),
    }).toMatchObject({ type: "subscription_updated", subscriptionId, ...expected });
    expect(await subscriptionUpdatedAt(subscriptionId)).not.toEqual(SUBSCRIPTION_UPDATED_AT);
  });

  // #1160: re-asserting what the subscription already has is not a change.
  it("publishes nothing and keeps the sync cursor for an edit that changes nothing", async () => {
    const { userId, token } = await createReader();
    const { subscriptionId, stream } = await createSubscriptionStream(userId);
    const newsId = await createTestTag(userId, { name: "News" });
    await db.insert(subscriptionTags).values({ subscriptionId, tagId: newsId });
    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    await expectNoMessage(subscriber, channel, async () => {
      const res = await editSubscription(
        formPost("subscription/edit", token, { ac: "edit", s: stream, a: "user/-/label/news" })
      );
      expect(res.status).toBe(200);
    });

    expect(await subscriptionUpdatedAt(subscriptionId)).toEqual(SUBSCRIPTION_UPDATED_AT);
  });
});

describe("Google Reader labels", () => {
  it("adds a label to the existing tag whose name differs only in case", async () => {
    const { userId, token } = await createReader();
    const newsId = await createTestTag(userId, { name: "News" });
    const subscriptionId = await createTestSubscription(userId, await createTestFeed());
    const [{ streamId }] = await db
      .select({ streamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));

    const res = await editSubscription(
      formPost("subscription/edit", token, {
        ac: "edit",
        s: `feed/${streamId}`,
        a: "user/-/label/news",
      })
    );

    expect(res.status).toBe(200);
    const attached = await db
      .select({ tagId: subscriptionTags.tagId })
      .from(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId));
    expect(attached).toEqual([{ tagId: newsId }]);
    const liveTags = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
    expect(liveTags).toHaveLength(1);
  });

  it("refuses to rename a label onto another tag's name, ignoring case", async () => {
    const { userId, token } = await createReader();
    await createTestTag(userId, { name: "Tech" });
    await createTestTag(userId, { name: "News" });

    const res = await renameTag(
      formPost("rename-tag", token, { s: "user/-/label/Tech", dest: "user/-/label/news" })
    );

    expect(res.status).toBe(409);
  });

  it.each([
    {
      route: "subscription/edit",
      send: (token: string, stream: string, name: string) =>
        editSubscription(
          formPost("subscription/edit", token, { ac: "edit", s: stream, a: `user/-/label/${name}` })
        ),
    },
    {
      route: "rename-tag",
      send: async (token: string, _stream: string, name: string) =>
        renameTag(
          formPost("rename-tag", token, { s: "user/-/label/Old", dest: `user/-/label/${name}` })
        ),
    },
  ])("$route rejects a label name over the tag-name limit", async ({ send }) => {
    const { userId, token } = await createReader();
    const { stream } = await createSubscriptionStream(userId);
    await createTestTag(userId, { name: "Old" });

    const res = await send(token, stream, "x".repeat(TAG_NAME_MAX_LENGTH + 1));

    expect(res.status).toBe(400);
    const names = await db.select({ name: tags.name }).from(tags).where(eq(tags.userId, userId));
    expect(names).toEqual([{ name: "Old" }]);
  });
});
