/**
 * Google Reader API: Tag List
 *
 * GET /api/greader.php/reader/api/0/tag/list
 *
 * Returns the system tags (reading-list, starred) and the user's labels: tags
 * as folders and collections as item labels (#1821).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse } from "@/server/google-reader/parse";
import { formatTagList } from "@/server/google-reader/format";
import { listGreaderLabels } from "@/server/google-reader/labels";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  const labels = await listGreaderLabels(db, session.user.id);

  return jsonResponse({
    tags: formatTagList(labels.all),
  });
}
