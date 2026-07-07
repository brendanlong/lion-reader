/**
 * E2E tests for the realtime SSE → cache update flow.
 *
 * These tests verify the core "minimal-request" invariant: SSE events patch
 * the React Query cache directly, they do NOT trigger refetches of entries,
 * tags, or subscriptions queries. Events are published through the same Redis
 * pub/sub functions the worker uses, so the full pipeline is exercised:
 * Redis → SSE endpoint → EventSource → handleSyncEvent → cache → UI.
 *
 * Each test seeds a tagged feed and an untagged feed so it can assert that
 * counts update correctly across every sidebar list (All Items, Starred,
 * tag, subscription row, Uncategorized) — including that unaffected lists
 * keep their counts.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  publishNewEntry,
  publishEntryStateChanged,
  getFeedEventsChannel,
  getUserEventsChannel,
} from "../../src/server/redis/pubsub";
import { getBulkEntryRelatedCounts } from "../../src/server/services/counts";
import { markAllEntriesRead } from "../../src/server/services/entries";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createTagOnSubscription,
  createUnreadEntry,
  starEntry,
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
  taggedFeed: TestFeed;
  tagId: string;
  taggedEntries: TestEntry[];
  trpcCalls: string[];
}

/**
 * Seeds a user with:
 * - a feed tagged "News" with two unread entries (optionally starring "Second post")
 * - an untagged feed with one unread entry (exercises the Uncategorized list)
 *
 * Then logs in, opens /all, waits for the SSE connection plus its Redis
 * channel subscriptions, and (unless expandTag is false) expands the News
 * tag so the per-subscription unread count is visible.
 */
async function seedAndOpenAll(
  page: Page,
  baseURL: string,
  channelFor: (setup: { user: TestUser; taggedFeed: TestFeed }) => string,
  options: { starSecondPost?: boolean; expandTag?: boolean } = {}
): Promise<RealtimeSetup> {
  const db = getDb();
  const user = await createConfirmedUser(db);

  const taggedFeed = await createSubscribedFeed(db, user.id);
  const tagId = await createTagOnSubscription(db, user.id, taggedFeed.subscriptionId, "News");
  const taggedEntries = [
    await createUnreadEntry(db, {
      feedId: taggedFeed.feedId,
      userId: user.id,
      title: "First post",
    }),
    await createUnreadEntry(db, {
      feedId: taggedFeed.feedId,
      userId: user.id,
      title: "Second post",
    }),
  ];
  if (options.starSecondPost) {
    await starEntry(db, user.id, taggedEntries[1].id);
  }

  const untaggedFeed = await createSubscribedFeed(db, user.id);
  await createUnreadEntry(db, {
    feedId: untaggedFeed.feedId,
    userId: user.id,
    title: "Untagged post",
  });

  await loginAs(page.context(), user, baseURL);
  const trpcCalls = recordTrpcProcedures(page);

  // Resolves when the SSE response headers arrive (connection established)
  const sseResponse = page.waitForResponse(
    (response) => response.url().includes("/api/v1/events"),
    { timeout: 90_000 }
  );

  await page.goto("/all");
  await expect(page.locator('[aria-label*="article: First post"]')).toBeVisible();

  // Expand the News tag so the subscription row (and its unread count) renders.
  if (options.expandTag !== false) {
    await page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: /News/ }) })
      .getByRole("button", { name: "Expand" })
      .click();
    await expect(page.getByRole("link", { name: new RegExp(taggedFeed.title) })).toBeVisible();
  }

  await sseResponse;
  // The SSE handler subscribes to Redis channels asynchronously after the
  // response starts; wait until it's actually listening before publishing.
  await waitForChannelSubscriber(channelFor({ user, taggedFeed }));

  return { user, taggedFeed, tagId, taggedEntries, trpcCalls };
}

function sidebarLinks(page: Page, taggedFeed: TestFeed) {
  return {
    allItems: page.getByRole("link", { name: /All Items/ }),
    starred: page.getByRole("link", { name: /^Starred/ }),
    newsTag: page.getByRole("link", { name: /News/ }),
    subscriptionRow: page.getByRole("link", { name: new RegExp(taggedFeed.title) }),
    uncategorized: page.getByRole("link", { name: /Uncategorized/ }),
  };
}

/**
 * Builds the list-item payload publishNewEntry carries so clients can insert
 * the entry into cached lists (mirrors what the feed worker publishes).
 */
function newEntryListData(entry: TestEntry, feed: TestFeed) {
  return {
    url: entry.url,
    title: entry.title,
    author: null,
    summary: entry.summary,
    publishedAt: entry.publishedAt.toISOString(),
    fetchedAt: entry.fetchedAt.toISOString(),
    siteName: null,
    feedTitle: feed.title,
  };
}

/**
 * Procedures that must never fire in response to a sync event — counts and
 * entry state are patched directly into the cache (the delta-update invariant
 * from src/FRONTEND_STATE.md).
 */
function refetchProcedures(trpcCalls: string[]): string[] {
  return trpcCalls.filter(
    (procedure) =>
      procedure.startsWith("entries.") ||
      procedure.startsWith("tags.") ||
      procedure.startsWith("subscriptions.")
  );
}

