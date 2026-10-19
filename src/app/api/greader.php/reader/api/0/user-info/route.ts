/**
 * Google Reader API: User Info
 *
 * GET /api/greader.php/reader/api/0/user-info
 *
 * Returns information about the authenticated user.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { formatUserInfo } from "@/server/google-reader/format";
import { jsonResponse, withClientErrors } from "@/server/google-reader/parse";

export const dynamic = "force-dynamic";

export const GET = withClientErrors(async (request: Request): Promise<Response> => {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  return jsonResponse(formatUserInfo(session.user.greaderUserId, session.user.email));
});
