/**
 * Unread-counter reconciliation (issue #1117, step 5a).
 *
 * The counters (see `services/counts.ts`) and `user_entries.active_memberships`
 * are maintained by triggers. This sweep recomputes them from their
 * definitions and fixes any drift, serving two purposes:
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
 *
 * The definitions are #1846's, over memberships (`subscription_entries`):
 * - an article is visible if it's starred or in an active subscription;
 * - a subscription (active or not) counts its unread, non-spam memberships,
 *   and Saved is the saved subscription's count (users.saved_unread_count, its
 *   copy for the previous release, is left to the triggers);
 * - All counts visible, unread, non-spam articles, and Starred the starred ones;
 * - a tag counts distinct unread, non-spam articles in an active subscription
 *   with that tag, and Uncategorized the same for untagged subscriptions other
 *   than saved.
 * They're written from those definitions, not from the trigger algebra, so
 * they check the triggers rather than repeating them.
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { logger } from "@/lib/logger";

export interface ReconcileCountersResult {
  /** user_entries rows whose active_memberships was wrong. */
  userEntriesFixed: number;
  subscriptionsFixed: number;
  usersFixed: number;
  tagsFixed: number;
}

/**
 * Every membership of an unread, non-spam article in an active subscription,
 * with the list it puts the article in: a tag of the subscription, or
 * Uncategorized (`tag_id` NULL) for an untagged one other than saved.
 */
const UNREAD_IN_LISTS = sql`
  SELECT se.user_id, se.entry_id, st.tag_id
  FROM subscription_entries se
  JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  JOIN user_entries ue ON ue.user_id = se.user_id AND ue.entry_id = se.entry_id
  LEFT JOIN subscription_tags st ON st.subscription_id = s.id
  WHERE NOT ue.read AND NOT ue.is_spam AND (st.tag_id IS NOT NULL OR s.type <> 'saved')
`;

export async function reconcileCounters(db: typeof dbType): Promise<ReconcileCountersResult> {
  // First, so the counters below (whose triggers follow it) start from it.
  const userEntriesResult = await db.execute(sql`
    UPDATE user_entries ue
    SET active_memberships = t.n
    FROM (
      SELECT ue2.user_id, ue2.entry_id, count(s.id)::int AS n
      FROM user_entries ue2
      LEFT JOIN subscription_entries se ON se.user_id = ue2.user_id AND se.entry_id = ue2.entry_id
      LEFT JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
      GROUP BY ue2.user_id, ue2.entry_id
    ) t
    WHERE ue.user_id = t.user_id AND ue.entry_id = t.entry_id AND ue.active_memberships <> t.n
  `);

  const subscriptionsResult = await db.execute(sql`
    UPDATE subscriptions s
    SET unread_count = COALESCE(t.n, 0)
    FROM subscriptions s2
    LEFT JOIN (
      SELECT se.subscription_id, count(*)::int AS n
      FROM subscription_entries se
      JOIN user_entries ue ON ue.user_id = se.user_id AND ue.entry_id = se.entry_id
      WHERE NOT ue.read AND NOT ue.is_spam
      GROUP BY se.subscription_id
    ) t ON t.subscription_id = s2.id
    WHERE s.id = s2.id AND s2.unread_count IS DISTINCT FROM COALESCE(t.n, 0)
  `);

  const tagsResult = await db.execute(sql`
    WITH truth AS (
      SELECT tag_id, count(DISTINCT entry_id)::int AS n
      FROM (${UNREAD_IN_LISTS}) l
      WHERE tag_id IS NOT NULL
      GROUP BY tag_id
    )
    UPDATE tags t
    SET unread_count = COALESCE(truth.n, 0)
    FROM tags t2
    LEFT JOIN truth ON truth.tag_id = t2.id
    WHERE t.id = t2.id AND t2.unread_count IS DISTINCT FROM COALESCE(truth.n, 0)
  `);

  const usersResult = await db.execute(sql`
    WITH uncategorized AS (
      SELECT user_id, count(DISTINCT entry_id)::int AS n
      FROM (${UNREAD_IN_LISTS}) l
      WHERE tag_id IS NULL
      GROUP BY user_id
    ),
    rows AS (
      SELECT ue.user_id,
             count(*) FILTER (WHERE ue.starred OR EXISTS (
               SELECT 1 FROM subscription_entries se
               JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
               WHERE se.user_id = ue.user_id AND se.entry_id = ue.entry_id
             ))::int AS visible,
             count(*) FILTER (WHERE ue.starred)::int AS starred
      FROM user_entries ue
      WHERE NOT ue.read AND NOT ue.is_spam
      GROUP BY ue.user_id
    ),
    truth AS (
      SELECT u2.id,
             COALESCE(rows.visible, 0) AS all_n,
             COALESCE(rows.starred, 0) AS starred_n,
             COALESCE(uncategorized.n, 0) AS uncategorized_n
      FROM users u2
      LEFT JOIN rows ON rows.user_id = u2.id
      LEFT JOIN uncategorized ON uncategorized.user_id = u2.id
    )
    UPDATE users u
    SET all_unread_count = truth.all_n,
        starred_unread_count = truth.starred_n,
        uncategorized_unread_count = truth.uncategorized_n
    FROM truth
    WHERE u.id = truth.id
      AND (u.all_unread_count, u.starred_unread_count, u.uncategorized_unread_count)
        IS DISTINCT FROM (truth.all_n, truth.starred_n, truth.uncategorized_n)
  `);

  const result: ReconcileCountersResult = {
    userEntriesFixed: userEntriesResult.rowCount ?? 0,
    subscriptionsFixed: subscriptionsResult.rowCount ?? 0,
    usersFixed: usersResult.rowCount ?? 0,
    tagsFixed: tagsResult.rowCount ?? 0,
  };

  if (Object.values(result).some((n) => n > 0)) {
    // Error level on purpose: the triggers should keep counters exact, so any
    // fix indicates a trigger bug or an untracked write path. The values are
    // already corrected; this is the signal to investigate.
    logger.error("Unread counter drift detected and fixed", { ...result });
  } else {
    logger.debug("Unread counters reconciled: no drift", { ...result });
  }

  return result;
}
