/**
 * Wallabag API: Entry Tags
 *
 * GET  /api/wallabag/api/entries/{entry}/tags - List an entry's tags
 * POST /api/wallabag/api/entries/{entry}/tags - Add tags (body `tags`: comma-separated
 *   labels), creating the missing ones; returns the entry
 */

import { requireAuth } from "@/server/wallabag/auth";
import {
  errorResponse,
  jsonResponse,
  parseBody,
  parseTagLabels,
  withClientErrors,
} from "@/server/wallabag/parse";
import { resolveWallabagEntry } from "@/server/wallabag/id";
import { addEntryTags, listEntryTags } from "@/server/wallabag/tags";
import { formatEntryResponse } from "@/server/wallabag/entry-response";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withClientErrors(async function (
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
  const tags = await listEntryTags(db, auth.userId, [resolved.id]);
  return jsonResponse(tags.get(resolved.id) ?? []);
});

export const POST = withClientErrors(async function (
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
  await addEntryTags(db, auth.userId, resolved.id, parseTagLabels(body.tags));
  return formatEntryResponse(db, auth.userId, resolved);
});
