/**
 * Digital Asset Links for the Android apps (GET /.well-known/assetlinks.json).
 *
 * Lets Android verify each app's App Link claim on the OAuth redirect URL, so
 * the authorization code is delivered only to our signed apps. See
 * src/server/oauth/app-client.ts.
 */

import { NextResponse } from "next/server";
import { androidAppConfig } from "@/server/config/env";

export function GET() {
  const statements = androidAppConfig.packages.map((app) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: app.packageName,
      sha256_cert_fingerprints: app.certSha256Fingerprints,
    },
  }));
  return NextResponse.json(statements, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
