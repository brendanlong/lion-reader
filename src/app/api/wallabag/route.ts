/**
 * Wallabag API: Root
 *
 * GET /api/wallabag - Server discovery endpoint
 *
 * The Wallabag Android app hits the configured server URL to verify
 * it exists before proceeding with the connection wizard. Returns
 * a simple 200 response so the app doesn't see a 404.
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
