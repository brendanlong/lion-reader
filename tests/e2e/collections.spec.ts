/**
 * E2E test for collections (#1806): adding an article to a new collection from
 * the reader, then finding it (and only it) in the collection's view in the
 * sidebar, with the collection's unread badge kept current.
 */

import { test, expect } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  loginAs,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

test("adds an article to a new collection and lists it there", async ({ page, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  const kept = await createUnreadEntry(db, {
    feedId: feed.feedId,
    userId: user.id,
    title: "A paper worth keeping",
  });
  await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "Just news" });

  await loginAs(page.context(), user, baseURL!);
  await page.goto(`/all?entry=${kept.id}`);

  await page.getByRole("button", { name: "Add to Collection" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Search or create a collection" }).fill("Research");
  await dialog.getByRole("option", { name: "Create “Research”" }).click();
  await expect(dialog.getByRole("option", { name: "Research" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Collections (1)" })).toBeVisible();

  // Opening the article marked it read; unread again, it shows in the
  // collection's badge and in its (unread-only) view.
  await page.getByRole("button", { name: "Mark as unread" }).click();
  const uncategorized = page.getByRole("listitem").filter({ hasText: "Uncategorized" });
  await uncategorized.getByRole("button", { name: "Expand" }).click();
  const research = page.getByRole("link", { name: /^Research/ });
  await expect(research).toContainText("(1)");

  await research.click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await expect(page.locator('[aria-label*="article: A paper worth keeping"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Just news"]')).toBeHidden();
});
