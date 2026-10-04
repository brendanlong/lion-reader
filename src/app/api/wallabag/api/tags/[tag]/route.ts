/**
 * Wallabag API: Single Tag
 *
 * DELETE /api/wallabag/api/tags/{tag} - Remove a tag from every entry; see
 * deleteWallabagTag for what happens to the collection behind it.
 */

import { requireAuth } from "@/server/wallabag/auth";
import { errorResponse, jsonResponse } from "@/server/wallabag/parse";
import { deleteWallabagTag, resolveWallabagTag, toWallabagTag } from "@/server/wallabag/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ tag: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const { tag: tagParam } = await params;

  const tag = await resolveWallabagTag(db, auth.userId, tagParam);
  if (!tag) {
    return errorResponse("not_found", "Tag not found", 404);
  }
  await deleteWallabagTag(db, auth.userId, tag);
  return jsonResponse(toWallabagTag(tag));
}
