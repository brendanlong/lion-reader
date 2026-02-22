/**
 * Wallabag API: Info
 *
 * GET /api/wallabag/api/info - Get application information
 */

import { jsonResponse } from "@/server/wallabag/parse";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return jsonResponse({
    appname: "Lion Reader",
    version: "2.6.0",
    allowed_registration: false,
  });
}
