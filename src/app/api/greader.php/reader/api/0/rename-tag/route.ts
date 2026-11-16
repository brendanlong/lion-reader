/**
 * Google Reader API: Rename Tag
 *
 * POST /api/greader.php/reader/api/0/rename-tag
 *
 * Renames a tag/folder.
 *
 * Request body (form-encoded):
 *   s={oldTagStreamId}   — old tag stream ID (e.g., "user/-/label/OldName")
 *   dest={newTagStreamId} — new tag stream ID (e.g., "user/-/label/NewName")
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { labelName } from "@/server/google-reader/streams";
import { resolveTagByName } from "@/server/google-reader/tags";
import * as tagsService from "@/server/services/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const POST = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  const userId = user.id;

  const params = await parseFormData(request);
  const oldStreamId = params.get("s");
  const newStreamId = params.get("dest");

  if (!oldStreamId || !newStreamId) {
    return errorResponse("Missing required parameters: s and dest", 400);
  }

  const oldName = labelName(oldStreamId);
  const newName = labelName(newStreamId);
  if (oldName === null || newName === null) {
    return errorResponse("Invalid tag stream IDs", 400);
  }

  const tag = await resolveTagByName(db, userId, oldName);
  if (!tag) {
    return errorResponse(`Tag not found: ${oldName}`, 404);
  }

  await tagsService.updateTag(db, userId, tag.id, { name: newName });

  return textResponse("OK");
});
