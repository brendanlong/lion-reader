/**
 * E2E tests for server-rendering the entry list on a page load.
 *
 * The page's `entries.list` prefetch streams to the client while pending; the
 * list suspends on it during SSR and hydration only (useCanRenderStreamedQuery),
 * so the first page of entries is real HTML in the response instead of a
 * skeleton, hydrates without a mismatch, and client navigation afterwards
 * still renders lists without suspending.
 */

import { test, expect } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  starEntry,
  loginAs,
  collectRenderErrors,
  closeTestConnections,
  type TestDb,
  type TestEntry,
  type TestFeed,
  type TestUser,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

async function seedReader(
  db: TestDb
): Promise<{ user: TestUser; feed: TestFeed; entries: TestEntry[] }> {
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  const entries: TestEntry[] = [];
  for (let i = 0; i < 3; i++) {
    entries.push(
      await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: `SSR Post ${i}` })
    );
  }
  return { user, feed, entries };
}

test("entry list routes serve their first page of entries in the server HTML", async ({
  request,
}) => {
  const { user, feed, entries } = await seedReader(getDb());
  const headers = { cookie: `session=${user.sessionToken}` };

  for (const path of ["/all", `/subscription/${feed.subscriptionId}`]) {
    const html = await (await request.get(path, { headers })).text();
    for (const entry of entries) {
      // A rendered row, not just the streamed query data.
      expect(html, path).toContain(`data-entry-id="${entry.id}"`);
    }
  }
});

test("a server-rendered list hydrates cleanly and client navigation still works", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const { user, entries } = await seedReader(db);
  await starEntry(db, user.id, entries[0].id);
  await loginAs(page.context(), user, baseURL!);
  const renderErrors = collectRenderErrors(page);

  await page.goto("/all");
  for (const entry of entries) {
    await expect(page.locator(`[aria-label*="article: ${entry.title} "]`)).toBeVisible();
  }
  // Give hydration and the post-hydration effects time to settle.
  await page.waitForTimeout(1500);

  // Client navigation renders the next list from its own query.
  await page.getByRole("link", { name: /^Starred/ }).click();
  await page.waitForURL("**/starred");
  await expect(page.locator(`[aria-label*="article: ${entries[0].title} "]`)).toBeVisible();
  await expect(page.locator(`[aria-label*="article: ${entries[1].title} "]`)).toHaveCount(0);

  // A deep link to an entry server-renders the (hidden) list under the
  // reader too, and closing the reader shows it.
  await page.goto(`/all?entry=${entries[1].id}`);
  await expect(page.getByText(`Content for ${entries[1].title}`)).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect(page.locator(`[aria-label*="article: ${entries[2].title} "]`)).toBeVisible();

  expect(renderErrors).toEqual([]);
});
