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

  // Fetch all subscriptions to get unread counts
  const allSubscriptions: Array<{ id: string; unreadCount: number; subscribedAt: Date }> = [];
  let cursor: string | undefined;

  do {
    const result = await subscriptionsService.listSubscriptions(db, {
      userId: session.user.id,
      cursor,
      limit: 100,
    });
    for (const sub of result.subscriptions) {
      allSubscriptions.push({
        id: sub.id,
        unreadCount: sub.unreadCount,
        subscribedAt: sub.subscribedAt,
      });
    }
    cursor = result.nextCursor;
  } while (cursor);

  // Include the synthetic "Saved Articles" feed (issue #730) so its unread items
  // are counted alongside subscriptions and folded into the reading-list total.
  const savedFeedId = await getSavedFeedId(db, session.user.id);
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
