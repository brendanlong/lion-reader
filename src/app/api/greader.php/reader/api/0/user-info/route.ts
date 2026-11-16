/**
 * Google Reader API: User Info
 *
 * GET /api/greader.php/reader/api/0/user-info
 *
 * Returns information about the authenticated user.
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { formatUserInfo } from "@/server/google-reader/format";
import { jsonResponse } from "@/server/http/json-response";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  return jsonResponse(formatUserInfo(user.greaderUserId, user.email));
});
