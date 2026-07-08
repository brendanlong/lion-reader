/**
 * Google Reader API: Subscription List
 *
 * GET /api/greader.php/reader/api/0/subscription/list
 *
 * Returns all subscriptions for the authenticated user.
 * Supports `output=json` parameter (default is JSON anyway).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatSubscription, formatSavedSubscription } from "@/server/google-reader/format";
import * as subscriptionsService from "@/server/services/subscriptions";
import { getSavedFeedId } from "@/server/feed/saved-feed";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

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

  const subscriptions = allSubscriptions.map(formatSubscription);

  // Expose saved articles as a synthetic "Saved Articles" subscription (issue
  // #730). Only when the saved feed exists — a user who has never saved anything
  // gets no empty feed.
  const savedFeedId = await getSavedFeedId(db, session.user.id);
  if (savedFeedId) {
    subscriptions.push(formatSavedSubscription(savedFeedId));
  }

  return jsonResponse({ subscriptions });
}
