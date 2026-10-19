/**
 * Discord OAuth callback: Discord redirects here with `code` and `state` in the query.
 */

import type { NextRequest } from "next/server";
import { handleOAuthCallback } from "@/server/auth/oauth/callback-helpers";

export function GET(request: NextRequest) {
  return handleOAuthCallback(request, "discord");
}
