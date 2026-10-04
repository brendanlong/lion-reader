/**
 * Unread-counter reconciliation (issue #1117, step 5a).
 *
 * The denormalized unread counters (subscriptions.unread_count /
 * starred_unread_count, users.saved_unread_count / starred_unread_count from
 * migration 0092; tags.unread_count, users.uncategorized_unread_count /
 * all_unread_count, maintained by `apply_unread_rows` / `recompute_list_counters`)
 * are maintained by triggers.
 * This sweep recomputes them from ground truth and fixes any drift, serving
 * two purposes:
 *
 * 1. Detection: nonzero fixes mean a trigger bug or an untracked write path —
 *    logged at error level so it surfaces (Sentry) instead of silently
 *    self-healing forever.
 * 2. Self-healing: badges converge even if something does drift.
 *
 * Each fix is a single UPDATE whose truth subquery and counter write share one
 * statement snapshot. A row-state change committing concurrently can, in a
 * narrow race, make the written value miss that change's trigger delta — the
 * next sweep corrects it, and at this write rate the window is negligible.
 * "Ground truth" mirrors the trigger contribution exactly: unread, non-spam
 * rows; starred subset; NULL subscription_id = saved; a collection's
 * subscription counts its members (collection_entries).
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { logger } from "@/lib/logger";

export interface ReconcileCountersResult {
  subscriptionsFixed: number;
  usersFixed: number;
  tagsFixed: number;
}

/**
 * Every route from a user to an unread, non-spam article: its active source
 * subscription, and each collection holding it.
 */
const UNREAD_ROUTES = sql`
  SELECT ue.user_id, ue.entry_id, ue.subscription_id AS route
  FROM user_entries ue
  JOIN subscriptions s ON s.id = ue.subscription_id AND s.unsubscribed_at IS NULL
  WHERE NOT ue.read AND NOT ue.is_spam
  UNION ALL
  SELECT ce.user_id, ce.entry_id, ce.subscription_id
  FROM collection_entries ce
  JOIN user_entries ue ON ue.user_id = ce.user_id AND ue.entry_id = ce.entry_id
  WHERE NOT ue.read AND NOT ue.is_spam
`;

export async function reconcileCounters(db: typeof dbType): Promise<ReconcileCountersResult> {
  const subscriptionsResult = await db.execute(sql`
    UPDATE subscriptions s
    SET unread_count = COALESCE(t.u, 0),
        starred_unread_count = COALESCE(t.su, 0)
    FROM subscriptions s2
    LEFT JOIN (
      SELECT subscription_id,
             count(*)::int AS u,
             count(*) FILTER (WHERE starred)::int AS su
      FROM (
        SELECT subscription_id, starred
        FROM user_entries
        WHERE subscription_id IS NOT NULL AND NOT read AND NOT is_spam
        UNION ALL
        SELECT ce.subscription_id, ue.starred
        FROM collection_entries ce
        JOIN user_entries ue ON ue.user_id = ce.user_id AND ue.entry_id = ce.entry_id
        WHERE NOT ue.read AND NOT ue.is_spam
      ) contributions
      GROUP BY subscription_id
    ) t ON t.subscription_id = s2.id
    WHERE s.id = s2.id
      AND (s2.unread_count IS DISTINCT FROM COALESCE(t.u, 0)
        OR s2.starred_unread_count IS DISTINCT FROM COALESCE(t.su, 0))
  `);

  const usersResult = await db.execute(sql`
    UPDATE users u
    SET saved_unread_count = COALESCE(t.sv, 0),
        starred_unread_count = COALESCE(t.st, 0)
    FROM users u2
    LEFT JOIN (
      SELECT user_id,
             count(*) FILTER (WHERE subscription_id IS NULL)::int AS sv,
             count(*) FILTER (WHERE starred)::int AS st
      FROM user_entries
      WHERE NOT read AND NOT is_spam
      GROUP BY user_id
    ) t ON t.user_id = u2.id
    WHERE u.id = u2.id
      AND (u2.saved_unread_count IS DISTINCT FROM COALESCE(t.sv, 0)
        OR u2.starred_unread_count IS DISTINCT FROM COALESCE(t.st, 0))
  `);

  // Tag, Uncategorized and All count distinct articles over every route into
  // them: an active source subscription, a collection, and (All only) being
  // saved or starred. Written from that definition, not from the trigger
  // algebra, so it checks the triggers rather than repeating them.
  const tagsResult = await db.execute(sql`
    WITH routes AS (${UNREAD_ROUTES}),
    truth AS (
      SELECT st.tag_id, count(DISTINCT r.entry_id)::int AS n
      FROM routes r JOIN subscription_tags st ON st.subscription_id = r.route
      GROUP BY st.tag_id
    )
    UPDATE tags t
    SET unread_count = COALESCE(truth.n, 0)
    FROM tags t2
    LEFT JOIN truth ON truth.tag_id = t2.id
    WHERE t.id = t2.id AND t2.unread_count IS DISTINCT FROM COALESCE(truth.n, 0)
  `);

  const listUsersResult = await db.execute(sql`
    WITH routes AS (${UNREAD_ROUTES}),
    uncategorized AS (
      SELECT r.user_id, count(DISTINCT r.entry_id)::int AS n
      FROM routes r
      WHERE NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = r.route)
      GROUP BY r.user_id
    ),
    visible AS (
      SELECT ue.user_id, count(*)::int AS n
      FROM user_entries ue
      LEFT JOIN subscriptions s ON s.id = ue.subscription_id
      WHERE NOT ue.read AND NOT ue.is_spam
        AND ((s.id IS NOT NULL AND s.unsubscribed_at IS NULL)
          OR ue.subscription_id IS NULL
          OR ue.starred
          OR EXISTS (
            SELECT 1 FROM collection_entries ce
            WHERE ce.user_id = ue.user_id AND ce.entry_id = ue.entry_id
          ))
      GROUP BY ue.user_id
    )
    UPDATE users u
    SET uncategorized_unread_count = COALESCE(uncategorized.n, 0),
        all_unread_count = COALESCE(visible.n, 0)
    FROM users u2
    LEFT JOIN uncategorized ON uncategorized.user_id = u2.id
    LEFT JOIN visible ON visible.user_id = u2.id
    WHERE u.id = u2.id
      AND (u2.uncategorized_unread_count IS DISTINCT FROM COALESCE(uncategorized.n, 0)
        OR u2.all_unread_count IS DISTINCT FROM COALESCE(visible.n, 0))
  `);

  const result: ReconcileCountersResult = {
    subscriptionsFixed: subscriptionsResult.rowCount ?? 0,
    usersFixed: (usersResult.rowCount ?? 0) + (listUsersResult.rowCount ?? 0),
    tagsFixed: tagsResult.rowCount ?? 0,
  };

  if (result.subscriptionsFixed > 0 || result.usersFixed > 0 || result.tagsFixed > 0) {
    // Error level on purpose: the triggers should keep counters exact, so any
    // fix indicates a trigger bug or an untracked write path. The values are
    // already corrected; this is the signal to investigate.
    logger.error("Unread counter drift detected and fixed", { ...result });
  } else {
    logger.debug("Unread counters reconciled: no drift", { ...result });
  }

  return result;
}
