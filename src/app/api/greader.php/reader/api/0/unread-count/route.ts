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
import { listGreaderSubscriptions } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  const subscriptions = await listGreaderSubscriptions(db, session.user.id, {
    showSpam: session.user.showSpam,
  });

  return jsonResponse(formatUnreadCounts(subscriptions));
}
