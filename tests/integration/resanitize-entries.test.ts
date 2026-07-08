/**
 * Integration tests for the background entry re-sanitization sweep.
 *
 * `resanitizeStaleEntries` (service) heals stored `entries.*_sanitized` columns
 * left stale by a SANITIZER_VERSION bump, a batch at a time, with a
 * compare-and-swap guard so it can't clobber concurrent writes. The sweep is
 * stateless — it relies on `idx_entries_resanitize` to seek to the stalest rows
 * each run — and is driven by the `resanitize_entries` singleton job
 * (`handleResanitizeEntries`). All exercised here against a real database,
 * including an EXPLAIN check that the query actually uses the index (no sort).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { SANITIZER_VERSION } from "../../src/server/html/sanitize";
import {
  resanitizeStaleEntries,
  selectStaleEntriesForResanitize,
  persistResanitizedFamily,
} from "../../src/server/services/resanitize";
import { handleResanitizeEntries, RESANITIZE_BATCH_SIZE } from "../../src/server/jobs/handlers";

const STALE_VERSION = SANITIZER_VERSION - 1;

async function seedFeed(): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}.xml`,
    title: "Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

/**
 * Insert a web entry with raw content containing XSS. By default it models the
 * dominant production shape — content only, `full_content_*` columns and version
 * left NULL (feed/email writes never populate full content). `version` sets the
 * content family's stored version (default: one behind current, i.e. stale);
 * `full: true` additionally seeds a stale full-content family. Returns the id.
 */
