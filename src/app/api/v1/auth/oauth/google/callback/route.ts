/**
 * Google OAuth callback: Google redirects here with `code` and `state` in the query.
 * Besides sign-in and linking, Google has the Docs-access re-authorization flows
 * (`createGoogleAuthUrl`'s `docsAccess`).
 */

import type { NextRequest } from "next/server";
import { handleOAuthCallback } from "@/server/auth/oauth/callback-helpers";

export function GET(request: NextRequest) {
  return handleOAuthCallback(request, "google");
}
