/**
 * Wallabag API: Tags
 *
 * GET /api/wallabag/api/tags - List all tags (the user's collections; see
 * src/server/wallabag/tags.ts)
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse } from "@/server/wallabag/parse";
import { listWallabagTags } from "@/server/wallabag/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  return jsonResponse(await listWallabagTags(db, auth.userId));
}
