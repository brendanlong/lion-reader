/**
 * FreshRSS-compatible health check endpoint.
 *
 * GET /api/greader.php
 *
 * Many Google Reader API clients (FocusReader, SmartRSS, etc.) check this
 * endpoint to verify the server is reachable before attempting authentication.
 * FreshRSS returns "OK" at this path, so we do the same.
 *
 * Actual API requests to /api/greader.php/accounts/... and
 * /api/greader.php/reader/... are handled via Next.js rewrites in next.config.ts.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });
}
