/**
 * Google Reader API: Rename Tag
 *
 * POST /reader/api/0/rename-tag
 *
 * Renames a tag/folder.
 *
 * Request body (form-encoded):
 *   s={oldTagStreamId}   — old tag stream ID (e.g., "user/-/label/OldName")
 *   dest={newTagStreamId} — new tag stream ID (e.g., "user/-/label/NewName")
 */

import { requireAuth } from "@/server/google-reader/auth";
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { resolveTagByName } from "@/server/google-reader/tags";
import * as tagsService from "@/server/services/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  const userId = session.user.id;

  const params = await parseFormData(request);
  const oldStreamId = params.get("s");
  const newStreamId = params.get("dest");

  if (!oldStreamId || !newStreamId) {
    return errorResponse("Missing required parameters: s and dest", 400);
  }

  // Extract tag names from stream IDs
  const oldLabelMatch = oldStreamId.match(/^user\/[^/]+\/label\/(.+)$/);
  const newLabelMatch = newStreamId.match(/^user\/[^/]+\/label\/(.+)$/);

  if (!oldLabelMatch || !newLabelMatch) {
    return errorResponse("Invalid tag stream IDs", 400);
  }

  const oldName = oldLabelMatch[1];
  const newName = newLabelMatch[1];

  const tag = await resolveTagByName(db, userId, oldName);
  if (!tag) {
    return errorResponse(`Tag not found: ${oldName}`, 404);
  }

  await tagsService.updateTag(db, userId, tag.id, { name: newName });

  return textResponse("OK");
}
