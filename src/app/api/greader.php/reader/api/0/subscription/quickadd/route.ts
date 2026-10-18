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

import { eq } from "drizzle-orm";
import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  jsonResponse,
  errorResponse,
  withClientErrors,
} from "@/server/google-reader/parse";
import { feedStreamId } from "@/server/google-reader/id";
import { subscribeToUrl } from "@/server/services/subscribe";
import { feedUrlSchema } from "@/server/trpc/validation";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { db } from "@/server/db";
import { subscriptions } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export const POST = withClientErrors(async (request: Request): Promise<Response> => {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // Subscribing fetches the URL and schedules feed fetches, so it's rate
  // limited like the tRPC subscribe, per user (issue #1266).
  const rateLimited = await checkRouteRateLimit(request, "expensive", {
    userId: session.user.id,
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

  const result = await subscribeToUrl(db, session.user.id, parsedUrl.data);
  const [{ greaderStreamId }] = await db
    .select({ greaderStreamId: subscriptions.greaderStreamId })
    .from(subscriptions)
    .where(eq(subscriptions.id, result.subscriptionId));

  return jsonResponse({
    query: rawUrl,
    numResults: 1,
    streamId: feedStreamId(greaderStreamId),
    streamName: result.customTitle ?? result.feed.title ?? result.feed.url ?? rawUrl,
  });
});
