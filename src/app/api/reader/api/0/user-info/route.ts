/**
 * Google Reader API: User Info
 *
 * GET /api/reader/api/0/user-info
 *
 * Returns information about the authenticated user.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { formatUserInfo } from "@/server/google-reader/format";
import { jsonResponse } from "@/server/google-reader/parse";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  return jsonResponse(formatUserInfo(session.user.id, session.user.email));
}
