/**
 * Writing memberships (`subscription_entries`, #1846). Every path that gives a
 * user an article writes its membership itself:
 * {@link insertUserEntriesWithMemberships} for an article's source (fetch
 * fan-out, subscribe-time populate, email, save), and the collection and merge
 * services for the rest.
 */

import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/server/db";
import { canonicalGuidSql } from "@/server/feed/guid-identity";

/**
 * Gives users articles: for each candidate row, its `user_entries` row
 * (unless the user has one) and its membership in the candidate's
 * subscription, in one statement, so no crash leaves an article without its
 * membership. Idempotent: a candidate whose membership exists is skipped.
 *
 * `candidates` is a SELECT of `subscription_id, user_id, entry_id,
 * published_or_fetched_at, is_spam, read`, the new row's values. The
 * membership copies the sort key and state of an existing row rather than
 * the candidate's, since the two must agree (the membership triggers correct
 * a state that changes meanwhile, but writing it right here saves them the
 * update). A new row starts with
 * `active_memberships` counting the membership inserted with it, which the
 * membership triggers confirm under lock (correcting it if the subscription
 * was unsubscribed meanwhile); left at 0, they would rewrite every new row.
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
): Promise<Array<{ subscriptionId: string; userId: string; entryId: string }>> {
  const result = await db.execute<{
    subscription_id: string;
    user_id: string;
    entry_id: string;
  }>(sql`
    WITH c AS (${candidates}),
    missing AS (
      SELECT c.subscription_id, c.user_id, c.entry_id, c.is_spam, c.read,
             COALESCE(ue.read, c.read) AS state_read, COALESCE(ue.starred, false) AS state_starred,
             (s.unsubscribed_at IS NULL)::int AS active_memberships,
             COALESCE(ue.published_or_fetched_at, c.published_or_fetched_at) AS published_or_fetched_at
      FROM c
      JOIN subscriptions s ON s.id = c.subscription_id
      LEFT JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
      WHERE NOT EXISTS (
        SELECT 1 FROM subscription_entries se
        WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      )
    ),
    new_rows AS (
      INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, is_spam, read, active_memberships)
      SELECT user_id, entry_id, published_or_fetched_at, is_spam, read, active_memberships FROM missing
      ON CONFLICT DO NOTHING
    )
    INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                      read, starred)
    SELECT subscription_id, user_id, entry_id, published_or_fetched_at, state_read, state_starred
    FROM missing
    ON CONFLICT DO NOTHING
    RETURNING subscription_id, user_id, entry_id
  `);
  return result.rows.map((r) => ({
    subscriptionId: r.subscription_id,
    userId: r.user_id,
    entryId: r.entry_id,
  }));
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
