/**
 * Google Reader API: ClientLogin
 *
 * POST /api/greader.php/accounts/ClientLogin
 *
 * Authenticates a user with email/password and returns a session token.
 * This is the first step in the Google Reader auth flow.
 *
 * Request body (form-encoded):
 *   Email={email}&Passwd={password}
 *
 * Response (text/plain):
 *   SID=unused
 *   LSID=unused
 *   Auth={sessionToken}
 */

import { clientLogin } from "@/server/google-reader/auth";
import { parseFormData, errorResponse } from "@/server/google-reader/parse";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { extractClientInfo } from "@/server/http/client-ip";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const rateLimitResponse = await checkRouteRateLimit(request, "expensive");
  if (rateLimitResponse) return rateLimitResponse;

  const params = await parseFormData(request);
  const email = params.get("Email");
  const password = params.get("Passwd");

  if (!email || !password) {
    return errorResponse("Error=BadAuthentication", 401);
  }

  const { userAgent, ipAddress } = extractClientInfo(request.headers);

  const result = await clientLogin(email, password, userAgent, ipAddress);

  if (!result) {
    return errorResponse("Error=BadAuthentication", 401);
  }

  const body = `SID=${result.auth}\nLSID=${result.auth}\nAuth=${result.auth}`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
