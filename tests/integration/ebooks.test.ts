/**
 * Ebook imports (#1805): a book becomes a collection with one article per
 * chapter, read in the book's order.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, userEntries, users } from "../../src/server/db/schema";
import { importEbook } from "../../src/server/services/ebooks";
import { listEntries } from "../../src/server/services/entries";
import { usageLimitsConfig } from "../../src/server/config/env";
import { getAppErrorCode } from "../../src/server/errors";
import { buildEpub, chapterXhtml } from "../utils/epub";
import { createTestUser } from "./helpers";

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "ebook" });
  createdUserIds.push(userId);
  return userId;
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

const BOOK = buildEpub({
  title: "A Tale",
  creators: ["Ann Author"],
  spine: [
    { path: "one.xhtml", xhtml: chapterXhtml("<p>It was the best of times.</p>") },
    { path: "two.xhtml", xhtml: chapterXhtml("<p>It was the worst of times.</p>") },
    { path: "three.xhtml", xhtml: chapterXhtml("<p>We had everything before us.</p>") },
  ],
  nav: [
    { href: "one.xhtml", label: "The Best" },
    { href: "two.xhtml", label: "The Worst" },
    { href: "three.xhtml", label: "Before Us" },
  ],
});

function upload(userId: string, file: Buffer = BOOK) {
  return importEbook(db, userId, { content: file.toString("base64"), filename: "tale.epub" });
}

async function savedEntryCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(and(eq(userEntries.userId, userId), eq(entries.type, "saved")));
  return rows.length;
}

describe("importEbook", () => {
  it("creates a collection named for the book, listing its chapters in order by default", async () => {
    const userId = await createUser();
    const result = await upload(userId);

    expect(result.created).toBe(true);
    expect(result.subscription.title).toBe("A Tale");
    const { items } = await listEntries(db, {
      userId,
      subscriptionId: result.subscription.id,
      showSpam: false,
    });
    expect(items.map((item) => item.id)).toEqual(result.entryIds);
    expect(items.map((item) => item.title)).toEqual(["The Best", "The Worst", "Before Us"]);
    expect(items.every((item) => item.author === "Ann Author")).toBe(true);
    expect(items.every((item) => item.siteName === "A Tale")).toBe(true);
    expect(result.counts.subscriptions.find((s) => s.id === result.subscription.id)?.unread).toBe(
      3
    );
  });

  it("saves nothing again when the same file is imported twice", async () => {
    const userId = await createUser();
    const first = await upload(userId);
    const second = await upload(userId);

    expect(second.created).toBe(false);
    expect(second.subscription.id).toBe(first.subscription.id);
    expect(second.entryIds).toEqual(first.entryIds);
    expect(await savedEntryCount(userId)).toBe(3);
  });

  it("saves no chapters when the user can't create the collection", async () => {
    const userId = await createUser();
    const cap = usageLimitsConfig.maxSubscriptionsPerUser;
    usageLimitsConfig.maxSubscriptionsPerUser = 0;
    try {
      await expect(upload(userId)).rejects.toSatisfy(
        (error) => getAppErrorCode(error) === "MAX_SUBSCRIPTIONS_REACHED"
      );
    } finally {
      usageLimitsConfig.maxSubscriptionsPerUser = cap;
    }
    expect(await savedEntryCount(userId)).toBe(0);
  });

  it("rejects a file that isn't an ebook as the user's error", async () => {
    const userId = await createUser();
    await expect(upload(userId, Buffer.from("not an epub"))).rejects.toSatisfy(
      (error) => getAppErrorCode(error) === "VALIDATION_ERROR"
    );
  });
});
