/**
 * Google Reader API: Unread Count
 *
 * GET /api/greader.php/reader/api/0/unread-count
 *
 * Returns per-subscription unread counts.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatUnreadCounts } from "@/server/google-reader/format";
import * as subscriptionsService from "@/server/services/subscriptions";
import { countEntries } from "@/server/services/entries";
import { getSavedFeedId } from "@/server/feed/saved-feed";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // Fetch the full subscription list (with per-subscription unread counts) in a
  // single query, concurrently with the saved-feed lookup.
  const [allSubscriptions, savedFeedId] = await Promise.all([
    subscriptionsService.listAllSubscriptions(db, session.user.id),
    getSavedFeedId(db, session.user.id),
  ]);

  // Include the synthetic "Saved Articles" feed (issue #730) so its unread items
  // are counted alongside subscriptions and folded into the reading-list total.
  // countEntries runs only when a saved feed exists (users who never saved
  // anything skip the extra aggregate).
  let savedFeed: { feedId: string; unreadCount: number } | undefined;
  if (savedFeedId) {
    const { unread } = await countEntries(db, session.user.id, {
      type: "saved",
      showSpam: session.user.showSpam,
    });
    savedFeed = { feedId: savedFeedId, unreadCount: unread };
  }

  return jsonResponse(formatUnreadCounts(allSubscriptions, savedFeed));
}
