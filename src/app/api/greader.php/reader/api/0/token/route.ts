/**
 * Google Reader API: Token
 *
 * GET /api/greader.php/reader/api/0/token
 *
 * Returns an XSRF/action token. Some clients require this before
 * making write operations. We return the auth token itself since
 * we don't use XSRF protection on the API (auth is token-based).
 */

import { requireAuth, extractAuthToken } from "@/server/google-reader/auth";

import { withClientErrors } from "@/server/google-reader/parse";

export const dynamic = "force-dynamic";

export const GET = withClientErrors(async (request: Request): Promise<Response> => {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // Return the auth token as the action token
  // This is what FreshRSS and Miniflux do
  const token = extractAuthToken(request) ?? "unused";

  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
});
