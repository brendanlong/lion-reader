/**
 * Google Reader API: Quick Add Subscription
 *
 * POST /api/greader.php/reader/api/0/subscription/quickadd
 *
 * Subscribes to a feed by URL.
 *
 * Request body (form-encoded):
 *   quickadd={feedUrl}
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { parseFormData, errorResponse } from "@/server/google-reader/parse";
import { subscriptionFeedStreamId } from "@/server/google-reader/id";
import { subscribeToUrl } from "@/server/services/subscribe";
import { feedUrlSchema } from "@/server/trpc/validation";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const POST = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  // Subscribing fetches the URL and schedules feed fetches, so it's rate
  // limited like the tRPC subscribe, per user (issue #1266).
  const rateLimited = await checkRouteRateLimit(request, "expensive", {
    userId: user.id,
  });
  if (rateLimited) return rateLimited;

  const params = await parseFormData(request);
  const rawUrl = params.get("quickadd");

  if (!rawUrl) {
    return errorResponse("Missing required parameter: quickadd", 400);
  }

  const parsedUrl = feedUrlSchema.safeParse(rawUrl);
  if (!parsedUrl.success) {
    return errorResponse("Invalid URL", 400);
  }

  const result = await subscribeToUrl(db, user.id, parsedUrl.data);

  return jsonResponse({
    query: rawUrl,
    numResults: 1,
    streamId: await subscriptionFeedStreamId(db, user.id, result.subscription.id),
    streamName: result.subscription.title ?? result.subscription.url ?? rawUrl,
  });
});
