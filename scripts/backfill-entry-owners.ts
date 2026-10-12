/**
 * Backfills email and saved entries' owners (#1846 phase 6A), then checks
 * them.
 *
 * Usage (with DATABASE_URL set, after migration 0137, while maintenance mode
 * is still on):
 *   pnpm exec tsx scripts/backfill-entry-owners.ts [--batch-size 5000] [--check-only]
 *
 * A web entry's owner is its feed (`owner_feed_id`, which 0137 renamed from
 * `feed_id`), so it needs nothing. An email gets `owner_subscription_id`, the
 * subscription to its per-user email feed; a saved article or upload gets
 * `owner_user_id`, its saved feed's user. Both keep `owner_feed_id` (that
 * per-user feed) until phase 6B. Walks the email and saved entries in
 * primary-key order, one batch per statement, and writes only rows that have
 * no owner yet, so it's safe to re-run. It doesn't move `updated_at`, so delta
 * sync doesn't re-deliver anything.
 */

import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { db as dbType } from "../src/server/db";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface EntryOwnersCheck {
  /** Email or saved entries without their owner. */
  unowned: number;
  /** Entries whose email/saved owner isn't the one their type and feed give, or a web entry with one. */
  mismatched: number;
}

/** The owners 0137's rule gives the entry `e`: (owner_subscription_id, owner_user_id). */
const EXPECTED_SUBSCRIPTION = sql.raw(`CASE WHEN e.type = 'email' THEN (
  SELECT s.id FROM subscriptions s WHERE s.feed_id = e.owner_feed_id AND s.type = 'email'
) END`);
const EXPECTED_USER = sql.raw(`CASE WHEN e.type = 'saved' THEN (
  SELECT f.user_id FROM feeds f WHERE f.id = e.owner_feed_id
) END`);

export async function backfillEntryOwners(
  db: typeof dbType,
  { batchSize = 5000, log = () => {} }: { batchSize?: number; log?: (m: string) => void } = {}
): Promise<{ updated: number }> {
  let updated = 0;
  let cursor = NIL_UUID;
  for (;;) {
    const result = await db.execute<{
      updated: number;
      scanned: number;
      last_id: string | null;
    }>(sql`
      WITH batch AS (
        SELECT id FROM entries
        WHERE id > ${cursor}::uuid AND type IN ('email', 'saved')
        ORDER BY id LIMIT ${batchSize}
      ),
      upd AS (
        UPDATE entries e
        SET owner_subscription_id = ${EXPECTED_SUBSCRIPTION},
            owner_user_id = ${EXPECTED_USER}
        FROM batch b
        WHERE e.id = b.id AND e.owner_subscription_id IS NULL AND e.owner_user_id IS NULL
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM upd)::int AS updated,
             (SELECT count(*) FROM batch)::int AS scanned,
             (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id
    `);
    const row = result.rows[0];
    updated += row.updated;
    if (row.scanned === 0 || row.last_id === null) break;
    cursor = row.last_id;
    log(`entries: +${row.updated} of ${row.scanned}, after ${cursor}`);
    if (row.scanned < batchSize) break;
  }
  return { updated };
}

/** Counts email and saved entries without their owner, and wrong owners. */
export async function checkEntryOwners(db: typeof dbType): Promise<EntryOwnersCheck> {
  const result = await db.execute<{ unowned: number; mismatched: number }>(sql`
    SELECT count(*) FILTER (
             WHERE e.type IN ('email', 'saved')
               AND e.owner_subscription_id IS NULL AND e.owner_user_id IS NULL
           )::int AS unowned,
           count(*) FILTER (
             WHERE (e.owner_subscription_id IS NOT NULL OR e.owner_user_id IS NOT NULL)
               AND (e.owner_subscription_id, e.owner_user_id)
                 IS DISTINCT FROM (${EXPECTED_SUBSCRIPTION}, ${EXPECTED_USER})
           )::int AS mismatched
    FROM entries e
  `);
  return result.rows[0];
}

function parseArgs(argv: string[]): { batchSize?: number; checkOnly: boolean } {
  let batchSize: number | undefined;
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check-only") checkOnly = true;
    else if (arg === "--batch-size") batchSize = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (batchSize !== undefined && !(batchSize > 0)) {
    throw new Error("--batch-size must be a positive number");
  }
  return { batchSize, checkOnly };
}

async function main(): Promise<void> {
  const { batchSize, checkOnly } = parseArgs(process.argv.slice(2));
  const { db, pool } = await import("../src/server/db");
  try {
    if (!checkOnly) {
      const started = Date.now();
      const result = await backfillEntryOwners(db, { batchSize, log: (m) => console.log(m) });
      console.log(
        `Backfilled in ${((Date.now() - started) / 1000).toFixed(1)} s:`,
        JSON.stringify(result)
      );
    }
    const started = Date.now();
    const check = await checkEntryOwners(db);
    console.log(`Check (${((Date.now() - started) / 1000).toFixed(1)} s):`, JSON.stringify(check));
    process.exitCode = check.unowned > 0 || check.mismatched > 0 ? 1 : 0;
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
