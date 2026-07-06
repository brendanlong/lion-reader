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

/**
 * Maximum scrollTop of the main container (scrollHeight - clientHeight). > 0
 * means the list overflows its container, so a non-zero scroll position is
 * actually reachable there — which is what makes a later `scrollTop === 0`
 * assertion meaningful rather than trivially true for a list too short to scroll.
 */
function mainMaxScroll(page: Page): Promise<number> {
  return page.locator("main").evaluate((el) => el.scrollHeight - el.clientHeight);
}

test("resets the entry-list scroll to the top on list→list navigation", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  // Star every entry so BOTH All and Starred are long lists (~40 rows). They
  // must each be taller than the pre-scroll offset used below, otherwise a
  // scrollTop === 0 on the target list could be trivially satisfied by the list
  // being too short to hold that offset (see the scrollHeight guards below).
  for (let i = 0; i < 40; i++) {
    const entry = await createUnreadEntry(db, {
      feedId: feed.feedId,
      userId: user.id,
      title: `Post ${String(i).padStart(2, "0")}`,
    });
    await starEntry(db, user.id, entry.id);
  }

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  // Lists render newest-first, so the highest-numbered post is at the top.
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();

  // Scroll the All list down, then switch to Starred.
  await page.locator("main").evaluate((el) => el.scrollTo(0, 1500));
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /^Starred/ }).click();
  // Starred is also a long list; it must open at the top rather than inheriting
  // All's scroll offset. All posts are starred, so Post 39 is at the top here too.
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();
  // Guard against the assertion passing trivially: the target list must overflow
  // (maxScroll > 0) so that, without the reset, the reused <main> container would
  // have kept a non-zero scrollTop (clamped to this list's maxScroll).
  await expect.poll(() => mainMaxScroll(page)).toBeGreaterThan(0);
  await expect.poll(() => mainScrollTop(page)).toBe(0);

  // Scroll Starred down, then navigate back to All: the same <main> container
  // kept its offset across the earlier swap, so returning must reset it too.
  await page.locator("main").evaluate((el) => el.scrollTo(0, 1500));
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);

  await page.getByRole("link", { name: /All Items/ }).click();
  await expect(page.locator('[aria-label*="article: Post 39"]')).toBeVisible();
  await expect.poll(() => mainMaxScroll(page)).toBeGreaterThan(0);
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
  // Locate by the stable data-entry-id, not the aria-label: opening marks the
  // entry read, which flips its aria-label ("Unread article: …" → "Read article:
  // …") and would break an aria-label-based locator after close.
  const centerEntryId = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const rect = main.getBoundingClientRect();
    const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return el?.closest("[data-entry-id]")?.getAttribute("data-entry-id") ?? null;
  });
  expect(centerEntryId).not.toBeNull();
  const centerEntry = page.locator(`[data-entry-id="${centerEntryId}"]`);
  await centerEntry.click();
  await expect(centerEntry).toBeHidden();

  // Close the entry (back). The list stays scrolled — it is not reset to the
  // top (closing re-centers the last-viewed entry, so the exact offset differs,
  // but it must remain a non-zero, mid-list position).
  await page.getByRole("button", { name: /back to list/i }).click();
  await expect(centerEntry).toBeVisible();
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0);
});