async function seedStaleEntry(
  feedId: string,
  opts: {
    version?: number | null;
    full?: boolean;
    contentSanitized?: string | null;
  } = {}
): Promise<string> {
  const id = generateUuidv7();
  const now = new Date();
  const version = opts.version === undefined ? STALE_VERSION : opts.version;
  await db.insert(entries).values({
    id,
    feedId,
    type: "web",
    guid: `guid-${id}`,
    title: "Stale",
    contentCleaned: `<p onclick="evil()">body-${id}<script>alert(1)</script></p>`,
    contentCleanedSanitized: opts.contentSanitized ?? null,
    contentSanitizedVersion: version,
    // Content-only by default: no full-content raw, NULL full version/hash.
    fullContentCleaned: opts.full ? `<p>full-${id}<script>alert(2)</script></p>` : null,
    fullContentSanitizedVersion: opts.full ? version : null,
    fullContentHash: opts.full ? `fullhash-${id}` : null,
    contentHash: `hash-${id}`,
    fetchedAt: now,
    publishedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function getVersions(id: string) {
  const [row] = await db
    .select({
      contentVersion: entries.contentSanitizedVersion,
      contentSanitized: entries.contentCleanedSanitized,
      fullVersion: entries.fullContentSanitizedVersion,
      fullSanitized: entries.fullContentCleanedSanitized,
    })
    .from(entries)
    .where(eq(entries.id, id));
  return row;
}

async function cleanup() {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(feeds);
}

describe("resanitizeStaleEntries", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("sanitizes stale rows and stamps the current version (both families)", async () => {
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId, { full: true });

    const result = await resanitizeStaleEntries(db, { limit: 10 });

    expect(result.processed).toBe(1);
    expect(result.contentResanitized).toBe(1);
    expect(result.fullContentResanitized).toBe(1);
    expect(result.failed).toBe(0);

    const row = await getVersions(id);
    expect(row.contentVersion).toBe(SANITIZER_VERSION);
    expect(row.fullVersion).toBe(SANITIZER_VERSION);
    expect(row.contentSanitized).toContain(`body-${id}`);
    expect(row.contentSanitized).not.toContain("<script>");
    expect(row.contentSanitized).not.toContain("onclick");
    expect(row.fullSanitized).toContain(`full-${id}`);
    expect(row.fullSanitized).not.toContain("<script>");
  });

  it("does NOT treat a content-only entry's NULL full-content version as stale", async () => {
    // Regression: the dominant production row is content sanitized at the
    // current version with full_content_sanitized_version = NULL (full content
    // never fetched). That row is fully fresh and must be left alone — otherwise
    // the sweep targets the whole table forever.
    const feedId = await seedFeed();
    const fresh = await seedStaleEntry(feedId, { version: SANITIZER_VERSION });

    const result = await resanitizeStaleEntries(db, { limit: 10 });

    expect(result.processed).toBe(0);
    const row = await getVersions(fresh);
    expect(row.contentVersion).toBe(SANITIZER_VERSION);
    expect(row.fullVersion).toBeNull(); // not re-stamped
  });

  it("heals a stale full-content family while leaving fresh content alone", async () => {
    const feedId = await seedFeed();
    // Full content present but at a stale version, content family already fresh.
    const id = await seedStaleEntry(feedId, { version: SANITIZER_VERSION, full: true });
    await db
      .update(entries)
      .set({ fullContentSanitizedVersion: STALE_VERSION })
      .where(eq(entries.id, id));

    const result = await resanitizeStaleEntries(db, { limit: 10 });

    expect(result.processed).toBe(1);
    expect(result.contentResanitized).toBe(0); // fresh content untouched
    expect(result.fullContentResanitized).toBe(1);
    const row = await getVersions(id);
    expect(row.fullVersion).toBe(SANITIZER_VERSION);
    expect(row.fullSanitized).not.toContain("<script>");
  });

  it("heals newest-first among rows at the same stale version", async () => {
    const feedId = await seedFeed();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedStaleEntry(feedId));
    // UUIDv7 ids minted within a ms aren't strictly monotonic; sort to learn the
    // true newest-first order (string order == uuid order).
    const [oldest, , newest] = [...ids].sort();

    const batch = await resanitizeStaleEntries(db, { limit: 1 });
    expect(batch.processed).toBe(1);
    expect((await getVersions(newest)).contentVersion).toBe(SANITIZER_VERSION);
    expect((await getVersions(oldest)).contentVersion).toBe(STALE_VERSION);
  });

  it("heals the highest stale version before older ones", async () => {
    const feedId = await seedFeed();
    // Straggler at an older version (from a hypothetical unfinished earlier
    // pass) plus a row at the previous version. The previous-version row is the
    // higher stale key, so it heals first.
    const older = await seedStaleEntry(feedId, { version: STALE_VERSION - 1 });
    const newerVersion = await seedStaleEntry(feedId, { version: STALE_VERSION });

    const batch = await resanitizeStaleEntries(db, { limit: 1 });
    expect(batch.processed).toBe(1);
    expect((await getVersions(newerVersion)).contentVersion).toBe(SANITIZER_VERSION);
    expect((await getVersions(older)).contentVersion).toBe(STALE_VERSION - 1);
  });

  it("skips rows already at the current version (no wasted work)", async () => {
    const feedId = await seedFeed();
    const fresh = await seedStaleEntry(feedId, {
      version: SANITIZER_VERSION,
      contentSanitized: "<p>ALREADY_FRESH</p>",
    });
    const stale = await seedStaleEntry(feedId);

    const result = await resanitizeStaleEntries(db, { limit: 10 });

    expect(result.processed).toBe(1);
    expect((await getVersions(fresh)).contentSanitized).toBe("<p>ALREADY_FRESH</p>");
    expect((await getVersions(stale)).contentVersion).toBe(SANITIZER_VERSION);
  });

  it("persistResanitizedFamily writes when version is stale and hash matches", async () => {
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId);

    const persisted = await persistResanitizedFamily(
      db,
      id,
      "content",
      { original: "<p>ok</p>", cleaned: "<p>ok</p>" },
      `hash-${id}`
    );

    expect(persisted).toBe(true);
    const row = await getVersions(id);
    expect(row.contentVersion).toBe(SANITIZER_VERSION);
    expect(row.contentSanitized).toBe("<p>ok</p>");
  });

  it("persistResanitizedFamily skips when the content changed under it (TOCTOU guard)", async () => {
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId);
    // Simulate a concurrent writer swapping the raw content (new hash) between
    // when we read the old raw and when we persist what we sanitized from it.
    await db.update(entries).set({ contentHash: "CHANGED" }).where(eq(entries.id, id));

    const persisted = await persistResanitizedFamily(
      db,
      id,
      "content",
      { original: "<p>from stale raw</p>", cleaned: "<p>from stale raw</p>" },
      `hash-${id}` // the hash our sanitize was based on — now outdated
    );

    expect(persisted).toBe(false);
    const row = await getVersions(id);
    expect(row.contentVersion).toBe(STALE_VERSION); // version untouched
    expect(row.contentSanitized).toBeNull(); // stale output not written
  });

  it("persistResanitizedFamily skips a row already at a newer version (no downgrade)", async () => {
    // A newer release wrote this family at version+1 (expand/contract rollout, or
    // we're an old release running after a rollback). The strictly-less-than CAS
    // must leave it untouched rather than clobber it with our older rules.
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId, {
      version: SANITIZER_VERSION + 1,
      contentSanitized: "<p>NEWER</p>",
    });

    const persisted = await persistResanitizedFamily(
      db,
      id,
      "content",
      { original: "<p>older rules</p>", cleaned: "<p>older rules</p>" },
      `hash-${id}`
    );

    expect(persisted).toBe(false);
    const row = await getVersions(id);
    expect(row.contentVersion).toBe(SANITIZER_VERSION + 1);
    expect(row.contentSanitized).toBe("<p>NEWER</p>");
  });

  it("sweep heals a stale family but leaves a newer sibling family untouched", async () => {
    // content is stale (version-1) while full_content was written by a newer
    // release (version+1). The row is selected (LEAST = version-1 < current), so
    // content heals, but the newer full-content family must not be downgraded.
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId, { full: true });
    await db
      .update(entries)
      .set({
        fullContentSanitizedVersion: SANITIZER_VERSION + 1,
        fullContentCleanedSanitized: "<p>NEWER FULL</p>",
      })
      .where(eq(entries.id, id));

    const result = await resanitizeStaleEntries(db, { limit: 10 });

    expect(result.contentResanitized).toBe(1);
    expect(result.fullContentResanitized).toBe(0);
    const row = await getVersions(id);
    expect(row.contentVersion).toBe(SANITIZER_VERSION);
    expect(row.fullVersion).toBe(SANITIZER_VERSION + 1);
    expect(row.fullSanitized).toBe("<p>NEWER FULL</p>");
  });

  it("uses idx_entries_resanitize with no sort (EXPLAIN)", async () => {
    const feedId = await seedFeed();
    // Enough rows + fresh stats so the planner has a real choice to make.
    for (let i = 0; i < 40; i++) await seedStaleEntry(feedId);
    await db.execute(sql`ANALYZE entries`);

    const query = selectStaleEntriesForResanitize(db, RESANITIZE_BATCH_SIZE);
    const plan = await db.transaction(async (tx) => {
      // Disable seq scan so "index vs. seq scan" cost noise can't hide a genuine
      // failure to match the expression index; a Sort in the plan would then
      // reveal the index doesn't provide the required order.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explain = await tx.execute(sql`EXPLAIN ${query.getSQL()}`);
      return explain.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
    });

    expect(plan).toContain("idx_entries_resanitize");
    expect(plan).not.toContain("Sort");
  });
});

