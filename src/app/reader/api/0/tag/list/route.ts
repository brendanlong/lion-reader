/**
 * Google Reader API: Tag List
 *
 * GET /reader/api/0/tag/list
 *
 * Returns all tags (folders) for the authenticated user,
 * including system tags (reading-list, starred).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatTagList } from "@/server/google-reader/format";
import * as tagsService from "@/server/services/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  const tagsResult = await tagsService.listTags(db, session.user.id);

  return jsonResponse({
    tags: formatTagList(tagsResult),
  });
}
