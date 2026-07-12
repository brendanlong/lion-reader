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

  // `formatSubscription` ignores unread counts, but they're now free counter
  // column reads (issue #1117, step 5b), so the old opt-out (issue #1074) is
  // gone.
  const subscriptions = (await listGreaderSubscriptions(db, session.user.id)).map(
    formatSubscription
  );

  return jsonResponse({ subscriptions });
}