test("new_entry event updates unread counts in all affected lists without refetching", async ({
  page,
  baseURL,
}) => {
  const { user, taggedFeed, trpcCalls } = await seedAndOpenAll(page, baseURL!, ({ taggedFeed }) =>
    getFeedEventsChannel(taggedFeed.feedId)
  );
  const links = sidebarLinks(page, taggedFeed);

  await expect(links.allItems).toContainText("(3)");
  await expect(links.newsTag).toContainText("(2)");
  await expect(links.subscriptionRow).toContainText("(2)");
  await expect(links.uncategorized).toContainText("(1)");

  // Everything from here on must happen via the SSE event, not refetches
  trpcCalls.length = 0;

  const db = getDb();
  const entry = await createUnreadEntry(db, {
    feedId: taggedFeed.feedId,
    userId: user.id,
    title: "Realtime post",
  });
  await publishNewEntry(
    taggedFeed.feedId,
    entry.id,
    entry.updatedAt,
    "web",
    newEntryListData(entry, taggedFeed)
  );

  // Affected lists update from the event's server-computed absolute counts...
  await expect(links.allItems).toContainText("(4)");
  await expect(links.newsTag).toContainText("(3)");
  await expect(links.subscriptionRow).toContainText("(3)");
  // ...while unaffected lists keep their counts
  await expect(links.uncategorized).toContainText("(1)");

  expect(refetchProcedures(trpcCalls)).toEqual([]);
});

test("new_entry event inserts the entry at the top of the open list without refetching", async ({
  page,
  baseURL,
}) => {
  const { user, taggedFeed, trpcCalls } = await seedAndOpenAll(page, baseURL!, ({ taggedFeed }) =>
    getFeedEventsChannel(taggedFeed.feedId)
  );

  trpcCalls.length = 0;

  const db = getDb();
  const entry = await createUnreadEntry(db, {
    feedId: taggedFeed.feedId,
    userId: user.id,
    title: "Realtime post",
  });
  await publishNewEntry(
    taggedFeed.feedId,
    entry.id,
    entry.updatedAt,
    "web",
    newEntryListData(entry, taggedFeed)
  );

  // The new entry appears in the open list, sorted first (it's the newest),
  // purely from the SSE event's list payload — no entries.list refetch.
  await expect(page.locator('[aria-label*="article: Realtime post"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article:"]').first()).toHaveAttribute(
    "aria-label",
    /Realtime post/
  );

  expect(refetchProcedures(trpcCalls)).toEqual([]);
});

// Regression test for #892: while a sidebar tag is collapsed (the default),
// the subscription isn't in any cache, so a tag count can't be derived from
// cached subscription data. The new_entry event carries the tag's absolute
// unread count (computed per-user by the SSE endpoint) so the badge still
// updates.
test("new_entry event updates a collapsed tag's unread count", async ({ page, baseURL }) => {
  const { user, taggedFeed, trpcCalls } = await seedAndOpenAll(
    page,
    baseURL!,
    ({ taggedFeed }) => getFeedEventsChannel(taggedFeed.feedId),
    { expandTag: false }
  );
  const links = sidebarLinks(page, taggedFeed);

  await expect(links.allItems).toContainText("(3)");
  await expect(links.newsTag).toContainText("(2)");

  trpcCalls.length = 0;

  const db = getDb();
  const entry = await createUnreadEntry(db, {
    feedId: taggedFeed.feedId,
    userId: user.id,
    title: "Realtime post",
  });
  await publishNewEntry(
    taggedFeed.feedId,
    entry.id,
    entry.updatedAt,
    "web",
    newEntryListData(entry, taggedFeed)
  );

  await expect(links.allItems).toContainText("(4)");
  // Intended behavior: the collapsed tag's badge should update too
  await expect(links.newsTag).toContainText("(3)");

  expect(refetchProcedures(trpcCalls)).toEqual([]);
});

test("entry_state_changed event syncs read state and counts across lists without refetching", async ({
  page,
  baseURL,
}) => {
  // "Second post" is starred (still unread) so the Starred count is visible
  // and we can verify it's unaffected by marking a different entry read.
  const { user, taggedFeed, tagId, taggedEntries, trpcCalls } = await seedAndOpenAll(
    page,
    baseURL!,
    ({ user }) => getUserEventsChannel(user.id),
    { starSecondPost: true }
  );
  const links = sidebarLinks(page, taggedFeed);
  const [firstPost] = taggedEntries;

  const db = getDb();
  const firstPostItem = page.locator('[aria-label*="article: First post"]');
  await expect(firstPostItem).toHaveAttribute("aria-label", /^Unread/);
  await expect(links.allItems).toContainText("(3)");
  await expect(links.starred).toContainText("(1)");
  await expect(links.newsTag).toContainText("(2)");
  await expect(links.subscriptionRow).toContainText("(2)");
  await expect(links.uncategorized).toContainText("(1)");

  trpcCalls.length = 0;

  // Simulate another device marking "First post" read (as entries.markRead
  // does): update the database, then publish the change with absolute counts.
  const updatedAt = await markEntryRead(db, user.id, firstPost.id);
  await publishEntryStateChanged(user.id, firstPost.id, true, false, updatedAt, {
    all: { unread: 2 },
    starred: { unread: 1 },
    subscriptions: [{ id: taggedFeed.subscriptionId, unread: 1 }],
    tags: [{ id: tagId, unread: 1 }],
    uncategorized: { unread: 1 },
  });

  // Read state and affected counts update from the event's absolute values...
  await expect(firstPostItem).toHaveAttribute("aria-label", /^Read/);
  await expect(links.allItems).toContainText("(2)");
  await expect(links.newsTag).toContainText("(1)");
  await expect(links.subscriptionRow).toContainText("(1)");
  // ...while unaffected lists keep their counts
  await expect(links.starred).toContainText("(1)");
  await expect(links.uncategorized).toContainText("(1)");

  expect(refetchProcedures(trpcCalls)).toEqual([]);
});

