/**
 * Google Reader API: Unread Count
 *
 * GET /api/greader.php/reader/api/0/unread-count
 *
 * Returns per-subscription unread counts, including the synthetic "Saved
 * Articles" feed (issue #730) folded into the reading-list total.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatUnreadCounts } from "@/server/google-reader/format";
import {
  listGreaderSubscriptions,
  getGreaderNewestItemAt,
} from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // Counts and newest-item times are independent queries; run them concurrently.
  const [subscriptions, newestItemAtById] = await Promise.all([
    listGreaderSubscriptions(db, session.user.id),
    getGreaderNewestItemAt(db, session.user.id),
  ]);

  return jsonResponse(formatUnreadCounts(subscriptions, newestItemAtById));
}
