/**
 * Google Reader `subscription/quickadd` subscribes through the same service as
 * the app (#1935), so a new feed gets its fetch job and a resubscribe works.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, jobs, subscriptions, users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { unsubscribe } from "../../src/server/services/subscriptions";
import { POST as quickadd } from "../../src/app/api/greader.php/reader/api/0/subscription/quickadd/route";
import { createTestUser } from "./helpers";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Quickadd Feed</title><link>https://example.com/</link>
<item><title>Hello</title><link>https://example.com/hello</link><guid>hello</guid></item>
</channel></rss>`;

let server: Server;
let baseUrl: string;
const createdUserIds: string[] = [];
const feedUrls: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/feed")) {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(RSS);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>No feed here</title></head><body></body></html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (feedUrls.length > 0) {
    const deleted = await db
      .delete(feeds)
      .where(inArray(feeds.url, feedUrls))
      .returning({ id: feeds.id });
    await db.delete(jobs).where(
      and(
        eq(jobs.type, "fetch_feed"),
        inArray(
          sql`${jobs.payload}->>'feedId'`,
          deleted.map((f) => f.id)
        )
      )
    );
  }
});

async function createReader(): Promise<{ userId: string; token: string }> {
  const userId = await createTestUser({ emailPrefix: "greader-quickadd" });
  createdUserIds.push(userId);
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  return { userId, token };
}

function quickaddRequest(token: string, url: string): Request {
  return new Request("https://example.com/api/greader.php/reader/api/0/subscription/quickadd", {
    method: "POST",
    headers: {
      authorization: `GoogleLogin auth=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ quickadd: url }).toString(),
  });
}

function uniqueFeedUrl(): string {
  const url = `${baseUrl}/feed-${crypto.randomUUID()}.xml`;
  feedUrls.push(url);
  return url;
}

async function activeSubscriptionTo(userId: string, feedUrl: string) {
  const [row] = await db
    .select({ id: subscriptions.id, streamId: subscriptions.greaderStreamId, feedId: feeds.id })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(feeds.url, feedUrl),
        isNull(subscriptions.unsubscribedAt)
      )
    );
  return row;
}

describe("Google Reader quickadd", () => {
  it("subscribes to a new feed and schedules its fetch", async () => {
    const { userId, token } = await createReader();
    const feedUrl = uniqueFeedUrl();

    const res = await quickadd(quickaddRequest(token, feedUrl));

    expect(res.status).toBe(200);
    const subscription = await activeSubscriptionTo(userId, feedUrl);
    const fetchJobs = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.type, "fetch_feed"), sql`${jobs.payload}->>'feedId' = ${subscription.feedId}`)
      );
    expect(fetchJobs).toHaveLength(1);
    expect(await res.json()).toEqual({
      query: feedUrl,
      numResults: 1,
      streamId: `feed/${subscription.streamId}`,
      streamName: "Quickadd Feed",
    });
  });

  it("resubscribes to a feed the user unsubscribed from", async () => {
    const { userId, token } = await createReader();
    const feedUrl = uniqueFeedUrl();
    expect((await quickadd(quickaddRequest(token, feedUrl))).status).toBe(200);
    const first = await activeSubscriptionTo(userId, feedUrl);
    await unsubscribe(db, userId, first.id);

    const res = await quickadd(quickaddRequest(token, feedUrl));

    expect(res.status).toBe(200);
    expect(await activeSubscriptionTo(userId, feedUrl)).toEqual(first);
  });

  it("rejects a page with no feed as a client error", async () => {
    const { token } = await createReader();

    const res = await quickadd(quickaddRequest(token, `${baseUrl}/page.html`));

    expect(res.status).toBe(400);
  });
});
