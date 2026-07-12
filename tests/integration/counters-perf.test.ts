/**
 * Performance checks for the unread-counter triggers (issue #1117, migration
 * 0092): measures the write-path overhead the statement-level triggers add to
 * the hot user_entries statements, times the reconciliation sweep, and prints
 * EXPLAIN ANALYZE for the counter-era queries.
 *
 * Overhead is isolated directly: the SAME statements run against the SAME data
 * with the counter triggers disabled vs enabled (ALTER TABLE ... DISABLE
 * TRIGGER), so the delta is purely trigger cost.
 *
 * Skipped by default. Run with:
 *   RUN_PERF_TESTS=1 pnpm test:integration:local -- tests/integration/counters-perf.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";

// ============================================================================
// Configuration — sized to the current production shape (~280k user_entries
// total; heaviest user ~50k entries across a few hundred subscriptions).
// ============================================================================

const NUM_SUBSCRIPTIONS = 200;
const ENTRIES_PER_FEED = 250; // 200 × 250 = 50k entries / user_entries
const FANOUT_BATCH = 5_000; // rows per bulk fanout-style INSERT benchmark
const SMALL_BATCH = 50; // rows per markEntriesRead-style UPDATE benchmark
const RUNS = 5;

const COUNTER_TRIGGERS = [
  "user_entries_counters_insert_trigger",
  "user_entries_counters_update_trigger",
  "user_entries_counters_delete_trigger",
];

// ============================================================================
// Helpers
// ============================================================================

function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function setTriggers(enabled: boolean) {
  for (const t of COUNTER_TRIGGERS) {
    await db.execute(
      sql.raw(`ALTER TABLE user_entries ${enabled ? "ENABLE" : "DISABLE"} TRIGGER ${t}`)
    );
  }
}

async function explainAnalyze(label: string, query: string) {
  const result = await db.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${query}`));
  console.log(`\n=== EXPLAIN ANALYZE: ${label} ===`);
  for (const row of result.rows as Array<{ "QUERY PLAN": string }>) {
    console.log(`  ${row["QUERY PLAN"]}`);
  }
}

function report(label: string, off: number[], on: number[]) {
  const offMs = median(off);
  const onMs = median(on);
  console.log(
    `${label}: triggers OFF ${offMs.toFixed(1)}ms | ON ${onMs.toFixed(1)}ms | overhead +${(
      onMs - offMs
    ).toFixed(1)}ms (${offMs > 0 ? (((onMs - offMs) / offMs) * 100).toFixed(0) : "?"}%)`
  );
  return { offMs, onMs };
}

// ============================================================================
// Setup
// ============================================================================

let userId: string;

describe.skipIf(!process.env.RUN_PERF_TESTS)("Unread counter performance", () => {
  beforeAll(async () => {
    userId = generateUuidv7();
    console.log("\n--- Seeding counters perf dataset ---");
    const start = performance.now();

    await db.execute(sql`
      INSERT INTO users (id, email, password_hash)
      VALUES (${userId}, ${`counters-perf-${userId}@test.com`}, 'test-hash')
    `);

    // 200 feeds + subscriptions + 50k entries + 50k user_entries, all set-based.
    await db.execute(sql`
      INSERT INTO feeds (id, type, url, title)
      SELECT gen_random_uuid(), 'web', 'https://perf.example.com/feed-' || g, 'Perf Feed ' || g
      FROM generate_series(1, ${NUM_SUBSCRIPTIONS}) g
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO subscriptions (id, user_id, feed_id)
      SELECT gen_random_uuid(), ${userId}::uuid, f.id
      FROM feeds f WHERE f.url LIKE 'https://perf.example.com/feed-%'
    `);
    await db.execute(sql`
      INSERT INTO entries (id, feed_id, type, guid, title, content_hash, fetched_at, last_seen_at, published_at)
      SELECT gen_random_uuid(), f.id, 'web', 'perf-guid-' || f.id || '-' || g,
             'Perf Entry', 'hash', now(), now(), now() - (g || ' minutes')::interval
      FROM feeds f, generate_series(1, ${ENTRIES_PER_FEED}) g
      WHERE f.url LIKE 'https://perf.example.com/feed-%'
    `);
    // Seed user_entries with counter triggers ENABLED — this itself is a giant
    // fanout-shaped statement, and leaves the counters exact for later checks.
    await db.execute(sql`
      INSERT INTO user_entries (user_id, entry_id, subscription_id, is_spam, published_or_fetched_at)
      SELECT ${userId}::uuid, e.id, s.id, false, COALESCE(e.published_at, e.fetched_at)
      FROM entries e
      JOIN feeds f ON f.id = e.feed_id
      JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = ${userId}::uuid
      WHERE f.url LIKE 'https://perf.example.com/feed-%'
      ON CONFLICT DO NOTHING
    `);

    console.log(`  Seeded in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  }, 300_000);

  afterAll(async () => {
    await setTriggers(true);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`);
    await db.execute(sql`DELETE FROM feeds WHERE url LIKE 'https://perf.example.com/feed-%'`);
  });

  it("measures trigger overhead on the hot write paths", async () => {
    console.log(`\n--- Write-path trigger overhead (median of ${RUNS}) ---`);

    // ---- Bulk fanout-style INSERT (FANOUT_BATCH rows in one statement) ----
    // Uses a scratch second user so inserts don't disturb the main dataset.
    const scratchUser = generateUuidv7();
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash)
      VALUES (${scratchUser}, ${`counters-perf-scratch-${scratchUser}@test.com`}, 'test-hash')
    `);
    await db.execute(sql`
      INSERT INTO subscriptions (id, user_id, feed_id)
      SELECT gen_random_uuid(), ${scratchUser}::uuid, f.id
      FROM feeds f WHERE f.url LIKE 'https://perf.example.com/feed-%'
    `);

    const insertBatch = () => sql`
      INSERT INTO user_entries (user_id, entry_id, subscription_id, is_spam, published_or_fetched_at)
      SELECT ${scratchUser}::uuid, e.id, s.id, false, COALESCE(e.published_at, e.fetched_at)
      FROM entries e
      JOIN subscriptions s ON s.feed_id = e.feed_id AND s.user_id = ${scratchUser}::uuid
      WHERE e.guid LIKE 'perf-guid-%'
        AND NOT EXISTS (
          SELECT 1 FROM user_entries ue
          WHERE ue.user_id = ${scratchUser}::uuid AND ue.entry_id = e.id
        )
      LIMIT ${FANOUT_BATCH}
    `;
    const resetInserts = () =>
      db.execute(sql`DELETE FROM user_entries WHERE user_id = ${scratchUser}::uuid`);

    const insertOff: number[] = [];
    const insertOn: number[] = [];
    for (const [enabled, samples] of [
      [false, insertOff],
      [true, insertOn],
    ] as const) {
      await setTriggers(enabled);
      for (let i = 0; i < RUNS; i++) {
        await resetInserts();
        samples.push(await timed(() => db.execute(insertBatch())));
      }
      await resetInserts();
    }
    report(`bulk INSERT (${FANOUT_BATCH} rows)`, insertOff, insertOn);

    // ---- Small UPDATE (markEntriesRead shape, SMALL_BATCH rows) ----
    const flipSmall = (read: boolean) => sql`
      UPDATE user_entries SET read = ${read}, read_changed_at = now()
      WHERE (user_id, entry_id) IN (
        SELECT user_id, entry_id FROM user_entries
        WHERE user_id = ${userId}::uuid
        ORDER BY entry_id
        LIMIT ${SMALL_BATCH}
      )
    `;
    const smallOff: number[] = [];
    const smallOn: number[] = [];
    for (const [enabled, samples] of [
      [false, smallOff],
      [true, smallOn],
    ] as const) {
      await setTriggers(enabled);
      for (let i = 0; i < RUNS * 2; i++) {
        samples.push(await timed(() => db.execute(flipSmall(i % 2 === 0))));
      }
      // Leave rows unread for the next section.
      await db.execute(flipSmall(false));
    }
    report(`small UPDATE (${SMALL_BATCH} rows)`, smallOff, smallOn);

    // ---- Bulk UPDATE (mark-all-read shape, all 50k rows) ----
    const flipAll = (read: boolean) => sql`
      UPDATE user_entries SET read = ${read}, read_changed_at = now()
      WHERE user_id = ${userId}::uuid AND read = ${!read}
    `;
    const bulkOff: number[] = [];
    const bulkOn: number[] = [];
    for (const [enabled, samples] of [
      [false, bulkOff],
      [true, bulkOn],
    ] as const) {
      await setTriggers(enabled);
      for (let i = 0; i < RUNS * 2; i++) {
        samples.push(await timed(() => db.execute(flipAll(i % 2 === 0))));
      }
      await db.execute(flipAll(false));
    }
    report(
      `bulk UPDATE (${NUM_SUBSCRIPTIONS * ENTRIES_PER_FEED} rows, ${NUM_SUBSCRIPTIONS} buckets)`,
      bulkOff,
      bulkOn
    );

    // Triggers were disabled for part of the runs above: reconcile, then the
    // counters must be exact again (also proves reconcile fixes bulk drift).
    await setTriggers(true);
    await reconcileCounters(db);
    const check = await reconcileCounters(db);
    expect(check).toEqual({ subscriptionsFixed: 0, usersFixed: 0 });

    await db.execute(sql`DELETE FROM users WHERE id = ${scratchUser}::uuid`);
  }, 600_000);

  it("times the reconciliation sweep and explains its plans", async () => {
    console.log("\n--- Reconciliation sweep ---");
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      samples.push(await timed(() => reconcileCounters(db)));
    }
    console.log(`reconcileCounters (50k rows): median ${median(samples).toFixed(1)}ms`);

    await explainAnalyze(
      "reconcile subscriptions (no-drift pass)",
      `UPDATE subscriptions s
       SET unread_count = COALESCE(t.u, 0), starred_unread_count = COALESCE(t.su, 0)
       FROM subscriptions s2
       LEFT JOIN (
         SELECT subscription_id, count(*)::int AS u,
                count(*) FILTER (WHERE starred)::int AS su
         FROM user_entries
         WHERE subscription_id IS NOT NULL AND NOT read AND NOT is_spam
         GROUP BY subscription_id
       ) t ON t.subscription_id = s2.id
       WHERE s.id = s2.id
         AND (s2.unread_count IS DISTINCT FROM COALESCE(t.u, 0)
           OR s2.starred_unread_count IS DISTINCT FROM COALESCE(t.su, 0))`
    );
  }, 300_000);

  it("compares the step-5b badge arithmetic against the current scan (informational)", async () => {
    // Current production shape (visible_entries scan over unread rows).
    const scanQuery = `SELECT count(*)::int AS all_unread,
              count(*) FILTER (WHERE starred)::int AS starred_unread,
              count(*) FILTER (WHERE type = 'saved')::int AS saved_unread
       FROM visible_entries
       WHERE user_id = '${userId}' AND read = false`;
    // Step 5b replacement: pure counter arithmetic.
    const arithmeticQuery = `SELECT COALESCE(sum(s.unread_count) FILTER (WHERE s.unsubscribed_at IS NULL), 0)::int
              + u.saved_unread_count
              + COALESCE(sum(s.starred_unread_count) FILTER (WHERE s.unsubscribed_at IS NOT NULL), 0)::int
                AS all_unread,
              u.starred_unread_count AS starred_unread,
              u.saved_unread_count AS saved_unread
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       WHERE u.id = '${userId}'
       GROUP BY u.id, u.saved_unread_count, u.starred_unread_count`;

    const scan: number[] = [];
    const arith: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      scan.push(await timed(() => db.execute(sql.raw(scanQuery))));
      arith.push(await timed(() => db.execute(sql.raw(arithmeticQuery))));
    }
    console.log("\n--- Badge query: current scan vs counter arithmetic (50k unread) ---");
    console.log(`visible_entries scan:  median ${median(scan).toFixed(1)}ms`);
    console.log(`counter arithmetic:    median ${median(arith).toFixed(1)}ms`);

    // Both must agree (the counters are exact after the previous test).
    const scanResult = (await db.execute(sql.raw(scanQuery))).rows[0];
    const arithResult = (await db.execute(sql.raw(arithmeticQuery))).rows[0];
    expect(arithResult).toEqual(scanResult);

    await explainAnalyze("current visible_entries scan", scanQuery);
    await explainAnalyze("counter arithmetic", arithmeticQuery);
  }, 300_000);
});
