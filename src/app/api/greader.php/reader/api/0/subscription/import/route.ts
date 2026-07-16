/**
 * Google Reader API: Import Subscriptions (OPML)
 *
 * POST /api/greader.php/reader/api/0/subscription/import
 *
 * Imports feed subscriptions from an OPML document. Unlike most Google Reader
 * endpoints, the OPML is sent as the **raw request body** (not form-encoded):
 * FreshRSS reads `php://input` directly, and the greader_api client used by
 * Newsflash POSTs the OPML string as the body (issue #1059). We therefore read
 * the raw body rather than going through `parseFormData`.
 *
 * On success we return `OK: {count}`, where {count} is the number of unique
 * feeds queued for import. The import itself runs asynchronously in a background
 * job (mirroring the tRPC `subscriptions.import` flow), so the count reflects
 * feeds queued, not yet subscribed. FreshRSS returns a bare `OK`; the `OK: N`
 * form is what the greader_api client parses (it checks for the `OK: ` prefix).
 */

import { requireAuth } from "@/server/google-reader/auth";
import { textResponse, errorResponse } from "@/server/google-reader/parse";
import { importOpml, MAX_OPML_BYTES } from "@/server/services/imports";
import { OpmlParseError } from "@/server/feed/opml";
import { checkRouteRateLimit } from "@/server/rate-limit";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  // OPML import queues a subscribe job per feed — the tRPC equivalent is an
  // "expensive" procedure, so rate-limit this compat path the same way.
  const rateLimited = await checkRouteRateLimit(request, "expensive");
  if (rateLimited) return rateLimited;

  const opml = await request.text();

  if (opml.trim().length === 0) {
    return errorResponse("Missing OPML content in request body", 400);
  }

  // Guard against oversized payloads (byte length, matching the tRPC limit).
  if (new TextEncoder().encode(opml).length > MAX_OPML_BYTES) {
    return errorResponse("OPML file too large (max 5MB)", 413);
  }

  try {
    const { totalFeeds } = await importOpml(db, session.user.id, opml);
    return textResponse(`OK: ${totalFeeds}`);
  } catch (err) {
    if (err instanceof OpmlParseError) {
      return errorResponse(`Failed to parse OPML: ${err.message}`, 400);
    }
    // Log the detail server-side but return a generic message — internal error
    // text must not be echoed to clients (issue #1266).
    console.error("Failed to import OPML:", err);
    return errorResponse("Failed to import OPML", 500);
  }
}
