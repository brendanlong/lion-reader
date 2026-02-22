/**
 * Wallabag OAuth Token Endpoint
 *
 * POST /api/wallabag/oauth/v2/token
 *
 * Supports two grant types:
 * - password: Authenticate with username/password
 * - refresh_token: Refresh an expired access token
 *
 * Request body (application/x-www-form-urlencoded or JSON):
 *   grant_type=password
 *   client_id=...
 *   client_secret=...
 *   username=...
 *   password=...
 *
 * Or for refresh:
 *   grant_type=refresh_token
 *   client_id=...
 *   client_secret=...
 *   refresh_token=...
 */

import { passwordGrant, refreshTokenGrant } from "@/server/wallabag/auth";
import { parseBody } from "@/server/wallabag/parse";
import { jsonResponse, errorResponse } from "@/server/wallabag/parse";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await parseBody(request);

  const grantType = body.grant_type;
  const clientId = body.client_id ?? "wallabag";

  if (grantType === "password") {
    const username = body.username;
    const password = body.password;

    if (!username || !password) {
      return errorResponse("invalid_request", "username and password are required", 400);
    }

    const result = await passwordGrant(username, password, clientId);
    if (!result) {
      return errorResponse("invalid_grant", "Invalid credentials", 401);
    }

    return jsonResponse(result);
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token;

    if (!refreshToken) {
      return errorResponse("invalid_request", "refresh_token is required", 400);
    }

    const result = await refreshTokenGrant(refreshToken, clientId);
    if (!result) {
      return errorResponse("invalid_grant", "Invalid or expired refresh token", 401);
    }

    return jsonResponse(result);
  }

  return errorResponse("unsupported_grant_type", `Unsupported grant type: ${grantType}`, 400);
}
