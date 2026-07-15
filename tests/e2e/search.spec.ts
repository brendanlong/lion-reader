/**
 * E2E tests for the entry search UI (#565).
 *
 * The search bar lives behind the header toggle (or `/`): submitting writes
 * the `?q=` URL param, which scopes the entries.list query to the current
 * view's filters and flips the unread-only default to "show all" (a search is
 * usually for something already read).
 *
 * Search is TEMPORARILY DISABLED until the full-text index lands (#1249):
 * the enabled-behavior tests below are skipped (un-skip them when flipping
 * ENTRY_SEARCH_ENABLED back on), and the active test verifies the disabled
 * state — no search affordances, and `?q=` deep links degrade gracefully.
 */

import { test, expect } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  markEntryRead,
  loginAs,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

test("hides the search UI and ignores ?q= deep links while search is disabled (#1249)", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Quantum computing breakthrough",
  });
  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Gardening tips for spring",
  });

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeVisible();

  // No search toggle in the header, and `/` doesn't open a search bar.
  await expect(page.getByRole("button", { name: "Search entries" })).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Search entries" })).toHaveCount(0);

  // A lingering ?q= deep link renders the plain (unfiltered) list instead of
  // erroring: the param is ignored, so both entries stay visible.
  await page.goto("/all?q=quantum");
  await expect(page.locator('[aria-label*="article: Quantum computing"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search entries" })).toHaveCount(0);
});

test.skip("searches entries from the header toggle and clears back to the list", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Quantum computing breakthrough",
  });
  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Gardening tips for spring",
  });
  // A read entry matching the query: search must find it even though the view
  // was showing unread-only (the default flips to "show all" while searching).
  const readEntry = await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Quantum error correction explained",
  });
  await markEntryRead(db, user.id, readEntry.id);

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeVisible();
  // Default view is unread-only, so the read entry is hidden.
  await expect(page.locator('[aria-label*="article: Quantum error"]')).toBeHidden();

  // Open the search bar and search.
  await page.getByRole("button", { name: "Search entries" }).click();
  const input = page.getByRole("searchbox", { name: "Search entries" });
  await expect(input).toBeFocused();
  await input.fill("quantum");
  await input.press("Enter");

  await expect(page).toHaveURL(/[?&]q=quantum/);
  // Both quantum entries match — including the read one — and the
  // non-matching entry is gone.
  await expect(page.locator('[aria-label*="article: Quantum computing"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Quantum error"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeHidden();

  // Closing the search (the X inside the bar) restores the unfiltered
  // (unread-only) view.
  await page.getByRole("search").getByRole("button", { name: "Close search" }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Quantum error"]')).toBeHidden();
});

test.skip("scopes search to the current view and supports the / shortcut", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feedA = await createSubscribedFeed(db, user.id);
  const feedB = await createSubscribedFeed(db, user.id);

  await createUnreadEntry(db, {
    feedId: feedA.feedId,
    userId: user.id,
    title: "Quantum news from feed A",
  });
  await createUnreadEntry(db, {
    feedId: feedB.feedId,
    userId: user.id,
    title: "Quantum news from feed B",
  });

  await loginAs(page.context(), user, baseURL!);
  await page.goto(`/subscription/${feedA.subscriptionId}`);
  await expect(page.locator('[aria-label*="article: Quantum news from feed A"]')).toBeVisible();

  // `/` opens and focuses the search bar.
  await page.keyboard.press("/");
  const input = page.getByRole("searchbox", { name: "Search entries" });
  await expect(input).toBeFocused();
  await input.fill("quantum");
  await input.press("Enter");

  // Only the current subscription's match shows up.
  await expect(page.locator('[aria-label*="article: Quantum news from feed A"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Quantum news from feed B"]')).toBeHidden();

  // Escape closes the search and restores the view.
  await input.press("Escape");
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.locator('[aria-label*="article: Quantum news from feed A"]')).toBeVisible();
});

test.skip("loads search results directly from a ?q= deep link", async ({ page, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Quantum computing breakthrough",
  });
  await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "Gardening tips for spring",
  });

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all?q=quantum");

  // The bar shows the active query and the list is filtered.
  await expect(page.getByRole("searchbox", { name: "Search entries" })).toHaveValue("quantum");
  await expect(page.locator('[aria-label*="article: Quantum computing"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Gardening tips"]')).toBeHidden();
});
