/**
 * Wallabag API: User
 *
 * GET /api/wallabag/api/user - Get current user information
 */

import { withWallabagAuth } from "@/server/wallabag/auth";
import { jsonResponse } from "@/server/http/json-response";

export const dynamic = "force-dynamic";

export const GET = withWallabagAuth(async (_request, user) =>
  jsonResponse({
    // The stored serial shared with the Google Reader API; opaque to clients
    // (never reversed).
    id: Number(user.greaderUserId),
    username: user.email,
    email: user.email,
    created_at: null,
    updated_at: null,
    default_client: null,
  })
);
