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
import { getGreaderUnreadCounts } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // Per-feed counts and newest-item times come from a single query, so they see
  // one consistent snapshot: a feed can't be counted (unread > 0) yet be absent
  // from the newest-item map between two reads (issue #1092). Cheap now that the
  // unread count is a trigger-maintained counter column rather than a scan.
  const { subscriptions, newestItemAtByStreamId } = await getGreaderUnreadCounts(
    db,
    session.user.id
  );

  return jsonResponse(formatUnreadCounts(subscriptions, newestItemAtByStreamId));
}
