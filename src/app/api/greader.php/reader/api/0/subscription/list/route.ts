/**
 * Google Reader API: Subscription List
 *
 * GET /api/greader.php/reader/api/0/subscription/list
 *
 * Returns all subscriptions for the authenticated user, including the synthetic
 * "Saved Articles" feed (issue #730). Supports `output=json` (default is JSON).
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/http/json-response";
import { formatSubscription } from "@/server/google-reader/format";
import { listGreaderSubscriptions } from "@/server/google-reader/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (_request, user) =>
  jsonResponse({
    subscriptions: (await listGreaderSubscriptions(db, user.id)).map(formatSubscription),
  })
);
