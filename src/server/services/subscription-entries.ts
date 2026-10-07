/**
 * Consistency check for `subscription_entries` (#1846 phase 4).
 *
 * Until phase 7 the memberships are a trigger-maintained copy of three older
 * forms: `user_entries.subscription_id`, `collection_entries`, and saved
 * articles (`user_entries` rows of saved entries with no subscription, which
 * belong to the user's saved subscription). Nothing reads the copy yet, so the
 * daily `reconcile_membership_counters` job runs this check to prove it complete before
 * phase 5 starts reading it. Any finding is a mirror-trigger bug and is logged
 * at error level, except before the backfill has finished (it marks the table
 * with `BACKFILLED_COMMENT`), when missing rows are expected and it's a
 * warning. Repair by re-running `scripts/backfill-subscription-entries.ts`,
 * which only adds what's missing.
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { logger } from "@/lib/logger";

/** The table comment the backfill sets when it finishes. */
export const BACKFILLED_COMMENT = "Backfilled by scripts/backfill-subscription-entries.ts";

export interface SubscriptionEntriesCheck {
  /** Old-form memberships with no subscription_entries row. */
  missing: number;
  /** subscription_entries rows no old form explains. */
  extra: number;
  /** Rows whose sort key differs from their user_entries row's. */
  misdated: number;
}

/**
 * Compares every membership with the old forms. A redirect merge keeps the
 * article in the subscription it moved from, which is then unsubscribed (and
 * after chained merges nothing records which one that was), so a web
 * subscription may also hold its own feed's articles, or any while
 * unsubscribed; any other extra row is reported.
 */
export async function checkSubscriptionEntries(
  db: typeof dbType
): Promise<SubscriptionEntriesCheck> {
  const result = await db.execute<{
    missing: number;
    extra: number;
    misdated: number;
    backfilled: boolean | null;
  }>(sql`
    WITH expected AS (
      SELECT ue.subscription_id, ue.entry_id
      FROM user_entries ue
      WHERE ue.subscription_id IS NOT NULL
      UNION ALL
      SELECT ce.subscription_id, ce.entry_id
      FROM collection_entries ce
      UNION ALL
      SELECT s.id, ue.entry_id
      FROM user_entries ue
      JOIN entries e ON e.id = ue.entry_id AND e.type = 'saved'
      LEFT JOIN subscriptions s ON s.user_id = ue.user_id AND s.type = 'saved'
      WHERE ue.subscription_id IS NULL
    ),
    held AS (
      SELECT
        se.published_or_fetched_at <> ue.published_or_fetched_at AS misdated,
        -- CASE, not OR, so only the few rows that aren't their article's
        -- source reach the lookups.
        CASE
          WHEN ue.subscription_id = se.subscription_id THEN true
          WHEN s.type = 'collection' THEN EXISTS (
            SELECT 1 FROM collection_entries ce
            WHERE ce.subscription_id = se.subscription_id AND ce.entry_id = se.entry_id
          )
          WHEN s.type = 'saved' THEN ue.subscription_id IS NULL AND EXISTS (
            SELECT 1 FROM entries e WHERE e.id = se.entry_id AND e.type = 'saved'
          )
          WHEN s.type = 'web' THEN s.unsubscribed_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM entries e WHERE e.id = se.entry_id AND e.feed_id = s.feed_id
          )
          ELSE false
        END AS explained
      FROM subscription_entries se
      JOIN subscriptions s ON s.id = se.subscription_id
      JOIN user_entries ue ON ue.user_id = se.user_id AND ue.entry_id = se.entry_id
    )
    SELECT
      (SELECT count(*) FROM expected x
       WHERE NOT EXISTS (
         SELECT 1 FROM subscription_entries se
         WHERE se.subscription_id = x.subscription_id AND se.entry_id = x.entry_id
       ))::int AS missing,
      (SELECT count(*) FROM held WHERE explained IS NOT TRUE)::int AS extra,
      (SELECT count(*) FROM held WHERE misdated)::int AS misdated,
      obj_description('subscription_entries'::regclass, 'pg_class') = ${BACKFILLED_COMMENT}
        AS backfilled
  `);
  const { backfilled, ...check } = result.rows[0];
  if (check.missing > 0 || check.extra > 0 || check.misdated > 0) {
    const message = "subscription_entries differs from the memberships it mirrors";
    if (backfilled) {
      logger.error(message, { ...check });
    } else {
      logger.warn(`${message} (not backfilled yet)`, { ...check });
    }
  }
  return check;
}
