/**
 * Google Reader API: Subscription List
 *
 * GET /api/greader.php/reader/api/0/subscription/list
 *
 * Returns all subscriptions for the authenticated user, including the synthetic
 * "Saved Articles" feed (issue #730). Supports `output=json` (default is JSON).
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { formatSubscription } from "@/server/google-reader/format";
import { listGreaderSubscriptions } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  // `formatSubscription` ignores unread counts, but they're now free counter
  // column reads (issue #1117, step 5b), so the old opt-out (issue #1074) is
  // gone.
  const subscriptions = (await listGreaderSubscriptions(db, user.id)).map(formatSubscription);

  return jsonResponse({ subscriptions });
});
