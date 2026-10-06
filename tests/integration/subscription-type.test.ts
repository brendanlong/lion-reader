/**
 * `subscriptions.type` (#1846): every insert path stores the subscription's
 * own type, and the BEFORE INSERT trigger fills it from the feed for inserts
 * that don't name the column (the previous release's).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  feeds,
  ingestAddresses,
  jobs,
  subscriptions,
  users,
  type FeedType,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import { createCollection } from "../../src/server/services/collections";
import {
  createSubscription,
  mergeSubscriptionIntoFeed,
} from "../../src/server/services/subscriptions";
import { POST as quickadd } from "../../src/app/api/greader.php/reader/api/0/subscription/quickadd/route";
import {
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
} from "./helpers";

async function typeOf(subscriptionId: string): Promise<FeedType> {
  const [row] = await db
    .select({ type: subscriptions.type })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row.type;
}

async function subscriptionTo(userId: string, feedId: string): Promise<string> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)));
  return row.id;
}

async function cleanup(): Promise<void> {
  await db.delete(subscriptions);
  await db.delete(ingestAddresses);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

describe("subscriptions.type", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("is filled from the feed when an insert omits it", async () => {
    const userId = await createTestUser();
    const emailFeedId = await createTestFeed({
      type: "email",
      userId,
      url: null,
      emailSenderPattern: "news@example.com",
    });
    const collectionFeedId = await createTestFeed({ type: "collection", userId, url: null });
    const emailSubId = generateUuidv7();
    const collectionSubId = generateUuidv7();

    // The previous release's inserts don't know the column.
    await db.execute(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, custom_title)
      VALUES (${emailSubId}, ${userId}, ${emailFeedId}, NULL),
             (${collectionSubId}, ${userId}, ${collectionFeedId}, 'Reading')
    `);

    expect(await typeOf(emailSubId)).toBe("email");
    expect(await typeOf(collectionSubId)).toBe("collection");
  });

  it.each<{ path: string; expected: FeedType; insert: (userId: string) => Promise<string> }>([
    {
      path: "createSubscription",
      expected: "web",
      insert: async (userId) => {
        const url = `https://example.com/${generateUuidv7()}.xml`;
        await createTestFeed({ url, lastEntriesUpdatedAt: new Date() });
        return (await createSubscription(db, userId, { url })).subscriptionId;
      },
    },
    {
      path: "mergeSubscriptionIntoFeed (new survivor)",
      expected: "web",
      insert: async (userId) => {
        const oldSubId = await createTestSubscription(userId, await createTestFeed());
        const newFeedId = await createTestFeed();
        const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, newFeedId));
        await mergeSubscriptionIntoFeed(db, userId, oldSubId, newFeed);
        return subscriptionTo(userId, newFeedId);
      },
    },
    {
      path: "createCollection",
      expected: "collection",
      insert: async (userId) => (await createCollection(db, userId, "Reading")).subscription.id,
    },
    {
      path: "processInboundEmail",
      expected: "email",
      insert: async (userId) => {
        const token = `token-${generateUuidv7()}`;
        await createTestIngestAddress(userId, { token });
        const result = await processInboundEmail({
          to: `${token}@ingest.lionreader.com`,
          from: { address: "news@example.com", name: "News" },
          subject: "Hello",
          messageId: `<${generateUuidv7()}@example.com>`,
          html: "<p>Hi</p>",
          headers: {},
        });
        expect(result.success).toBe(true);
        return subscriptionTo(userId, result.feedId ?? "");
      },
    },
    {
      path: "Google Reader quickadd",
      expected: "web",
      insert: async (userId) => {
        const { token } = await createSession(db, {
          userId,
          scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
        });
        const url = `https://example.com/${generateUuidv7()}.xml`;
        const response = await quickadd(
          new Request("https://example.com/api/greader.php/reader/api/0/subscription/quickadd", {
            method: "POST",
            headers: {
              authorization: `GoogleLogin auth=${token}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ quickadd: url }).toString(),
          })
        );
        expect(response.status).toBe(200);
        const [feed] = await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.url, url));
        return subscriptionTo(userId, feed.id);
      },
    },
  ])("$path stores type $expected", async ({ insert, expected }) => {
    const userId = await createTestUser();
    expect(await typeOf(await insert(userId))).toBe(expected);
  });
});
