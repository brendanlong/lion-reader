/**
 * Wallabag API: User
 *
 * GET /api/wallabag/api/user - Get current user information
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse } from "@/server/wallabag/parse";
import { uuidToWallabagId } from "@/server/wallabag/format";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);

  return jsonResponse({
    id: uuidToWallabagId(auth.userId),
    username: auth.email,
    email: auth.email,
    created_at: null,
    updated_at: null,
    default_client: null,
  });
}
