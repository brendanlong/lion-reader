/**
 * Wallabag API: Single Tag
 *
 * DELETE /api/wallabag/api/tags/{tag} - Remove a tag from every entry; see
 * deleteWallabagTag for what happens to the collection behind it.
 */

import { withWallabagAuth } from "@/server/wallabag/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { errorResponse } from "@/server/wallabag/parse";
import { deleteWallabagTag, resolveWallabagTag, toWallabagTag } from "@/server/wallabag/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const DELETE = withWallabagAuth(async function (
  request: Request,
  user: User,
  { params }: { params: Promise<{ tag: string }> }
): Promise<Response> {
  const { tag: tagParam } = await params;

  const tag = await resolveWallabagTag(db, user.id, tagParam);
  if (!tag) {
    return errorResponse("not_found", "Tag not found", 404);
  }
  await deleteWallabagTag(db, user.id, tag);
  return jsonResponse(toWallabagTag(tag));
});
