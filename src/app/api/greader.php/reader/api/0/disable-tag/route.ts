/**
 * Google Reader API: Disable Tag
 *
 * POST /api/greader.php/reader/api/0/disable-tag
 *
 * Deletes a tag/folder.
 *
 * Request body (form-encoded):
 *   s={tagStreamId}  — tag stream ID (e.g., "user/-/label/MyFolder")
 *   OR
 *   t={tagName}      — tag name directly
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

  const tag = await resolveTagByName(db, userId, tagName);
  if (!tag) {
    return textResponse("OK"); // Tag doesn't exist, nothing to do
  }

  await tagsService.deleteTag(db, userId, tag.id);

  return textResponse("OK");
}
