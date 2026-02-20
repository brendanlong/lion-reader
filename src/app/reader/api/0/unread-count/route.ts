/**
 * Google Reader API: Unread Count
 *
 * GET /reader/api/0/unread-count
 *
 * Returns per-subscription unread counts.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatUnreadCounts } from "@/server/google-reader/format";
import * as subscriptionsService from "@/server/services/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);

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

  return jsonResponse(formatUnreadCounts(allSubscriptions));
}
