/**
 * Integration tests for migrations 0189–0191: stored links are only ever
 * http(s). Migrations already ran against the test database, so each cleanup
 * is exercised by replaying its UPDATE over seeded bad rows with the
 * constraints dropped, inside a transaction that's rolled back.
 */

import { readFileSync } from "fs";
import { describe, it, expect, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { createTestEntry, createTestFeed } from "./helpers";

function migrationStatements(file: string): string[] {
  return readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const entriesCleanup = migrationStatements("0190_entries_links_http_cleanup.sql");
// 0191 adds the constraint, then cleans up: replay only the cleanup.
const feedsCleanup = migrationStatements("0191_feeds_site_url_http.sql").slice(1);

class Rollback extends Error {}

/** Runs `body` with the link constraints dropped, then rolls everything back. */
async function withoutConstraints(body: (tx: typeof db) => Promise<void>): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`ALTER TABLE entries
          DROP CONSTRAINT entries_url_http,
          DROP CONSTRAINT entries_image_url_http,
          DROP CONSTRAINT entries_unsubscribe_url_http,
          DROP CONSTRAINT entries_list_unsubscribe_https_http`)
      );
      await tx.execute(sql.raw("ALTER TABLE feeds DROP CONSTRAINT feeds_site_url_http"));
      await body(tx as unknown as typeof db);
      throw new Rollback();
    })
  ).rejects.toBeInstanceOf(Rollback);
}

describe("migrations 0189–0191: http(s)-only stored links", () => {
  afterAll(async () => {
    await db.delete(feeds);
  });

  it("refuses a stored link that isn't http(s)", async () => {
    const feedId = await createTestFeed();
    await expect(createTestEntry(feedId, { url: "javascript:alert(1)" })).rejects.toThrow();
    await expect(
      db.update(feeds).set({ siteUrl: "/relative" }).where(eq(feeds.id, feedId))
    ).rejects.toThrow();
  });

  it("clears existing links that aren't http(s) and keeps the rest", async () => {
    const feedId = await createTestFeed();
    const goodFeedId = await createTestFeed();
    const badEntryId = await createTestEntry(feedId);
    const goodEntryId = await createTestEntry(feedId);
    // Kept as stored: only a link the constraint rejects is cleared.
    const good = "HTTPS://Example.com/ü?q=1";
    await withoutConstraints(async (tx) => {
      // The four entry link columns share one expression; url stands for all.
      await tx
        .update(entries)
        .set({ url: "javascript:alert(1)" })
        .where(eq(entries.id, badEntryId));
      await tx.update(entries).set({ url: good }).where(eq(entries.id, goodEntryId));
      await tx.update(feeds).set({ siteUrl: "javascript:alert(2)" }).where(eq(feeds.id, feedId));
      await tx.update(feeds).set({ siteUrl: good }).where(eq(feeds.id, goodFeedId));

      for (const statement of [...entriesCleanup, ...feedsCleanup]) {
        await tx.execute(sql.raw(statement));
      }

      const urls = await tx
        .select({ id: entries.id, url: entries.url })
        .from(entries)
        .where(sql`${entries.id} IN (${badEntryId}, ${goodEntryId})`);
      expect(new Map(urls.map((e) => [e.id, e.url]))).toEqual(
        new Map([
          [badEntryId, null],
          [goodEntryId, good],
        ])
      );
      const siteUrls = await tx
        .select({ id: feeds.id, siteUrl: feeds.siteUrl })
        .from(feeds)
        .where(sql`${feeds.id} IN (${feedId}, ${goodFeedId})`);
      expect(new Map(siteUrls.map((f) => [f.id, f.siteUrl]))).toEqual(
        new Map([
          [feedId, null],
          [goodFeedId, good],
        ])
      );
    });
  });
});
