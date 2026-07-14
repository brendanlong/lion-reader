/**
 * Wallabag API: Tags
 *
 * GET /api/wallabag/api/tags - List all tags
 */

import { and, eq, isNull } from "drizzle-orm";
import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse } from "@/server/wallabag/parse";
import { formatTags } from "@/server/wallabag/format";
import { db } from "@/server/db";
import { tags } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  // A tag's Wallabag id is its stored serial (tags.greader_sortid), an opaque
  // value that's never reversed — so read just the name + serial directly
  // rather than the full listTags result (whose `Tag` type is kept free of the
  // bigint that a JSON MCP response can't serialize). Mirrors the Google
  // Reader tag/list route.
  const userTags = await db
    .select({ name: tags.name, greaderSortid: tags.greaderSortid })
    .from(tags)
    .where(and(eq(tags.userId, auth.userId), isNull(tags.deletedAt)))
    .orderBy(tags.name);

  return jsonResponse(formatTags(userTags));
}
