/**
 * Unread-counter reconciliation (issue #1117, step 5a).
 *
 * The four denormalized counters (subscriptions.unread_count /
 * starred_unread_count, users.saved_unread_count / starred_unread_count,
 * migration 0092) are maintained by statement-level triggers on user_entries.
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
 * rows; starred subset; NULL subscription_id = saved.
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { logger } from "@/lib/logger";

export interface ReconcileCountersResult {
  subscriptionsFixed: number;
  usersFixed: number;
}

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
      FROM user_entries
      WHERE subscription_id IS NOT NULL AND NOT read AND NOT is_spam
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

  const result: ReconcileCountersResult = {
    subscriptionsFixed: subscriptionsResult.rowCount ?? 0,
    usersFixed: usersResult.rowCount ?? 0,
  };

  if (result.subscriptionsFixed > 0 || result.usersFixed > 0) {
    // Error level on purpose: the triggers should keep counters exact, so any
    // fix indicates a trigger bug or an untracked write path. The values are
    // already corrected; this is the signal to investigate.
    logger.error("Unread counter drift detected and fixed", { ...result });
  } else {
    logger.debug("Unread counters reconciled: no drift", { ...result });
  }

  return result;
}
