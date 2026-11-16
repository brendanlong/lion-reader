/**
 * Wallabag API: Single Entry Tag
 *
 * DELETE /api/wallabag/api/entries/{entry}/tags/{tag} - Remove a tag (by id)
 *   from an entry; returns the entry
 */

import { withWallabagAuth } from "@/server/wallabag/auth";
import type { User } from "@/server/db/schema";
import { errorResponse } from "@/server/wallabag/parse";
import { resolveWallabagEntry } from "@/server/wallabag/id";
import { resolveWallabagTag } from "@/server/wallabag/tags";
import { formatEntryResponse } from "@/server/wallabag/entry-response";
import { removeEntriesFromCollection } from "@/server/services/collections";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const DELETE = withWallabagAuth(async function (
  request: Request,
  user: User,
  { params }: { params: Promise<{ entry: string; tag: string }> }
): Promise<Response> {
  const { entry: entryParam, tag: tagParam } = await params;

  const resolved = await resolveWallabagEntry(db, user.id, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }
  const tag = await resolveWallabagTag(db, user.id, tagParam);
  if (!tag) {
    return errorResponse("not_found", "Tag not found", 404);
  }
  await removeEntriesFromCollection(db, user.id, tag.subscriptionId, [resolved.id]);
  return formatEntryResponse(db, user.id, resolved);
});
