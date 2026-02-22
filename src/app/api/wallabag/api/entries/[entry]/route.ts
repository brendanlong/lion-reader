/**
 * Wallabag API: Single Entry
 *
 * GET    /api/wallabag/api/entries/{entry} - Get a single entry
 * PATCH  /api/wallabag/api/entries/{entry} - Update entry properties
 * DELETE /api/wallabag/api/entries/{entry} - Delete an entry
 *
 * The {entry} parameter is the Wallabag numeric ID.
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse, errorResponse, parseBody } from "@/server/wallabag/parse";
import { formatEntryFull, uuidToWallabagId } from "@/server/wallabag/format";
import { wallabagIdToUuid } from "@/server/wallabag/id";
import * as entriesService from "@/server/services/entries";
import * as savedService from "@/server/services/saved";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

async function resolveEntryId(userId: string, entryParam: string): Promise<string | null> {
  // If the param looks like a UUID, use it directly
  if (entryParam.includes("-") && entryParam.length >= 32) {
    return entryParam;
  }

  // Otherwise treat as Wallabag numeric ID
  const numericId = parseInt(entryParam, 10);
  if (isNaN(numericId)) {
    return null;
  }

  return wallabagIdToUuid(db, userId, numericId);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ entry: string }> }
): Promise<Response> {
  const auth = await requireAuth(request);
  const { entry: entryParam } = await params;

  const entryId = await resolveEntryId(auth.userId, entryParam);
  if (!entryId) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  try {
    const entry = await entriesService.getEntry(db, auth.userId, entryId);
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
  const { entry: entryParam } = await params;
  const body = await parseBody(request);

  const entryId = await resolveEntryId(auth.userId, entryParam);
  if (!entryId) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Handle archive (read) state
  if (body.archive !== undefined) {
    const read = body.archive === "1";
    await entriesService.markEntriesRead(db, auth.userId, [entryId], read);
  }

  // Handle starred state
  if (body.starred !== undefined) {
    const starred = body.starred === "1";
    await entriesService.updateEntryStarred(db, auth.userId, entryId, starred);
  }

  // Return the updated entry
  try {
    const entry = await entriesService.getEntry(db, auth.userId, entryId);
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
  const { entry: entryParam } = await params;

  const entryId = await resolveEntryId(auth.userId, entryParam);
  if (!entryId) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Try deleting as a saved article first
  const deleted = await savedService.deleteSavedArticle(db, auth.userId, entryId);
  if (!deleted) {
    return errorResponse("not_found", "Entry not found", 404);
  }

  // Return the entry (Wallabag API returns the deleted entry)
  return jsonResponse({ id: uuidToWallabagId(entryId) });
}
