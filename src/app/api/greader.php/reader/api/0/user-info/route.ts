/**
 * Google Reader API: User Info
 *
 * GET /api/greader.php/reader/api/0/user-info
 *
 * Returns information about the authenticated user.
 */

import { requireAuth } from "@/server/google-reader/auth";
import { formatUserInfo } from "@/server/google-reader/format";
import { jsonResponse, errorResponse } from "@/server/google-reader/parse";
import { db } from "@/server/db";
import { eq } from "drizzle-orm";
import { users } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // The Google Reader user id is the stored serial (users.greader_user_id), not
  // derived from the UUID; read it for the authenticated user.
  const [row] = await db
    .select({ greaderUserId: users.greaderUserId })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!row) return errorResponse("User not found", 404);

  return jsonResponse(formatUserInfo(row.greaderUserId, session.user.email));
}
