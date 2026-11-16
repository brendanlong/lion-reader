/**
 * Google Reader API: Tag List
 *
 * GET /api/greader.php/reader/api/0/tag/list
 *
 * Returns all tags (folders) for the authenticated user,
 * including system tags (reading-list, starred).
 */

import { withGreaderAuth } from "@/server/google-reader/auth";
import type { User } from "@/server/db/schema";
import { jsonResponse } from "@/server/http/json-response";
import { formatTagList } from "@/server/google-reader/format";
import { db } from "@/server/db";
import { and, eq, isNull } from "drizzle-orm";
import { tags } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export const GET = withGreaderAuth(async (request: Request, user: User): Promise<Response> => {
  // A tag's Google Reader sortid is its stored serial (tags.greader_sortid), an
  // opaque value that's never reversed — so read just the name + serial directly
  // rather than the full listTags result (whose `Tag` type is kept free of the
  // bigint that a JSON MCP response can't serialize).
  const userTags = await db
    .select({ name: tags.name, greaderSortid: tags.greaderSortid })
    .from(tags)
    .where(and(eq(tags.userId, user.id), isNull(tags.deletedAt)));

  return jsonResponse({
    tags: formatTagList(userTags),
  });
});
