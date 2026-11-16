/**
 * Google Reader API: Unread Count
 *
 * GET /api/greader.php/reader/api/0/unread-count
 *
 * Returns per-subscription unread counts, including the synthetic "Saved
 * Articles" feed (issue #730), and the All badge as the reading-list total.
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { formatUnreadCounts } from "@/server/google-reader/format";
import { getGreaderUnreadCounts } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  // Per-feed counts and newest-item times come from a single query, so they see
  // one consistent snapshot: a feed can't be counted (unread > 0) yet be absent
  // from the newest-item map between two reads (issue #1092). Cheap now that the
  // unread count is a trigger-maintained counter column rather than a scan.
  const { subscriptions, newestItemAtByStreamId, readingListUnread } = await getGreaderUnreadCounts(
    db,
    user.id
  );

  return jsonResponse(formatUnreadCounts(subscriptions, newestItemAtByStreamId, readingListUnread));
});
