/**
 * Apple OAuth callback. Sign in with Apple uses `response_mode=form_post`, so Apple
 * POSTs `code` and `state` here cross-site as a form.
 */

import type { NextRequest } from "next/server";
import { handleOAuthCallback } from "@/server/auth/oauth/callback-helpers";

export function POST(request: NextRequest) {
  return handleOAuthCallback(request, "apple");
}
