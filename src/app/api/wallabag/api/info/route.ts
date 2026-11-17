/**
 * Wallabag API: Info
 *
 * GET /api/wallabag/api/info - Get application information
 */

import { jsonResponse } from "@/server/http/json-response";
import { WALLABAG_VERSION } from "@/server/wallabag/client";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return jsonResponse({
    appname: "Lion Reader",
    version: WALLABAG_VERSION,
    allowed_registration: false,
  });
}
