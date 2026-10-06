/**
 * Backfills `subscription_entries` (#1846 phase 4B) from the memberships the
 * mirror triggers copy going forward, then runs the daily consistency check.
 *
 * Usage (with DATABASE_URL set, after migration 0132 is deployed):
 *   pnpm exec tsx scripts/backfill-subscription-entries.ts [--batch-size 5000] [--after <user_id>,<entry_id>] [--check-only]
 *
 * 1. Gives every user with a saved feed their saved subscription.
 * 2. Walks user_entries in primary-key order, one batch per statement: a row
 *    joins its `subscription_id`, or for a saved article the saved
 *    subscription.
 * 3. Copies collection_entries.
 *
 * Every write is ON CONFLICT DO NOTHING, so it's safe to re-run, and runs
 * alongside live traffic: rows written meanwhile are mirrored by the triggers.
 * Each batch logs its cursor; `--after` resumes step 2 from one. A user_entries
 * row deleted mid-batch fails its foreign key, and a batch can lose a deadlock to
 * live traffic; either way the batch is retried. When done, it comments the
 * table, which tells the daily check missing rows are now a bug.
 */

import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { db as dbType } from "../src/server/db";
import {
  BACKFILLED_COMMENT,
  checkSubscriptionEntries,
} from "../src/server/services/subscription-entries";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
// A row the batch read was deleted before its insert, or the batch lost a
// deadlock to live traffic: either way, running it again succeeds.
const RETRYABLE = new Set(["23503", "40P01"]);
const BATCH_ATTEMPTS = 5;

export interface BackfillOptions {
  batchSize?: number;
  /** Resume the user_entries walk after this (user_id, entry_id). */
  after?: { userId: string; entryId: string };
  log?: (message: string) => void;
}

export interface BackfillResult {
  savedSubscriptionsCreated: number;
  userEntryMemberships: number;
  collectionMemberships: number;
}

interface BatchRow extends Record<string, unknown> {
  inserted: number;
  scanned: number;
  last_a: string | null;
  last_b: string | null;
}

function isRetryable(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Runs one batch statement, retrying the failures a re-run fixes. */
async function runBatch(db: typeof dbType, statement: ReturnType<typeof sql>): Promise<BatchRow> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db.execute<BatchRow>(statement)).rows[0];
    } catch (err) {
      if (attempt >= BATCH_ATTEMPTS || !isRetryable(err)) throw err;
    }
  }
}

