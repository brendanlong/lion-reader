/**
 * E2E test for collections (#1806): adding an article to a new collection from
 * the reader, then finding it (and only it) in the collection's view in the
 * sidebar, with the collection's unread badge kept current; and uploading a
 * file into the collection being viewed, then deleting the collection along
 * with it.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as schema from "../../src/server/db/schema";
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
  await expect(dialog.getByRole("option", { name: "Research", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Collections (1)" })).toBeVisible();

  // Opening the article marked it read, so the unread-only sidebar hides the
  // collection. Unread again, it appears with its badge without a refetch of
  // its own, and lists the article in its (unread-only) view.
  await page.getByRole("button", { name: "Uncategorized feeds", expanded: false }).click();
  await expect(page.getByRole("link", { name: new RegExp(`^${feed.title}`) })).toBeVisible();
  const research = page.getByRole("link", { name: /^Research/ });
  await expect(research).toBeHidden();
  await page.getByRole("button", { name: "Mark as unread" }).click();
  await expect(research).toContainText("(1)");

  await research.click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await expect(page.locator('[aria-label*="article: A paper worth keeping"]')).toBeVisible();
  await expect(page.locator('[aria-label*="article: Just news"]')).toBeHidden();
});

test("uploads into the viewed collection and deletes the collection with it", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const collectionId = generateUuidv7();
  await db
    .insert(schema.subscriptions)
    .values({ id: collectionId, userId: user.id, type: "collection", customTitle: "Book" });

  await loginAs(page.context(), user, baseURL!);
  await page.goto(`/subscription/${collectionId}`);
  await expect(page.getByRole("heading", { name: "Book", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Upload file" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Add to collection")).toHaveValue(collectionId);
  await dialog.getByLabel("Choose a file to upload").setInputFiles({
    name: "chapter-1.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Chapter 1\n\nIt was a dark and stormy night."),
  });
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.locator('[aria-label*="article: Chapter 1"]')).toBeVisible();

  await page.getByRole("button", { name: "Uncategorized feeds", expanded: false }).click();
  await page.getByRole("link", { name: /^Book/ }).hover();
  await page.getByRole("button", { name: "Delete Book" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByRole("checkbox", { name: /delete its saved articles/ }).check();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Delete Book" })).toBeHidden();

  await expect
    .poll(() => db.$count(schema.entries, eq(schema.entries.ownerUserId, user.id)))
    .toBe(0);
});
