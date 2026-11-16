/**
 * Wallabag API: Version
 *
 * GET /api/wallabag/api/version.json - Get API version string
 *
 * No authentication required. The Wallabag Android app calls this
 * as the first step when validating a server connection.
 */

import { jsonResponse } from "@/server/http/json-response";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return jsonResponse("2.6.0");
}