describe("handleResanitizeEntries", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("heals the corpus across stateless runs, then idles", async () => {
    const feedId = await seedFeed();
    const total = RESANITIZE_BATCH_SIZE + 2; // spans two batches
    const ids: string[] = [];
    for (let i = 0; i < total; i++) ids.push(await seedStaleEntry(feedId));

    // First run heals a full batch and asks to be run again soon.
    const run1 = await handleResanitizeEntries({});
    expect(run1.success).toBe(true);
    expect(run1.metadata?.status).toBe("in_progress");
    expect(await countHealed(ids)).toBe(RESANITIZE_BATCH_SIZE);

    // Second run finishes the remainder (still "in_progress" — nonzero work).
    const run2 = await handleResanitizeEntries({});
    expect(run2.metadata?.status).toBe("in_progress");
    expect(await countHealed(ids)).toBe(total);

    // Third run finds nothing stale → idle, with the far-future reschedule.
    const before = Date.now();
    const run3 = await handleResanitizeEntries({});
    expect(run3.metadata?.status).toBe("idle");
    expect(run3.metadata?.processed).toBe(0);
    expect(run3.nextRunAt.getTime() - before).toBeGreaterThan(10 * 60 * 1000);
  });

  it("resumes automatically after a (simulated) version bump", async () => {
    const feedId = await seedFeed();
    // A fresh content-only row — nothing to do.
    await seedStaleEntry(feedId, { version: SANITIZER_VERSION });
    expect((await handleResanitizeEntries({})).metadata?.status).toBe("idle");

    // A bump is modeled by a row landing below the current version; the very
    // next stateless run picks it up with no cursor to reset.
    const stale = await seedStaleEntry(feedId);
    const run = await handleResanitizeEntries({});
    expect(run.metadata?.status).toBe("in_progress");
    expect((await getVersions(stale)).contentVersion).toBe(SANITIZER_VERSION);
  });
});

/** Count how many of the given entries are healed to the current version. */
async function countHealed(ids: string[]): Promise<number> {
  const rows = await db
    .select({ id: entries.id, v: entries.contentSanitizedVersion })
    .from(entries)
    .where(inArray(entries.id, ids));
  return rows.filter((r) => r.v === SANITIZER_VERSION).length;
}
