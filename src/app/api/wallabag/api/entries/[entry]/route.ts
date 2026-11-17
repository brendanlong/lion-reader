/**
 * Wallabag API: Single Entry
 *
 * GET    /api/wallabag/api/entries/{entry} - Get a single entry
 * PATCH  /api/wallabag/api/entries/{entry} - Update entry properties (archive, starred, tags)
 * DELETE /api/wallabag/api/entries/{entry} - Delete an entry
 *
 * The {entry} parameter is the Wallabag numeric ID (or a Lion Reader UUID);
 * see resolveWallabagEntry.
 */

import { withWallabagAuth } from "@/server/wallabag/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { errorResponse, parseBody, parseTagLabels } from "@/server/wallabag/parse";
import { formatEntryResponse } from "@/server/wallabag/entry-response";
import { addEntryTags } from "@/server/wallabag/tags";
import { resolveWallabagEntry } from "@/server/wallabag/id";
import * as entryStateService from "@/server/services/entry-state";
import * as savedService from "@/server/services/saved";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withWallabagAuth(async function (
  request: Request,
  user: User,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const { entry: entryParam } = await params;

  const resolved = await resolveWallabagEntry(db, user.id, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  return formatEntryResponse(db, user.id, resolved);
});

export const PATCH = withWallabagAuth(async function (
  request: Request,
  user: User,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const { entry: entryParam } = await params;
  const body = await parseBody(request);

  const resolved = await resolveWallabagEntry(db, user.id, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Like Wallabag, `tags` adds to the entry's tags rather than replacing them.
  await addEntryTags(db, user.id, resolved.id, parseTagLabels(body.tags));

  // Handle archive (read) state
  if (body.archive !== undefined) {
    const read = body.archive === "1";
    await entryStateService.markEntriesRead(db, user.id, [{ id: resolved.id }], read);
  }

  // Handle starred state
  if (body.starred !== undefined) {
    const starred = body.starred === "1";
    await entryStateService.updateEntryStarred(db, user.id, resolved.id, starred);
  }

  // Return the updated entry
  return formatEntryResponse(db, user.id, resolved);
});

export const DELETE = withWallabagAuth(async function (
  request: Request,
  user: User,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const { entry: entryParam } = await params;

  const resolved = await resolveWallabagEntry(db, user.id, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Try deleting as a saved article first
  const counts = await savedService.deleteSavedArticle(db, user.id, resolved.id);
  if (counts === null) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Return the entry (Wallabag API returns the deleted entry)
  return jsonResponse({ id: resolved.wallabagId });
});
