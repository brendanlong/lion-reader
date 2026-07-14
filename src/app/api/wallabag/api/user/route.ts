/**
 * Wallabag API: User
 *
 * GET /api/wallabag/api/user - Get current user information
 */

import { eq } from "drizzle-orm";
import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse, errorResponse } from "@/server/wallabag/parse";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;

  // The Wallabag user id is the stored serial (users.greader_user_id, shared
  // with the Google Reader API), not derived from the UUID; it's opaque to
  // clients (never reversed).
  const [row] = await db
    .select({ greaderUserId: users.greaderUserId })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (!row) return errorResponse("not_found", "User not found", 404);

  return jsonResponse({
    id: Number(row.greaderUserId),
    username: auth.email,
    email: auth.email,
    created_at: null,
    updated_at: null,
    default_client: null,
  });
}
