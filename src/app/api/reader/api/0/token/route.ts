/**
 * Google Reader API: Token
 *
 * GET /api/reader/api/0/token
 *
 * Returns an XSRF/action token. Some clients require this before
 * making write operations. We return the auth token itself since
 * we don't use XSRF protection on the API (auth is token-based).
 */

import { requireAuth, extractAuthToken } from "@/server/google-reader/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireAuth(request);

  // Return the auth token as the action token
  // This is what FreshRSS and Miniflux do
  const token = extractAuthToken(request) ?? "unused";

  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
