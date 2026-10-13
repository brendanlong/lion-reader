/**
 * Google Reader API: Rename Tag
 *
 * POST /api/greader.php/reader/api/0/rename-tag
 *
 * Renames a tag/folder, or a collection's item label (#1821).
 *
 * Request body (form-encoded):
 *   s={oldTagStreamId}   — old tag stream ID (e.g., "user/-/label/OldName")
 *   dest={newTagStreamId} — new tag stream ID (e.g., "user/-/label/NewName")
 */

import { requireAuth } from "@/server/google-reader/auth";
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { listGreaderLabels } from "@/server/google-reader/labels";
import { renameGreaderSubscription } from "@/server/google-reader/subscriptions";
import * as tagsService from "@/server/services/tags";
import { getAppErrorCode } from "@/server/trpc/errors";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
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

  const label = (await listGreaderLabels(db, userId)).find(oldName);
  if (!label) {
    return errorResponse(`Label not found: ${oldName}`, 404);
  }
  if (label.kind === "collection") {
    return (
      (await renameGreaderSubscription(db, userId, label.subscriptionId, newName)) ??
      textResponse("OK")
    );
  }

  try {
    await tagsService.updateTag(db, userId, label.tagId, { name: newName });
  } catch (error) {
    if (getAppErrorCode(error) === "TAG_NAME_TAKEN") {
      return errorResponse(`Tag already exists: ${newName}`, 409);
    }
    throw error;
  }

  return textResponse("OK");
}
