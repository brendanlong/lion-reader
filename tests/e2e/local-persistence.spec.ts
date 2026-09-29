/**
 * E2E tests for "Keep entries on this device": the entry store persisted to
 * IndexedDB in a real browser, restored on the next page load, and deleted on
 * sign-out.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  starEntry,
  loginAs,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

/** Names of this app's local databases in the page's browser. */
function localDatabaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name ?? "")
      .filter((name) => name.startsWith("lion-reader-local-"))
  );
}

/** Resolves once the local database holds at least one list row. */
async function waitForPersistedListRows(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const [info] = (await indexedDB.databases()).filter((database) =>
          database.name?.startsWith("lion-reader-local-")
        );
        if (!info?.name) return 0;
        const request = indexedDB.open(info.name);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!db.objectStoreNames.contains("listRows")) return 0;
        const count = db.transaction("listRows").objectStore("listRows").count();
        const rows = await new Promise<number>((resolve) => {
          count.onsuccess = () => resolve(count.result);
        });
        db.close();
        return rows;
      })
    )
    .toBeGreaterThan(0);
}

test("a list viewed with the setting on shows on the next visit before its fetch returns", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  const entry = await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Persisted starred article",
  });
  await starEntry(db, user.id, entry.id);

  await loginAs(page.context(), user, baseURL!);

  // Turn the setting on through the UI (it reloads the page).
  await page.goto("/settings");
  const toggle = page.getByRole("switch", { name: "Keep entries on this device (beta)" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.goto("/starred");
  await expect(page.locator('[aria-label*="article: Persisted starred article"]')).toBeVisible();
  await waitForPersistedListRows(page);

  // Next visit, on a page with no list: entries.list requests never answer,
  // so the Starred list can only come from the local database.
  await page.route("**/api/trpc/**", (route) =>
    route.request().url().includes("entries.list") ? new Promise(() => {}) : route.continue()
  );
  await page.goto("/settings");
  await page.getByRole("link", { name: /^Starred/ }).click();

  await expect(page.locator('[aria-label*="article: Persisted starred article"]')).toBeVisible();
});

test("signing out deletes the local database", async ({ page, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "Some article" });

  await loginAs(page.context(), user, baseURL!);
  await page.addInitScript(() => localStorage.setItem("lion-reader:local-persistence", "true"));
  await page.goto("/all");
  await expect(page.locator('[aria-label*="article: Some article"]')).toBeVisible();
  await waitForPersistedListRows(page);

  await page.locator('button[aria-haspopup="true"]').click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login**");

  expect(await localDatabaseNames(page)).toEqual([]);
});
