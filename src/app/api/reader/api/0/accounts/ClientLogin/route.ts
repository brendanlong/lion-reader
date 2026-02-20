/**
 * Google Reader API: ClientLogin
 *
 * POST /api/reader/api/0/accounts/ClientLogin
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

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const params = await parseFormData(request);
  const email = params.get("Email");
  const password = params.get("Passwd");

  if (!email || !password) {
    return errorResponse("Error=BadAuthentication", 401);
  }

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

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
