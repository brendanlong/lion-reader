/**
 * E2E tests for client-side navigation behavior.
 *
 * In-app navigation is shallow (`pushState` + AppRouter re-deriving from
 * `usePathname()`), so there's no browser-native scroll reset. These tests
 * pin the behaviors that need to be reproduced by hand:
 *
 * - list→list navigation resets the entry-list scroll container to the top
 *   (issue #1013), while
 * - opening/closing an entry (a `?entry=` search-param change, same pathname)
 *   does NOT reset it — the list stays put under the reader.
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

/** Current scrollTop of the main entry-list scroll container. */
function mainScrollTop(page: Page): Promise<number> {
  return page.locator("main").evaluate((el) => el.scrollTop);
}

test("resets the entry-list scroll to the top on list→list navigation", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  // Enough entries that both All and Starred overflow the viewport (so a
  // non-zero scroll position is possible on each and scrollTop === 0 is a
  // meaningful assertion, not just "the new list happened to be short").
  for (let i = 0; i < 40; i++) {
    const entry = await createUnreadEntry(db, {
      feedId: feed.feedId,
      userId: user.id,
      title: `Post ${String(i).padStart(2, "0")}`,
    });
    if (i % 2 === 0) {
      await starEntry(db, user.id, entry.id);
    }
  }

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  // Lists render newest-first, so the highest-numbered post is at the top.
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();

  // Scroll the All list down, then switch to Starred.
  await page.locator("main").evaluate((el) => el.scrollTo(0, 1500));
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /^Starred/ }).click();
  // Starred is also a scrollable list (half the posts are starred); it must
  // open at the top rather than inheriting All's scroll offset. Post 38 is the
  // newest starred entry.
  await expect(page.locator('[aria-label*="article: Post 38"]')).toBeVisible();
  await expect.poll(() => mainScrollTop(page)).toBe(0);

  // Scroll Starred down, then navigate back to All: the same <main> container
  // kept its offset across the earlier swap, so returning must reset it too.
  await page.locator("main").evaluate((el) => el.scrollTo(0, 1500));
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /All Items/ }).click();
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();
  await expect.poll(() => mainScrollTop(page)).toBe(0);
});

test("does not reset the entry-list scroll when opening and closing an entry", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  for (let i = 0; i < 40; i++) {
    await createUnreadEntry(db, {
      feedId: feed.feedId,
      userId: user.id,
      title: `Post ${String(i).padStart(2, "0")}`,
    });
  }

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  // Lists render newest-first, so the highest-numbered post is at the top.
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();

  // Scroll the list well off the top. Opening/closing an entry only changes the
  // ?entry= search param (same pathname), so the list scroll must NOT reset.
  await page.locator("main").evaluate((el) => el.scrollTo(0, 1000));
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);

  // Open the entry sitting at the viewport center. Picking one already on-screen
  // means the click doesn't scroll the list (which clicking an off-screen entry
  // would), so the pre-open scroll offset is preserved for the comparison below.
  const centerLabel = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const rect = main.getBoundingClientRect();
    const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return el?.closest("[aria-label*='article:']")?.getAttribute("aria-label") ?? null;
  });
  expect(centerLabel).not.toBeNull();
  const centerEntry = page.locator(`[aria-label="${centerLabel}"]`);
  await centerEntry.click();
  await expect(centerEntry).toBeHidden();

  // Close the entry (back). The list stays scrolled — it is not reset to the
  // top (closing re-centers the last-viewed entry, so the exact offset differs,
  // but it must remain a non-zero, mid-list position).
  await page.getByRole("button", { name: /back to list/i }).click();
  await expect(centerEntry).toBeVisible();
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);
});
