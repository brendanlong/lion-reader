/**
 * Google Reader API: Subscription List
 *
 * GET /api/greader.php/reader/api/0/subscription/list
 *
 * Returns all subscriptions for the authenticated user, including the synthetic
 * "Saved Articles" feed (issue #730). Supports `output=json` (default is JSON).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatSubscription } from "@/server/google-reader/format";
import { listGreaderSubscriptions } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // `formatSubscription` ignores unread counts, but listGreaderSubscriptions
  // computes them anyway: the per-subscription counts are baked into the
  // subscription query (skipping those is tracked as issue #1074), and the
  // synthetic saved feed runs its own separate `countEntries` (out of scope for
  // #1074) whose result is likewise discarded here. Both are wasted work only on
  // this endpoint; unread-count needs the counts.
  const subscriptions = (
    await listGreaderSubscriptions(db, session.user.id, { showSpam: session.user.showSpam })
  ).map(formatSubscription);

  return jsonResponse({ subscriptions });
}
