/**
 * Writing memberships (`subscription_entries`, #1846), and the forms the
 * previous release still reads.
 *
 * Every path that gives a user an article writes its membership itself:
 * {@link insertUserEntriesWithMemberships} for an article's source (fetch
 * fan-out, subscribe-time populate, email, save), and the collection and merge
 * services for the rest.
 *
 * Until #1846 phase 7B, the previous release still writes and reads two older
 * forms, `user_entries.subscription_id` (filled on insert by a trigger) and
 * `collection_entries`, and mirror triggers copy its writes into memberships.
 * So that it stays correct on rows this release writes (during a rollout, or
 * after a rollback), this release keeps both forms current while they exist
 * ({@link legacyMembershipForms}), and the daily `reconcile_membership_counters`
 * job checks memberships against them ({@link checkSubscriptionEntries}). Any
 * finding is a bug, logged at error level.
 */

import { sql, type SQL } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { logger } from "@/lib/logger";
import { canonicalGuidSql } from "@/server/feed/guid-identity";

/** The table comment the backfill sets when it finishes. */
export const BACKFILLED_COMMENT = "Backfilled by scripts/backfill-subscription-entries.ts";

/**
 * Gives users articles: for each candidate row, its `user_entries` row
 * (unless the user has one) and its membership in the candidate's
 * subscription, in one statement, so no crash leaves an article without its
 * membership. Idempotent: a candidate whose membership exists is skipped.
 *
 * `candidates` is a SELECT of `subscription_id, user_id, entry_id,
 * published_or_fetched_at, is_spam, read`, the new row's values. The
 * membership copies the sort key of an existing row rather than the
 * candidate's, since the two must agree.
 *
 * The membership insert is the main statement and the `user_entries` insert a
 * CTE nothing reads, so Postgres runs it last and the membership triggers fire
 * first: they lock the subscriptions before the `user_entries` triggers lock
 * the users, the lock order in `src/server/CLAUDE.md`. (A CTE the main
 * statement read from would fire its triggers first.)
 *
 * Returns the memberships it added.
 */
export async function insertUserEntriesWithMemberships(
  db: DbOrTx,
  candidates: SQL
): Promise<Array<{ subscriptionId: string; entryId: string }>> {
  const result = await db.execute<{ subscription_id: string; entry_id: string }>(sql`
    WITH c AS (${candidates}),
    missing AS (
      SELECT c.subscription_id, c.user_id, c.entry_id, c.is_spam, c.read,
             COALESCE(ue.published_or_fetched_at, c.published_or_fetched_at) AS published_or_fetched_at
      FROM c
      LEFT JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
      WHERE NOT EXISTS (
        SELECT 1 FROM subscription_entries se
        WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      )
    ),
    new_rows AS (
      INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, is_spam, read)
      SELECT user_id, entry_id, published_or_fetched_at, is_spam, read FROM missing
      ON CONFLICT DO NOTHING
    )
    INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
    SELECT subscription_id, user_id, entry_id, published_or_fetched_at FROM missing
    ON CONFLICT DO NOTHING
    RETURNING subscription_id, entry_id
  `);
  return result.rows.map((r) => ({ subscriptionId: r.subscription_id, entryId: r.entry_id }));
}

/**
 * Whether subscription `subscriptionId` already holds a twin of the web entry
 * aliased `entry` (the same guid, compared as `guid-identity.ts` requires)
 * from another feed: a redirect merge copied the subscription's old feed's
 * articles into it, and the new feed usually republishes them. Insert paths
 * skip such an entry.
 *
 * Starts from the entry's twins, found through
 * `idx_entries_web_guid_canonical` (normally none), then probes the
 * membership by primary key; starting from the subscription's articles walks
 * all of them for every subscriber and entry (#1861). `type = 'web'` lets the
 * partial index serve the lookup and drops nothing, since only web
 * subscriptions are merged.
 */
export function holdsRedirectTwin(subscriptionId: SQL, entry: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM entries e_prev
    JOIN subscription_entries se_prev
      ON se_prev.subscription_id = ${subscriptionId} AND se_prev.entry_id = e_prev.id
    WHERE e_prev.type = 'web'
      AND ${sql.raw(canonicalGuidSql("e_prev.guid"))} = ${sql.raw(canonicalGuidSql(`${entry}.guid`))}
      AND e_prev.owner_feed_id <> ${sql.raw(`${entry}.owner_feed_id`)}
  )`;
}

/**
 * Whether the previous release's membership forms still exist. #1846 phase
 * 7B's migration drops `collection_entries` and `user_entries.subscription_id`
 * together; until then this release keeps them current for the previous
 * release, which still reads them: `collection_entries` to add and remove
 * collection members, and the column for its fan-out's redirect check and its
 * merges. Ask inside the transaction that writes, after it has touched
 * `user_entries`: 7B's migration then waits for it to commit, so the answer
 * holds for the rest of the transaction.
 *
 * Temporary: 7B removes it with the forms.
 */
export async function legacyMembershipForms(db: DbOrTx): Promise<boolean> {
  const result = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('public.collection_entries') IS NOT NULL AS present`
  );
  return result.rows[0]?.present ?? false;
}

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
 * unsubscribed; any other extra row is reported. Returns null without
 * checking once the old forms are gone.
 */
export async function checkSubscriptionEntries(
  db: typeof dbType
): Promise<SubscriptionEntriesCheck | null> {
  if (!(await legacyMembershipForms(db))) {
    return null;
  }
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
            SELECT 1 FROM entries e WHERE e.id = se.entry_id AND e.owner_feed_id = s.feed_id
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
    const message = "subscription_entries differs from the older membership forms";
    if (backfilled) {
      logger.error(message, { ...check });
    } else {
      logger.warn(`${message} (not backfilled yet)`, { ...check });
    }
  }
  return check;
}
