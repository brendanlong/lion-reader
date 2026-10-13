/**
 * Google Reader API: Disable Tag
 *
 * POST /api/greader.php/reader/api/0/disable-tag
 *
 * Deletes a tag/folder, or the collection behind an item label (#1821). Like
 * deleting it in the app, that removes only its memberships: every article
 * stays in its feed or in Saved.
 *
 * Request body (form-encoded):
 *   s={tagStreamId}  — tag stream ID (e.g., "user/-/label/MyFolder")
 *   OR
 *   t={tagName}      — tag name directly
 */

import { requireAuth } from "@/server/google-reader/auth";
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { listGreaderLabels } from "@/server/google-reader/labels";
import * as tagsService from "@/server/services/tags";
import { unsubscribe } from "@/server/services/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
  const userId = session.user.id;

  const params = await parseFormData(request);

  // Get tag name from either s or t parameter
  let tagName: string | null = null;

  const streamId = params.get("s");
  if (streamId) {
    const labelMatch = streamId.match(/^user\/[^/]+\/label\/(.+)$/);
    if (labelMatch) {
      tagName = labelMatch[1];
    }
  }

  if (!tagName) {
    tagName = params.get("t");
  }

  if (!tagName) {
    return errorResponse("Missing required parameter: s or t (tag identifier)", 400);
  }

  const label = (await listGreaderLabels(db, userId)).find(tagName);
  if (!label) {
    return textResponse("OK"); // Label doesn't exist, nothing to do
  }

  if (label.kind === "tag") {
    await tagsService.deleteTag(db, userId, label.tagId);
  } else {
    await unsubscribe(db, userId, label.subscriptionId);
  }

  return textResponse("OK");
}
