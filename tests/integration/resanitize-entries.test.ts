/**
 * Integration tests for the entry re-sanitization primitives
 * (src/server/services/resanitize.ts).
 *
 * `selectStaleEntriesForResanitize` finds entries whose stored
 * `entries.*_sanitized` columns were left stale by a SANITIZER_VERSION bump
 * (used by the manual bulk script, scripts/resanitize-bulk.ts), and
 * `persistResanitizedFamily` writes healed output under a compare-and-swap
 * guard (shared with the read-path self-heal) so it can't clobber concurrent
 * writes. All exercised here against a real database, including EXPLAIN checks
 * that the staleness query actually uses `idx_entries_resanitize` (no sort).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { SANITIZER_VERSION } from "../../src/server/html/sanitize";
import {
  selectStaleEntriesForResanitize,
  persistResanitizedFamily,
} from "../../src/server/services/resanitize";

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

describe("selectStaleEntriesForResanitize", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("selects rows with a stale family (both families reported)", async () => {
    const feedId = await seedFeed();
    const id = await seedStaleEntry(feedId, { full: true });

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].contentSanitizedVersion).toBe(STALE_VERSION);
    expect(rows[0].fullContentSanitizedVersion).toBe(STALE_VERSION);
  });

  it("does NOT treat a content-only entry's NULL full-content version as stale", async () => {
    // Regression: the dominant production row is content sanitized at the
    // current version with full_content_sanitized_version = NULL (full content
    // never fetched). That row is fully fresh and must be left alone — otherwise
    // the staleness query targets the whole table forever.
    const feedId = await seedFeed();
    await seedStaleEntry(feedId, { version: SANITIZER_VERSION });

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows).toHaveLength(0);
  });

  it("selects a row whose full-content family is stale while content is fresh", async () => {
    const feedId = await seedFeed();
    // Full content present but at a stale version, content family already fresh.
    const id = await seedStaleEntry(feedId, { version: SANITIZER_VERSION, full: true });
    await db
      .update(entries)
      .set({ fullContentSanitizedVersion: STALE_VERSION })
      .where(eq(entries.id, id));

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });

  it("skips rows already at the current version", async () => {
    const feedId = await seedFeed();
    await seedStaleEntry(feedId, { version: SANITIZER_VERSION });
    const stale = await seedStaleEntry(feedId);

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows.map((r) => r.id)).toEqual([stale]);
  });

  it("orders newest-first among rows at the same stale version", async () => {
    const feedId = await seedFeed();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedStaleEntry(feedId));
    // UUIDv7 ids minted within a ms aren't strictly monotonic; sort to learn the
    // true newest-first order (string order == uuid order).
    const newestFirst = [...ids].sort().reverse();

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows.map((r) => r.id)).toEqual(newestFirst);
  });

  it("orders the highest stale version before older ones", async () => {
    const feedId = await seedFeed();
    // Straggler at an older version (from an unfinished earlier pass) plus a
    // row at the previous version. The previous-version row is the higher stale
    // key, so it comes first.
    const older = await seedStaleEntry(feedId, { version: STALE_VERSION - 1 });
    const newerVersion = await seedStaleEntry(feedId, { version: STALE_VERSION });

    const rows = await selectStaleEntriesForResanitize(db, 10);

    expect(rows.map((r) => r.id)).toEqual([newerVersion, older]);
  });

  it("keyset-paginates within the stale range on (stalenessKey, id) descending", async () => {
    const feedId = await seedFeed();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedStaleEntry(feedId));
    const newestFirst = [...ids].sort().reverse();

    const [first] = await selectStaleEntriesForResanitize(db, 1);
    const rest = await selectStaleEntriesForResanitize(db, 10, {
      stalenessKey: first.stalenessKey,
      id: first.id,
    });

    expect([first.id, ...rest.map((r) => r.id)]).toEqual(newestFirst);
  });

  it("uses idx_entries_resanitize with no sort (EXPLAIN)", async () => {
    const feedId = await seedFeed();
    // Enough rows + fresh stats so the planner has a real choice to make.
    for (let i = 0; i < 40; i++) await seedStaleEntry(feedId);
    await db.execute(sql`ANALYZE entries`);

    const query = selectStaleEntriesForResanitize(db, 10);
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

  it("uses idx_entries_resanitize with no sort when keyset-paginated (EXPLAIN)", async () => {
    const feedId = await seedFeed();
    for (let i = 0; i < 40; i++) await seedStaleEntry(feedId);
    await db.execute(sql`ANALYZE entries`);

    // The bulk script (scripts/resanitize-bulk.ts) pages the stale set with a
    // keyset cursor; guard that the cursor variant still seeks the index rather
    // than falling back to a pkey walk + filter (the pre-fix regression that
    // scanned the whole table when little was stale).
    const query = selectStaleEntriesForResanitize(db, 10, {
      stalenessKey: SANITIZER_VERSION - 1,
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    });
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const explain = await tx.execute(sql`EXPLAIN ${query.getSQL()}`);
      return explain.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
    });

    expect(plan).toContain("idx_entries_resanitize");
    expect(plan).not.toContain("Sort");
  });
});

describe("persistResanitizedFamily", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("writes when version is stale and hash matches", async () => {
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

  it("skips when the content changed under it (TOCTOU guard)", async () => {
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

  it("skips a row already at a newer version (no downgrade)", async () => {
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
});
