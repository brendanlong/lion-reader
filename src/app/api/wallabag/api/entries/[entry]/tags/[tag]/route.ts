/**
 * Wallabag API: Single Entry Tag
 *
 * DELETE /api/wallabag/api/entries/{entry}/tags/{tag} - Remove a tag (by id)
 *   from an entry; returns the entry
 */

import { requireAuth } from "@/server/wallabag/auth";
import { errorResponse } from "@/server/wallabag/parse";
import { resolveWallabagEntry } from "@/server/wallabag/id";
import { resolveWallabagTag } from "@/server/wallabag/tags";
import { formatEntryResponse } from "@/server/wallabag/entry-response";
import { removeEntriesFromCollection } from "@/server/services/collections";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entry: string; tag: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const { entry: entryParam, tag: tagParam } = await params;

  const resolved = await resolveWallabagEntry(db, auth.userId, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }
  const tag = await resolveWallabagTag(db, auth.userId, tagParam);
  if (!tag) {
    return errorResponse("not_found", "Tag not found", 404);
  }
  await removeEntriesFromCollection(db, auth.userId, tag.subscriptionId, [resolved.id]);
  return formatEntryResponse(db, auth.userId, resolved.id);
}
