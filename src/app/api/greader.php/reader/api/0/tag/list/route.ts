/**
 * Google Reader API: Tag List
 *
 * GET /api/greader.php/reader/api/0/tag/list
 *
 * Returns all tags (folders) for the authenticated user,
 * including system tags (reading-list, starred).
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/http/json-response";
import { formatTagList } from "@/server/google-reader/format";
import { listGreaderTags } from "@/server/google-reader/tags";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (_request, user) =>
  jsonResponse({
    tags: formatTagList(await listGreaderTags(db, user.id)),
  })
);