// mark_all_read is the ONE realtime event that deliberately refetches (see
// src/FRONTEND_STATE.md): mark-all-read is unbounded, so the server sends a
// lightweight signal and the client invalidates its lists + counts instead of
// patching. This test locks in both the behavior (unread view empties, badges
// clear) and the boundary (a refetch IS expected here, unlike every test above).
test("mark_all_read event empties the unread list and clears badges via a refetch", async ({
  page,
  baseURL,
}) => {
  const { user, taggedFeed, trpcCalls } = await seedAndOpenAll(page, baseURL!, ({ user }) =>
    getUserEventsChannel(user.id)
  );
  const links = sidebarLinks(page, taggedFeed);
  const firstPostItem = page.locator('[aria-label*="article: First post"]');

  await expect(firstPostItem).toBeVisible();
  await expect(links.allItems).toContainText("(3)");
  await expect(links.newsTag).toContainText("(2)");
  await expect(links.subscriptionRow).toContainText("(2)");
  await expect(links.uncategorized).toContainText("(1)");

  trpcCalls.length = 0;

  // Simulate another device/tab marking everything read. markAllEntriesRead
  // marks read in the DB AND publishes the mark_all_read signal — the exact code
  // path the tRPC mutation and the Google Reader mark-all-as-read route hit.
  const db = getDb();
  await markAllEntriesRead(db, { userId: user.id });

  // The unread-only /all view empties out and every sidebar unread badge clears
  // (CountBadge renders nothing at 0; the tag/sub/uncategorized rows hide).
  await expect(firstPostItem).toBeHidden();
  await expect(links.allItems).not.toContainText("(");
  await expect(links.newsTag).toBeHidden();
  await expect(links.subscriptionRow).toBeHidden();
  await expect(links.uncategorized).toBeHidden();

  // ...and, unlike every other realtime event, this one refetched entries.list.
  expect(refetchProcedures(trpcCalls)).toContain("entries.list");
});

// Regression test: when the LAST unread entry of a subscription is read, the
// server-computed counts must still include the subscription and its tag
// (with unread 0). The grouped count queries used to omit lists that dropped
// to zero, so the sidebar badges stayed stale until a refresh. Unlike the
// test above, the event counts here come from the real counts service (as
// entries.markRead computes them), not a hand-written literal.
test("entry_state_changed for the last unread entry clears subscription and tag badges", async ({
  page,
  baseURL,
}) => {
  const { user, taggedFeed, taggedEntries, trpcCalls } = await seedAndOpenAll(
    page,
    baseURL!,
    ({ user }) => getUserEventsChannel(user.id)
  );
  const links = sidebarLinks(page, taggedFeed);

  await expect(links.allItems).toContainText("(3)");
  await expect(links.newsTag).toContainText("(2)");
  await expect(links.subscriptionRow).toContainText("(2)");
  await expect(links.uncategorized).toContainText("(1)");

  trpcCalls.length = 0;

  // Simulate another device marking BOTH tagged entries read, draining the
  // subscription: update the database, compute absolute counts with the same
  // service entries.markRead uses, and publish the state change.
  const db = getDb();
  let updatedAt = new Date();
  for (const entry of taggedEntries) {
    updatedAt = await markEntryRead(db, user.id, entry.id);
  }
  const counts = await getBulkEntryRelatedCounts(db, user.id, [
    { subscriptionId: taggedFeed.subscriptionId, type: "web" },
  ]);
  const lastEntry = taggedEntries[taggedEntries.length - 1];
  await publishEntryStateChanged(user.id, lastEntry.id, true, false, updatedAt, counts);

  // The sidebar defaults to unread-only mode, so once the subscription's
  // count reaches zero the tag and subscription rows disappear entirely
  // (with the stale non-zero count they'd stay visible)...
  await expect(links.allItems).toContainText("(1)");
  await expect(links.newsTag).toBeHidden();
  await expect(links.subscriptionRow).toBeHidden();
  // ...while the unaffected Uncategorized list keeps its count.
  await expect(links.uncategorized).toContainText("(1)");

  expect(refetchProcedures(trpcCalls)).toEqual([]);
});