export async function backfillSubscriptionEntries(
  db: typeof dbType,
  { batchSize = 5000, after, log = () => {} }: BackfillOptions = {}
): Promise<BackfillResult> {
  const created = await db.execute<{ n: number }>(sql`
    SELECT COALESCE(ensure_saved_subscriptions(array_agg(user_id)), 0) AS n
    FROM feeds WHERE type = 'saved'
  `);
  const savedSubscriptionsCreated = created.rows[0].n;
  log(`saved subscriptions created: ${savedSubscriptionsCreated}`);

  let userEntryMemberships = 0;
  let cursor = after ?? { userId: NIL_UUID, entryId: NIL_UUID };
  for (;;) {
    // Saved articles carry no subscription_id: they join the user's saved
    // subscription, found only for them.
    const row = await runBatch(
      db,
      sql`
        WITH batch AS (
          SELECT ue.user_id, ue.entry_id, ue.subscription_id, ue.published_or_fetched_at
          FROM user_entries ue
          WHERE (ue.user_id, ue.entry_id) > (${cursor.userId}::uuid, ${cursor.entryId}::uuid)
          ORDER BY ue.user_id, ue.entry_id
          LIMIT ${batchSize}
        ),
        source AS (
          SELECT b.subscription_id, b.user_id, b.entry_id, b.published_or_fetched_at
          FROM batch b
          WHERE b.subscription_id IS NOT NULL
          UNION ALL
          SELECT s.id, b.user_id, b.entry_id, b.published_or_fetched_at
          FROM batch b
          JOIN entries e ON e.id = b.entry_id AND e.type = 'saved'
          JOIN subscriptions s ON s.user_id = b.user_id AND s.type = 'saved'
          WHERE b.subscription_id IS NULL
        ),
        ins AS (
          INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
          SELECT subscription_id, user_id, entry_id, published_or_fetched_at FROM source
          ON CONFLICT DO NOTHING
          RETURNING 1
        ),
        last AS (
          SELECT user_id, entry_id FROM batch ORDER BY user_id DESC, entry_id DESC LIMIT 1
        )
        SELECT (SELECT count(*) FROM ins)::int AS inserted,
               (SELECT count(*) FROM batch)::int AS scanned,
               (SELECT user_id FROM last) AS last_a,
               (SELECT entry_id FROM last) AS last_b
      `
    );
    userEntryMemberships += row.inserted;
    if (row.scanned === 0 || row.last_a === null || row.last_b === null) break;
    cursor = { userId: row.last_a, entryId: row.last_b };
    log(
      `user_entries: +${row.inserted} of ${row.scanned}, after ${cursor.userId},${cursor.entryId}`
    );
    if (row.scanned < batchSize) break;
  }

  // Key-share locks hold off a concurrent removal from the collection until the
  // copy commits, so its delete trigger then removes the copy too.
  let collectionMemberships = 0;
  let collectionCursor = { subscriptionId: NIL_UUID, entryId: NIL_UUID };
  for (;;) {
    const row = await runBatch(
      db,
      sql`
        WITH batch AS (
          SELECT ce.subscription_id, ce.user_id, ce.entry_id
          FROM collection_entries ce
          WHERE (ce.subscription_id, ce.entry_id) > (${collectionCursor.subscriptionId}::uuid, ${collectionCursor.entryId}::uuid)
          ORDER BY ce.subscription_id, ce.entry_id
          LIMIT ${batchSize}
          FOR KEY SHARE
        ),
        ins AS (
          INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
          SELECT b.subscription_id, b.user_id, b.entry_id, ue.published_or_fetched_at
          FROM batch b
          JOIN user_entries ue ON ue.user_id = b.user_id AND ue.entry_id = b.entry_id
          ON CONFLICT DO NOTHING
          RETURNING 1
        ),
        last AS (
          SELECT subscription_id, entry_id FROM batch
          ORDER BY subscription_id DESC, entry_id DESC LIMIT 1
        )
        SELECT (SELECT count(*) FROM ins)::int AS inserted,
               (SELECT count(*) FROM batch)::int AS scanned,
               (SELECT subscription_id FROM last) AS last_a,
               (SELECT entry_id FROM last) AS last_b
      `
    );
    collectionMemberships += row.inserted;
    if (row.scanned === 0 || row.last_a === null || row.last_b === null) break;
    collectionCursor = { subscriptionId: row.last_a, entryId: row.last_b };
    log(`collection_entries: +${row.inserted} of ${row.scanned}`);
    if (row.scanned < batchSize) break;
  }

  // Marks the table, so the daily check treats anything missing as a bug.
  await db.execute(sql.raw(`COMMENT ON TABLE subscription_entries IS '${BACKFILLED_COMMENT}'`));

  return { savedSubscriptionsCreated, userEntryMemberships, collectionMemberships };
}

function parseArgs(argv: string[]): { options: BackfillOptions; checkOnly: boolean } {
  const options: BackfillOptions = { log: (m) => console.log(m) };
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--batch-size") options.batchSize = Number(argv[++i]);
    else if (arg === "--after") {
      const [userId, entryId] = (argv[++i] ?? "").split(",");
      if (!userId || !entryId) throw new Error("--after takes <user_id>,<entry_id>");
      options.after = { userId, entryId };
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.batchSize !== undefined && !(options.batchSize > 0)) {
    throw new Error("--batch-size must be a positive number");
  }
  return { options, checkOnly };
}

async function main(): Promise<void> {
  const { options, checkOnly } = parseArgs(process.argv.slice(2));
  const { db, pool } = await import("../src/server/db");
  try {
    if (!checkOnly) {
      const started = Date.now();
      const result = await backfillSubscriptionEntries(db, options);
      console.log(
        `Backfilled in ${((Date.now() - started) / 1000).toFixed(1)} s:`,
        JSON.stringify(result)
      );
    }
    const started = Date.now();
    const check = await checkSubscriptionEntries(db);
    console.log(`Check (${((Date.now() - started) / 1000).toFixed(1)} s):`, JSON.stringify(check));
    process.exitCode = check.missing > 0 || check.extra > 0 || check.misdated > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
