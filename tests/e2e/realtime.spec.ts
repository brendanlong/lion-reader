/**
 * E2E tests for the realtime SSE → cache update flow.
 *
 * These tests verify the core "minimal-request" invariant: SSE events patch
 * the React Query cache directly, they do NOT trigger refetches of entries
 * queries. Events are published through the same Redis pub/sub functions the
 * worker uses, so the full pipeline is exercised: Redis → SSE endpoint →
 * EventSource → handleSyncEvent → cache operations → UI.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  publishNewEntry,
  publishEntryStateChanged,
  getFeedEventsChannel,
  getUserEventsChannel,
} from "../../src/server/redis/pubsub";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  markEntryRead,
  loginAs,
  waitForChannelSubscriber,
  recordTrpcProcedures,
  closeTestConnections,
  type TestUser,
  type TestFeed,
  type TestEntry,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

interface RealtimeSetup {
  user: TestUser;
  feed: TestFeed;
  entries: TestEntry[];
  trpcCalls: string[];
  allItemsLink: ReturnType<Page["getByRole"]>;
}

/**
 * Seeds a user with one feed and two unread entries, logs in, opens /all,
 * and waits for the SSE connection plus its Redis channel subscriptions.
 */
async function openAllWithSse(
  page: Page,
  baseURL: string,
  channelForSetup: (setup: { user: TestUser; feed: TestFeed }) => string
): Promise<RealtimeSetup> {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  const entries = [
    await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "First post" }),
    await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "Second post" }),
  ];

  await loginAs(page.context(), user, baseURL);
  const trpcCalls = recordTrpcProcedures(page);

  // Resolves when the SSE response headers arrive (connection established)
  const sseResponse = page.waitForResponse(
    (response) => response.url().includes("/api/v1/events"),
    {
      timeout: 90_000,
    }
  );

  await page.goto("/all");

  const allItemsLink = page.getByRole("link", { name: /All Items/ });
  await expect(allItemsLink).toContainText("(2)");
  await expect(page.locator('[aria-label*="article: First post"]')).toBeVisible();

  await sseResponse;
  // The SSE handler subscribes to Redis channels asynchronously after the
  // response starts; wait until it's actually listening before publishing.
  await waitForChannelSubscriber(channelForSetup({ user, feed }));

  return { user, feed, entries, trpcCalls, allItemsLink };
}

function entriesProcedures(trpcCalls: string[]): string[] {
  return trpcCalls.filter((procedure) => procedure.startsWith("entries."));
}

test("new_entry event updates unread counts without refetching entries", async ({
  page,
  baseURL,
}) => {
  const { user, feed, trpcCalls, allItemsLink } = await openAllWithSse(page, baseURL!, ({ feed }) =>
    getFeedEventsChannel(feed.feedId)
  );

  // Everything from here on must happen via the SSE event, not refetches
  trpcCalls.length = 0;

  const db = getDb();
  const entry = await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Realtime post",
  });
  await publishNewEntry(feed.feedId, entry.id, entry.updatedAt, "web");

  // Unread count updates from the SSE event (delta applied client-side)
  await expect(allItemsLink).toContainText("(3)");

  // The minimal-request invariant: no entries.list / entries.count refetches
  expect(entriesProcedures(trpcCalls)).toEqual([]);
});

test("entry_state_changed event syncs read state and counts without refetching", async ({
  page,
  baseURL,
}) => {
  const { user, feed, entries, trpcCalls, allItemsLink } = await openAllWithSse(
    page,
    baseURL!,
    ({ user }) => getUserEventsChannel(user.id)
  );

  const firstPost = page.locator('[aria-label*="article: First post"]');
  await expect(firstPost).toHaveAttribute("aria-label", /^Unread/);

  trpcCalls.length = 0;

  // Simulate another device marking the entry read (as entries.markRead does):
  // update the database, then publish the state change with absolute counts.
  const db = getDb();
  const entry = entries[0];
  const updatedAt = await markEntryRead(db, user.id, entry.id);
  await publishEntryStateChanged(user.id, entry.id, true, false, updatedAt, {
    all: { unread: 1 },
    starred: { unread: 0 },
    subscriptions: [{ id: feed.subscriptionId, unread: 1 }],
    tags: [],
    uncategorized: { unread: 1 },
  });

  // Read state and counts update from the SSE event's absolute values
  await expect(firstPost).toHaveAttribute("aria-label", /^Read/);
  await expect(allItemsLink).toContainText("(1)");

  expect(entriesProcedures(trpcCalls)).toEqual([]);
});
