/**
 * Google Reader API: Subscription List
 *
 * GET /api/reader/api/0/subscription/list
 *
 * Returns all subscriptions for the authenticated user.
 * Supports `output=json` parameter (default is JSON anyway).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatSubscription } from "@/server/google-reader/format";
import * as subscriptionsService from "@/server/services/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  // Fetch all subscriptions (no pagination — Google Reader clients expect all at once)
  const allSubscriptions: subscriptionsService.Subscription[] = [];
  let cursor: string | undefined;

  do {
    const result = await subscriptionsService.listSubscriptions(db, {
      userId: session.user.id,
      cursor,
      limit: 100,
    });
    allSubscriptions.push(...result.subscriptions);
    cursor = result.nextCursor;
  } while (cursor);

  return jsonResponse({
    subscriptions: allSubscriptions.map(formatSubscription),
  });
}
