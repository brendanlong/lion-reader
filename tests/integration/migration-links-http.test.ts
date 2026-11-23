/**
 * Integration tests for migrations 0189–0191: stored links are only ever
 * http(s). Migrations already ran against the test database, so each cleanup
 * is exercised by replaying its UPDATE over seeded bad rows with the
 * constraints dropped (`withoutLinkConstraints`).
 */

import { readFileSync } from "fs";
import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, users } from "../../src/server/db/schema";
import {
  createTestEmailSubscription,
  createTestEntry,
  createTestFeed,
  createTestUser,
  withoutLinkConstraints,
} from "./helpers";

function migrationStatements(file: string): string[] {
  return readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const entriesCleanup = migrationStatements("0190_entries_links_http_cleanup.sql");
// 0191 adds the constraint, then cleans up: replay only the cleanup.
const feedsCleanup = migrationStatements("0191_feeds_site_url_http.sql").slice(1);

const BAD = "javascript:alert(1)";
// Kept as stored: only a value the constraints reject is cleared.
const GOOD = "HTTPS://Example.com/ü?q=1";

describe("migrations 0189–0191: http(s)-only stored links", () => {
  afterAll(async () => {
    await db.delete(feeds);
    await db.delete(users);
  });

  it("refuses a stored link that isn't http(s)", async () => {
    const feedId = await createTestFeed();
    await expect(createTestEntry(feedId, { url: BAD })).rejects.toMatchObject({
      cause: { constraint: "entries_url_http" },
    });
    await expect(
      db.update(feeds).set({ siteUrl: "/relative" }).where(eq(feeds.id, feedId))
    ).rejects.toMatchObject({ cause: { constraint: "feeds_site_url_http" } });
  });

  it("clears existing links that aren't http(s), keeps the rest, and tells syncing clients", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const goodFeedId = await createTestFeed();
    const web = await createTestEntry(feedId);
    const goodWeb = await createTestEntry(feedId);
    const saved = await createTestEntry(userId, { type: "saved" });
    const email = await createTestEntry(await createTestEmailSubscription(userId), {
      type: "email",
    });
    const ids = [web, goodWeb, saved, email];
    const updatedAt = async (database: typeof db) =>
      new Map(
        (
          await database
            .select({ id: entries.id, updatedAt: entries.updatedAt })
            .from(entries)
            .where(inArray(entries.id, ids))
        ).map((row) => [row.id, row.updatedAt.getTime()])
      );
    const before = await updatedAt(db);

    await withoutLinkConstraints(async (tx) => {
      await tx.update(entries).set({ url: BAD }).where(eq(entries.id, web));
      await tx.update(entries).set({ url: GOOD }).where(eq(entries.id, goodWeb));
      await tx.update(entries).set({ imageUrl: BAD }).where(eq(entries.id, saved));
      await tx
        .update(entries)
        .set({ unsubscribeUrl: BAD, listUnsubscribeHttps: BAD })
        .where(eq(entries.id, email));
      await tx.update(feeds).set({ siteUrl: BAD }).where(eq(feeds.id, feedId));
      await tx.update(feeds).set({ siteUrl: GOOD }).where(eq(feeds.id, goodFeedId));

      for (const statement of [...entriesCleanup, ...feedsCleanup]) {
        await tx.execute(sql.raw(statement));
      }

      const rows = await tx
        .select({
          id: entries.id,
          url: entries.url,
          imageUrl: entries.imageUrl,
          unsubscribeUrl: entries.unsubscribeUrl,
          listUnsubscribeHttps: entries.listUnsubscribeHttps,
        })
        .from(entries)
        .where(inArray(entries.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(web)).toMatchObject({ url: null });
      expect(byId.get(goodWeb)).toMatchObject({ url: GOOD });
      expect(byId.get(saved)).toMatchObject({ imageUrl: null });
      expect(byId.get(email)).toMatchObject({ unsubscribeUrl: null, listUnsubscribeHttps: null });
      const after = await updatedAt(tx);
      for (const id of [web, saved, email]) expect(after.get(id)).toBeGreaterThan(before.get(id)!);
      expect(after.get(goodWeb)).toBe(before.get(goodWeb));

      const siteUrls = await tx
        .select({ id: feeds.id, siteUrl: feeds.siteUrl })
        .from(feeds)
        .where(inArray(feeds.id, [feedId, goodFeedId]));
      expect(new Map(siteUrls.map((f) => [f.id, f.siteUrl]))).toEqual(
        new Map([
          [feedId, null],
          [goodFeedId, GOOD],
        ])
      );
    });
  });
});
