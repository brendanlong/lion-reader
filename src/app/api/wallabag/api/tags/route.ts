/**
 * Wallabag API: Tags
 *
 * GET /api/wallabag/api/tags - List all tags
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse } from "@/server/wallabag/parse";
import { formatTags } from "@/server/wallabag/format";
import * as tagsService from "@/server/services/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);

  const tags = await tagsService.listTags(db, auth.userId);
  return jsonResponse(formatTags(tags));
}
