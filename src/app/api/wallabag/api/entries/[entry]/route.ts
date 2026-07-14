/**
 * Wallabag API: Single Entry
 *
 * GET    /api/wallabag/api/entries/{entry} - Get a single entry
 * PATCH  /api/wallabag/api/entries/{entry} - Update entry properties
 * DELETE /api/wallabag/api/entries/{entry} - Delete an entry
 *
 * The {entry} parameter is the Wallabag numeric ID (or a Lion Reader UUID);
 * see resolveWallabagEntry.
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse, errorResponse, parseBody } from "@/server/wallabag/parse";
import { formatEntryFull } from "@/server/wallabag/format";
import { resolveWallabagEntry } from "@/server/wallabag/id";
import * as entriesService from "@/server/services/entries";
import * as savedService from "@/server/services/saved";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const { entry: entryParam } = await params;

  const resolved = await resolveWallabagEntry(db, auth.userId, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  try {
    const entry = await entriesService.getEntry(db, auth.userId, resolved.id);
    return jsonResponse(formatEntryFull(entry));
  } catch {
    return errorResponse("not_found", "Entry not found", 404);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const { entry: entryParam } = await params;
  const body = await parseBody(request);

  const resolved = await resolveWallabagEntry(db, auth.userId, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Handle archive (read) state
  if (body.archive !== undefined) {
    const read = body.archive === "1";
    await entriesService.markEntriesRead(db, auth.userId, [{ id: resolved.id }], read);
  }

  // Handle starred state
  if (body.starred !== undefined) {
    const starred = body.starred === "1";
    await entriesService.updateEntryStarred(db, auth.userId, resolved.id, starred);
  }

  // Return the updated entry
  try {
    const entry = await entriesService.getEntry(db, auth.userId, resolved.id);
    return jsonResponse(formatEntryFull(entry));
  } catch {
    return errorResponse("not_found", "Entry not found", 404);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const { entry: entryParam } = await params;

  const resolved = await resolveWallabagEntry(db, auth.userId, entryParam);
  if (!resolved) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Try deleting as a saved article first
  const deleted = await savedService.deleteSavedArticle(db, auth.userId, resolved.id);
  if (!deleted) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Return the entry (Wallabag API returns the deleted entry)
  return jsonResponse({ id: resolved.wallabagId });
}
