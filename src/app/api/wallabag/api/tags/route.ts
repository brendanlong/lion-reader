/**
 * Wallabag API: Tags
 *
 * GET /api/wallabag/api/tags - List all tags (the user's collections; see
 * src/server/wallabag/tags.ts)
 */

import { withWallabagAuth } from "@/server/wallabag/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { listWallabagTags } from "@/server/wallabag/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withWallabagAuth(async function (
  request: Request,
  user: User
): Promise<Response> {
  return jsonResponse(await listWallabagTags(db, user.id));
});
